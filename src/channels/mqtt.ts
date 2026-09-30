import type { Duplex } from "node:stream";
import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { reconnectDelay } from "./ws-client.js";
import { defineService, secretName, ShortIds, type SocketOpener } from "./parity-common.js";

/**
 * MQTT 3.1.1 (OASIS standard, https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/mqtt-v3.1.1.html), with
 * the packets written by hand: CONNECT, CONNACK, SUBSCRIBE, SUBACK, PUBLISH (QoS 0 and 1), PUBACK,
 * PINGREQ, PINGRESP and DISCONNECT.
 *
 * MQTT has no idea of people or chats, so this service agrees a small shape with whatever else is
 * on the broker: a message on `inboundTopic` is JSON `{"from", "chat", "text"}` (or, with
 * `plainTextSender`, plain words from that one sender), and a reply goes to `replyTopic` with
 * `{chat}` replaced. Replies carry `"from": <clientId>`, and a message with that sender is never
 * answered, so a reply topic the assistant also listens to cannot start a loop. A retained message
 * is one the broker kept from before, so it is never answered either.
 */
export const PACKET = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4, SUBSCRIBE: 8, SUBACK: 9, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 } as const;
const MAX_PACKET = 1 << 20;

/** The "remaining length" of a packet: seven bits a byte, low bits first, at most four bytes. */
export function encodeLength(length: number): Buffer {
  if (length < 0 || length > 268_435_455) throw new Error("An MQTT packet cannot be that long");
  const bytes: number[] = [];
  do {
    let byte = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) byte |= 0x80;
    bytes.push(byte);
  } while (length > 0);
  return Buffer.from(bytes);
}
/** A UTF-8 string with its two-byte length in front. */
function field(value: string | Buffer): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  if (bytes.length > 65535) throw new Error("An MQTT field cannot be that long");
  const head = Buffer.alloc(2);
  head.writeUInt16BE(bytes.length);
  return Buffer.concat([head, bytes]);
}
export function packet(type: number, flags: number, body: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.concat([Buffer.from([(type << 4) | flags]), encodeLength(body.length), body]);
}
function id16(value: number): Buffer { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; }

export interface ConnectFields { clientId: string; username?: string; password?: string; keepAliveSeconds: number }
export function connectPacket(fields: ConnectFields): Buffer {
  const hasUser = fields.username !== undefined;
  const hasPassword = hasUser && fields.password !== undefined;
  const flags = (hasUser ? 0x80 : 0) | (hasPassword ? 0x40 : 0) | 0x02;
  const body = Buffer.concat([
    field("MQTT"), Buffer.from([4, flags]), id16(Math.min(65535, Math.ceil(fields.keepAliveSeconds))), field(fields.clientId),
    ...(hasUser ? [field(fields.username!)] : []), ...(hasPassword ? [field(fields.password!)] : []),
  ]);
  return packet(PACKET.CONNECT, 0, body);
}
export function publishPacket(topic: string, payload: Buffer, qos: 0 | 1, packetId: number): Buffer {
  return packet(PACKET.PUBLISH, qos << 1, Buffer.concat([field(topic), ...(qos ? [id16(packetId)] : []), payload]));
}

export interface MqttPacket { type: number; flags: number; body: Buffer }
/** Collects bytes and hands back whole packets, however the network split them. */
export class MqttReader {
  private pending = Buffer.alloc(0);
  push(chunk: Buffer): MqttPacket[] {
    this.pending = Buffer.concat([this.pending, chunk]);
    const out: MqttPacket[] = [];
    for (;;) {
      const size = this.header();
      if (!size) return out;
      const [headLength, bodyLength] = size;
      if (this.pending.length < headLength + bodyLength) return out;
      const first = this.pending[0]!;
      out.push({ type: first >> 4, flags: first & 0x0f, body: this.pending.subarray(headLength, headLength + bodyLength) });
      this.pending = this.pending.subarray(headLength + bodyLength);
    }
  }
  /** The fixed header's length and the body's length, or null when not all of it is here yet. */
  private header(): [number, number] | null {
    let length = 0;
    for (let i = 1; i <= 4; i++) {
      if (this.pending.length <= i) return null;
      const byte = this.pending[i]!;
      length += (byte & 0x7f) * 128 ** (i - 1);
      if (!(byte & 0x80)) {
        if (length > MAX_PACKET) throw new Error("The MQTT broker sent a packet that is too large");
        return [i + 1, length];
      }
    }
    throw new Error("The MQTT broker sent a broken packet length");
  }
}

