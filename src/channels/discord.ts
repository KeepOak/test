import { z } from "zod";
import { fenced } from "./progress-render.js";
import type { MessageFormat } from "./router.js";
import type { ChannelAdapter, ChannelHealth, InboundMessage, OutgoingFile } from "./router.js"; // R17-C: OutgoingFile
import { connectWebSocket, reconnectDelay, type WebSocketConnect, type WebSocketConnection } from "./ws-client.js";

/**
 * Discord adapter. Messages arrive over Discord's gateway socket and replies go out over its REST
 * API. The socket is kept alive with heartbeats, resumed after a drop where Discord allows it, and
 * reopened with a widening wait when it does not. Direct messages always count as addressed; in a
 * server channel the assistant answers when it is mentioned or when someone replies to it.
 */
export interface DiscordOptions {
  id: string;
  token: string;
  apiBase?: string;
  /** Set in tests to skip asking Discord where its gateway is. */
  gatewayUrl?: string;
  fetch?: typeof fetch;
  connect?: WebSocketConnect;
  reconnectBaseMs?: number;
  /** Overrides the interval Discord asks for, so a test does not wait forty seconds. */
  heartbeatMs?: number;
}
/** GUILDS, GUILD_MESSAGES, DIRECT_MESSAGES and MESSAGE_CONTENT: what reading a message needs. */
const intents = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const userSchema = z.object({ id: z.string(), username: z.string().optional(), bot: z.boolean().optional() }).passthrough();
const createSchema = z.object({
  id: z.string(), channel_id: z.string(), guild_id: z.string().optional(), content: z.string().default(""),
  author: userSchema, mentions: z.array(userSchema).default([]),
  referenced_message: z.object({ author: userSchema.optional() }).passthrough().nullish(),
  attachments: z.array(z.object({
    url: z.string().min(1).max(2000), content_type: z.string().max(100).optional(),
    size: z.number().nonnegative().optional(), duration_secs: z.number().nonnegative().optional(),
  }).passthrough()).default([]),
}).passthrough();
const payloadSchema = z.object({ op: z.number(), d: z.unknown().optional(), s: z.number().nullish(), t: z.string().nullish() }).passthrough();
const readySchema = z.object({ user: userSchema, session_id: z.string(), resume_gateway_url: z.string().optional(),
  application: z.object({ id: z.string() }).passthrough().optional() }).passthrough();
/** A slash command chosen from Discord's picker (interaction type 2, APPLICATION_COMMAND). */
const slashSchema = z.object({ id: z.string().min(1).max(64), token: z.string().min(1).max(300), type: z.literal(2),
  channel_id: z.string().min(1).max(64), guild_id: z.string().optional(), context: z.number().optional(),
  user: userSchema.optional(), member: z.object({ user: userSchema }).passthrough().optional(),
  data: z.object({ name: z.string().regex(/^[a-z0-9_-]{1,32}$/), options: z.array(z.object({ name: z.string(), value: z.unknown() }).passthrough()).optional() }).passthrough(),
}).passthrough();
const interactionSchema = z.object({ id: z.string().min(1).max(64), token: z.string().min(1).max(300), type: z.literal(3),
  channel_id: z.string().min(1).max(64), guild_id: z.string().optional(), context: z.number().optional(),
  user: userSchema.optional(), member: z.object({ user: userSchema }).passthrough().optional(),
  data: z.object({ custom_id: z.string().regex(/^[yan]:[a-f0-9]{32}(?::[a-f0-9]{12})?$/), component_type: z.literal(2) }).passthrough(),
}).passthrough();

