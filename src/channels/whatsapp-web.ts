import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage, OutgoingFile } from "./router.js";
import { defineService, type ParityDeps } from "./parity-common.js";
import { connectWebSocket, reconnectDelay, type WebSocketConnect, type WebSocketConnection } from "./ws-client.js";

/**
 * WhatsApp with a personal number, through WAHA (github.com/devlikeapro/waha, Apache-2.0), a WhatsApp Web bridge the
 * owner installs and runs themselves on this computer, as signal-cli is for Signal. Branch ships none of it: it talks
 * to the bridge's local HTTP API and socket only, and links the number by the QR code the bridge makes.
 *
 * Automating a personal number goes through an unofficial client, which WhatsApp's terms do not allow, so the number
 * can be banned. The setup says so, recommends a spare number, and keeps the official Cloud API (whatsapp.ts) as the
 * option with no such risk. This one ships off, like every added service, until the owner sets it up.
 *
 * The bridge is a program on this computer, so only a loopback address is accepted (127.0.0.1, localhost, ::1); the
 * network settings, which keep tasks away from this computer's own services, are not asked about that one address.
 * API used (WAHA docs, waha.devlike.pro): `X-Api-Key` on every call; `POST /api/sessions` to create a session,
 * `GET /api/sessions/{s}` for its status and `me`, `GET /api/{s}/auth/qr?format=raw` for the pairing code,
 * `POST /api/sendText`, and `ws://host/ws?session=s&events=message` for arriving messages.
 */