/** What a PUBLISH carries. */
export function readPublish(p: MqttPacket): { topic: string; qos: number; retain: boolean; packetId: number; payload: Buffer } {
  const topicLength = p.body.readUInt16BE(0);
  const topic = p.body.subarray(2, 2 + topicLength).toString("utf8");
  const qos = (p.flags >> 1) & 0x03;
  const packetId = qos ? p.body.readUInt16BE(2 + topicLength) : 0;
  return { topic, qos, retain: (p.flags & 1) === 1, packetId, payload: p.body.subarray(2 + topicLength + (qos ? 2 : 0)) };
}

const REFUSALS: Record<number, [ChannelHealth["state"], string]> = {
  1: ["needs attention", "The MQTT broker does not speak MQTT 3.1.1"],
  2: ["needs attention", "The MQTT broker refused the client id. Choose another clientId"],
  3: ["reconnecting", "The MQTT broker is unavailable right now"],
  4: ["needs attention", "The MQTT broker did not accept the user name or password. Save the right password as the secret named in passwordSecret (MQTT_PASSWORD by default)"],
  5: ["needs attention", "The MQTT broker says this account may not connect. Check the account's permissions on the broker"],
};

const payloadSchema = z.object({ from: z.string().min(1).max(200), chat: z.string().min(1).max(200).optional(), text: z.string() }).passthrough();

export interface MqttOptions {
  id: string;
  host: string;
  port: number;
  tls: boolean;
  open: SocketOpener;
  clientId: string;
  username?: string;
  password?: string;
  inboundTopic: string;
  replyTopic: string;
  qos: 0 | 1;
  plainTextSender?: string;
  keepAliveSeconds?: number;
  retryBaseMs?: number;
}

