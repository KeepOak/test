import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage, MessageFormat, OutgoingFile, SendGate } from "./router.js"; // R17-C: OutgoingFile
import { telegramEntities } from "./progress-render.js";
import { ArtifactTooLarge, maxArtifactBytes } from "../artifacts.js";
import type { ChannelPosition } from "../never-break/channel-position.js";
import { verifyTelegramLaunch, type TelegramLaunch } from "./telegram-init-data.js";
import { verifyInitData, type MiniAppUser } from "../miniapp/init-data.js";
import { MemoryInbox, type InboxRow, type TelegramInbox } from "./telegram-inbox.js";
import { catchUpLimit } from "./catch-up.js";
import { backoffDelay, conflictBackoff, maxInCallWaitSeconds, pollBackoff, repeatable, telegramFailure, type TelegramFailure } from "./telegram-retry.js";
import { telegramForwardContext, telegramPollContent, telegramStickerContent, telegramStickerSchema } from "./telegram-content.js";
import { telegramLocationSchema, telegramLocationText, telegramVenueSchema } from "./telegram-location.js";

/**
 * Telegram Bot API adapter using long polling. Text and media messages are delivered; a message is
 * "addressed" when it mentions the bot's username or replies to one of the bot's messages.
 */
export interface TelegramOptions {
  id: string;
  token: string;
  apiBase?: string;
  fetch?: typeof fetch;
  pollTimeoutSeconds?: number;
  /** mac3/never-break: where the stream was read up to, kept across restarts. */
  position?: ChannelPosition;
  /** P17-D §8: milliseconds before asking again with a refused token (30 s; tests shorten it). */
  refusedRetryMs?: number;
  /** Milliseconds without an update before asking from Telegram's earliest unconfirmed update (a day; tests shorten it). */
  renumberAfterMs?: number;
  /**
   * Where each update is written down before Telegram is told it arrived (telegram-inbox.ts): Branch's saved-work
   * database, so a restart handles only what was not yet handled. Left out, it is kept in memory.
   */
  inbox?: TelegramInbox;
  /**
   * Starts even when Telegram cannot be reached yet (the card's bot, connected in the background after
   * its token was checked): the name is learned by the first poll that gets through. Left out, any
   * failure other than a refused token stops the start, as a settings-file channel always has.
   */
  keepTrying?: boolean;
}
/** A bot's own id: the number before the colon in its token, so a read position is kept per bot, never shared. */
export const telegramBotId = (token: string): string => token.split(":")[0] ?? "";
/** P17-D §8: what Settings › Chat apps and the Inbox show while Telegram refuses the bot token. */
export const tokenRefused = "Telegram refused the bot token, so messages sent to the bot since then haven't reached Branch. It was probably revoked or replaced in BotFather: paste the new token to bring it back.";
const userSchema = z.object({ id: z.number(), is_bot: z.boolean().optional(), first_name: z.string().optional(), username: z.string().optional() }).passthrough();
const voiceSchema = z.object({
  file_id: z.string().min(1).max(200),
  duration: z.number().nonnegative().optional(),
  mime_type: z.string().max(100).optional(),
  file_size: z.number().nonnegative().optional(),
}).passthrough();
const mediaSchema = voiceSchema.extend({ file_unique_id: z.string().optional(), file_name: z.string().optional() });
const messageSchema = z.object({
  location: telegramLocationSchema.optional(),
  venue: telegramVenueSchema.optional(),
  photo: z.array(mediaSchema).optional(),
  document: mediaSchema.optional(),
  sticker: telegramStickerSchema.optional(),
  video: mediaSchema.optional(),
  message_id: z.number(),
  /** When it was sent (and edited), in seconds: an update sent before Branch started is old news (caughtUp). */
  date: z.number().optional(),
  edit_date: z.number().optional(),
  message_thread_id: z.number().int().positive().optional(),
  /** Photo albums as one message: the album a photo came in. */
  media_group_id: z.string().max(64).optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  voice: voiceSchema.optional(),
  audio: voiceSchema.optional(),
  from: userSchema.optional(),
  chat: z.object({ id: z.number(), type: z.string(), title: z.string().optional(), is_forum: z.boolean().optional() }).passthrough(),
  entities: z.array(z.object({ type: z.string(), offset: z.number(), length: z.number() })).optional(),
  reply_to_message: z.object({ from: userSchema.optional() }).passthrough().optional(),
}).passthrough();
/** A button somebody pressed. Telegram sends the button's own `data` back, at most 64 bytes of it. */
const callbackSchema = z.object({
  id: z.string(),
  data: z.string().max(64).optional(),
  from: userSchema.optional(),
  message: messageSchema.optional(),
}).passthrough();
const updateSchema = z.object({
  update_id: z.number(),
  message: messageSchema.optional(),
  /** Settings › Chat apps › Edited messages: a new version of a message sent before. */
  edited_message: messageSchema.optional(),
  callback_query: callbackSchema.optional(),
}).passthrough();
/** `parameters.retry_after`: Telegram's "too many requests, try again in N seconds" (https://core.telegram.org/bots/api#responseparameters). */
const responseSchema = z.object({ ok: z.boolean(), result: z.unknown().optional(), description: z.string().optional(),
  parameters: z.object({ retry_after: z.number().optional(), migrate_to_chat_id: z.number().optional() }).passthrough().optional() });
/**
 * Which words are code, as Telegram message entities rather than a parse mode, so nothing in the words needs escaping:
 * a `pre` entity with a language gets Telegram's code block with the language's name and a copy button. `quiet` sends
 * without a notification sound (a progress message; the reply after it is the one that rings).
 */
const formatted = (format?: MessageFormat) => ({
  ...(!format?.plain && format?.spans?.length ? { entities: telegramEntities(format.spans) } : {}),
  ...(format?.quiet ? { disable_notification: true } : {}),
});
/** Topic addresses remain distinct in the router; Telegram receives the underlying chat and thread. */
const topicAddress = (chatId: number, threadId?: number): string =>
  threadId === undefined ? String(chatId) : `${chatId}:${threadId}`;
