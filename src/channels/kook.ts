import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";
import { connectWebSocket, reconnectDelay, type WebSocketConnect, type WebSocketConnection } from "./ws-client.js";
import { callJson, defineService, secretName } from "./parity-common.js";
import { CatchUpWindow, MarkKeeper, type ChannelMark } from "./catch-up.js";

/**
 * mac6/bucket-16: KOOK (formerly Kaiheila), through its official bot API v3
 * (https://developer.kookapp.cn/doc/websocket). The bot token is sent as `Authorization: Bot …`;
 * KOOK hands back a gateway address, which is followed only when it is on KOOK's own servers and is
 * never written into an error, because it carries a key.
 *
 * Signals on the socket: 1 hello (with the session id), 0 an event with its sequence number `sn`,
 * 2/3 ping and pong every thirty seconds, 5 "start again", 6 "resumed". After a drop, and after a
 * restart when the session is still young, the socket is reopened with `resume=1`, the session id
 * and the last `sn`, and KOOK sends what was missed. Channel messages are answered when the bot is
 * mentioned; direct messages always are. Replies are sent as plain text (type 1), never KMarkdown,
 * so nothing a model writes can turn into a mention of everybody.
 */
export interface KookOptions {
  id: string;
  token: string;
  tokenName?: string;
  apiBase?: string;
  fetch?: typeof fetch;
  connect?: WebSocketConnect;
  heartbeatMs?: number;
  pongWaitMs?: number;
  retryBaseMs?: number;
}

const officialApi = "https://www.kookapp.cn/api/v3";
const kookHost = /(^|\.)(kookapp\.cn|kaiheila\.cn)$/;
const signalSchema = z.object({ s: z.number(), d: z.unknown().optional(), sn: z.number().optional() }).passthrough();
const answerSchema = z.object({ code: z.number(), message: z.string().optional(), data: z.unknown().optional() }).passthrough();
const eventSchema = z.object({
  channel_type: z.string(), type: z.number(), target_id: z.string().min(1).max(40),
  author_id: z.string().min(1).max(40), content: z.string().max(20000).default(""), msg_id: z.string().min(1).max(80),
  extra: z.object({
    mention: z.array(z.union([z.string(), z.number()])).nullish(),
    author: z.object({ username: z.string().optional(), nickname: z.string().optional(), bot: z.boolean().optional() }).passthrough().nullish(),
  }).passthrough().nullish(),
}).passthrough();
type KookEvent = z.infer<typeof eventSchema>;

