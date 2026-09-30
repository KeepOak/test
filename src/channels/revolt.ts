import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { connectWebSocket, reconnectDelay, type WebSocketConnect, type WebSocketConnection } from "./ws-client.js";
import { callJson, defineService, secretName } from "./parity-common.js";

/**
 * Revolt (now also known as Stoat), through its official bot API: messages arrive over the events
 * socket and replies go out over the REST API. Written from https://developers.revolt.chat.
 *
 * The socket is signed in with an Authenticate frame (so the token never sits in an address) and
 * kept alive with a Ping every twenty seconds. A direct-message channel is always answered; in a
 * server channel or a group the assistant answers when it is mentioned.
 */
export interface RevoltOptions {
  id: string;
  token: string;
  /** Where the REST API lives. Self-hosted instances have their own. */
  apiBase?: string;
  /** Where the events socket lives. */
  wsBase?: string;
  fetch?: typeof fetch;
  connect?: WebSocketConnect;
  /** The secret's name, for the health line. */
  tokenName?: string;
  pingMs?: number;
  retryBaseMs?: number;
}

const eventSchema = z.object({ type: z.string() }).passthrough();
const messageSchema = z.object({
  _id: z.string().min(1).max(60), channel: z.string().min(1).max(60), author: z.string().min(1).max(60),
  content: z.string().max(20000).nullish(), mentions: z.array(z.string()).nullish(), system: z.unknown().optional(),
}).passthrough();
const readySchema = z.object({
  channels: z.array(z.object({ _id: z.string(), channel_type: z.string() }).passthrough()).default([]),
}).passthrough();
const meSchema = z.object({ _id: z.string().min(1), username: z.string().optional() }).passthrough();
const channelSchema = z.object({ channel_type: z.string() }).passthrough();

