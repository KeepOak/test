import { randomInt } from "node:crypto";
import { z } from "zod";
import type { ChannelHealth, InboundMessage } from "./router.js";
import { callJson, defineService, PollingChannel, secretName } from "./parity-common.js";

/**
 * VK (VKontakte), through a community's Bots Long Poll API
 * (https://dev.vk.com/en/api/bots-long-poll/getting-started). Branch asks VK for a long-poll server,
 * then keeps asking that server for new events; each ask waits up to 25 seconds for something to
 * happen. Replies go out with `messages.send`.
 *
 * The access token always travels in a form body, never in an address. The long-poll address VK
 * hands back does carry a session key (that is how the protocol works), so it is never repeated in
 * an error, and it is only followed when it points at VK's own servers.
 *
 * A private message to the community is always answered; in a group chat the assistant answers
 * when the community is mentioned (`[club123|…]` or `@club123`).
 */
export interface VkOptions {
  id: string;
  groupId: number;
  token: string;
  tokenName?: string;
  /** Tests point this at a stand-in; the long-poll server must then be on the same host. */
  apiBase?: string;
  fetch?: typeof fetch;
  /** How long each long poll waits, in seconds (VK allows up to 90). */
  waitSeconds?: number;
  pollGapMs?: number;
  retryBaseMs?: number;
}

const apiVersion = "5.199";
/** Peer ids from here up are group chats; below are people. */
const chatPeerStart = 2_000_000_000;
const errorSchema = z.object({ error: z.object({ error_code: z.number() }).passthrough() }).passthrough();
const serverSchema = z.object({ response: z.object({ key: z.string().min(1), server: z.string().min(1), ts: z.union([z.string(), z.number()]) }) });
const checkSchema = z.object({
  ts: z.union([z.string(), z.number()]).optional(), failed: z.number().optional(),
  updates: z.array(z.object({ type: z.string(), object: z.unknown().optional() }).passthrough()).default([]),
}).passthrough();
const messageSchema = z.object({
  message: z.object({
    id: z.number().default(0), conversation_message_id: z.number().default(0),
    from_id: z.number(), peer_id: z.number(), text: z.string().max(20000).default(""), out: z.number().default(0),
  }).passthrough(),
}).passthrough();

