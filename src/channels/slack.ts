import { attachmentKind, fetchCapped, voiceFileName } from "./media.js";
import { z } from "zod";
import { lookup } from "../commands/catalog.js";
import { fenced } from "./progress-render.js";
import type { MessageFormat } from "./router.js";
import type { ChannelAdapter, ChannelHealth, InboundMessage, OutgoingFile } from "./router.js"; // R17-C: OutgoingFile
import { connectWebSocket, reconnectDelay, type WebSocketConnect, type WebSocketConnection } from "./ws-client.js";

/**
 * Slack adapter using Socket Mode, so Slack does not need to reach this computer. An app-level
 * token opens the socket; the bot token sends replies. Every envelope Slack pushes is acknowledged
 * at once or Slack sends it again, and an event id already seen is dropped. Replies go back into
 * the thread the message came from. Slack's own formatting is close to, but not, markdown, so the
 * reply is converted before it is sent.
 */
export interface SlackOptions {
  id: string;
  /** xoxb-... : sends messages and identifies the bot. */
  token: string;
  /** xapp-... : opens the Socket Mode connection. */
  appToken: string;
  apiBase?: string;
  socketUrl?: string;
  /** When set, only these Slack channel ids are answered. */
  channels?: string[];
  fetch?: typeof fetch;
  connect?: WebSocketConnect;
  reconnectBaseMs?: number;
  /** mac6/bucket-16: every event Slack sends, for Slack-started automations (src/channels/slack-automations.ts). */
  onEvent?: (event: unknown, botUserId: string | null) => void;
}
const eventSchema = z.object({
  type: z.string(), channel: z.string().optional(), user: z.string().optional(), text: z.string().optional(),
  ts: z.string().optional(), thread_ts: z.string().optional(), channel_type: z.string().optional(),
  subtype: z.string().optional(), bot_id: z.string().optional(),
  /** Files shared with the message (subtype `file_share`). */
  files: z.array(z.object({ id: z.string(), name: z.string().max(300).optional(), mimetype: z.string().max(100).optional(), size: z.number().optional(),
    url_private_download: z.string().max(2000).optional(), url_private: z.string().max(2000).optional() }).passthrough()).optional(),
}).passthrough();
const envelopeSchema = z.object({
  type: z.string(), envelope_id: z.string().optional(),
  payload: z.object({ event: eventSchema.optional(), event_id: z.string().optional() }).passthrough().optional(),
}).passthrough();

/** Turns the markdown the assistant writes into the shape Slack renders. */
export function toMrkdwn(text: string): string {
  const fences: string[] = [];
  let out = text.replace(/```[\s\S]*?```/g, (block) => `\u0000${fences.push(block) - 1}\u0000`);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>");
  // Italics first: in Slack one asterisk means bold, so *text* has to become _text_ before
  // **text** collapses to *text*, or the new bold would be turned into italics.
  out = out.replace(/(^|[^*])\*(?!\*)([^*\n]+)\*(?!\*)/g, "$1_$2_");
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "*$1*");
  return out.replace(/\u0000(\d+)\u0000/g, (_, index: string) => fences[Number(index)]!);
}

/** Slack names reactions in words; these are the ones the live status uses (see live-status.ts). */
const slackEmojiNames: Record<string, string> = {
  "👀": "eyes", "🤔": "thinking_face", "\u{1F468}\u200D\u{1F4BB}": "technologist", "👍": "+1", "😢": "cry",
};

/** Slack's own formatting, with code spans as fences that carry no language (Slack would show it as a first code line). */
// Plain: the notification text has Slack's three control characters escaped, so "<!channel>" shows as written and
// pings nobody. No `parse: "full"`: it reads the words as a person's typing and turns a written @channel into a ping.
const slackText = (text: string, format?: MessageFormat): string =>
  format?.plain ? text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    : toMrkdwn(format?.spans?.length ? fenced(text, format.spans, { tag: false }) : text);
