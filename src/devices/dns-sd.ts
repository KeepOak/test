import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";

/**
 * find-computers: just enough DNS-SD over multicast DNS (RFC 6762/6763) for Branch computers to find each other on
 * the local network, written here rather than taken from a library: it is four record types, it reads packets from
 * anyone on the network so every length and pointer is checked, and every test runs it over a stand-in socket.
 *
 *   A computer waiting to pair (`branch node pair` with nothing after it, or the app's "be found" state) answers
 *   questions for `_branch-node._tcp.local` with a random instance label, its pairing port (SRV) and its display
 *   name (TXT), and says goodbye (time to live 0) when it stops. Nothing else is advertised, ever.
 *   The computer pairing it asks that question while its "Pair another computer" dialog is open, and reads the
 *   answers. The address used is the one the answer came from, never an address written inside it.
 */
export const serviceType = "_branch-node._tcp.local";
export const mdnsGroup = "224.0.0.251";
export const mdnsPort = 5353;
const packetLimit = 9000;
const questionLimit = 32;
const recordLimit = 64;
const TYPE = { A: 1, PTR: 12, TXT: 16, SRV: 33, ANY: 255 } as const;

export type DnsRecord =
  | { type: "PTR"; name: string; ttl: number; target: string }
  | { type: "SRV"; name: string; ttl: number; port: number; target: string }
  | { type: "TXT"; name: string; ttl: number; text: string[] };
export interface DnsQuestion { name: string; type: number }
export interface DnsPacket { response: boolean; questions: DnsQuestion[]; records: DnsRecord[] }

/** The one socket both sides use; tests hand in a stand-in, so no test ever sends on a real network. */
export interface MdnsSocket {
  send(data: Buffer): void;
  onMessage(listener: (data: Buffer, from: string) => void): void;
  close(): void;
}
export type OpenMdnsSocket = () => Promise<MdnsSocket>;

/* ---------- writing ---------- */

function encodeName(name: string): Buffer {
  const parts: Buffer[] = [];
  for (const label of name.split(".").filter(Boolean)) {
    const bytes = Buffer.from(label, "utf8");
    if (bytes.length > 63) throw new Error("A DNS label is at most 63 bytes.");
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));
  const out = Buffer.concat(parts);
  if (out.length > 255) throw new Error("A DNS name is at most 255 bytes.");
  return out;
}
const u16 = (value: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; };
const u32 = (value: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };

function recordData(record: DnsRecord): Buffer {
  if (record.type === "PTR") return encodeName(record.target);
  if (record.type === "SRV") return Buffer.concat([u16(0), u16(0), u16(record.port), encodeName(record.target)]);
  return Buffer.concat(record.text.map((text) => {
    const bytes = Buffer.from(text, "utf8").subarray(0, 255);
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  }));
}

export function encodePacket(packet: DnsPacket): Buffer {
  const header = Buffer.concat([u16(0), u16(packet.response ? 0x8400 : 0), u16(packet.questions.length), u16(packet.records.length), u16(0), u16(0)]);
  const questions = packet.questions.map((q) => Buffer.concat([encodeName(q.name), u16(q.type), u16(1)]));
  const records = packet.records.map((record) => {
    const data = recordData(record);
    // A shared record (PTR) keeps class IN; the unique ones set the cache-flush bit, as RFC 6762 §10.2 asks.
    const klass = record.type === "PTR" ? 1 : 0x8001;
    return Buffer.concat([encodeName(record.name), u16(TYPE[record.type]), u16(klass), u32(record.ttl), u16(data.length), data]);
  });
  return Buffer.concat([header, ...questions, ...records]);
}

/* ---------- reading (anyone on the network can send these, so nothing is trusted) ---------- */