export class VkChannel extends PollingChannel {
  readonly kind = "vk";
  /** A reply to a message only quotes it here, so Settings › Chat apps › Replies in each app decides (reply-style.ts). */
  readonly replyQuotes = true;
  private readonly api: string;
  private readonly fetch: typeof fetch;
  private server: { key: string; server: string; ts: string } | null = null;
  private refused = false;
  private aborter = new AbortController();
  constructor(private readonly options: VkOptions) {
    super(options.id, options.pollGapMs ?? 100, options.retryBaseMs ?? 1000);
    this.api = (options.apiBase ?? "https://api.vk.com/method").replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  botName(): string | null { return `club${this.options.groupId}`; }
  override health(): ChannelHealth {
    if (this.refused) return { state: "needs attention", reason: `VK refused the access token. Save a new community token as ${this.options.tokenName ?? "VK_GROUP_TOKEN"}` };
    return this.state;
  }
  override async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.aborter = new AbortController();
    this.server = null;
    await super.start(onMessage);
  }
  override async stop(): Promise<void> {
    // A long poll can hold for 25 seconds; stopping should not wait for it.
    this.aborter.abort();
    await super.stop();
  }
  /** Calls one VK API method with everything, the token included, in the form body. */
  private async method(name: string, params: Record<string, string>): Promise<unknown> {
    const answer = await callJson(this.fetch, "VK", `${this.api}/${name}`, {
      method: "POST", form: { ...params, access_token: this.options.token, v: apiVersion }, signal: this.signal(30),
    });
    const failure = errorSchema.safeParse(answer);
    if (failure.success) {
      const code = failure.data.error.error_code;
      if (code === 5 || code === 27 || code === 28) this.refused = true;
      throw new Error(`VK refused ${name} (error ${code})`);
    }
    this.refused = false;
    return answer;
  }
  private signal(seconds: number): AbortSignal {
    return AbortSignal.any([this.aborter.signal, AbortSignal.timeout(seconds * 1000)]);
  }
  /** Asks VK for a long-poll server. `keepTs` keeps our place when only the key ran out. */
  private async connect(keepTs: boolean): Promise<void> {
    const answer = serverSchema.parse(await this.method("groups.getLongPollServer", { group_id: String(this.options.groupId) }));
    const { key, server, ts } = answer.response;
    this.checkServer(server);
    this.server = { key, server, ts: keepTs && this.server ? this.server.ts : String(ts) };
  }
  /** Only VK's own servers are followed, so a forged answer cannot send Branch elsewhere. */
  private checkServer(server: string): void {
    const url = new URL(server);
    const host = url.hostname.toLowerCase();
    const ok = this.options.apiBase
      ? host === new URL(this.options.apiBase).hostname.toLowerCase()
      : url.protocol === "https:" && /(^|\.)vk\.(com|ru)$/.test(host);
    if (!ok) throw new Error("VK answered with a long-poll server that is not VK's, so it was not used");
  }
  protected override async prepare(): Promise<void> { await this.connect(false); }
  // mac6/bucket-16: carry on after a restart from the saved place (src/channels/catch-up.ts).
  protected override placeMark(): string | null { return this.server?.ts ?? null; }
  protected override resumeFrom(mark: string): boolean {
    if (!this.server || !/^\d{1,20}$/.test(mark)) return false;
    this.server.ts = mark;
    return true;
  }
  protected async poll(first: boolean): Promise<InboundMessage[]> {
    if (!this.server) await this.connect(false);
    const current = this.server!;
    const wait = first ? 0 : (this.options.waitSeconds ?? 25);
    const url = new URL(current.server);
    for (const [name, value] of Object.entries({ act: "a_check", key: current.key, ts: current.ts, wait: String(wait) })) url.searchParams.set(name, value);
    const answer = checkSchema.parse(await callJson(this.fetch, "VK long poll", url.href, { signal: this.signal(wait + 15) }));
    if (answer.failed !== undefined) { await this.recover(answer.failed, answer.ts); return []; }
    if (answer.ts !== undefined) current.ts = String(answer.ts);
    // The first ask only learns where things stand; anything it returns was already there.
    if (first) return [];
    return answer.updates.flatMap((update) => {
      if (update.type !== "message_new") return [];
      const parsed = messageSchema.safeParse(update.object);
      const inbound = parsed.success ? this.inbound(parsed.data.message) : null;
      return inbound ? [inbound] : [];
    });
  }
  /** What the docs say to do for each `failed` value. */
  private async recover(failed: number, ts: string | number | undefined): Promise<void> {
    if (failed === 1 && this.server && ts !== undefined) { this.server.ts = String(ts); return; }
    if (failed === 2) { await this.connect(true); return; }
    await this.connect(false);
  }
  private inbound(message: z.infer<typeof messageSchema>["message"]): InboundMessage | null {
    // Outgoing messages, and anything written by a community (ours included), are not answered.
    if (message.out === 1 || message.from_id <= 0 || !message.text.trim()) return null;
    const group = message.peer_id >= chatPeerStart;
    const mention = new RegExp(`\\[(?:club|public)${this.options.groupId}\\|[^\\]]*\\]|@(?:club|public)${this.options.groupId}\\b`, "gi");
    const mentioned = mention.test(message.text);
    const text = message.text.replace(mention, "").replace(/^[\s,:]+/, "").trim();
    return {
      channel: this.id, chatId: String(message.peer_id), chatKind: group ? "group" : "direct",
      ...(group ? { chatTitle: `VK chat ${message.peer_id - chatPeerStart}` } : {}),
      senderId: String(message.from_id), senderName: `id${message.from_id}`,
      text: text || message.text, addressed: !group || mentioned,
      // In a group chat a community bot only knows the message by its number within the chat.
      messageId: message.id > 0 ? String(message.id) : `c${message.conversation_message_id}`,
    };
  }
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    if (!/^-?\d{1,12}$/.test(chatId)) throw new Error("That is not a VK conversation");
    const params: Record<string, string> = {
      peer_id: chatId, message: text.slice(0, this.maxTextLength), random_id: String(randomInt(1, 2 ** 31 - 1)),
    };
    if (replyToMessageId?.startsWith("c")) {
      params.forward = JSON.stringify({ peer_id: Number(chatId), conversation_message_ids: [Number(replyToMessageId.slice(1))], is_reply: true });
    } else if (replyToMessageId && /^\d+$/.test(replyToMessageId)) params.reply_to = replyToMessageId;
    const answer = await this.method("messages.send", params);
    const parsed = z.object({ response: z.number() }).passthrough().safeParse(answer);
    return parsed.success && parsed.data.response > 0 ? String(parsed.data.response) : undefined;
  }
}

export const vkService = defineService({
  kind: "vk", name: "VK", docs: "https://dev.vk.com/en/api/bots-long-poll/getting-started",
  needs: ["Your VK community's number (the group id)",
    "A community access token with the messages right, saved as a secret",
    "Long Poll API switched on in the community settings, with the incoming message event"],
  receives: "polls",
  settings: z.object({
    groupId: z.number().int().positive().max(1e12),
    tokenSecret: z.string().regex(secretName).default("VK_GROUP_TOKEN"),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL("https://api.vk.com"), "VK API");
    return new VkChannel({
      id: deps.id, groupId: settings.groupId, token: await deps.secret(settings.tokenSecret),
      tokenName: settings.tokenSecret, fetch: deps.fetch,
    });
  },
});