export class DiscordAdapter implements ChannelAdapter {
  readonly kind = "discord";
  readonly id: string;
  /** Discord refuses a message longer than two thousand characters. */
  private textMode: () => "native" | "plain" = () => "native";
  get maxTextLength(): number { return this.textMode() === "plain" ? 1000 : 2000; }
  configureFormatting(mode: () => "native" | "plain"): void { this.textMode = mode; }
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly connect: WebSocketConnect;
  private socket: WebSocketConnection | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private state: ChannelHealth = { state: "reconnecting", reason: "Connecting to Discord" };
  private user: { id: string; name: string } | null = null;
  private session: { id: string; url: string } | null = null;
  private sequence: number | null = null;
  private stopping = false;
  private loop: Promise<void> | null = null;
  /** Empty until a rate-limit header tells us to hold off; the next send waits for it. */
  private readyAt = 0;
  private readonly pressed = new Set<string>();
  constructor(private readonly options: DiscordOptions) {
    this.id = options.id;
    this.base = (options.apiBase ?? "https://discord.com/api/v10").replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.connect = options.connect ?? connectWebSocket;
  }
  botName(): string | null { return this.user?.name ?? null; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.loop = this.run(onMessage);
    // Give the first connection a moment so a wrong token is reported while the owner is watching.
    await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 50))]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.socket?.close();
    await this.loop?.catch(() => undefined);
  }
  /** Reconnects for as long as the channel is attached, resuming where Discord lets us. */
  private async run(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    for (let attempt = 0; !this.stopping; attempt++) {
      try {
        await this.live(onMessage);
        attempt = 0;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.state = reason.includes("token")
          ? { state: "needs attention", reason: "Discord would not accept the bot token. Check the token saved in the locker." }
          : { state: "reconnecting", reason: `Lost the Discord connection: ${reason}` };
      }
      if (this.stopping) return;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt + 1, this.options.reconnectBaseMs ?? 1000)));
    }
  }
  /** One socket, from handshake to close. Returns when the socket ends. */
  private async live(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    const address = this.session?.url ?? this.options.gatewayUrl ?? (await this.gateway());
    const socket = await this.connect(`${address}${address.includes("?") ? "&" : "?"}v=10&encoding=json`, {
      onMessage: (text) => void this.receive(text, onMessage).catch(() => undefined),
    });
    this.socket = socket;
    // mac7/linux-fixes: a stop that arrived while this was still being opened found nothing to
    // close, and the loop then waited for a close nobody would ask for. Let it go straight away.
    if (this.stopping) socket.close();
    await socket.closed;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (!this.stopping) this.state = { state: "reconnecting", reason: "Discord closed the connection; reconnecting" };
  }
  private async gateway(): Promise<string> {
    const response = await this.fetch(`${this.base}/gateway/bot`, { headers: this.headers(), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(response.status === 401 ? "Discord refused the bot token" : `Discord could not be reached (${response.status})`);
    return z.object({ url: z.string() }).passthrough().parse(await response.json()).url;
  }
  /** Handles one gateway payload: the handshake ones itself, a new message through the router. */
  private async receive(text: string, onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    const payload = payloadSchema.parse(JSON.parse(text));
    if (typeof payload.s === "number") this.sequence = payload.s;
    if (payload.op === 10) return this.hello(payload.d);
    if (payload.op === 1) return this.beat();
    if (payload.op === 7) { this.socket?.close(); return; }
    if (payload.op === 9) { this.session = null; this.socket?.close(); return; }
    if (payload.op !== 0) return;
    if (payload.t === "READY") return this.ready(payload.d);
    if (payload.t === "INTERACTION_CREATE")
      return (payload.d as { type?: unknown } | undefined)?.type === 2 ? this.slash(payload.d, onMessage) : this.button(payload.d, onMessage);
    if (payload.t !== "MESSAGE_CREATE") return;
    const inbound = this.inbound(createSchema.parse(payload.d));
    if (inbound) await onMessage(inbound).catch(() => undefined);
  }
  /** Gateway-authenticated component events retain Discord's actual sender and DM context. */
  private async button(data: unknown, onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    const parsed = interactionSchema.safeParse(data);
    if (!parsed.success) return;
    const input = parsed.data, user = input.user ?? input.member?.user;
    if (!user || user.bot || this.pressed.has(input.id)) return;
    if (this.pressed.size >= 500) this.pressed.delete(this.pressed.values().next().value!);
    this.pressed.add(input.id);
    const ack = await this.fetch(`${this.base}/interactions/${encodeURIComponent(input.id)}/${encodeURIComponent(input.token)}/callback`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: 6 }), signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    if (!ack?.ok) return;
    await onMessage({ channel: this.id, chatId: input.channel_id, chatKind: input.context === 1 && !input.guild_id ? "direct" : "group",
      senderId: user.id, senderName: user.username ?? user.id, text: input.data.custom_id, addressed: true,
      messageId: `interaction:${input.id}` }).catch(() => undefined);
  }
  /**
   * CHAT-161: a command chosen from Discord's own picker. Discord is told at once (only the person sees "Running /x"), and
   * the command then goes to the router as the words `/name what followed`, from the person who chose it, where every
   * rule for a typed command applies: pairing, the allowlist, the chat commands switch and each command's own level.
   */
  private async slash(data: unknown, onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    const parsed = slashSchema.safeParse(data);
    if (!parsed.success) return;
    const input = parsed.data, user = input.user ?? input.member?.user;
    if (!user || user.bot || this.pressed.has(input.id)) return;
    if (this.pressed.size >= 500) this.pressed.delete(this.pressed.values().next().value!);
    this.pressed.add(input.id);
    const words = input.data.options?.find((option) => option.name === "text")?.value;
    const line = `/${input.data.name}${typeof words === "string" && words.trim() ? ` ${words.trim().slice(0, 4000)}` : ""}`;
    const ack = await this.fetch(`${this.base}/interactions/${encodeURIComponent(input.id)}/${encodeURIComponent(input.token)}/callback`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: 4, data: { content: `Running ${line.slice(0, 200)}`, flags: 64, allowed_mentions: { parse: [] } } }), signal: AbortSignal.timeout(2500),
    }).catch(() => null);
    if (!ack?.ok) return;
    await onMessage({ channel: this.id, chatId: input.channel_id, chatKind: input.context === 1 && !input.guild_id ? "direct" : "group",
      senderId: user.id, senderName: user.username ?? user.id, text: line, addressed: true, messageId: `interaction:${input.id}` }).catch(() => undefined);
  }
  /** The application this bot belongs to (from READY), whose commands Discord lists in its picker. */
  private application: string | null = null;
  /** The last command list asked for, registered once the application is known. */
  private menu: { command: string; description: string }[] | null = null;
  /**
   * CHAT-161: Branch's commands in Discord's own "/" picker, as global application commands (one bulk overwrite, so a
   * command taken out of the list is taken out of Discord too). Each takes what follows it as one optional text option.
   */
  async setCommands(commands: { command: string; description: string }[]): Promise<void> {
    this.menu = commands;
    if (!this.application) return; // registered on READY
    const body = commands.slice(0, 100).map((one) => ({ name: one.command, type: 1, description: one.description.slice(0, 100) || one.command,
      options: [{ type: 3, name: "text", description: "What follows the command", required: false, max_length: 4000 }] }));
    const response = await this.fetch(`${this.base}/applications/${encodeURIComponent(this.application)}/commands`, {
      method: "PUT", headers: { ...this.headers(), "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    this.noteLimits(response);
    if (!response.ok) throw new Error(`Discord refused the command list (${response.status})`);
  }
  private hello(data: unknown): void {
    const interval = this.options.heartbeatMs ?? z.object({ heartbeat_interval: z.number() }).passthrough().parse(data).heartbeat_interval;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => this.beat(), Math.max(20, interval));
    this.heartbeat.unref();
    this.socket?.send(JSON.stringify(this.session
      ? { op: 6, d: { token: this.options.token, session_id: this.session.id, seq: this.sequence } }
      : { op: 2, d: { token: this.options.token, intents, properties: { os: process.platform, browser: "Branch Agent", device: "Branch Agent" } } }));
  }
  private beat(): void { this.socket?.send(JSON.stringify({ op: 1, d: this.sequence })); }
  private ready(data: unknown): void {
    const parsed = readySchema.parse(data);
    this.user = { id: parsed.user.id, name: parsed.user.username ?? parsed.user.id };
    if (parsed.application?.id && parsed.application.id !== this.application) {
      this.application = parsed.application.id;
      if (this.menu) void this.setCommands(this.menu).catch(() => undefined);
    }
    this.session = { id: parsed.session_id, url: parsed.resume_gateway_url ?? this.options.gatewayUrl ?? "" };
    if (!this.session.url) this.session = null;
    this.state = { state: "connected" };
  }
  private inbound(message: z.infer<typeof createSchema>): InboundMessage | null {
    const spoken = message.attachments.find((file) => (file.content_type ?? "").startsWith("audio/"));
    if ((!message.content && !spoken) || message.author.bot || message.author.id === this.user?.id) return null;
    const direct = !message.guild_id;
    const mentioned = message.mentions.some((mention) => mention.id === this.user?.id);
    const repliedTo = message.referenced_message?.author?.id === this.user?.id;
    const text = this.user ? message.content.replace(new RegExp(`<@!?${this.user.id}>`, "g"), "").trim() : message.content;
    return {
      channel: this.id, chatId: message.channel_id, chatKind: direct ? "direct" : "group",
      ...(message.guild_id ? { chatTitle: `channel ${message.channel_id}` } : {}),
      senderId: message.author.id, senderName: message.author.username ?? message.author.id,
      text: text || message.content, addressed: direct || mentioned || repliedTo, messageId: message.id,
      ...(spoken ? { voice: {
        mediaType: spoken.content_type ?? "audio/ogg",
        seconds: spoken.duration_secs,
        bytes: () => this.downloadAudio(spoken.url, spoken.size ?? 0),
      } } : {}),
    };
  }
  /** Fetches a voice message's bytes from the address Discord gave, and only when it is answered. */
  private async downloadAudio(url: string, declaredSize: number): Promise<Uint8Array> {
    const limit = 20 * 1024 * 1024;
    if (declaredSize > limit) throw new Error("That voice message is larger than 20 MB, so it was not downloaded");
    const target = new URL(url);
    if (target.protocol !== "https:" || !/(^|\.)discordapp\.(com|net)$/i.test(target.hostname))
      throw new Error("That attachment is not hosted by Discord, so it was not downloaded");
    const response = await this.fetch(target.href, { redirect: "error", signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Discord would not hand over that voice message (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error("That voice message is larger than 20 MB, so it was not used");
    return bytes;
  }
  /** Sends one reply, waiting out any rate limit Discord has told us about. */
  /** Code spans as Markdown fences with their language, unless the fences would push the words past Discord's limit. */
  private content(text: string, format?: MessageFormat): string {
    if (format?.plain) return text.replace(/[\\`*_~|>]/g, "\\$&").slice(0, 2000);
    const marked = format?.spans?.length ? fenced(text, format.spans, { tag: true }) : text;
    return (marked.length <= this.maxTextLength ? marked : text).slice(0, this.maxTextLength);
  }
  async send(chatId: string, text: string, replyToMessageId?: string, format?: MessageFormat): Promise<string | undefined> {
    const wait = this.readyAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 10000)));
    // flags 4096: SUPPRESS_NOTIFICATIONS, for a progress message; the reply after it is the one that notifies.
    const body = JSON.stringify({ content: this.content(text, format), ...(format?.quiet ? { flags: 4096 } : {}),
      ...(replyToMessageId ? { message_reference: { message_id: replyToMessageId, fail_if_not_exists: false } } : {}) });
    const response = await this.fetch(`${this.base}/channels/${encodeURIComponent(chatId)}/messages`, {
      method: "POST", headers: { ...this.headers(), "content-type": "application/json" }, body, signal: AbortSignal.timeout(20000),
    });
    this.noteLimits(response);
    if (response.status === 429) throw new Error("Discord asked us to slow down; the message will be tried again");
    if (!response.ok) throw new Error(`Discord refused the message (${response.status})`);
    const parsed = z.object({ id: z.string() }).passthrough().safeParse(await response.json().catch(() => ({})));
    return parsed.success ? parsed.data.id : undefined;
  }
  /**
   * A question with buttons. Discord calls them message components: one action row (type 1) of
   * buttons (type 2), each carrying a `custom_id` that comes back when it is pressed. "No" is
   * styled as the danger button (4) and the yeses as the ordinary one (1), so the refusal reads as
   * the refusal at a glance.
   */
  static components(buttons: { label: string; value: string }[]): unknown[] {
    return [{
      type: 1,
      components: buttons.slice(0, 5).map((button) => ({
        type: 2,
        style: button.value.startsWith("n") ? 4 : 1,
        label: button.label.slice(0, 80),
        custom_id: button.value.slice(0, 100),
      })),
    }];
  }
  async sendButtons(chatId: string, text: string, buttons: { label: string; value: string }[], replyToMessageId?: string, format?: MessageFormat): Promise<string | undefined> {
    const wait = this.readyAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 10000)));
    const body = JSON.stringify({
      content: this.content(text, format),
      components: DiscordAdapter.components(buttons),
      ...(replyToMessageId ? { message_reference: { message_id: replyToMessageId, fail_if_not_exists: false } } : {}),
    });
    const response = await this.fetch(`${this.base}/channels/${encodeURIComponent(chatId)}/messages`, {
      method: "POST", headers: { ...this.headers(), "content-type": "application/json" }, body, signal: AbortSignal.timeout(20000),
    });
    this.noteLimits(response);
    if (!response.ok) throw new Error(`Discord refused the question (${response.status})`);
    const parsed = z.object({ id: z.string() }).passthrough().safeParse(await response.json().catch(() => ({})));
    return parsed.success ? parsed.data.id : undefined;
  }
  // ---- R17-C (R17-022): a file as a Discord attachment: a multipart message with payload_json and
  // files[0]. Discord takes 10 MiB from a bot in an ordinary server.
  readonly maxFileBytes = 10 * 1024 * 1024;
  async sendFile(chatId: string, file: OutgoingFile, replyToMessageId?: string): Promise<string | undefined> {
    const wait = this.readyAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 10000)));
    const form = new FormData();
    form.append("payload_json", JSON.stringify({
      ...(file.caption ? { content: file.caption.slice(0, this.maxTextLength) } : {}),
      attachments: [{ id: 0, filename: file.name }],
      ...(replyToMessageId ? { message_reference: { message_id: replyToMessageId, fail_if_not_exists: false } } : {}),
    }));
    form.append("files[0]", new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }), file.name);
    const response = await this.fetch(`${this.base}/channels/${encodeURIComponent(chatId)}/messages`, {
      method: "POST", headers: this.headers(), body: form, signal: AbortSignal.timeout(120000),
    });
    this.noteLimits(response);
    if (response.status === 413) throw new Error("Discord said the file is too large for that chat");
    if (!response.ok) throw new Error(`Discord refused the file (${response.status})`);
    const parsed = z.object({ id: z.string() }).passthrough().safeParse(await response.json().catch(() => ({})));
    return parsed.success ? parsed.data.id : undefined;
  }
  // ---- end R17-C ----
  /** "typing…" for about ten seconds; the router asks again while the task works. */
  async sendTyping(chatId: string): Promise<void> {
    await this.rest("POST", `/channels/${encodeURIComponent(chatId)}/typing`);
  }
  /** Discord keeps every reaction side by side, so the previous one is taken off first. */
  async react(chatId: string, messageId: string, emoji: string, previous?: string): Promise<void> {
    const message = `/channels/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}/reactions`;
    if (previous && previous !== emoji) await this.rest("DELETE", `${message}/${encodeURIComponent(previous)}/@me`).catch(() => undefined);
    await this.rest("PUT", `${message}/${encodeURIComponent(emoji)}/@me`);
  }
  async edit(chatId: string, messageId: string, text: string, format?: MessageFormat): Promise<void> {
    await this.rest("PATCH", `/channels/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`,
      { content: this.content(text, format) });
  }
  /** One small call for the live status; a rate limit is noted and reported as a failure. */
  private async rest(method: string, path: string, body?: unknown): Promise<void> {
    // Discord's own wait, carried on the error so the live status waits it out rather than counting it as a failure.
    if (this.readyAt > Date.now()) throw Object.assign(new Error("Discord asked us to slow down"), { retryAfter: (this.readyAt - Date.now()) / 1000 });
    const response = await this.fetch(`${this.base}${path}`, {
      method, signal: AbortSignal.timeout(20000),
      headers: { ...this.headers(), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    this.noteLimits(response);
    if (response.status === 429) throw Object.assign(new Error("Discord asked us to slow down"), { retryAfter: Math.max(0.5, (this.readyAt - Date.now()) / 1000) });
    if (!response.ok) throw new Error(`Discord refused ${method} ${path.split("/")[1] ?? ""} (${response.status})`);
  }
  /** Records how long Discord wants us to wait before the next call on this route. */
  private noteLimits(response: { status: number; headers: Headers }): void {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const resetAfter = Number(response.headers.get("x-ratelimit-reset-after") ?? "0");
    const retryAfter = Number(response.headers.get("retry-after") ?? "0");
    const seconds = response.status === 429 ? Math.max(retryAfter, resetAfter) : remaining === "0" ? resetAfter : 0;
    if (seconds > 0) this.readyAt = Date.now() + Math.min(seconds, 60) * 1000;
  }
  private headers(): Record<string, string> {
    return { authorization: `Bot ${this.options.token}`, "user-agent": "DiscordBot (https://github.com/branch-agent, 1.0)" };
  }
}