class Reader {
  constructor(private readonly buf: Buffer, public at = 0) {}
  need(bytes: number): void { if (this.at + bytes > this.buf.length) throw new Error("The packet ends too soon."); }
  u8(): number { this.need(1); return this.buf.readUInt8(this.at++); }
  u16(): number { this.need(2); const v = this.buf.readUInt16BE(this.at); this.at += 2; return v; }
  u32(): number { this.need(4); const v = this.buf.readUInt32BE(this.at); this.at += 4; return v; }
  bytes(count: number): Buffer { this.need(count); const v = this.buf.subarray(this.at, this.at + count); this.at += count; return v; }
  /** A name, following compression pointers only backwards and at most 16 times, so no packet can loop it. */
  name(): string {
    const labels: string[] = [];
    let at = this.at, jumps = 0, length = 0, end = -1;
    for (;;) {
      if (at >= this.buf.length) throw new Error("A name runs past the packet.");
      const size = this.buf[at]!;
      if (size === 0) { at += 1; break; }
      if ((size & 0xc0) === 0xc0) {
        if (at + 1 >= this.buf.length) throw new Error("A pointer runs past the packet.");
        const target = ((size & 0x3f) << 8) | this.buf[at + 1]!;
        if (target >= at || ++jumps > 16) throw new Error("A name points forwards or loops.");
        if (end < 0) end = at + 2;
        at = target;
        continue;
      }
      if (size > 63 || at + 1 + size > this.buf.length) throw new Error("A label is too long.");
      length += size + 1;
      if (length > 255) throw new Error("A name is too long.");
      labels.push(this.buf.toString("utf8", at + 1, at + 1 + size));
      at += 1 + size;
    }
    this.at = end >= 0 ? end : at;
    return labels.join(".");
  }
}

function readRecord(r: Reader): DnsRecord | null {
  const name = r.name();
  const type = r.u16();
  r.u16(); // class
  const ttl = r.u32();
  const size = r.u16();
  r.need(size);
  const end = r.at + size;
  let record: DnsRecord | null = null;
  if (type === TYPE.PTR) record = { type: "PTR", name, ttl, target: r.name() };
  else if (type === TYPE.SRV) { r.u16(); r.u16(); const port = r.u16(); record = { type: "SRV", name, ttl, port, target: r.name() }; }
  else if (type === TYPE.TXT) {
    const text: string[] = [];
    while (r.at < end) { const length = r.u8(); if (r.at + length > end) throw new Error("A text entry runs past its record."); text.push(r.bytes(length).toString("utf8")); }
    record = { type: "TXT", name, ttl, text };
  }
  if (r.at > end) throw new Error("A record runs past its length.");
  r.at = end;
  return record;
}

/** Reads a packet, or throws on anything malformed; a caller drops what throws. */
export function decodePacket(buf: Buffer): DnsPacket {
  if (buf.length < 12 || buf.length > packetLimit) throw new Error("Not a DNS packet of a size Branch reads.");
  const r = new Reader(buf);
  r.u16();
  const flags = r.u16();
  const counts = [r.u16(), r.u16(), r.u16(), r.u16()] as const;
  if (counts[0] > questionLimit || counts[1] + counts[2] + counts[3] > recordLimit) throw new Error("Too many entries.");
  const questions: DnsQuestion[] = [];
  for (let i = 0; i < counts[0]; i++) { const name = r.name(); const type = r.u16(); r.u16(); questions.push({ name, type }); }
  const records: DnsRecord[] = [];
  for (let i = 0; i < counts[1] + counts[2] + counts[3]; i++) { const record = readRecord(r); if (record) records.push(record); }
  return { response: (flags & 0x8000) !== 0, questions, records };
}

/* ---------- the two sides ---------- */

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const asksForUs = (packet: DnsPacket): boolean =>
  !packet.response && packet.questions.some((q) => same(q.name, serviceType) && (q.type === TYPE.PTR || q.type === TYPE.ANY));

/** Advertises one computer waiting to pair: a random instance label, the pairing port and the display name. */
export class MdnsAdvertiser {
  private socket: MdnsSocket | null = null;
  private readonly instance = `branch-${randomBytes(4).toString("hex")}.${serviceType}`;
  private readonly host = `branch-${randomBytes(4).toString("hex")}.local`;
  constructor(private readonly open: OpenMdnsSocket, private readonly name: string, private readonly port: number) {}

  records(ttl: number): DnsRecord[] {
    return [
      { type: "PTR", name: serviceType, ttl, target: this.instance },
      { type: "SRV", name: this.instance, ttl, port: this.port, target: this.host },
      { type: "TXT", name: this.instance, ttl, text: [`name=${this.name.slice(0, 80)}`] },
    ];
  }
  private announce(ttl: number): void { this.socket?.send(encodePacket({ response: true, questions: [], records: this.records(ttl) })); }