export class KookChannel implements ChannelAdapter {
  readonly kind = "kook";
  /** A reply to a message only quotes it here, so Settings › Chat apps › Replies in each app decides (reply-style.ts). */
  readonly replyQuotes = true;
  readonly id: string;
  readonly maxTextLength = 4000;
  /** Where the stream was read up to (`session:sn`), kept across restarts. */
  catchUp: ChannelMark | null = null;
  private readonly api: string;
  private readonly fetch: typeof fetch;
  private socket: WebSocketConnection | null = null;
  private state: ChannelHealth = { state: "reconnecting", reason: "Connecting to KOOK" };
  private me: { id: string; name: string } | null = null;
  private session: string | null = null;
  private sn = 0;
  private refused = false;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private keeper = new MarkKeeper(null);
  /** mac6/bucket-16 integration: what KOOK replays after a restart is capped. */
  private replay: CatchUpWindow | null = null;
  constructor(private readonly options: KookOptions) {
    this.id = options.id;
    this.api = (options.apiBase ?? officialApi).replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  botName(): string | null { return this.me?.name ?? null; }
  health(): ChannelHealth {
    if (this.refused) return { state: "needs attention", reason: `KOOK refused the bot token. Save a new one as ${this.options.tokenName ?? "KOOK_BOT_TOKEN"}` };
    return this.state;
  }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.stopping = false;
    this.keeper = new MarkKeeper(this.catchUp);
    this.restore(this.keeper.load());
    this.replay = this.session ? new CatchUpWindow() : null;
    this.loop = this.run(onMessage);
    await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 50))]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.stopHeartbeat();
    this.socket?.close();
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }
  private restore(mark: string | null): void {
    const match = /^([\w-]{1,80}):(\d{1,15})$/.exec(mark ?? "");
    if (!match) return;
    this.session = match[1]!;
    this.sn = Number(match[2]);
  }
  private async run(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    for (let attempt = 0; !this.stopping; attempt++) {
      try {
        if (!this.me) await this.whoAmI();
        const socket = await (this.options.connect ?? connectWebSocket)(await this.gateway(), {
          onMessage: (text) => this.receive(text, onMessage),
        });
        this.socket = socket;
        // mac7/linux-fixes: a stop that arrived while this was still being opened found nothing to
        // close, and the loop then waited for a close nobody would ask for. Let it go straight away.
        if (this.stopping) socket.close();
        this.replay?.open();
        await socket.closed;
        this.replay = null;
        if (this.state.state === "connected") attempt = 0;
        if (!this.stopping && !this.refused) this.state = { state: "reconnecting", reason: "KOOK closed the connection; reconnecting" };
      } catch (error) {
        this.state = { state: "reconnecting", reason: `Could not reach KOOK: ${error instanceof Error ? error.message : String(error)}` };
      }
      this.stopHeartbeat();
      this.socket = null;
      if (this.stopping) return;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt + 1, this.options.retryBaseMs ?? 1000)));
    }
  }
  /** One API call. KOOK answers `{ code, data }`; any code but 0 is a refusal. */
  private async call(path: string, init: Parameters<typeof callJson>[3] = {}): Promise<unknown> {
    const answer = await callJson(this.fetch, "KOOK", `${this.api}${path}`, {
      ...init, headers: { authorization: `Bot ${this.options.token}` },
    }).catch((error: unknown) => { if (/\((401|403)\)/.test(String(error))) this.refused = true; throw error; });
    const parsed = answerSchema.parse(answer);
    if (parsed.code === 401 || parsed.code === 403) this.refused = true;
    if (parsed.code !== 0) throw new Error(`KOOK refused the request (${parsed.code})`);
    this.refused = false;
    return parsed.data;
  }
  private async whoAmI(): Promise<void> {
    const me = z.object({ id: z.string().min(1), username: z.string().optional() }).passthrough().parse(await this.call("/user/me"));
    this.me = { id: me.id, name: me.username ?? me.id };
  }
  /** Asks KOOK where its gateway is, and only follows an address on KOOK's own servers. */
  private async gateway(): Promise<string> {
    const data = z.object({ url: z.string().min(1) }).passthrough().parse(await this.call("/gateway/index?compress=0"));
    const url = new URL(data.url);
    const apiHost = new URL(this.api).hostname.toLowerCase();
    const host = url.hostname.toLowerCase();
    const ok = kookHost.test(apiHost) ? url.protocol === "wss:" && kookHost.test(host) : host === apiHost && /^wss?:$/.test(url.protocol);
    if (!ok) throw new Error("KOOK answered with a gateway that is not KOOK's, so it was not used");
    url.searchParams.set("compress", "0");
    if (this.session) {
      url.searchParams.set("resume", "1");
      url.searchParams.set("sn", String(this.sn));
      url.searchParams.set("session_id", this.session);
    }
    return url.href;
  }
  private receive(text: string, onMessage: (message: InboundMessage) => Promise<void>): void {
    const signal = signalSchema.parse(JSON.parse(text));
    if (signal.s === 1) return this.hello(signal.d);
    if (signal.s === 3) { this.pongDue = 0; return; }
    if (signal.s === 5) { this.session = null; this.sn = 0; this.socket?.close(); return; }
    if (signal.s === 6) { this.state = { state: "connected" }; return; }
    if (signal.s !== 0 || signal.sn === undefined) return;
    // A number already handled is a repeat from a resume; it is not answered twice.
    if (signal.sn <= this.sn && this.sn !== 0) return;
    this.sn = signal.sn;
    const parsed = eventSchema.safeParse(signal.d);
    const read = parsed.success ? this.inbound(parsed.data) : null;
    const inbound = this.replay ? this.replay.pass(read) : read;
    const handling = inbound ? [onMessage(inbound).catch(() => undefined)] : [];
    if (this.session) void this.keeper.after(`${this.session}:${signal.sn}`, handling);
  }
  private hello(data: unknown): void {
    const hello = z.object({ code: z.number(), session_id: z.string().optional() }).passthrough().safeParse(data);
    if (!hello.success || hello.data.code !== 0) {
      const code = hello.success ? hello.data.code : 0;
      // 40101-40103: the token is wrong or ran out; anything else, start a fresh session.
      if (code >= 40101 && code <= 40103) this.refused = true;
      this.session = null;
      this.sn = 0;
      this.socket?.close();
      return;
    }
    if (hello.data.session_id && hello.data.session_id !== this.session) { this.session = hello.data.session_id; this.sn = 0; this.replay = null; }
    this.state = { state: "connected" };
    this.startHeartbeat();
  }
  private pongDue = 0;
  /** A ping every thirty seconds with the last number seen; no pong within six closes the socket. */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const socket = this.socket;
    if (!socket) return;
    this.heartbeat = setInterval(() => {
      if (this.pongDue && Date.now() > this.pongDue) { this.stopHeartbeat(); socket.close(); return; }
      socket.send(JSON.stringify({ s: 2, sn: this.sn }));
      this.pongDue ||= Date.now() + (this.options.pongWaitMs ?? 6000);
    }, this.options.heartbeatMs ?? 30_000);
    this.heartbeat.unref?.();
  }
  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.pongDue = 0;
  }
  /** A text or KMarkdown message from a person, as a message; null for anything else. */
  private inbound(event: KookEvent): InboundMessage | null {
    const me = this.me;
    const direct = event.channel_type === "PERSON";
    if (!me || (event.type !== 1 && event.type !== 9) || (!direct && event.channel_type !== "GROUP")) return null;
    if (event.author_id === me.id || event.extra?.author?.bot || event.author_id === "1") return null;
    const mentioned = (event.extra?.mention ?? []).map(String).includes(me.id);
    const handle = new RegExp(`\\(met\\)${me.id}\\(met\\)|@${escapeRegExp(me.name)}(#\\d+)?`, "gi");
    const named = handle.test(event.content);
    const text = event.content.replace(handle, "").trim();
    if (!text) return null;
    const author = event.extra?.author;
    return {
      channel: this.id, chatId: direct ? `u:${event.author_id}` : `c:${event.target_id}`,
      chatKind: direct ? "direct" : "group", ...(direct ? {} : { chatTitle: `KOOK channel ${event.target_id}` }),
      senderId: `kook:${event.author_id}`, senderName: author?.nickname || author?.username || event.author_id,
      text, addressed: direct || mentioned || named, messageId: event.msg_id,
    };
  }
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    const match = /^([uc]):([\w-]{1,40})$/.exec(chatId);
    if (!match) throw new Error("That is not a KOOK chat Branch has heard from");
    const path = match[1] === "u" ? "/direct-message/create" : "/message/create";
    const json = { type: 1, target_id: match[2], content: text.slice(0, this.maxTextLength), ...(replyToMessageId ? { quote: replyToMessageId } : {}) };
    const data = await this.call(path, { method: "POST", json });
    const parsed = z.object({ msg_id: z.string() }).passthrough().safeParse(data);
    return parsed.success ? parsed.data.msg_id : undefined;
  }
  async react(chatId: string, messageId: string, emoji: string, previous?: string): Promise<void> {
    const match = /^([uc]):([\w-]{1,40})$/.exec(chatId);
    if (!match || !/^[\w-]{1,80}$/.test(messageId)) throw new Error("Invalid KOOK reaction destination.");
    const convert = (value: string) => {
      // KOOK's built-in emoji IDs are single code points; use a wrench for the tool-work status.
      if (value === "\u{1F468}\u200D\u{1F4BB}") return "[#128295;]";
      const points = Array.from(value).filter((point) => point.codePointAt(0) !== 0xfe0f);
      if (points.length !== 1) throw new Error("KOOK status reactions require a single Unicode emoji.");
      return `[#${points[0]!.codePointAt(0)};]`;
    };
    const path = match[1] === "u" ? "/direct-message" : "/message";
    if (previous && previous !== emoji) await this.call(`${path}/delete-reaction`, { method: "POST", json: { msg_id: messageId, emoji: convert(previous) } });
    await this.call(`${path}/add-reaction`, { method: "POST", json: { msg_id: messageId, emoji: convert(emoji) } });
  }
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export const kookService = defineService({
  kind: "kook", name: "KOOK", docs: "https://developer.kookapp.cn/doc/websocket",
  needs: ["A bot application made at developer.kookapp.cn, set to connect by WebSocket",
    "The bot's token, saved as a secret", "The bot invited to your KOOK server"],
  receives: "socket",
  settings: z.object({
    tokenSecret: z.string().regex(secretName).default("KOOK_BOT_TOKEN"),
    apiBase: z.string().url().regex(/^https?:\/\//).default(officialApi),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.apiBase), "KOOK API");
    return new KookChannel({
      id: deps.id, token: await deps.secret(settings.tokenSecret), tokenName: settings.tokenSecret,
      apiBase: settings.apiBase, fetch: deps.fetch, connect: deps.connectWs,
    });
  },
});