/** Plain-text blocks work for sends and edits; chat.update does not accept a mrkdwn switch. */
const slackPlain = (text: string, format?: MessageFormat): Record<string, unknown> => format?.plain
  ? { link_names: false, blocks: [{ type: "section", text: { type: "plain_text", text, emoji: false } }] } : {};
export class SlackAdapter implements ChannelAdapter {
  readonly kind = "slack";
  readonly id: string;
  /** Slack accepts more, but long posts are unreadable; the ledger splits at this length. */
  readonly maxTextLength = 3000;
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly connect: WebSocketConnect;
  private socket: WebSocketConnection | undefined;
  private state: ChannelHealth = { state: "reconnecting", reason: "Connecting to Slack" };
  private user: { id: string; name: string } | null = null;
  private readonly seen = new Set<string>();
  private stopping = false;
  private loop: Promise<void> | null = null;
  constructor(private readonly options: SlackOptions) {
    this.id = options.id;
    this.base = (options.apiBase ?? "https://slack.com/api").replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.connect = options.connect ?? connectWebSocket;
  }
  botName(): string | null { return this.user?.name ?? null; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    const me = await this.call("auth.test", this.options.token, {}).catch(() => undefined);
    const parsed = z.object({ user_id: z.string(), user: z.string().optional() }).passthrough().safeParse(me);
    if (parsed.success) this.user = { id: parsed.data.user_id, name: parsed.data.user ?? parsed.data.user_id };
    else this.state = { state: "needs attention", reason: "Slack would not accept the bot token. Check the token saved in the locker." };
    this.loop = this.run(onMessage);
    await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 50))]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.socket?.close();
    await this.loop?.catch(() => undefined);
  }
  private async run(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    for (let attempt = 0; !this.stopping; attempt++) {
      try {
        const address = this.options.socketUrl ?? await this.open();
        const socket = await this.connect(address, { onMessage: (text) => this.receive(text, onMessage) });
        this.socket = socket;
        // mac7/linux-fixes: a stop that arrived while this was still being opened found nothing to
        // close, and the loop then waited for a close nobody would ask for. Let it go straight away.
        if (this.stopping) socket.close();
        this.state = { state: "connected" };
        attempt = 0;
        await socket.closed;
        if (!this.stopping) this.state = { state: "reconnecting", reason: "Slack closed the connection; reconnecting" };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.state = { state: "reconnecting", reason: `Lost the Slack connection: ${reason}` };
      }
      if (this.stopping) return;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt + 1, this.options.reconnectBaseMs ?? 1000)));
    }
  }
  private async open(): Promise<string> {
    const result = await this.call("apps.connections.open", this.options.appToken, {});
    return z.object({ url: z.string() }).passthrough().parse(result).url;
  }
  /** Acknowledges the envelope first, then decides whether the event is one to answer. */
  private receive(text: string, onMessage: (message: InboundMessage) => Promise<void>): void {
    const envelope = envelopeSchema.safeParse(JSON.parse(text));
    if (!envelope.success) return;
    const { envelope_id: id, payload, type } = envelope.data;
    if (id) this.socket?.send(JSON.stringify({ envelope_id: id }));
    if (type === "disconnect") { this.socket?.close(); return; }
    if (type === "slash_commands") { const typed = this.fromSlash(payload); if (typed) void onMessage(typed).catch(() => undefined); return; }
    const eventId = payload?.event_id;
    if (!payload?.event || (eventId && this.seen.has(eventId))) return;
    if (eventId) { this.seen.add(eventId); if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!); }
    try { this.options.onEvent?.(payload.event, this.user?.id ?? null); } catch { /* an automation never stops a reply */ } // mac6/bucket-16
    const inbound = this.inbound(payload.event);
    if (inbound) void onMessage(inbound).catch(() => undefined);
  }
  private inbound(event: z.infer<typeof eventSchema>): InboundMessage | null {
    if (!["message", "app_mention"].includes(event.type)) return null;
    // Edits, joins and the assistant's own posts are not questions to answer. A shared file is a message too (subtype file_share); edits, joins and other subtypes are not.
    const files = event.subtype === "file_share" ? (event.files ?? []).slice(0, 10) : [];
    const user = event.user, channel = event.channel;
    if ((event.subtype && event.subtype !== "file_share") || event.bot_id || (!event.text && !files.length) || !user || !channel) return null;
    if (user === this.user?.id) return null;
    if (this.options.channels?.length && !this.options.channels.includes(channel)) return null;
    const direct = event.channel_type === "im";
    const said = event.text ?? "";
    const mentioned = event.type === "app_mention" || (!!this.user && said.includes(`<@${this.user.id}>`));
    const text = this.user ? said.replace(new RegExp(`<@${this.user.id}>`, "g"), "").trim() : said;
    return {
      channel: this.id, chatId: channel, chatKind: direct ? "direct" : "group",
      ...(direct ? {} : { chatTitle: `channel ${channel}` }),
      senderId: user, senderName: user, text: text || said,
      // CHAT-105: fetched with the bot token from Slack's own file host, only once the message is answered.
      ...(files.length ? { attachments: files.flatMap((file) => {
        const url = file.url_private_download ?? file.url_private;
        if (!url) return [];
        const mediaType = file.mimetype?.split(";")[0] ?? "application/octet-stream";
        return [{ name: file.name ?? file.id, sourceId: file.id, mediaType, kind: attachmentKind(mediaType), ...(file.size !== undefined ? { size: file.size } : {}),
          bytes: () => fetchCapped(this.fetch, url, { headers: { authorization: `Bearer ${this.options.token}` } }, /(^|\.)slack\.com$/i, "file", file.size ?? 0) }];
      }) } : {}),
      addressed: direct || mentioned,
      // Replying to this id keeps the answer in the thread the question was asked in.
      messageId: event.thread_ts ?? event.ts ?? "",
      ...(event.thread_ts && event.ts ? { reactTo: event.ts } : {}),
    };
  }
  /**
   * CHAT-164: `/branch <command> [words]` from Slack's own picker (Slack keeps an app's slash commands in its settings,
   * and many plain names such as /status are Slack's own, so Branch has one). It reaches the router as `/<command>
   * words` from the person who typed it, with every rule a typed command meets; `/branch` alone is `/help`, and words
   * that are not a command are an ordinary message.
   */
  private fromSlash(payload: unknown): InboundMessage | null {
    const parsed = z.object({ command: z.string(), text: z.string().default(""), user_id: z.string(), user_name: z.string().optional(),
      channel_id: z.string(), trigger_id: z.string().optional() }).passthrough().safeParse(payload);
    if (!parsed.success || parsed.data.command !== "/branch" || parsed.data.user_id === this.user?.id) return null;
    const { text, user_id: user, channel_id: channel } = parsed.data;
    if (this.options.channels?.length && !this.options.channels.includes(channel)) return null;
    const words = text.trim().slice(0, 4000);
    const direct = channel.startsWith("D");
    return {
      channel: this.id, chatId: channel, chatKind: direct ? "direct" : "group", ...(direct ? {} : { chatTitle: `channel ${channel}` }),
      senderId: user, senderName: parsed.data.user_name ?? user,
      // Only a word that is one of the chat's commands becomes one; anything else is the person's own words.
      text: !words ? "/help" : lookup(words.split(/\s/)[0]!)?.surfaces.includes("chat") ? `/${words}` : words, addressed: true,
      messageId: `slash:${parsed.data.trigger_id ?? Date.now()}`,
    };
  }
  async send(chatId: string, text: string, replyToMessageId?: string, format?: MessageFormat): Promise<string | undefined> {
    const result = await this.call("chat.postMessage", this.options.token, {
      channel: chatId, text: slackText(text, format), ...slackPlain(text, format), ...(replyToMessageId && /^\d+\.\d+$/.test(replyToMessageId) ? { thread_ts: replyToMessageId } : {}),
    });
    const parsed = z.object({ ts: z.string() }).passthrough().safeParse(result);
    return parsed.success ? parsed.data.ts : undefined;
  }
  /**
   * Slack keeps every reaction side by side and names them in words, so the previous one is taken
   * off first. Slack has no "typing…" for an app, so there is no `sendTyping` here.
   */
  async react(chatId: string, messageId: string, emoji: string, previous?: string): Promise<void> {
    const name = slackEmojiNames[emoji];
    if (!name) throw new Error("Slack has no name for that reaction");
    const old = previous ? slackEmojiNames[previous] : undefined;
    if (old && old !== name)
      await this.call("reactions.remove", this.options.token, { channel: chatId, timestamp: messageId, name: old }).catch(() => undefined);
    await this.call("reactions.add", this.options.token, { channel: chatId, timestamp: messageId, name });
  }
  async edit(chatId: string, messageId: string, text: string, format?: MessageFormat): Promise<void> {
    await this.call("chat.update", this.options.token, { channel: chatId, ts: messageId, text: slackText(text, format), ...slackPlain(text, format) });
  }
  // ---- R17-C (R17-022): a file through Slack's external upload (the older files.upload is retired).
  // 1. files.getUploadURLExternal hands out an address and a file id; 2. the bytes go to that
  // address; 3. files.completeUploadExternal shares the file in the chat, in the thread if one is named.
  readonly maxFileBytes = 100 * 1024 * 1024;
  async sendFile(chatId: string, file: OutgoingFile, replyToMessageId?: string): Promise<string | undefined> {
    const form = new URLSearchParams({ filename: file.name, length: String(file.bytes.byteLength) });
    const response = await this.fetch(`${this.base}/files.getUploadURLExternal`, {
      method: "POST", headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(), signal: AbortSignal.timeout(20000),
    });
    const slot = z.object({ ok: z.boolean(), error: z.string().optional(), upload_url: z.string().url().optional(), file_id: z.string().optional() })
      .passthrough().parse(await response.json());
    if (!slot.ok || !slot.upload_url || !slot.file_id) throw new Error(`Slack files.getUploadURLExternal failed: ${slot.error ?? response.status}`);
    if (!/^https:\/\/([a-z0-9-]+\.)*slack\.com\//i.test(slot.upload_url)) throw new Error("Slack gave an upload address outside slack.com"); // R17-C
    const upload = await this.fetch(slot.upload_url, { method: "POST", body: new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }),
      signal: AbortSignal.timeout(120000) });
    if (!upload.ok) throw new Error(`Slack would not take the file (${upload.status})`);
    await this.call("files.completeUploadExternal", this.options.token, {
      files: [{ id: slot.file_id, title: file.name }], channel_id: chatId,
      ...(file.caption ? { initial_comment: toMrkdwn(file.caption) } : {}), ...(replyToMessageId ? { thread_ts: replyToMessageId } : {}),
    });
    return slot.file_id;
  }
  /** CHAT-094: a spoken reply, as an audio file in the chat. */
  async sendVoice(chatId: string, audio: Uint8Array, mediaType: string, replyToMessageId?: string): Promise<string | undefined> {
    return this.sendFile(chatId, { name: voiceFileName(mediaType), mediaType, bytes: audio }, replyToMessageId);
  }
  // ---- end R17-C ----
  private async call(method: string, token: string, body: unknown): Promise<unknown> {
    const response = await this.fetch(`${this.base}/${method}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    const parsed = z.object({ ok: z.boolean(), error: z.string().optional() }).passthrough().parse(await response.json());
    if (!parsed.ok) throw new Error(`Slack ${method} failed: ${parsed.error ?? response.status}`);
    return parsed;
  }
}