/** A reply topic: `{chat}` replaced, and refused if the chat would add a wildcard or a NUL. */
export function replyTopicFor(template: string, chat: string): string {
  if (/[+#\0]/.test(chat)) throw new Error("That chat name cannot be used in an MQTT topic");
  const topic = template.split("{chat}").join(chat);
  if (!topic || Buffer.byteLength(topic) > 65535) throw new Error("That reply topic is not a valid MQTT topic");
  return topic;
}

export class MqttChannel implements ChannelAdapter {
  readonly id: string;
  readonly kind = "mqtt";
  readonly maxTextLength = 3500;
  private state: ChannelHealth = { state: "reconnecting", reason: "Connecting to the MQTT broker" };
  private socket: Duplex | null = null;
  private stopping = false;
  private refused = false;
  private loop: Promise<void> | null = null;
  private nextId = 1;
  private counter = 0;
  private readonly waiting = new Map<number, (lost?: Error) => void>();
  private readonly ids = new ShortIds();
  private onMessage: (message: InboundMessage) => Promise<void> = async () => undefined;
  constructor(private readonly options: MqttOptions) { this.id = options.id; }
  botName(): string | null { return this.options.clientId; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.stopping = false;
    this.onMessage = onMessage;
    this.loop = this.run();
    await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 50))]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    const socket = this.socket;
    let unanswered: NodeJS.Timeout | null = null;
    if (socket) {
      // DISCONNECT has to reach the broker before the socket goes. Destroying it straight after the
      // write threw the goodbye away wherever the write was still queued (on Windows it often is),
      // so the socket is ended, which sends what is queued first, and the broker closes its side.
      this.write(packet(PACKET.DISCONNECT, 0));
      socket.end();
      unanswered = setTimeout(() => socket.destroy(), 2000);
    }
    await this.loop?.catch(() => undefined);
    if (unanswered) clearTimeout(unanswered);
    socket?.destroy();
    this.loop = null;
  }

  private async run(): Promise<void> {
    for (let attempt = 0; !this.stopping && !this.refused; attempt++) {
      try {
        const { host, port, tls } = this.options;
        const socket = await this.options.open({ host, port, tls });
        await this.session(socket);
        if (this.state.state === "connected") attempt = 0;
        if (!this.stopping && !this.refused) this.state = { state: "reconnecting", reason: "The MQTT broker closed the connection" };
      } catch (error) {
        if (this.stopping) return;
        this.state = { state: "reconnecting", reason: `Could not reach the MQTT broker: ${error instanceof Error ? error.message : String(error)}` };
      }
      this.socket = null;
      for (const done of this.waiting.values()) done(new Error("The MQTT connection dropped before the broker confirmed the message"));
      this.waiting.clear();
      if (this.stopping || this.refused) return;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt + 1, this.options.retryBaseMs ?? 1000)));
    }
  }

  /** One connection, from CONNECT until the socket closes. */
  private session(socket: Duplex): Promise<void> {
    this.socket = socket;
    const reader = new MqttReader();
    const keepAlive = this.options.keepAliveSeconds ?? 60;
    let answered = true;
    const ping = setInterval(() => {
      if (!answered) { socket.destroy(); return; }
      answered = false;
      this.write(packet(PACKET.PINGREQ, 0));
    }, keepAlive * 1000);
    return new Promise<void>((resolve) => {
      const finish = () => { clearInterval(ping); resolve(); };
      socket.once("close", finish);
      socket.on("error", () => { socket.destroy(); finish(); });
      socket.on("data", (chunk: Buffer) => {
        try {
          for (const p of reader.push(chunk)) { if (p.type === PACKET.PINGRESP) answered = true; this.onPacket(p); }
        } catch (error) {
          this.state = { state: "reconnecting", reason: `The MQTT broker sent something unreadable: ${error instanceof Error ? error.message : String(error)}` };
          socket.destroy();
        }
      });
      const { clientId, username, password } = this.options;
      this.write(connectPacket({ clientId, keepAliveSeconds: keepAlive,
        ...(username !== undefined ? { username } : {}), ...(password !== undefined ? { password } : {}) }));
    });
  }
  private write(data: Buffer): void { if (this.socket?.writable) this.socket.write(data); }

  private onPacket(p: MqttPacket): void {
    switch (p.type) {
      case PACKET.CONNACK: return this.onConnack(p.body[1] ?? 255);
      case PACKET.SUBACK:
        if (p.body.subarray(2).includes(0x80)) this.state = { state: "needs attention", reason: "The MQTT broker would not let the assistant listen on inboundTopic. Check the account's permissions" };
        return;
      case PACKET.PUBLISH: return this.onPublish(p);
      case PACKET.PUBACK: { const id = p.body.readUInt16BE(0); this.waiting.get(id)?.(); this.waiting.delete(id); return; }
      default: return;
    }
  }
  private onConnack(code: number): void {
    if (code === 0) {
      this.state = { state: "connected" };
      const body = Buffer.concat([id16(this.packetId()), field(this.options.inboundTopic), Buffer.from([1])]);
      this.write(packet(PACKET.SUBSCRIBE, 0x02, body));
      return;
    }
    const [state, reason] = REFUSALS[code] ?? ["needs attention", `The MQTT broker refused the connection (code ${code})`];
    this.state = { state, reason };
    if (state === "needs attention") this.refused = true;
    this.socket?.destroy();
  }
  private onPublish(p: MqttPacket): void {
    const message = readPublish(p);
    if (message.qos === 1) this.write(packet(PACKET.PUBACK, 0, id16(message.packetId)));
    if (message.qos > 1 || message.retain) return; // QoS 2 was never asked for; retained is from before.
    const inbound = this.inbound(message.payload.toString("utf8"));
    if (inbound) void this.onMessage({ ...inbound, mqttTopic: message.topic, mqttDuplicate: (p.flags & 8) !== 0 }).catch(() => undefined);
  }
  private inbound(payload: string): InboundMessage | null {
    const said = this.read(payload);
    if (!said || !said.text.trim() || said.from === this.options.clientId) return null;
    const chat = said.chat ?? said.from;
    const direct = chat === said.from;
    const me = `@${this.options.clientId}`.toLowerCase();
    const lower = said.text.toLowerCase();
    const text = lower.startsWith(me) ? said.text.slice(me.length).replace(/^[\s:,]+/, "") : said.text;
    return {
      channel: this.id, chatId: this.ids.short(chat, "chat"), chatKind: direct ? "direct" : "group",
      ...(direct ? {} : { chatTitle: chat }),
      senderId: this.ids.short(said.from, "who"), senderName: said.from,
      text: text || said.text, addressed: direct || lower.includes(me), messageId: `${Date.now()}-${++this.counter}`,
    };
  }
  /** The agreed JSON shape, or plain words when a plain-text sender is set. */
  private read(payload: string): { from: string; chat?: string | undefined; text: string } | null {
    let parsed: unknown;
    try { parsed = JSON.parse(payload); } catch { parsed = undefined; }
    const shaped = payloadSchema.safeParse(parsed);
    if (shaped.success) return shaped.data;
    return this.options.plainTextSender ? { from: this.options.plainTextSender, text: payload } : null;
  }
  private packetId(): number {
    const id = this.nextId;
    this.nextId = this.nextId >= 65535 ? 1 : this.nextId + 1;
    return id;
  }

  async send(chatId: string, text: string): Promise<string | undefined> {
    const chat = this.ids.long(chatId);
    const topic = replyTopicFor(this.options.replyTopic, chat);
    if (!this.socket || this.state.state !== "connected") throw new Error("The MQTT broker is not connected, so the message could not be sent");
    const payload = Buffer.from(JSON.stringify({ from: this.options.clientId, chat, text: text.slice(0, this.maxTextLength) }), "utf8");
    const id = this.packetId();
    const acknowledged = new Promise<void>((resolve, reject) => {
      if (this.options.qos === 0) { resolve(); return; }
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error("The MQTT broker did not confirm the message")); }, 15000);
      this.waiting.set(id, (lost) => { clearTimeout(timer); if (lost) reject(lost); else resolve(); });
    });
    this.write(publishPacket(topic, payload, this.options.qos, id));
    await acknowledged;
    return undefined;
  }
}