  async start(): Promise<void> {
    if (this.socket) return;
    const socket = await this.open();
    this.socket = socket;
    socket.onMessage((data) => {
      let packet: DnsPacket;
      try { packet = decodePacket(data); } catch { return; } // somebody else's packet, or rubbish: not ours to read
      if (asksForUs(packet)) this.announce(120);
    });
    this.announce(120);
  }
  /** Says goodbye (time to live 0), so browsers drop it straight away, then closes the socket. */
  stop(): void {
    if (!this.socket) return;
    this.announce(0);
    this.socket.close();
    this.socket = null;
  }
  get advertising(): boolean { return this.socket !== null; }
}

export interface FoundLocal { key: string; name: string; address: string; port: number; seenAt: number }
/** The local network's private ranges, and Tailscale's; an answer from anywhere else is not listed. */
export function isPrivateAddress(address: string): boolean {
  const p = address.replace(/^::ffff:/, "").split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 10 || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || (p[0] === 192 && p[1] === 168)
    || (p[0] === 169 && p[1] === 254) || (p[0] === 100 && p[1]! >= 64 && p[1]! <= 127);
}
const foundLimit = 32;
const forgetAfterMs = 120_000;

/** Asks the local network for computers waiting to pair, and keeps what answers, while it is started. */
export class MdnsBrowser {
  private socket: MdnsSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly seen = new Map<string, FoundLocal>();
  constructor(private readonly open: OpenMdnsSocket, private readonly now: () => number = Date.now, private readonly askEveryMs = 3000) {}

  async start(): Promise<void> {
    if (this.socket) return;
    const socket = await this.open();
    this.socket = socket;
    socket.onMessage((data, from) => this.hear(data, from));
    this.ask();
    this.timer = setInterval(() => this.ask(), this.askEveryMs);
    this.timer.unref?.();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.socket?.close();
    this.socket = null;
    this.seen.clear();
  }
  get browsing(): boolean { return this.socket !== null; }
  private ask(): void { this.socket?.send(encodePacket({ response: false, questions: [{ name: serviceType, type: TYPE.PTR }], records: [] })); }

  private hear(data: Buffer, from: string): void {
    let packet: DnsPacket;
    try { packet = decodePacket(data); } catch { return; } // not a packet Branch reads; others share this port
    if (!packet.response) return;
    const address = from.replace(/^::ffff:/, "");
    for (const ptr of packet.records) {
      if (ptr.type !== "PTR" || !same(ptr.name, serviceType) || !ptr.target.toLowerCase().endsWith(`.${serviceType}`)) continue;
      const key = `${address}|${ptr.target.toLowerCase()}`;
      if (ptr.ttl === 0) { this.seen.delete(key); continue; }
      const srv = packet.records.find((r): r is Extract<DnsRecord, { type: "SRV" }> => r.type === "SRV" && same(r.name, ptr.target));
      const txt = packet.records.find((r): r is Extract<DnsRecord, { type: "TXT" }> => r.type === "TXT" && same(r.name, ptr.target));
      const name = (txt?.text.find((entry) => entry.startsWith("name="))?.slice(5) ?? "").trim().slice(0, 80);
      if (!srv || srv.port === 0 || !name || !isPrivateAddress(address)) continue;
      if (!this.seen.has(key) && this.seen.size >= foundLimit) continue;
      this.seen.set(key, { key, name, address, port: srv.port, seenAt: this.now() });
    }
  }
  found(): FoundLocal[] {
    const cutoff = this.now() - forgetAfterMs;
    for (const [key, entry] of this.seen) if (entry.seenAt < cutoff) this.seen.delete(key);
    return [...this.seen.values()];
  }
}

/** The real socket: UDP 5353 on the multicast group, used only while a side above is started. */
export const openMdnsSocket: OpenMdnsSocket = () => new Promise((resolve, reject) => {
  const socket = createSocket({ type: "udp4", reuseAddr: true });
  socket.once("error", reject);
  socket.bind(mdnsPort, () => {
    socket.off("error", reject);
    try {
      socket.addMembership(mdnsGroup);
      socket.setMulticastTTL(255);
    } catch (error) { socket.close(); reject(error); return; }
    socket.on("error", () => socket.close());
    resolve({
      send: (data) => socket.send(data, mdnsPort, mdnsGroup),
      onMessage: (listener) => socket.on("message", (data, info) => listener(data, info.address)),
      close: () => { try { socket.close(); } catch { /* already closed by an error */ } },
    });
  });
});