export class RevoltChannel implements ChannelAdapter {
  readonly kind = "revolt";
  /** A reply to a message only quotes it here, so Settings › Chat apps › Replies in each app decides (reply-style.ts). */
  readonly replyQuotes = true;
  readonly id: string;
  /** Revolt refuses a message longer than two thousand characters. */
  readonly maxTextLength = 2000;
  private readonly api: string;
  private readonly fetch: typeof fetch;
  private socket: WebSocketConnection | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private state: ChannelHealth = { state: "reconnecting", reason: "Connecting to Revolt" };
  private me: { id: string; name: string } | null = null;
  private refused = false;
  private stopping = false;
  private loop: Promise<void> | null = null;
  /** Channel id → its kind, so a message does not cost a lookup every time. */
  private readonly kinds = new Map<string, string>();
  constructor(private readonly options: RevoltOptions) {
    this.id = options.id;
    this.api = (options.apiBase ?? "https://api.revolt.chat").replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  botName(): string | null { return this.me?.name ?? null; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.stopping = false;
    this.loop = this.run(onMessage);
    await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 50))]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.socket?.close();
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }
  private async run(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    for (let attempt = 0; !this.stopping; attempt++) {
      try {
        await this.live(onMessage);
        if (this.state.state === "connected") attempt = 0;
        if (!this.stopping && !this.refused) this.state = { state: "reconnecting", reason: "Revolt closed the connection; reconnecting" };
      } catch (error) {
        const said = error instanceof Error ? error.message : String(error);
        this.state = this.refused || /\(401\)/.test(said)
          ? { state: "needs attention", reason: this.tokenRefused() }
          : { state: "reconnecting", reason: `Could not reach Revolt: ${said}` };
      }
      if (this.timer) clearInterval(this.timer);
      this.socket = null;
      if (this.stopping) return;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt + 1, this.options.retryBaseMs ?? 1000)));
    }
  }
  /** One socket, from signing in to close. */
  private async live(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.refused = false;
    const me = meSchema.parse(await callJson(this.fetch, "Revolt", `${this.api}/users/@me`, { headers: this.headers() }));
    this.me = { id: me._id, name: me.username ?? me._id };
    const base = this.options.wsBase ?? "wss://ws.revolt.chat";
    const socket = await (this.options.connect ?? connectWebSocket)(`${base}${base.includes("?") ? "&" : "?"}version=1&format=json`, {
      onMessage: (text) => this.receive(text, onMessage),
    });
    this.socket = socket;
    // mac7/linux-fixes: a stop that arrived while this was still being opened found nothing to
    // close, and the loop then waited for a close nobody would ask for. Let it go straight away.
    if (this.stopping) socket.close();
    socket.send(JSON.stringify({ type: "Authenticate", token: this.options.token }));
    this.timer = setInterval(() => socket.send(JSON.stringify({ type: "Ping", data: Date.now() })), this.options.pingMs ?? 20000);
    this.timer.unref();
    await socket.closed;
    if (this.refused) throw new Error("Revolt refused the bot token");
  }
  private receive(text: string, onMessage: (message: InboundMessage) => Promise<void>): void {
    const event = eventSchema.parse(JSON.parse(text));
    if (event.type === "Error") {
      if (/InvalidSession|NotAuthenticated/.test(String(event.error))) { this.refused = true; this.socket?.close(); }
      return;
    }
    if (event.type === "Ready") {
      for (const channel of readySchema.parse(event).channels) this.remember(channel._id, channel.channel_type);
      this.state = { state: "connected" };
      return;
    }
    if (event.type !== "Message") return;
    const parsed = messageSchema.safeParse(event);
    if (!parsed.success) return;
    void this.inbound(parsed.data).then((message) => (message ? onMessage(message) : undefined)).catch(() => undefined);
  }
  private async inbound(message: z.infer<typeof messageSchema>): Promise<InboundMessage | null> {
    const me = this.me;
    if (!me || message.author === me.id || message.system || !message.content?.trim()) return null;
    const direct = (await this.channelKind(message.channel)) === "DirectMessage";
    const tag = `<@${me.id}>`;
    const mentioned = (message.mentions ?? []).includes(me.id) || message.content.includes(tag);
    const text = message.content.split(tag).join("").trim();
    return {
      channel: this.id, chatId: message.channel, chatKind: direct ? "direct" : "group",
      ...(direct ? {} : { chatTitle: `Revolt channel ${message.channel}` }),
      senderId: message.author, senderName: message.author,
      text: text || message.content, addressed: direct || mentioned, messageId: message._id,
    };
  }
  /** Asks Revolt what kind of channel this is, once per channel. */
  private async channelKind(channelId: string): Promise<string> {
    const known = this.kinds.get(channelId);
    if (known) return known;
    const answer = channelSchema.parse(await callJson(this.fetch, "Revolt", `${this.api}/channels/${encodeURIComponent(channelId)}`, { headers: this.headers() }));
    this.remember(channelId, answer.channel_type);
    return answer.channel_type;
  }
  private remember(channelId: string, kind: string): void {
    this.kinds.set(channelId, kind);
    if (this.kinds.size > 1000) this.kinds.delete(this.kinds.keys().next().value!);
  }
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    const json = { content: text.slice(0, this.maxTextLength),
      ...(replyToMessageId ? { replies: [{ id: replyToMessageId, mention: false }] } : {}) };
    const answer = await callJson(this.fetch, "Revolt", `${this.api}/channels/${encodeURIComponent(chatId)}/messages`,
      { method: "POST", json, headers: this.headers() });
    const parsed = z.object({ _id: z.string() }).passthrough().safeParse(answer);
    return parsed.success ? parsed.data._id : undefined;
  }
  private headers(): Record<string, string> { return { "x-bot-token": this.options.token }; }
  private tokenRefused(): string {
    return `Revolt refused the bot token. Save a new one as ${this.options.tokenName ?? "REVOLT_BOT_TOKEN"}`;
  }
}

export const revoltService = defineService({
  kind: "revolt", name: "Revolt", docs: "https://developers.revolt.chat/developers/api/reference.html",
  needs: ["A bot made in Revolt's settings, under My Bots, added to your server",
    "The bot's token, saved as a secret"],
  receives: "socket",
  settings: z.object({
    tokenSecret: z.string().regex(secretName).default("REVOLT_BOT_TOKEN"),
    apiBase: z.string().url().regex(/^https?:\/\//).default("https://api.revolt.chat"),
    socketBase: z.string().url().regex(/^wss?:\/\//).default("wss://ws.revolt.chat"),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.apiBase), "Revolt API");
    await deps.assertAllowed(new URL(settings.socketBase.replace(/^ws/, "http")), "Revolt events socket");
    return new RevoltChannel({
      id: deps.id, token: await deps.secret(settings.tokenSecret), tokenName: settings.tokenSecret, apiBase: settings.apiBase,
      wsBase: settings.socketBase, fetch: deps.fetch, connect: deps.connectWs,
    });
  },
});
