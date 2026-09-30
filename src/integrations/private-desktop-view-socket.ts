import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { acceptKey, binaryFrame, frame, readFrame } from '../ws.js';
import type { PrivateDesktops } from './private-desktops.js';
import type { PrivateDesktopViews } from './private-desktop-views.js';
import { openPrivateRfb, type PrivateRfbStream } from './private-rfb-stream.js';

/** The surrounding server checks the local window key, origin, owner, profile and lock before this upgrade. */
export async function servePrivateDesktopView(views: PrivateDesktopViews, desktops: PrivateDesktops,
  request: IncomingMessage, socket: Duplex, authorized: () => boolean, answerHeaders: string[] = [], onInput: () => void = () => {}): Promise<void> {
  const key = String(request.headers['sec-websocket-key'] ?? '');
  const offered = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(part => part.trim());
  const id = offered.find(part => /^private-view\.[a-f0-9-]{36}$/.test(part))?.slice(13);
  if (!id || !/^[A-Za-z0-9+/]{22}==$/.test(key) || request.headers['sec-websocket-version'] !== '13') throw new Error('Invalid private viewer upgrade.');
  const grant = views.claim(id), abort = new AbortController();
  let stream: PrivateRfbStream | undefined, pending: Buffer = Buffer.alloc(0), open = true, heard = 0, since = Date.now();
  const valid = () => open && authorized() && grant.valid();
  const close = () => { if (!open) return; open = false; abort.abort(); stream?.close(); views.revoke(id); socket.destroy(); };
  grant.disconnect(close);
  const send = (bytes: Buffer) => { if (!valid() || socket.writableLength + bytes.length > 5 * 1024 * 1024) return close(); socket.write(bytes); };
  const clock = setInterval(() => { if (!valid()) close(); }, 250); clock.unref();
  socket.once('close', close); socket.once('end', close); socket.once('error', close);
  socket.on('data', (chunk: Buffer) => {
    if (!valid() || pending.length + chunk.length > 65536) return close();
    pending = Buffer.concat([pending, chunk]);
    try {
      for (let decoded = readFrame(pending); decoded && open; decoded = readFrame(pending)) {
        if (!decoded.fin || (pending[0]! & 0x70) !== 0 || (pending[1]! & 0x80) === 0) return close();
        pending = pending.subarray(decoded.consumed);
        if (Date.now() - since >= 1000) { since = Date.now(); heard = 0; }
        if (++heard > 120) return close();
        if (decoded.opcode === 8) return close();
        if (decoded.opcode === 9 && decoded.payload.length <= 125) { send(Buffer.concat([Buffer.from([0x8a, decoded.payload.length]), decoded.payload])); continue; }
        if (decoded.opcode === 10 && decoded.payload.length <= 125) continue;
        if (decoded.opcode !== 2 || !grant.control) return close();
        if (!inputAllowed(decoded.payload) || !valid()) return close();
        stream?.input(decoded.payload); onInput();
      }
    } catch { close(); }
  });
  try {
    const target = await desktops.viewerTarget(grant.owner, grant.agent);
    if (!valid()) return close();
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`, 'Sec-WebSocket-Protocol: bearer', ...answerHeaders, '', ''].join('\r\n'));
    stream = await openPrivateRfb(target, valid,
      (width, height) => send(frame(JSON.stringify({kind: 'ready', width, height, control: grant.control}))),
      bytes => send(binaryFrame(bytes)), close, abort.signal);
    if (!valid()) close();
  } catch { close(); }
  socket.once('close', () => { clearInterval(clock); });
  if (!open) clearInterval(clock);
}
function inputAllowed(packet: Buffer): boolean {
  if (packet[0] === 4 && packet.length === 8) return packet[1]! <= 1 && packet[2] === 0 && packet[3] === 0 && packet.readUInt32BE(4) <= 0x10ffffff;
  if (packet[0] === 5 && packet.length === 6) return packet[1]! <= 7 && packet.readUInt16BE(2) < 1280 && packet.readUInt16BE(4) < 800;
  return false; // No clipboard, format changes, extension messages or arbitrary VNC payloads.
}
