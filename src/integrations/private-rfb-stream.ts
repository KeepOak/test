import { connect, type Socket } from 'node:net';
import { createCipheriv } from 'node:crypto';
import type { SharedDesktopInfo } from './linux-desktop.js';

const maximumBuffer = 5 * 1024 * 1024;
/** Original RFC 6143 implementation: fixed true-color Raw only; no extensions, clipboard or file transfer. */
class RfbReader {
  private pending: Buffer = Buffer.alloc(0);
  private waiter: (() => void) | undefined;
  private failed = false;
  constructor(readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      if (this.pending.length + chunk.length > maximumBuffer) { this.failed = true; socket.destroy(); }
      else this.pending = Buffer.concat([this.pending, chunk]);
      this.waiter?.();
    });
    for (const event of ['close', 'end', 'error']) socket.on(event, () => { this.failed = true; this.waiter?.(); });
  }
  async read(size: number): Promise<Buffer> {
    if (size < 0 || size > maximumBuffer) throw new Error('Unsupported private desktop frame.');
    while (this.pending.length < size) {
      if (this.failed) throw new Error('The private desktop connection ended.');
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { this.waiter = undefined; reject(new Error('The private desktop did not answer.')); }, 10_000);
        this.waiter = () => { this.waiter = undefined; clearTimeout(timeout); resolve(); };
      });
    }
    const bytes = this.pending.subarray(0, size); this.pending = this.pending.subarray(size); return bytes;
  }
}
/** VNC reverses key bits. EDE with the same key three times is DES without requiring OpenSSL's legacy provider. */
function challengeResponse(password: string, challenge: Buffer): Buffer {
  const key = Buffer.alloc(8), bytes = Buffer.from(password, 'latin1');
  for (let i = 0; i < 8; i++) {
    let input = bytes[i] ?? 0, reversed = 0;
    for (let bit = 0; bit < 8; bit++) { reversed = (reversed << 1) | (input & 1); input >>>= 1; }
    key[i] = reversed;
  }
  const triple = Buffer.concat([key, key, key]);
  try {
    const cipher = createCipheriv('des-ede3', triple, null); cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(challenge), cipher.final()]);
  } finally { key.fill(0); triple.fill(0); bytes.fill(0); }
}
async function authenticate(reader: RfbReader, password: string): Promise<{width: number; height: number}> {
  const socket = reader.socket;
  if ((await reader.read(12)).toString('ascii') !== 'RFB 003.008\n') throw new Error('This viewer requires RFB 3.8.');
  socket.write('RFB 003.008\n');
  const count = (await reader.read(1))[0]!;
  if (count === 0 || count > 32 || !(await reader.read(count)).includes(2)) throw new Error('Private VNC authentication is unavailable.');
  socket.write(Buffer.from([2]));
  socket.write(challengeResponse(password, await reader.read(16)));
  if ((await reader.read(4)).readUInt32BE() !== 0) throw new Error('The private desktop refused authentication.');
  socket.write(Buffer.from([1])); // Shared viewer; never evict another owner viewer.
  const init = await reader.read(24), width = init.readUInt16BE(0), height = init.readUInt16BE(2), nameSize = init.readUInt32BE(20);
  if (!width || !height || width > 1280 || height > 800 || nameSize > 4096) throw new Error('The private desktop size is unsupported.');
  await reader.read(nameSize); // Do not forward server names or private metadata.
  socket.write(Buffer.from([0, 0, 0, 0, 32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0]));
  socket.write(Buffer.from([2, 0, 0, 1, 0, 0, 0, 0])); // Raw encoding only.
  return {width, height};
}
async function update(reader: RfbReader, width: number, height: number, valid: () => boolean, rectangle: (bytes: Buffer) => void): Promise<void> {
  let pixels = 0, notices = 0;
  for (;;) {
    if (!valid()) throw new Error('Private desktop view revoked.');
    const type = (await reader.read(1))[0]!;
    if (type === 2 && ++notices <= 16) continue; // Bell; no host sound.
    if (type === 3 && ++notices <= 16) {
      const head = await reader.read(7), length = head.readUInt32BE(3);
      if (length > 65536) throw new Error('Private clipboard message is too large.');
      await reader.read(length); continue; // Clipboard never leaves the private desktop.
    }
    if (type !== 0) throw new Error('Unsupported private desktop message.');
    const count = (await reader.read(3)).readUInt16BE(1);
    if (count > 2048) throw new Error('Too many private desktop rectangles.');
    for (let i = 0; i < count; i++) {
      const head = await reader.read(12), x = head.readUInt16BE(0), y = head.readUInt16BE(2), w = head.readUInt16BE(4), h = head.readUInt16BE(6);
      pixels += w * h;
      if (!w || !h || head.readInt32BE(8) !== 0 || x + w > width || y + h > height || pixels > width * height) throw new Error('Unsupported private desktop rectangle.');
      const raw = await reader.read(w * h * 4);
      if (!valid()) throw new Error('Private desktop view revoked.');
      rectangle(Buffer.concat([head.subarray(0, 8), raw]));
    }
    return;
  }
}
export interface PrivateRfbStream { close(): void; input(packet: Buffer): void }
/** Closing only releases keys/buttons this connection pressed; it never introduces new input. */
function inputChannel(socket: Socket, valid: () => boolean, signal: AbortSignal) {
  const held = new Set<number>(); let active = false, closed = false, pointer: Buffer | undefined;
  const close = () => {
    if (closed) return; closed = true;
    if (!active || !socket.writable) { socket.destroy(); return; }
    const releases = [...held].map(symbol => { const packet = Buffer.alloc(8); packet[0] = 4; packet.writeUInt32BE(symbol, 4); return packet; });
    if (pointer) { pointer[1] = 0; releases.push(pointer); }
    socket.end(Buffer.concat(releases));
    const timer = setTimeout(() => socket.destroy(), 300); timer.unref(); socket.once('close', () => clearTimeout(timer));
  };
  signal.addEventListener('abort', close, {once: true});
  socket.once('close', () => signal.removeEventListener('abort', close));
  if (signal.aborted) close();
  return {close, activate: () => { active = true; }, input: (packet: Buffer) => {
    if (closed || !active || !valid() || socket.writableLength > 65536) return close();
    if (packet[0] === 4 && packet.length === 8) {
      const symbol = packet.readUInt32BE(4);
      if (packet[1] === 1) { if (held.size >= 32 && !held.has(symbol)) return close(); held.add(symbol); }
      else held.delete(symbol);
    } else if (packet[0] === 5 && packet.length === 6) pointer = Buffer.from(packet);
    else return close();
    socket.write(packet);
  }};
}
export async function openPrivateRfb(info: SharedDesktopInfo, valid: () => boolean,
  ready: (width: number, height: number) => void, rectangle: (bytes: Buffer) => void,
  ended: () => void, signal: AbortSignal): Promise<PrivateRfbStream> {
  if (info.host !== '127.0.0.1' || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535) throw new Error('Invalid local private desktop transport.');
  const socket = connect({host: info.host, port: info.port}), reader = new RfbReader(socket);
  const channel = inputChannel(socket, valid, signal), close = channel.close;
  try {
    const {width, height} = await authenticate(reader, info.password);
    if (!valid()) throw new Error('Private desktop view revoked.');
    channel.activate();
    ready(width, height);
    const loop = async () => {
      while (!socket.destroyed && valid()) {
        const request = Buffer.alloc(10); request[0] = 3; request.writeUInt16BE(width, 6); request.writeUInt16BE(height, 8);
        socket.write(request);
        await update(reader, width, height, valid, rectangle);
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 500); timer.unref(); });
      }
    };
    void loop().catch(() => undefined).finally(() => { close(); ended(); });
    return channel;
  } catch (error) { close(); throw error; }
}
