import { attachmentKind, fetchCapped, voiceFileName } from "./media.js";
import { z } from "zod";
import { EditedWords } from "./edited-words.js";
import { lookup } from "../commands/catalog.js";
import { fenced } from "./progress-render.js";
import type { MessageFormat } from "./router.js";
import type { ChannelAdapter, ChannelHealth, InboundMessage, OutgoingFile, SendGate } from "./router.js"; // R17-C: OutgoingFile
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
  /** How often the socket is pinged to show it is still there (20 s; tests shorten it). */
  keepaliveMs?: number;
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
/** A button pressed on a question (Socket Mode `interactive`, Block Kit `block_actions`). */
const actionSchema = z.object({
  type: z.literal("block_actions"),
  user: z.object({ id: z.string(), username: z.string().optional(), name: z.string().optional() }).passthrough(),
  channel: z.object({ id: z.string() }).passthrough(),
  message: z.object({ ts: z.string(), thread_ts: z.string().optional(), text: z.string().optional() }).passthrough(),
  actions: z.array(z.object({ action_id: z.string(), value: z.string().optional(), action_ts: z.string().optional() }).passthrough()).min(1),
}).passthrough();
/** The action ids Branch's own buttons carry, so a press on some other app's button is never read as an answer. */
const answerAction = /^branch_answer_\d{1,2}$/;
/** The Slack thread a reply goes to: the timestamp before any "#" a button press added; anything else is no thread. */
const threadOf = (id: string | undefined): string | undefined => { const ts = id?.split("#")[0]; return ts && /^\d+\.\d+$/.test(ts) ? ts : undefined; };

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
  /** Its buttons carry a list, so `/model` can be a menu (ChannelAdapter.listButtons). */
  readonly listButtons = true;
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
  /** The words each recent message had, so an edit that changed none is not one. */
  private readonly edits = new EditedWords();
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
  /** Staying connected: when Slack last answered at all (any envelope, or a pong to our own ping). */
  private contactAt = Date.now();
  private keepalive: ReturnType<typeof setInterval> | undefined;
  lastContact(): number { return this.contactAt; }
  /** The watchdog (and a wake from sleep) starts a stalled connection again, resuming the session where it can. */
  async restart(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    await this.stop();
    this.stopping = false;
    await this.start(onMessage);
  }
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
    if (this.keepalive) clearInterval(this.keepalive);
    this.socket?.close();
    await this.loop?.catch(() => undefined);
  }
  private async run(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    for (let attempt = 0; !this.stopping; attempt++) {
      try {
        const address = this.options.socketUrl ?? await this.open();
        const socket = await this.connect(address, { onMessage: (text) => this.receive(text, onMessage) });
        this.socket = socket;
        this.contactAt = Date.now();
        // A socket that went quiet after a sleep never says it closed; a ping every 20 s shows whether anyone is there.
        if (this.keepalive) clearInterval(this.keepalive);
        this.keepalive = setInterval(() => socket.ping?.(() => { this.contactAt = Date.now(); }), this.options.keepaliveMs ?? 20_000);
        this.keepalive.unref?.();
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
    this.contactAt = Date.now();
    const envelope = envelopeSchema.safeParse(JSON.parse(text));
    if (!envelope.success) return;
    const { envelope_id: id, payload, type } = envelope.data;
    if (id) this.socket?.send(JSON.stringify({ envelope_id: id }));
    if (type === "disconnect") { this.socket?.close(); return; }
    if (type === "interactive") { const pressed = this.fromButton(payload); if (pressed) void onMessage(pressed).catch(() => undefined); return; }
    if (type === "slash_commands") { const typed = this.fromSlash(payload); if (typed) void onMessage(typed).catch(() => undefined); return; }
    const eventId = payload?.event_id;
    if (!payload?.event || (eventId && this.seen.has(eventId))) return;
    if (eventId) { this.seen.add(eventId); if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value!); }
    try { this.options.onEvent?.(payload.event, this.user?.id ?? null); } catch { /* an automation never stops a reply */ } // mac6/bucket-16
    const changed = payload.event.type === "message" && payload.event.subtype === "message_changed" ? this.changed(payload.event) : undefined;
    if (changed !== undefined) { if (changed) void onMessage(changed).catch(() => undefined); return; }
    const inbound = this.inbound(payload.event);
    if (inbound) { this.edits.changed(`${inbound.chatId}:${payload.event.ts ?? ""}`, payload.event.text ?? ""); void onMessage(inbound).catch(() => undefined); }
  }
  /**
   * Settings › Chat apps › Edited messages: Slack says a message changed as a `message_changed` event holding the new
   * message. Only a person's own edit that changed the words counts (a link unfolding changes none); it is read as that
   * message again, marked edited, for the router to answer or leave as the owner chose.
   */
  private changed(event: z.infer<typeof eventSchema>): InboundMessage | null {
    const message = eventSchema.safeParse((event as Record<string, unknown>).message);
    if (!message.success || !message.data.ts || !event.channel || !message.data.text) return null;
    if (!this.edits.changed(`${event.channel}:${message.data.ts}`, message.data.text)) return null;
    const inbound = this.inbound({ ...message.data, type: "message", channel: event.channel, channel_type: event.channel_type,
      subtype: undefined });
    return inbound ? { ...inbound, edited: true, messageId: message.data.thread_ts ?? message.data.ts } : null;
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
   * CHAT-062: a question with Block Kit buttons. Each button's value is the answer and the fingerprint of the exact
   * request, as on Telegram; the words stay in `text` too, for notifications and for apps that cannot show blocks.
   */
  async sendButtons(chatId: string, text: string, buttons: { label: string; value: string }[], replyToMessageId?: string,
    format?: MessageFormat): Promise<string | undefined> {
    // A command shown before its Yes (src/channels/owner-commands.ts) comes as a code span, fenced here like a reply's.
    const words = slackText(text, format).slice(0, 2900);
    const result = await this.call("chat.postMessage", this.options.token, {
      channel: chatId, text: words, ...(threadOf(replyToMessageId) ? { thread_ts: threadOf(replyToMessageId) } : {}),
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: words } },
        // A question's Yes and No, or a /model menu (Slack takes up to 25 buttons in one actions block).
        { type: "actions", elements: buttons.slice(0, 25).map((button, index) => ({
          type: "button", action_id: `branch_answer_${index}`, value: button.value.slice(0, 2000),
          text: { type: "plain_text", text: button.label.slice(0, 75) },
          ...(button.value.startsWith("y") ? { style: "primary" } : button.value.startsWith("n") ? { style: "danger" } : {}),
        })) },
      ],
    });
    const parsed = z.object({ ts: z.string() }).passthrough().safeParse(result);
    return parsed.success ? parsed.data.ts : undefined;
  }
  /**
   * A pressed button, as an ordinary addressed message carrying the button's own value; the router reads it as an answer
   * to what this chat is waiting on, with every rule a typed y or n meets. Only Branch's own buttons count. The buttons
   * stay as they are, as on Telegram: a press the router refuses (a stranger, a yes that belongs in the window) must not
   * take them away from the person who may answer, and a second press on an answered question is told so.
   */
  private fromButton(payload: unknown): InboundMessage | null {
    const parsed = actionSchema.safeParse(payload);
    if (!parsed.success) return null;
    const { user, channel, message, actions } = parsed.data;
    const action = actions[0]!;
    if (!answerAction.test(action.action_id) || !action.value || user.id === this.user?.id) return null;
    if (this.options.channels?.length && !this.options.channels.includes(channel.id)) return null;
    const direct = channel.id.startsWith("D");
    return {
      channel: this.id, chatId: channel.id, chatKind: direct ? "direct" : "group",
      ...(direct ? {} : { chatTitle: `channel ${channel.id}` }),
      senderId: user.id, senderName: user.username ?? user.name ?? user.id,
      text: action.value, addressed: true,
      // The reply goes to the thread the question was asked in; the press's own time after "#" keeps two presses in one
      // thread apart, so each gets its own answer (the delivery keys are made from this).
      messageId: `${message.thread_ts ?? message.ts}#${action.action_ts ?? Date.now()}`,
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
      // A thread is Slack's own timestamp: a button press's "#time" is taken off, and a slash command's id is no thread.
      channel: chatId, text: slackText(text, format), ...slackPlain(text, format), ...(threadOf(replyToMessageId) ? { thread_ts: threadOf(replyToMessageId) } : {}),
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
  /**
   * Slack's assistant status under the person's message ("Branch is thinking…"), as Hermes Agent and OpenClaw show it.
   * It needs the app's Agents & AI Apps setting and the assistant:write scope; without them Slack refuses and the live
   * status stops asking. "" clears it (posting the reply clears it too).
   */
  async setStatus(chatId: string, threadId: string, words: string): Promise<void> {
    await this.call("assistant.threads.setStatus", this.options.token, { channel_id: chatId, thread_ts: threadId, status: words.slice(0, 100) });
  }
  async edit(chatId: string, messageId: string, text: string, format?: MessageFormat, gate?: SendGate): Promise<void> {
    await this.call("chat.update", this.options.token, { channel: chatId, ts: messageId, text: slackText(text, format), ...slackPlain(text, format) }, gate);
  }
  async deleteMessage(chatId: string, messageId: string, gate?: SendGate): Promise<void> {
    await this.call("chat.delete", this.options.token, { channel: chatId, ts: messageId }, gate);
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
      ...(file.caption ? { initial_comment: toMrkdwn(file.caption) } : {}), ...(threadOf(replyToMessageId) ? { thread_ts: threadOf(replyToMessageId) } : {}),
    });
    return slot.file_id;
  }
  /** CHAT-094: a spoken reply, as an audio file in the chat. */
  async sendVoice(chatId: string, audio: Uint8Array, mediaType: string, replyToMessageId?: string): Promise<string | undefined> {
    return this.sendFile(chatId, { name: voiceFileName(mediaType), mediaType, bytes: audio }, replyToMessageId);
  }
  // ---- end R17-C ----
  /** One Web API request. A `gate` (an owner's own-message edit or delete) is checked last before sending, and its
      signal aborts the request, including while the address is still being checked. */
  private async call(method: string, token: string, body: unknown, gate?: SendGate): Promise<unknown> {
    const timeout = AbortSignal.timeout(20000), signal = gate ? AbortSignal.any([timeout, gate.signal]) : timeout;
    gate?.check();
    const response = await this.fetch(`${this.base}/${method}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body), signal,
    });
    const parsed = z.object({ ok: z.boolean(), error: z.string().optional() }).passthrough().parse(await response.json());
    if (!parsed.ok) throw new Error(`Slack ${method} failed: ${parsed.error ?? response.status}`);
    return parsed;
  }
}