const topic = z.string().min(1).max(512).refine((value) => !value.includes("\0"), "A topic cannot contain a NUL");
export const mqttService = defineService({
  kind: "mqtt", name: "MQTT", docs: "https://docs.oasis-open.org/mqtt/mqtt/v3.1.1/mqtt-v3.1.1.html",
  needs: ["The broker's address and port", "A client id, and the topics to listen on and reply to",
    "The broker account's user name, and its password saved as a secret (MQTT_PASSWORD), if the broker asks for one"],
  receives: "socket",
  settings: z.object({
    host: z.string().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/),
    port: z.number().int().min(1).max(65535).optional(),
    tls: z.boolean().default(true),
    clientId: z.string().regex(/^[A-Za-z0-9_-]{1,23}$/).default("branch"),
    username: z.string().min(1).max(200).optional(),
    passwordSecret: z.string().regex(secretName).default("MQTT_PASSWORD"),
    inboundTopic: topic,
    replyTopic: topic.refine((value) => !/[+#]/.test(value), "A reply topic cannot contain + or #"),
    qos: z.union([z.literal(0), z.literal(1)]).default(1),
    plainTextSender: z.string().min(1).max(64).optional(),
    keepAliveSeconds: z.number().int().min(10).max(3600).default(60),
  }).strict(),
  async build(settings, deps) {
    // A raw socket has no fetch to guard it, so the broker is checked by name first.
    await deps.assertAllowed(new URL(`https://${settings.host}`), "MQTT broker");
    return new MqttChannel({
      id: deps.id, host: settings.host, port: settings.port ?? (settings.tls ? 8883 : 1883), tls: settings.tls, open: deps.openSocket,
      clientId: settings.clientId, inboundTopic: settings.inboundTopic, replyTopic: settings.replyTopic, qos: settings.qos,
      keepAliveSeconds: settings.keepAliveSeconds,
      ...(settings.username !== undefined ? { username: settings.username, password: await deps.secret(settings.passwordSecret) } : {}),
      ...(settings.plainTextSender !== undefined ? { plainTextSender: settings.plainTextSender } : {}),
    });
  },
});