/**
 * UP-CHAT-014: a topic is its own conversation only in a forum. In an ordinary group, Telegram gives a reply chain a
 * `message_thread_id` too, and that must not split one group into a conversation per reply chain.
 * From OpenClaw (MIT), extensions/telegram/src/bot/helpers.ts `resolveTelegramForumThreadId`.
 */
const forumThread = (chat: { is_forum?: boolean | undefined }, threadId: number | undefined): number | undefined =>
  chat.is_forum ? threadId : undefined;
/**
 * UP-CHAT-013: `/cmd@SomeBot` names the bot a command is for (Telegram's form in groups). Adapted from OpenClaw (MIT),
 * src/auto-reply/commands-registry-normalize.ts `TARGETED_COMMAND_BODY_RE`.
 */
const targetedCommand = /^\/([^\s@]+)@([A-Za-z0-9_]+)(?=$|\s|[.!?,;:'")\]}])([\s\S]*)$/u;
/** Telegram's own limits for a bot's command menu (https://core.telegram.org/bots/api#botcommand). */
const menuNamePattern = /^[a-z0-9_]{1,32}$/;
const menuMax = 100, menuTextBudget = 5700, menuDescriptionMax = 256;
/**
 * The menu within Telegram's limits: names it accepts, at most 100 commands, and descriptions trimmed so the whole menu
 * fits the text budget. Adapted from OpenClaw (MIT), extensions/telegram/src/bot-native-command-menu.ts
 * `fitTelegramCommandsWithinTextBudget`. A name Telegram would refuse is left out rather than renamed, because the
 * router reads the name as it is.
 */
export function telegramMenu(commands: { command: string; description: string }[]): { command: string; description: string }[] {
  let menu = commands.filter((one) => menuNamePattern.test(one.command)).slice(0, menuMax);
  while (menu.length) {
    const names = menu.reduce((total, one) => total + one.command.length, 0);
    const room = menuTextBudget - names;
    if (room < menu.length) { menu = menu.slice(0, -1); continue; }
    const cap = Math.min(menuDescriptionMax, Math.floor(room / menu.length));
    return menu.map((one) => ({ command: one.command, description: (one.description.trim() || one.command).slice(0, cap) }));
  }
  return [];
}
const telegramTarget = (address: string): { chat_id: number; message_thread_id?: number } => {
  const [chatId, threadId] = address.split(":");
  return { chat_id: Number(chatId), ...(threadId === undefined ? {} : { message_thread_id: Number(threadId) }) };
};

export class TelegramAdapter implements ChannelAdapter {
  readonly kind = "telegram";
  /** A reply to a message only quotes it here, so Settings › Chat apps › Replies in each app decides (reply-style.ts). */
  readonly replyQuotes = true;
  /** Its buttons carry a list, so `/model` can be a menu (ChannelAdapter.listButtons). */
  readonly listButtons = true;
  readonly id: string;
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly pollTimeout: number;
  private username: string | null = null;
  /** The offset the next getUpdates asks from: one past the newest update saved in the inbox. */
  private offset = 0;
  private stopping = new AbortController();
  /** P17-D §8: how long to wait before asking again with a token Telegram refused. */
  private readonly refusedRetryMs: number;
  private readonly renumberAfterMs: number;
  /** When an update last arrived (or, at start, when the saved position was last moved on). */
  private lastUpdateAt = Date.now();
  /** Every update is saved here before Telegram is told it arrived; the offset moves on as soon as it is. */
  private readonly inbox: TelegramInbox;
  private onMessage: ((message: InboundMessage) => Promise<void>) | null = null;
  /**
   * Set by the first start() only: the updates that waited while Branch was closed. Every update up to the newest one
   * sent before the start (`oldThrough`) is caught up; the window closes once Telegram has handed the backlog over.
   */
  private backlog: { startedAt: number; oldThrough: number } | null = null;
  private started = false;
  private loop: Promise<void> | null = null;
  /** P17-D §8: Telegram's refusal of the bot token while polling (revoked or replaced in BotFather), in words, or null. */
  private refused: string | null = null;
  /** 409 Conflict: another program reads this bot's updates (or a webhook is set), in words, or null. */
  private conflict: string | null = null;
  /** Polls failed in a row, and 409s in a row, for the backoff. Kept across the watchdog's restart(). */
  private failures = 0;
  private conflicts = 0;
  /** Groups that became supergroups: the old chat id and the new one (migrate_to_chat_id). */
  private readonly movedChats = new Map<number, number>();
  /** keepTrying: getMe did not get through at start, so the name is still to be learned. */
  private nameUnknown = false;
  constructor(private readonly options: TelegramOptions) {
    this.id = options.id;
    this.base = `${(options.apiBase ?? "https://api.telegram.org").replace(/\/$/, "")}/bot${options.token}`;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.pollTimeout = options.pollTimeoutSeconds ?? 25;
    this.refusedRetryMs = options.refusedRetryMs ?? 30_000;
    this.renumberAfterMs = options.renumberAfterMs ?? 24 * 60 * 60 * 1000;
    this.inbox = options.inbox ?? new MemoryInbox();
  }
  botName(): string | null { return this.username; }
  verifyMiniApp(raw: string): TelegramLaunch { return verifyTelegramLaunch(raw, this.options.token); }
  /** P17-D §8: a refused token (or another program reading this bot) stops every message arriving, so it is said. */
  health(): ChannelHealth {
    const reason = this.refused ?? this.conflict;
    return reason ? { state: "needs attention", reason } : { state: "connected" };
  }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    // P17-D §8: a token revoked while Branch was closed is refused here first. It still starts, so the refusal shows
    // in its health and it comes back by itself once the token works; any other failure stops the start as before.
    await this.learnName().catch((error: unknown) => {
      if ((error as { status?: unknown }).status === 401) { this.refused = tokenRefused; return; }
      if (!this.options.keepTrying) throw error;
      this.nameUnknown = true; // the poll below keeps asking, and learns the name once Telegram answers
    });
    const kept = this.inbox.newest();
    this.offset = Math.max(this.offset, this.options.position?.load() ?? 0, kept ? kept + 1 : 0); // mac3/never-break
    const movedAt = this.options.position?.savedAt?.();
    if (this.offset > 0 && movedAt !== undefined && movedAt < this.lastUpdateAt) this.lastUpdateAt = movedAt;
    if (!this.started) {
      // Only when Branch starts, not when the watchdog starts the poll again: what waited meanwhile is old news, and so
      // is an update a restart cut off, so an owner's command is not carried out late or run again after a restart.
      this.started = true;
      this.inbox.markCaughtUp();
      this.backlog = { startedAt: Date.now(), oldThrough: 0 };
    }
    this.onMessage = onMessage;
    this.loop = this.poll().catch(() => undefined); // never an unhandled rejection, even if the loop itself fails
  }
  /** `stoppable`: asked from the poll, so stop() cuts it short instead of waiting up to twenty seconds for it. */
  private async learnName(stoppable = false): Promise<void> {
    const me = userSchema.parse(await this.call("getMe", {}, false, stoppable));
    this.username = me.username ?? null;
  }
  /** Disconnected for good (router.detach): the inbox rows this bot saved are dropped at once. */
  forget(): void { this.inbox.forget(); }
  async stop(): Promise<void> {
    this.stopping.abort();
    await this.loop?.catch(() => undefined);
  }
  /** Staying connected: when Telegram last answered a poll (or when this bot started). */
  private contactAt = Date.now();
  lastContact(): number { return this.contactAt; }
  /** The watchdog starts a stalled bot again: the poll is stopped and a new one begins from the saved position. */
  async restart(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    await this.stop();
    this.stopping = new AbortController();
    // contactAt is left as it was: only Telegram answering moves it, so a restart that brings nothing back shows (Codex P1).
    await this.start(onMessage);
  }
  /** Presence: the bot's short description, which Telegram shows on its profile ("" clears it). */
  async setPresence(words: string): Promise<void> {
    await this.call("setMyShortDescription", { short_description: words.slice(0, 120) });
  }
  /** Hermes run_topics.py (MIT): require getMe's actual private-topic flag and sanitize the title. */
  async createDirectTopic(address: string, title: string): Promise<string> {
    const target = telegramTarget(address);
    if (!Number.isSafeInteger(target.chat_id) || target.chat_id <= 0) throw new Error("Create a topic in your Telegram direct chat.");
    const chat = z.object({ type: z.string() }).passthrough().parse(await this.call("getChat", { chat_id: target.chat_id }));
    if (chat.type !== "private") throw new Error("Only private Telegram topics can be created from this command.");
    const me = z.object({ has_topics_enabled: z.boolean().optional() }).passthrough().parse(await this.call("getMe", {}));
    if (me.has_topics_enabled !== true) throw new Error("Enable forum topic mode for this bot in BotFather, then send /topic <name> again.");
    const cleaned = title.replace(/\s+/g, " ").trim();
    const characters = Array.from(cleaned);
    if (!characters.length) throw new Error("Give the topic a name.");
    const name = characters.length <= 120 ? cleaned : characters.slice(0, 117).join("").trimEnd() + "...";
    const result = z.object({ message_thread_id: z.number().int().positive() }).passthrough()
      .parse(await this.call("createForumTopic", { chat_id: target.chat_id, name }));
    return topicAddress(target.chat_id, result.message_thread_id);
  }
  async send(chatId: string, text: string, replyToMessageId?: string, format?: MessageFormat, gate?: SendGate): Promise<string | undefined> {
    const result = await this.call("sendMessage", {
      ...telegramTarget(chatId), text, ...formatted(format),
      ...(replyToMessageId && /^\d+$/.test(replyToMessageId) ? { reply_parameters: { message_id: Number(replyToMessageId), allow_sending_without_reply: true } } : {}),
    }, false, false, gate);
    const parsed = z.object({ message_id: z.number() }).passthrough().safeParse(result);
    return parsed.success ? String(parsed.data.message_id) : undefined;
  }
  /**
   * Hermes Agent's private-chat send_draft contract (MIT), adapted to Branch's topic handles and plain preview.
   * Reusing the nonzero id animates the preview; it has no message id and never replaces the final sendMessage.
   */
  async sendDraft(chatId: string, draftId: number, text: string, gate?: SendGate): Promise<void> {
    const target = telegramTarget(chatId);
    if (!Number.isSafeInteger(target.chat_id) || target.chat_id <= 0 || !Number.isSafeInteger(draftId) || draftId <= 0)
      throw new Error("Telegram drafts require a private chat and a positive draft id");
    const result = await this.call("sendMessageDraft", { ...target, draft_id: draftId, text: text.slice(0, 3500) }, false, false, gate);
    if (result !== true) throw new Error("Telegram refused the draft preview");
  }
  /** Sends a spoken reply as a Telegram voice note. Telegram wants the file as a form upload. */
  async sendVoice(chatId: string, audio: Uint8Array, mediaType: string, replyToMessageId?: string): Promise<string | undefined> {
    if (audio.byteLength > this.maxFileBytes) throw new Error("That spoken reply is larger than Telegram's 50 MB limit.");
    const type = mediaType.split(";")[0]!.toLowerCase();
    // Local speech may produce WAV; send the playable file without claiming it is an Opus voice bubble.
    if (!["audio/ogg", "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a"].includes(type))
      return this.sendFile(chatId, { name: type.includes("wav") ? "reply.wav" : "reply.audio", mediaType, bytes: audio }, replyToMessageId);
    const form = new FormData();
    const target = telegramTarget(chatId);
    form.append("chat_id", String(target.chat_id));
    if (target.message_thread_id !== undefined) form.append("message_thread_id", String(target.message_thread_id));
    const extension = ["audio/mpeg", "audio/mp3"].includes(type) ? "mp3" : ["audio/mp4", "audio/x-m4a"].includes(type) ? "m4a" : "ogg";
    form.append("voice", new Blob([new Uint8Array(audio)], { type: mediaType }), `reply.${extension}`);
    if (replyToMessageId && /^\d+$/.test(replyToMessageId)) form.append("reply_parameters", JSON.stringify({ message_id: Number(replyToMessageId), allow_sending_without_reply: true }));
    const response = await this.fetch(`${this.base}/sendVoice`, { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
    const parsed = responseSchema.parse(await response.json());
    if (!parsed.ok) throw new Error(`Telegram sendVoice failed: ${parsed.description ?? response.status}`);
    const message = z.object({ message_id: z.number() }).passthrough().safeParse(parsed.result);
    return message.success ? String(message.data.message_id) : undefined;
  }
  // ---- R17-C (R17-022): a file as a Telegram document. Bots may send up to 50 MB. ----
  readonly maxFileBytes = 50 * 1024 * 1024;
  async sendFile(chatId: string, file: OutgoingFile, replyToMessageId?: string): Promise<string | undefined> {
    const form = new FormData();
    const target = telegramTarget(chatId);
    form.append("chat_id", String(target.chat_id));
    if (target.message_thread_id !== undefined) form.append("message_thread_id", String(target.message_thread_id));
    // CHAT-102: a picture Telegram can show (JPEG, PNG or WebP, up to 10 MB) goes as a photo, everything else as a file.
    const method = telegramPhoto(file) ? "sendPhoto" : "sendDocument";
    form.append(method === "sendPhoto" ? "photo" : "document", new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }), file.name);
    if (file.caption) form.append("caption", file.caption.slice(0, 1024));
    if (replyToMessageId) form.append("reply_to_message_id", replyToMessageId);
    const response = await this.fetch(`${this.base}/${method}`, { method: "POST", body: form, signal: AbortSignal.timeout(120000) });
    const parsed = responseSchema.parse(await response.json());
    if (!parsed.ok) throw new Error(`Telegram ${method} failed: ${parsed.description ?? response.status}`);
    const message = z.object({ message_id: z.number() }).passthrough().safeParse(parsed.result);
    if (!message.success) throw new Error(`Telegram ${method} failed: response missing message_id`);
    return String(message.data.message_id);
  }
  // ---- end R17-C ----
  /** The Mini App's signed launch data, checked with this bot's own token, which never leaves this adapter. */
  miniAppUser(initData: string): MiniAppUser {
    return verifyInitData(initData, this.options.token);
  }
  /** The live browser in a chat: a photo with buttons, then the same message's photo replaced (editMessageMedia). */
  async sendPicture(chatId: string, file: OutgoingFile, buttons: { label: string; value: string; webApp?: string }[], replyToMessageId?: string): Promise<string | undefined> {
    const form = new FormData(), target = telegramTarget(chatId);
    form.append("chat_id", String(target.chat_id));
    if (target.message_thread_id !== undefined) form.append("message_thread_id", String(target.message_thread_id));
    form.append("photo", new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }), file.name);
    if (file.caption) form.append("caption", file.caption.slice(0, 1024));
    if (buttons.length) form.append("reply_markup", JSON.stringify({ inline_keyboard: [buttons.map(inlineButton)] }));
    form.append("disable_notification", "true");
    if (replyToMessageId && /^\d+$/.test(replyToMessageId))
      form.append("reply_parameters", JSON.stringify({ message_id: Number(replyToMessageId), allow_sending_without_reply: true }));
    const response = await this.fetch(`${this.base}/sendPhoto`, { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
    const parsed = responseSchema.parse(await response.json());
    if (!parsed.ok) throw Object.assign(new Error(`Telegram sendPhoto failed: ${parsed.description ?? response.status}`), retryOf(parsed));
    const message = z.object({ message_id: z.number() }).passthrough().safeParse(parsed.result);
    if (!message.success) throw new Error("Telegram sendPhoto failed: response missing message_id");
    return String(message.data.message_id);
  }
  async editPicture(chatId: string, messageId: string, file: OutgoingFile, buttons: { label: string; value: string; webApp?: string }[]): Promise<void> {
    const form = new FormData();
    form.append("chat_id", String(telegramTarget(chatId).chat_id));
    form.append("message_id", messageId);
    form.append("media", JSON.stringify({ type: "photo", media: "attach://picture", ...(file.caption ? { caption: file.caption.slice(0, 1024) } : {}) }));
    form.append("picture", new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }), file.name);
    form.append("reply_markup", JSON.stringify({ inline_keyboard: buttons.length ? [buttons.map(inlineButton)] : [] }));
    const response = await this.fetch(`${this.base}/editMessageMedia`, { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
    const parsed = responseSchema.parse(await response.json());
    if (!parsed.ok && !/message is not modified/i.test(parsed.description ?? ""))
      throw Object.assign(new Error(`Telegram editMessageMedia failed: ${parsed.description ?? response.status}`), retryOf(parsed));
  }
  private async poll(): Promise<void> {
    while (!this.stopping.signal.aborted) {
      try {
        const renumbered = this.mayBeRenumbered(), asked = Date.now();
        // "callback_query" has to be asked for by name, or a pressed button never arrives at all.
        const updates = z.array(updateSchema).parse(await this.call("getUpdates", { offset: renumbered ? 0 : this.offset,
          limit: pollLimit, timeout: this.pollTimeout, allowed_updates: ["message", "edited_message", "callback_query"] }, true));
        this.contactAt = Date.now(); // Staying connected: Telegram answered, even with nothing new
        this.failures = 0; this.conflicts = 0; this.conflict = null;
        if (this.refused || this.nameUnknown) { // P17-D §8: the token works again, or Telegram is reachable at last
          this.refused = null;
          await this.learnName(true).then(() => { this.nameUnknown = false; }, () => undefined);
        }
        this.take(updates, renumbered, Date.now() - asked >= heldOpenMs);
      } catch (error) {
        if (this.stopping.signal.aborted) return;
        // Deciding the wait reads the inbox; if even that fails, the plain backoff still keeps the loop alive.
        const wait = await this.afterFailure(error as TelegramFailure).catch(() => backoffDelay(pollBackoff, ++this.failures));
        await this.pause(wait);
      }
    }
  }
  /**
   * Saves what a poll brought to the inbox and moves the offset past it at once: the saved rows are the acknowledgement,
   * so the next poll waits for new updates instead of being handed the ones still being answered, and never stalls
   * behind a hundred of them. A failed save throws before the offset moves, so nothing is confirmed that was not kept.
   */
  private take(updates: z.infer<typeof updateSchema>[], renumbered: boolean, heldOpen: boolean): void {
    // A poll Telegram held open found nothing waiting when it was asked: what it brings was sent since the start.
    if (heldOpen) this.closeBacklog();
    if (updates.length) {
      this.lastUpdateAt = Date.now();
      const sorted = [...updates].sort((a, b) => a.update_id - b.update_id);
      this.inbox.add(this.rowsOf(sorted));
      const next = sorted.at(-1)!.update_id + 1;
      // Asked without the position after a quiet spell: an update below it is Telegram's new numbering, read on from there.
      this.offset = renumbered ? next : Math.max(this.offset, next);
      try { this.options.position?.save(this.offset); }
      catch { /* the inbox holds the updates; the position only says where to ask from after a restart */ }
    }
    // Fewer than a full poll: Telegram handed over everything that was waiting, so the backlog is in.
    if (updates.length < pollLimit) this.closeBacklog();
    this.drain();
  }
  /** Inbox rows for one poll; while the backlog is open, everything up to the newest update sent before the start is old news. */
  private rowsOf(sorted: z.infer<typeof updateSchema>[]): InboxRow[] {
    const backlog = this.backlog;
    if (backlog) for (const update of sorted) {
      const sent = sentAt(update);
      if (sent !== undefined && sent * 1000 < backlog.startedAt - clockSkewMs) backlog.oldThrough = Math.max(backlog.oldThrough, update.update_id);
    }
    return sorted.map((update) => ({ updateId: update.update_id, update, caughtUp: !!backlog && update.update_id <= backlog.oldThrough }));
  }
  /**
   * The backlog is in: of what waited while Branch was closed, only the newest `catchUpLimit` are answered (as the other
   * chat apps do, catch-up.ts), and the rest are let go, so a computer off for a week does not answer a week at once.
   */
  private closeBacklog(): void {
    if (!this.backlog) return;
    this.backlog = null;
    const old = this.inbox.pending().filter((row) => row.caughtUp && !this.inbox.working.has(row.updateId));
    for (const row of old.slice(0, Math.max(0, old.length - catchUpLimit))) this.inbox.done(row.updateId);
  }
  /**
   * Hands every waiting update to the router in the order it came, without waiting for any of them: a message sent while
   * a task works is a note for that task, and has to be read while the task is still going. The router keeps one task
   * per chat, so each chat's messages are taken in order.
   */
  private drain(): void {
    if (this.backlog || !this.onMessage) return;
    for (const row of this.inbox.pending()) if (!this.inbox.working.has(row.updateId)) this.handOver(row, this.onMessage);
  }
  /** After a failed poll: how long to wait before the next one. */
  private async afterFailure(failure: TelegramFailure): Promise<number> {
    // P17-D §8: 401 is Telegram refusing the token itself. Nothing arrives until it is replaced, so it is reported in
    // the channel's health and asked again only every half minute.
    if (failure.status === 401) { this.refused = tokenRefused; return this.refusedRetryMs; }
    // Telegram cannot be asked now: work on what the inbox already holds.
    this.closeBacklog();
    this.drain();
    if (failure.status === 409) return this.afterConflict(failure);
    if (failure.retryAfter) { this.contactAt = Date.now(); return failure.retryAfter * 1000; } // exactly as asked
    return backoffDelay(pollBackoff, ++this.failures);
  }
  /**
   * 409: another program is reading this bot's updates, or a webhook is still set, and Telegram serves only one. The
   * webhook is removed (Branch reads by polling), the problem is shown in the channel's health, and polling backs off.
   * Telegram did answer, so the watchdog does not count this as a stall and start the poll again.
   */
  private async afterConflict(failure: TelegramFailure): Promise<number> {
    this.contactAt = Date.now();
    this.conflict = conflictReason;
    const removed = await this.call("deleteWebhook", { drop_pending_updates: false }, false, true).then(() => true, () => false);
    // A webhook was the cause and is gone: ask again at once. Anything else waits 30 s, doubling up to ten minutes.
    if (removed && /webhook/i.test(failure.description ?? "") && this.conflicts === 0) { this.conflicts++; return 0; }
    return backoffDelay(conflictBackoff, ++this.conflicts);
  }
  /**
   * Telegram numbers a bot's next update afresh after a week without any: "If there are no new updates for at least a
   * week, then identifier of the next update will be chosen randomly instead of sequentially"
   * (https://core.telegram.org/bots/api#update). It can come out below the saved position, and asking with that
   * position would confirm it, and so lose it: "An update is considered confirmed as soon as getUpdates is called with
   * an offset higher than its update_id" (https://core.telegram.org/bots/api#getupdates). So once nothing has arrived
   * for a day the bot asks without its position (0: "the earliest unconfirmed update"). That repeats nothing: every
   * update taken in was confirmed long before, the inbox keeps each update id once, and updates "will not be kept
   * longer than 24 hours" (https://core.telegram.org/bots/api#getting-updates).
   */
  private mayBeRenumbered(): boolean {
    return this.offset > 0 && Date.now() - this.lastUpdateAt >= this.renumberAfterMs;
  }
  /**
   * Waits before asking again, cut short by stop(): replacing a refused token on its card stops this bot, and the
   * owner's save must not wait out the half minute before the next attempt.
   */
  private pause(ms: number): Promise<void> {
    const signal = this.stopping.signal;
    if (ms <= 0 || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
    });
  }
  /** Hands one inbox row to the router without waiting for it, and marks it done in the inbox once it is settled. */
  private handOver(row: InboxRow, onMessage: (message: InboundMessage) => Promise<void>): void {
    const id = row.updateId;
    const settle = () => {
      this.inbox.working.delete(id);
      try { this.inbox.done(id); } catch { /* not marked: a restart hands it over once more */ }
    };
    const parsed = updateSchema.safeParse(row.update);
    const message = parsed.success ? this.toMessage(parsed.data) : null;
    if (!message) { settle(); return; }
    this.inbox.working.add(id);
    try { void Promise.resolve(onMessage(row.caughtUp ? { ...message, caughtUp: true } : message)).catch(() => undefined).finally(settle); }
    catch { settle(); }
  }
  private toMessage(update: z.infer<typeof updateSchema>): InboundMessage | null {
    const pressed = update.callback_query && this.fromButton(update.callback_query);
    if (pressed) return pressed;
    const edited = !update.message && update.edited_message ? this.inbound(update.edited_message) : null;
    return update.message ? this.inbound(update.message) : edited ? { ...edited, edited: true } : null;
  }
  /**
   * A pressed button, as an ordinary addressed message carrying the button's own value. The router
   * reads it as an answer to whatever this chat's conversation is waiting on; if nothing is waiting
   * it is a short message like any other. Telegram is told the press landed straight away, so the
   * button stops spinning whatever happens next.
   */
  private fromButton(query: z.infer<typeof callbackSchema>): InboundMessage | null {
    const chat = query.message?.chat;
    // mac7/chat-approvals (integration review): the same guard `inbound` puts on an ordinary
    // message. A press carries the sender id a line is matched against, so a bot posting as the
    // person the owner named would otherwise have carried that person's yes.
    if (!chat || !query.from || query.from.is_bot || !query.data) return null;
    void this.call("answerCallbackQuery", { callback_query_id: query.id }).catch(() => undefined);
    return {
      channel: this.id, chatId: topicAddress(chat.id, forumThread(chat as { is_forum?: boolean }, query.message?.message_thread_id)),
      chatKind: chat.type === "private" ? "direct" : "group",
      ...(chat.title ? { chatTitle: chat.title } : {}),
      senderId: String(query.from.id),
      senderName: query.from.username ?? query.from.first_name ?? String(query.from.id),
      // The message belongs to the *question*, not the press. Distinct presses on the same
      // keyboard need distinct delivery identities (including a stale-press explanation).
      text: query.data, addressed: true, messageId: query.id,
    };
  }
  /** The menu last set for each scope ("" for every chat), so an unchanged one is not sent again (OpenClaw's command hash). */
  private readonly menuSet = new Map<string, string>();
  /**
   * UP-CHAT-015 (CHAT-018, CHAT-161): Branch's commands in Telegram's own "/" menu, from the list the router hands every
   * app. An empty list clears the menu. A menu Telegram calls too big is sent again with four in five of its commands
   * until it fits (OpenClaw's BOT_COMMANDS_TOO_MUCH retry).
   */
  async setCommands(commands: { command: string; description: string }[]): Promise<void> {
    await this.putMenu(commands, null);
  }
  /** The menu for one private chat (the owner's own), in Telegram's `chat` scope; a private chat's id is its person's. */
  async setChatCommands(chatId: string, commands: { command: string; description: string }[]): Promise<void> {
    if (!/^\d+$/.test(chatId)) return;
    await this.putMenu(commands, { type: "chat", chat_id: Number(chatId) });
  }
  private async putMenu(commands: { command: string; description: string }[], scope: { type: "chat"; chat_id: number } | null): Promise<void> {
    let menu = telegramMenu(commands);
    const key = JSON.stringify(menu), where = scope ? String(scope.chat_id) : "";
    if (key === this.menuSet.get(where)) return;
    const scoped = scope ? { scope } : {};
    if (!menu.length) { await this.call("deleteMyCommands", scoped); this.menuSet.set(where, key); return; }
    for (;;) {
      try {
        await this.call("setMyCommands", { commands: menu, ...scoped });
        this.menuSet.set(where, key);
        return;
      } catch (error) {
        if (!/BOT_COMMANDS_TOO_MUCH/i.test(error instanceof Error ? error.message : String(error)) || menu.length <= 1) throw error;
        menu = menu.slice(0, Math.floor(menu.length * 0.8));
      }
    }
  }
  /**
   * A question with buttons to press. Each button's `data` is the answer plus the fingerprint of
   * the exact request, which fits inside Telegram's 64-byte limit; the conversation the answer
   * belongs to is worked out from the chat, not carried in the button.
   */
  async sendButtons(chatId: string, text: string, buttons: { label: string; value: string }[], replyToMessageId?: string, format?: MessageFormat): Promise<string | undefined> {
    const result = await this.call("sendMessage", {
      ...telegramTarget(chatId), text, ...formatted({ spans: format?.spans }),
      // Yes / No side by side; a longer list (the /model menu) one button a row, so each name can be read whole.
      reply_markup: { inline_keyboard: buttons.length > 3 ? buttons.map((button) => [{ text: button.label, callback_data: button.value }])
        : [buttons.map((button) => ({ text: button.label, callback_data: button.value }))] },
      ...(replyToMessageId && /^\d+$/.test(replyToMessageId) ? { reply_parameters: { message_id: Number(replyToMessageId), allow_sending_without_reply: true } } : {}),
    });
    const parsed = z.object({ message_id: z.number() }).passthrough().safeParse(result);
    return parsed.success ? String(parsed.data.message_id) : undefined;
  }
  /** "typing…" for about five seconds; the router asks again while the task works. */
  async sendTyping(chatId: string): Promise<void> {
    await this.call("sendChatAction", { ...telegramTarget(chatId), action: "typing" });
  }
  /** Telegram shows one reaction from a bot and replaces it, so `previous` needs no removing. */
  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    await this.call("setMessageReaction", {
      chat_id: telegramTarget(chatId).chat_id, message_id: Number(messageId), reaction: [{ type: "emoji", emoji }],
    });
  }
  async edit(chatId: string, messageId: string, text: string, format?: MessageFormat, gate?: SendGate): Promise<void> {
    try {
      await this.call("editMessageText", { chat_id: telegramTarget(chatId).chat_id, message_id: Number(messageId), text,
        ...formatted({ spans: format?.spans }) }, false, false, gate);
    } catch (error) {
      // Sending the same words again is refused with this; the message already says them.
      if (!/message is not modified/i.test(error instanceof Error ? error.message : "")) throw error;
    }
  }
  /** Removes a message the bot sent (Telegram allows it for 48 hours; an older one stays). */
  async deleteMessage(chatId: string, messageId: string, gate?: SendGate): Promise<void> {
    if (!/^\d+$/.test(messageId)) throw new Error("Telegram: that is not a message this bot sent");
    await this.call("deleteMessage", { chat_id: telegramTarget(chatId).chat_id, message_id: Number(messageId) }, false, false, gate);
  }
  private inbound(message: z.infer<typeof messageSchema>): InboundMessage | null {
    const spoken = message.voice ?? message.audio;
    const sticker = message.sticker && !message.sticker.is_animated && !message.sticker.is_video ? message.sticker : undefined;
    const media = message.document ?? message.video ?? message.photo?.at(-1) ?? sticker;
    const extra = [telegramPollContent(message.poll), telegramStickerContent(message.sticker)].filter(Boolean).join("\n");
    const location = telegramLocationText(message);
    const written = message.text ?? location ?? (spoken || media || extra ? message.caption ?? "" : undefined);
    if (written === undefined || !message.from || message.from.is_bot) return null;
    const mention = this.username ? `@${this.username.toLowerCase()}` : null;
    const mentioned = !!mention && (message.entities ?? []).some((entity) =>
      entity.type === "mention" && written.slice(entity.offset, entity.offset + entity.length).toLowerCase() === mention);
    const replyToBot = !!this.username && message.reply_to_message?.from?.username === this.username;
    const direct = message.chat.type === "private";
    // UP-CHAT-013: `/stop@ThisBot` is a command for this bot, so it counts as addressed and is read as `/stop`;
    // `/stop@OtherBot` is somebody else's command, and this bot lets it go (OpenClaw mention-gating.ts, MIT).
    const targeted = targetedCommand.exec(written);
    if (targeted && targeted[2]!.toLowerCase() !== this.username?.toLowerCase()) return null;
    const aimed = targeted ? `/${targeted[1]}${targeted[3]}` : null;
    const text = aimed ?? (mention && mentioned ? written.replace(new RegExp(mention, "ig"), "").trim() : written);
    return {
      channel: this.id, chatId: topicAddress(message.chat.id, forumThread(message.chat, message.message_thread_id)), chatKind: direct ? "direct" : "group",
      ...(message.chat.title ? { chatTitle: message.chat.title } : {}),
      senderId: String(message.from.id), senderName: message.from.username ?? message.from.first_name ?? String(message.from.id),
      text: [telegramForwardContext(message.forward_origin), text, extra].filter(Boolean).join("\n"),
      addressed: direct || mentioned || !!aimed || replyToBot || (!!spoken && direct), messageId: String(message.message_id),
      ...(message.media_group_id ? { groupId: message.media_group_id } : {}),
      ...(media ? { attachments: [{
        name: message.document?.file_name ?? message.video?.file_name ?? (sticker ? `sticker-${message.message_id}.webp` : `photo-${message.message_id}.jpg`),
        sourceId: media.file_unique_id ?? media.file_id,
        mediaType: message.document?.mime_type ?? message.video?.mime_type ?? (sticker ? "image/webp" : "image/jpeg"),
        kind: message.document ? "document" as const : message.video ? "video" as const : "picture" as const,
        ...(media.file_size !== undefined ? { size: media.file_size } : {}),
        bytes: () => this.downloadAttachment(media.file_id, media.file_size),
      }] } : {}),
      ...(spoken ? { voice: {
        mediaType: spoken.mime_type ?? "audio/ogg",
        seconds: spoken.duration,
        bytes: () => this.download(spoken.file_id, spoken.file_size ?? 0),
      } } : {}),
    };
  }
  /** Fetches a voice note's bytes, and only once the message has earned an answer. */
  private async download(fileId: string, declaredSize: number): Promise<Uint8Array> {
    const limit = 20 * 1024 * 1024;
    if (declaredSize > limit) throw new Error("That voice note is larger than 20 MB, so it was not downloaded");
    const info = z.object({ file_path: z.string().min(1).max(400) }).passthrough().parse(await this.call("getFile", { file_id: fileId }));
    const response = await this.fetch(`${this.base.replace("/bot", "/file/bot")}/${info.file_path}`, {
      redirect: "error", signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Telegram would not hand over that voice note (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error("That voice note is larger than 20 MB, so it was not used");
    return bytes;
  }
  /** Fetch only after the router accepts the sender, enforcing the intake ceiling on both sides. */
  private async downloadAttachment(fileId: string, declaredSize?: number): Promise<Uint8Array> {
    const limit = maxArtifactBytes; // what the file store keeps
    if (declaredSize !== undefined && declaredSize > limit) throw new ArtifactTooLarge("Telegram attachment exceeds 8 MB");
    const info = z.object({ file_path: z.string().min(1).max(400), file_size: z.number().optional() })
      .passthrough().parse(await this.call("getFile", { file_id: fileId }));
    if (info.file_size !== undefined && info.file_size > limit) throw new ArtifactTooLarge("Telegram attachment exceeds 8 MB");
    const response = await this.fetch(`${this.base.replace("/bot", "/file/bot")}/${info.file_path}`, {
      redirect: "error", signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Telegram attachment download failed (${response.status})`);
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > limit) { await response.body?.cancel(); throw new ArtifactTooLarge("Telegram attachment exceeds 8 MB"); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Telegram attachment has no bytes");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new ArtifactTooLarge("Telegram attachment exceeds 8 MB");
        chunks.push(value);
      }
    } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
    if (declaredSize !== undefined && size !== declaredSize) throw new Error("Telegram attachment size mismatch");
    if (info.file_size !== undefined && size !== info.file_size) throw new Error("Telegram attachment size mismatch");
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }
  /**
   * One Bot API request, asked again when Telegram says so (grammY auto-retry, telegram-retry.ts): after "too many
   * requests" it waits exactly `retry_after` (up to a few seconds; longer is thrown for the caller to schedule), follows
   * a group's move to a supergroup, and repeats a request that is safe to repeat after a server error or a lost
   * connection. getUpdates is never asked again here: the poll loop decides how long to wait. A `gate` (an owner's
   * own-message edit or delete) is checked last before each send, and its signal aborts the request, including while
   * the address is still being checked; a request it stopped is never asked again.
   */
  private async call(method: string, body: Record<string, unknown>, longPoll = false, stoppable = longPoll, gate?: SendGate): Promise<unknown> {
    let payload = this.movedChat(body), floods = 0, failures = 0;
    for (;;) {
      try { return await this.callOnce(method, payload, longPoll, stoppable, gate); }
      catch (error) {
        const failure = error as TelegramFailure;
        if (longPoll || (stoppable && this.stopping.signal.aborted) || gate?.signal.aborted) throw error;
        const chat = payload.chat_id;
        if (failure.migrateTo !== undefined && typeof chat === "number" && chat !== failure.migrateTo) {
          this.movedChats.set(chat, failure.migrateTo);
          payload = { ...payload, chat_id: failure.migrateTo };
          continue;
        }
        const wait = failure.retryAfter;
        if (wait && wait <= maxInCallWaitSeconds && floods++ < 3 && method !== "sendChatAction") { await this.sleep(wait * 1000, stoppable); continue; }
        const lost = failure.status === undefined || failure.status >= 500;
        if (lost && repeatable.has(method) && failures < 2) { await this.sleep(3000 * 2 ** failures++, stoppable); continue; }
        throw error;
      }
    }
  }
  private async callOnce(method: string, body: Record<string, unknown>, longPoll: boolean, stoppable: boolean, gate?: SendGate): Promise<unknown> {
    const timeout = AbortSignal.timeout(longPoll ? (this.pollTimeout + 10) * 1000 : 20000);
    const signals = [timeout, ...(stoppable ? [this.stopping.signal] : []), ...(gate ? [gate.signal] : [])];
    const signal = signals.length > 1 ? AbortSignal.any(signals) : timeout;
    gate?.check();
    const response = await this.fetch(`${this.base}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
    });
    const parsed = responseSchema.parse(await response.json());
    if (!parsed.ok) throw telegramFailure(method, response.status, parsed);
    return parsed.result;
  }
  /** A request for a group that became a supergroup goes to the supergroup. */
  private movedChat(body: Record<string, unknown>): Record<string, unknown> {
    const moved = typeof body.chat_id === "number" ? this.movedChats.get(body.chat_id) : undefined;
    return moved === undefined ? body : { ...body, chat_id: moved };
  }
  private sleep(ms: number, stoppable: boolean): Promise<void> {
    return stoppable ? this.pause(ms) : new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** Telegram hands out at most this many updates a poll (its own default and ceiling), asked for by name. */
const pollLimit = 100;
/** A poll that took this long was held open by Telegram: nothing was waiting when it was asked. */
const heldOpenMs = 1500;
/** Telegram's clock and this computer's may differ a little; an update sent this close to the start counts as new. */
const clockSkewMs = 2000;
/** What Settings › Chat apps shows while Telegram answers 409 Conflict. */
export const conflictReason = "Another program is reading this bot's messages (a second Branch, a script, or a webhook), so Telegram "
  + "turned Branch away. Branch removed any webhook and keeps trying; stop the other program that uses this bot token.";
/** When an update's message was sent (or edited), in seconds; a button press carries no time of its own. */
function sentAt(update: { message?: { date?: number | undefined } | undefined; edited_message?: { date?: number | undefined; edit_date?: number | undefined } | undefined }): number | undefined {
  return update.message?.date ?? update.edited_message?.edit_date ?? update.edited_message?.date;
}

/** What Telegram shows as a photo: JPEG, PNG or WebP, up to its 10 MB photo limit. */
export function telegramPhoto(file: Pick<OutgoingFile, "mediaType" | "bytes">): boolean {
  const type = file.mediaType.split(";")[0]!.toLowerCase();
  return ["image/jpeg", "image/png", "image/webp"].includes(type) && file.bytes.byteLength <= 10 * 1024 * 1024;
}

/** Telegram's "wait this long" on a refusal, carried on the error so a live status can pause (live-status.ts retryAfterMs). */
function retryOf(parsed: z.infer<typeof responseSchema>): { retryAfter?: number } {
  const wait = parsed.parameters?.retry_after;
  return typeof wait === "number" ? { retryAfter: wait } : {};
}

/** One button under a message: a press sent back to Branch, or (`webApp`) the bot's Mini App opened at that address. */
function inlineButton(button: { label: string; value: string; webApp?: string }): Record<string, unknown> {
  return button.webApp ? { text: button.label, web_app: { url: button.webApp } } : { text: button.label, callback_data: button.value };
}
