import { z } from "zod";
import type { ChannelHealth, InboundMessage } from "./router.js";
import { callJson, defineService, PollingChannel, secretName } from "./parity-common.js";

/**
 * Nextcloud Talk, the chat inside a Nextcloud server. Branch signs in as an ordinary Nextcloud user
 * with an app password and asks each chosen conversation for new messages. A one-to-one
 * conversation is always answered; in a group conversation Branch answers only when mentioned.
 * API: https://nextcloud-talk.readthedocs.io/en/latest/chat/ (chat) and .../conversation/ (room type).
 * Asking with `lookIntoFuture=1` and treating 304 as "nothing new" follows the approach in
 * OpenFang's nextcloud channel (MIT OR Apache-2.0).
 */
export interface NextcloudTalkOptions {
  id: string;
  server: string;
  username: string;
  password: string;
  rooms: string[];
  passwordSecret: string;
  pollMs?: number;
  /** The first wait after a failed call, in milliseconds; it grows with each failure. */
  retryBaseMs?: number;
  /** How long the server may hold each "anything new?" call open, in seconds. */
  waitSeconds?: number;
  fetch?: typeof fetch;
}

const ParameterSchema = z.object({ type: z.string(), id: z.coerce.string(), name: z.string().optional() }).passthrough();
const TalkMessageSchema = z.object({
  id: z.number().int(),
  actorType: z.string(),
  actorId: z.string(),
  actorDisplayName: z.string().default(""),
  message: z.string().default(""),
  systemMessage: z.string().default(""),
  messageType: z.string().default("comment"),
  messageParameters: z.union([z.record(z.string(), ParameterSchema), z.array(z.unknown())]).default({}),
}).passthrough();
type TalkMessage = z.infer<typeof TalkMessageSchema>;
const ChatAnswerSchema = z.object({ ocs: z.object({ data: z.array(z.unknown()) }) });
const RoomAnswerSchema = z.object({ ocs: z.object({ data: z.object({ type: z.number().int(), displayName: z.string().default("") }).passthrough() }) });
const SentAnswerSchema = z.object({ ocs: z.object({ data: z.object({ id: z.number().int() }).passthrough() }) });

/** Messages the service handed back, keeping only the ones shaped like a chat message. */
function talkMessages(answer: unknown): TalkMessage[] {
  const parsed = ChatAnswerSchema.safeParse(answer);
  if (!parsed.success) return [];
  return parsed.data.ocs.data.flatMap((item) => {
    const one = TalkMessageSchema.safeParse(item);
    return one.success ? [one.data] : [];
  });
}