export const wahaDocs = "https://waha.devlike.pro/docs/how-to/sessions/";
const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** The bridge's address, refused unless it is on this computer. */
export function bridgeAddress(text: string): string {
  let url: URL;
  try { url = new URL(text.trim()); } catch { throw new Error("The bridge's address must be a full address, like http://127.0.0.1:3000."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The bridge's address must start with http:// or https://.");
  if (!loopback.has(url.hostname.toLowerCase())) throw new Error("The WhatsApp bridge must run on this computer (127.0.0.1 or localhost).");
  if (url.username || url.password || url.search || url.hash) throw new Error("The bridge's address must be just the address and port.");
  return url.origin;
}

const statusSchema = z.object({ status: z.string(), me: z.object({ id: z.string(), pushName: z.string().nullish() }).passthrough().nullish() }).passthrough();
const eventSchema = z.object({
  event: z.string(), session: z.string().optional(),
  payload: z.object({
    id: z.union([z.string(), z.object({ _serialized: z.string() }).passthrough()]).optional(),
    from: z.string(), fromMe: z.boolean().optional(), body: z.string().nullish(),
    participant: z.string().nullish(), author: z.string().nullish(),
    replyTo: z.object({ id: z.string().optional(), participant: z.string().nullish() }).passthrough().nullish(),
    /** A picture, video, file or voice note the bridge has downloaded, at an address of its own. */
    hasMedia: z.boolean().optional(),
    media: z.object({ url: z.string().max(2000).nullish(), mimetype: z.string().max(100).nullish(), filename: z.string().max(300).nullish() }).passthrough().nullish(),
    _data: z.object({ notifyName: z.string().optional(), pushName: z.string().optional() }).passthrough().nullish(),
  }).passthrough(),
}).passthrough();
const idOf = (id: unknown): string | undefined => (typeof id === "string" ? id : (id as { _serialized?: string } | undefined)?._serialized);
/** The largest file fetched from the bridge for a task, as every other chat app holds it. */
const inboundLimit = 20 * 1024 * 1024;
const kindOf = (type: string): "picture" | "video" | "document" => (type.startsWith("image/") ? "picture" : type.startsWith("video/") ? "video" : "document");
/** A WhatsApp id without its device suffix, for comparing the assistant's own number (1234:5@c.us is 1234@c.us). */
const bare = (id: string): string => id.replace(/:\d+(?=@)/, "");

export interface BridgeOptions {
  id: string; server: string; session: string; apiKey: string;
  fetch?: typeof fetch; connect?: WebSocketConnect; reconnectBaseMs?: number;
}

/** The bridge's own HTTP API, for the channel and for the setup's pairing step. */
export class WahaBridge {
  private readonly fetch: typeof fetch;
  constructor(readonly server: string, readonly session: string, private readonly apiKey: string, fetcher?: typeof fetch) {
    this.fetch = fetcher ?? globalThis.fetch;
  }
  async call(method: string, path: string, body?: unknown, accept = "application/json"): Promise<Response> {
    return this.fetch(`${this.server}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(20000),
      headers: { "x-api-key": this.apiKey, accept, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  /** The session's state, or null when the bridge has no session by that name yet. */
  async status(): Promise<z.infer<typeof statusSchema> | null> {
    const response = await this.call("GET", `/api/sessions/${encodeURIComponent(this.session)}`);
    if (response.status === 404) return null;
    if (response.status === 401) throw new Error("The WhatsApp bridge refused the API key.");
    if (!response.ok) throw new Error(`The WhatsApp bridge answered ${response.status}.`);
    return statusSchema.parse(await response.json());
  }
  /** Makes the session (started) when the bridge has none by that name, or starts a stopped one. */
  async ensureStarted(): Promise<string> {
    const now = await this.status();
    if (!now) {
      const made = await this.call("POST", "/api/sessions", { name: this.session, start: true });
      if (!made.ok) throw new Error(`The WhatsApp bridge would not make a session (${made.status}).`);
      return statusSchema.parse(await made.json()).status;
    }
    if (now.status === "STOPPED" || now.status === "FAILED") {
      const started = await this.call("POST", `/api/sessions/${encodeURIComponent(this.session)}/start`, {});
      if (!started.ok) throw new Error(`The WhatsApp bridge would not start the session (${started.status}).`);
      return "STARTING";
    }
    return now.status;
  }
  /**
   * A file the bridge downloaded, fetched only from the bridge itself (same address, with the key), without redirects,
   * and never past `inboundLimit`.
   */
  async file(url: string): Promise<Uint8Array> {
    const target = new URL(url, this.server);
    if (target.origin !== new URL(this.server).origin) throw new Error("That file is not held by the WhatsApp bridge, so it was not fetched");
    const response = await this.fetch(target.href, { headers: { "x-api-key": this.apiKey }, redirect: "error", signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`The WhatsApp bridge would not hand over that file (${response.status})`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > inboundLimit) throw new Error("That file is larger than 20 MB, so it was not used");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > inboundLimit) throw new Error("That file is larger than 20 MB, so it was not used");
    return bytes;
  }
  /** The code WhatsApp's Linked devices screen scans, while the session waits for one. */
  async pairingCode(): Promise<{ value: string | null; image: string | null }> {
    const raw = await this.call("GET", `/api/${encodeURIComponent(this.session)}/auth/qr?format=raw`);
    const value = raw.ok ? z.object({ value: z.string().min(1).max(2000) }).passthrough().safeParse(await raw.json().catch(() => null)) : null;
    if (value?.success) return { value: value.data.value, image: null };
    const png = await this.call("GET", `/api/${encodeURIComponent(this.session)}/auth/qr`);
    const image = png.ok ? z.object({ mimetype: z.literal("image/png"), data: z.string().max(200_000) }).passthrough().safeParse(await png.json().catch(() => null)) : null;
    return { value: null, image: image?.success ? image.data.data : null };
  }
}

export class WhatsAppWebChannel implements ChannelAdapter {
  readonly kind = "whatsapp-web";
  readonly maxTextLength = 4000;
  readonly id: string;
  private readonly bridge: WahaBridge;
  private readonly connect: WebSocketConnect;
  private socket: WebSocketConnection | undefined;
  private loop: Promise<void> | null = null;
  private stopping = false;
  private me: { id: string; name: string | null } | null = null;
  private state: ChannelHealth = { state: "reconnecting", reason: "Connecting to the WhatsApp bridge" };
  constructor(private readonly options: BridgeOptions) {
    this.id = options.id;
    this.bridge = new WahaBridge(options.server, options.session, options.apiKey, options.fetch);
    this.connect = options.connect ?? connectWebSocket;
  }
  botName(): string | null { return this.me?.name ?? this.me?.id.replace(/@.*$/, "") ?? null; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.stopping = false;
    await this.refreshStatus(); // a bridge that is not there, or a key it refuses, is said at once
    this.loop = this.run(onMessage);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.socket?.close();
    await this.loop?.catch(() => undefined);
  }
  private async refreshStatus(): Promise<void> {
    const now = await this.bridge.status();
    if (!now) { this.state = { state: "needs attention", reason: "The WhatsApp bridge has no session yet. Link the number in the setup." }; return; }
    if (now.me) this.me = { id: bare(now.me.id), name: now.me.pushName ?? null };
    this.state = now.status === "WORKING" ? { state: "connected" }
      : now.status === "SCAN_QR_CODE" ? { state: "needs attention", reason: "The number is not linked. Scan the code in the setup with WhatsApp, Linked devices." }
        : { state: "reconnecting", reason: `The WhatsApp bridge says ${now.status.toLowerCase().replace(/_/g, " ")}` };
  }
  private async run(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    for (let attempt = 0; !this.stopping; attempt++) {
      try {
        const address = new URL("/ws", this.options.server.replace(/^http/, "ws"));
        address.searchParams.set("session", this.options.session);
        address.searchParams.set("events", "message");
        address.searchParams.set("x-api-key", this.options.apiKey);
        const socket = await this.connect(address.href, { headers: { "x-api-key": this.options.apiKey },
          onMessage: (text) => { const inbound = this.inbound(text); if (inbound) void onMessage(inbound).catch(() => undefined); } });
        this.socket = socket;
        if (this.stopping) socket.close();
        await this.refreshStatus().catch(() => undefined);
        attempt = 0;
        await socket.closed;
      } catch (error) {
        this.state = { state: "reconnecting", reason: `Lost the WhatsApp bridge: ${error instanceof Error ? error.message.replace(this.options.apiKey, "…") : String(error)}` };
      }
      if (this.stopping) return;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt + 1, this.options.reconnectBaseMs ?? 1000)));
    }
  }
  /** One event from the bridge: a text message from somebody else, not a status update, becomes a message to answer. */
  private inbound(text: string): InboundMessage | null {
    let parsed: z.infer<typeof eventSchema>;
    try { parsed = eventSchema.parse(JSON.parse(text)); } catch { return null; }
    const message = parsed.payload;
    const media = message.hasMedia && message.media?.url ? message.media : null;
    if (parsed.event !== "message" || message.fromMe || (!message.body && !media) || message.from === "status@broadcast" || message.from.endsWith("@broadcast")) return null;
    const body = message.body ?? "";
    const group = message.from.endsWith("@g.us");
    const sender = (group ? message.participant ?? message.author : message.from) ?? message.from;
    const me = this.me?.id;
    const mentioned = !!me && body.includes(`@${me.replace(/@.*$/, "")}`);
    const repliedTo = !!me && !!message.replyTo?.participant && bare(message.replyTo.participant) === me;
    const name = message._data?.notifyName ?? message._data?.pushName ?? sender.replace(/@.*$/, "");
    return {
      channel: this.id, chatId: message.from, chatKind: group ? "group" : "direct", ...(group ? { chatTitle: `group ${message.from.slice(0, 12)}` } : {}),
      senderId: sender, senderName: name, text: body,
      ...(media ? this.mediaOf(media, idOf(message.id) ?? sender) : {}),
      addressed: !group || mentioned || repliedTo, messageId: idOf(message.id) ?? `${Date.now()}`,
    };
  }
  /** A voice note to transcribe, or a picture, video or file as the task's material; fetched only once it is answered. */
  private mediaOf(media: { url?: string | null | undefined; mimetype?: string | null | undefined; filename?: string | null | undefined }, id: string): Partial<InboundMessage> {
    const type = (media.mimetype ?? "application/octet-stream").split(";")[0]!.toLowerCase();
    const bytes = () => this.bridge.file(media.url!);
    if (type.startsWith("audio/")) return { voice: { mediaType: type, seconds: undefined, bytes } };
    return { attachments: [{ name: media.filename ?? `whatsapp-${id.slice(-8)}`, sourceId: id, mediaType: type, kind: kindOf(type), bytes }] };
  }
  /** Sent through the bridge as JSON with the bytes written out, so kept well under WhatsApp's own limits. */
  readonly maxFileBytes = 16 * 1024 * 1024;
  /** A picture as a picture (JPEG or PNG), anything else as a file, with its caption; through the bridge. */
  async sendFile(chatId: string, file: OutgoingFile, replyToMessageId?: string): Promise<string | undefined> {
    if (file.bytes.byteLength > this.maxFileBytes) throw new Error("That file is larger than the 16 MB the WhatsApp bridge takes from Branch");
    const type = file.mediaType.split(";")[0]!.toLowerCase();
    const path = ["image/jpeg", "image/png"].includes(type) ? "/api/sendImage" : "/api/sendFile";
    return this.post(path, { chatId, file: { mimetype: file.mediaType, filename: file.name, data: Buffer.from(file.bytes).toString("base64") },
      ...(file.caption ? { caption: file.caption.slice(0, 1024) } : {}) }, replyToMessageId);
  }
  /** A spoken reply as a voice note; the bridge turns it into WhatsApp's own voice format (`convert`). */
  async sendVoice(chatId: string, audio: Uint8Array, mediaType: string, replyToMessageId?: string): Promise<string | undefined> {
    if (audio.byteLength > this.maxFileBytes) throw new Error("That spoken reply is larger than the 16 MB the WhatsApp bridge takes from Branch");
    return this.post("/api/sendVoice", { chatId, file: { mimetype: mediaType, data: Buffer.from(audio).toString("base64") }, convert: true }, replyToMessageId);
  }
  private async post(path: string, body: Record<string, unknown>, replyToMessageId?: string): Promise<string | undefined> {
    const response = await this.bridge.call("POST", path, { session: this.options.session, ...body,
      ...(replyToMessageId && replyToMessageId.includes("@") ? { reply_to: replyToMessageId } : {}) });
    if (!response.ok) throw new Error(`The WhatsApp bridge refused the file (${response.status})`);
    const sent = await response.json().catch(() => null) as { id?: unknown } | null;
    return idOf(sent?.id);
  }
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    const response = await this.bridge.call("POST", "/api/sendText", { session: this.options.session, chatId, text: text.slice(0, this.maxTextLength),
      ...(replyToMessageId && replyToMessageId.includes("@") ? { reply_to: replyToMessageId } : {}) });
    if (!response.ok) throw new Error(`The WhatsApp bridge refused the message (${response.status})`);
    const sent = await response.json().catch(() => null) as { id?: unknown } | null;
    return idOf(sent?.id);
  }
}

export const whatsappWebService = defineService({
  kind: "whatsapp-web", name: "WhatsApp (personal number)", docs: wahaDocs,
  needs: ["WAHA, a WhatsApp Web bridge you install and run yourself with Docker on this computer",
    "Its API key (WAHA_API_KEY), and a number you are willing to risk: WhatsApp's terms do not allow unofficial clients"],
  receives: "socket",
  settings: z.object({
    server: z.string().max(200).transform((value, context) => {
      try { return bridgeAddress(value); } catch (error) { context.addIssue({ code: "custom", message: (error as Error).message }); return z.NEVER; }
    }),
    session: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).default("default"),
    apiKeySecret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).default("WAHA_API_KEY"),
  }).strict(),
  async build(settings, deps: ParityDeps) {
    // The bridge is a program on this computer: its loopback address alone is reached without the network settings.
    return new WhatsAppWebChannel({ id: deps.id, server: settings.server, session: settings.session, apiKey: await deps.secret(settings.apiKeySecret) });
  },
});