export class NextcloudTalkChannel extends PollingChannel {
  readonly kind = "nextcloud-talk";
  /** A reply to a message only quotes it here, so Settings › Chat apps › Replies in each app decides (reply-style.ts). */
  readonly replyQuotes = true;
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private readonly lastIds = new Map<string, number>();
  private readonly rooms = new Map<string, { direct: boolean; title: string }>();
  private refused: string | null = null;
  constructor(private readonly options: NextcloudTalkOptions) {
    super(options.id, options.pollMs ?? 3000, options.retryBaseMs ?? 1000);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.base = options.server.replace(/\/+$/, "");
  }
  botName(): string | null { return this.options.username; }
  override health(): ChannelHealth {
    return this.refused ? { state: "needs attention", reason: this.refused } : super.health();
  }
  private headers(): Record<string, string> {
    const basic = Buffer.from(`${this.options.username}:${this.options.password}`).toString("base64");
    return { authorization: `Basic ${basic}`, "ocs-apirequest": "true", accept: "application/json" };
  }
  private chatUrl(room: string, query: Record<string, string>): string {
    return `${this.base}/ocs/v2.php/apps/spreed/api/v1/chat/${encodeURIComponent(room)}?${new URLSearchParams(query)}`;
  }
  /** Turns a refused sign-in into words the owner can act on, then passes the error on. */
  private noteRefusal(error: unknown): never {
    const said = error instanceof Error ? error.message : String(error);
    if (/\((401|403)\)/.test(said))
      this.refused = `Nextcloud refused the app password for ${this.options.username}. Make a new app password and save it as ${this.options.passwordSecret}`;
    throw error;
  }
  protected async poll(first: boolean): Promise<InboundMessage[]> {
    const out: InboundMessage[] = [];
    try {
      for (const room of this.options.rooms) {
        if (first || !this.lastIds.has(room)) await this.takeStock(room);
        else out.push(...await this.newIn(room));
      }
    } catch (error) { this.noteRefusal(error); }
    this.refused = null;
    return out;
  }
  /** Learns the newest message and what kind of conversation this is, without answering anything. */
  private async takeStock(room: string): Promise<void> {
    const info = RoomAnswerSchema.parse(await callJson(this.fetchImpl, "Nextcloud",
      `${this.base}/ocs/v2.php/apps/spreed/api/v4/room/${encodeURIComponent(room)}`, { headers: this.headers() }));
    this.rooms.set(room, { direct: info.ocs.data.type === 1, title: info.ocs.data.displayName || "Nextcloud Talk" });
    const newest = talkMessages(await callJson(this.fetchImpl, "Nextcloud",
      this.chatUrl(room, { lookIntoFuture: "0", limit: "1" }), { headers: this.headers() }));
    this.lastIds.set(room, Math.max(0, ...newest.map((m) => m.id)));
  }
  /** Asks for what came after the last message seen. A 304 means nothing did. */
  private async newIn(room: string): Promise<InboundMessage[]> {
    const wait = this.options.waitSeconds ?? 2;
    const url = this.chatUrl(room, { lookIntoFuture: "1", lastKnownMessageId: String(this.lastIds.get(room) ?? 0),
      timeout: String(wait), setReadMarker: "0", limit: "100" });
    const response = await this.fetchImpl(url, { headers: this.headers(), redirect: "error", signal: AbortSignal.timeout((wait + 30) * 1000) });
    if (response.status === 304) return [];
    if (!response.ok) throw new Error(`Nextcloud refused the request (${response.status})`);
    const text = await response.text();
    const messages = talkMessages(text ? JSON.parse(text) as unknown : {}).sort((a, b) => a.id - b.id);
    const out: InboundMessage[] = [];
    for (const message of messages) {
      if (message.id <= (this.lastIds.get(room) ?? 0)) continue;
      this.lastIds.set(room, message.id);
      const inbound = this.inbound(room, message);
      if (inbound) out.push(inbound);
    }
    return out;
  }
  private inbound(room: string, message: TalkMessage): InboundMessage | null {
    if (message.systemMessage || message.messageType === "system" || message.messageType === "command") return null;
    if (message.actorType === "users" && message.actorId === this.options.username) return null;
    if (message.actorType === "bots") return null;
    const { text, mentioned } = this.readMentions(message);
    if (!text.trim()) return null;
    const kind = this.rooms.get(room) ?? { direct: false, title: "Nextcloud Talk" };
    const who = message.actorType === "users" ? message.actorId : `${message.actorType}/${message.actorId}`;
    return {
      channel: this.id, chatId: room, chatKind: kind.direct ? "direct" : "group",
      ...(kind.direct ? {} : { chatTitle: kind.title }),
      senderId: this.ids.short(who, "who"), senderName: message.actorDisplayName || message.actorId,
      text, addressed: kind.direct || mentioned, messageId: String(message.id),
    };
  }
  /** Fills in `{mention-user1}` placeholders, and removes the mention of the assistant itself. */
  private readMentions(message: TalkMessage): { text: string; mentioned: boolean } {
    const parameters = Array.isArray(message.messageParameters) ? {} : message.messageParameters;
    const me = this.options.username.toLowerCase();
    let mentioned = false;
    let text = message.message.replace(/\{([a-z0-9-]+)\}/gi, (whole, key: string) => {
      const parameter = parameters[key];
      if (!parameter) return whole;
      if (parameter.type === "user" && parameter.id.toLowerCase() === me) { mentioned = true; return ""; }
      return parameter.type === "user" || parameter.type === "call" ? `@${parameter.name ?? parameter.id}` : (parameter.name ?? whole);
    });
    const typed = new RegExp(`(^|\\s)@"?${me.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?(?=\\s|$|[,:])`, "i");
    if (typed.test(text)) { mentioned = true; text = text.replace(typed, "$1"); }
    return { text: text.replace(/^[\s,:]+/, "").trim(), mentioned };
  }
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    if (!/^[a-z0-9]{4,64}$/i.test(chatId)) throw new Error("That is not a Nextcloud Talk conversation token");
    const replyTo = replyToMessageId && /^\d+$/.test(replyToMessageId) ? { replyTo: Number(replyToMessageId) } : {};
    const answer = await callJson(this.fetchImpl, "Nextcloud", this.chatUrl(chatId, {}).replace(/\?$/, ""), {
      method: "POST", headers: this.headers(), json: { message: text.slice(0, this.maxTextLength), ...replyTo },
    }).catch((error: unknown) => this.noteRefusal(error));
    const sent = SentAnswerSchema.safeParse(answer);
    return sent.success ? String(sent.data.ocs.data.id) : undefined;
  }
}

export const nextcloudTalkService = defineService({
  kind: "nextcloud-talk", name: "Nextcloud Talk", docs: "https://nextcloud-talk.readthedocs.io/en/latest/chat/",
  needs: ["The address of your Nextcloud server", "A Nextcloud user for the assistant, and an app password made for it in Settings, Security, saved as a secret",
    "The token of each conversation to watch (the last part of the conversation's link), with the assistant's user added to it"],
  receives: "polls",
  settings: z.object({
    server: z.string().url(),
    username: z.string().min(1).max(64),
    passwordSecret: z.string().regex(secretName).default("NEXTCLOUD_TALK_APP_PASSWORD"),
    rooms: z.array(z.string().regex(/^[a-z0-9]{4,64}$/i)).min(1).max(20),
    pollSeconds: z.number().int().min(1).max(300).default(3),
    waitSeconds: z.number().int().min(0).max(30).default(2),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.server), "Nextcloud server");
    return new NextcloudTalkChannel({ id: deps.id, server: settings.server, username: settings.username,
      password: await deps.secret(settings.passwordSecret), passwordSecret: settings.passwordSecret, rooms: settings.rooms,
      pollMs: settings.pollSeconds * 1000, waitSeconds: settings.waitSeconds, fetch: deps.fetch });
  },
});
