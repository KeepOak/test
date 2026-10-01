import { calledByName, type GroupReading } from "./addressing.js";
import { z } from "zod";
import { telegramMarkdown } from "./chat-markdown.js";
import type { ChannelAdapter, ChannelHealth, InboundMessage, MessageFormat, OutgoingFile, SendGate } from "./router.js"; // R17-C: OutgoingFile
import { telegramEntities } from "./progress-render.js";
import { isOggOpus } from "../voice-note.js";
import { ArtifactTooLarge, maxArtifactBytes } from "../artifacts.js";
import type { ChannelPosition } from "../never-break/channel-position.js";
import { verifyInitData, type MiniAppUser } from "../miniapp/init-data.js";
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
const userSchema = z.object({ id: z.number(), is_bot: z.boolean().optional(), first_name: z.string().optional(), username: z.string().optional(),
  /** getMe only: false while the bot's privacy mode is on, when a group hands it only mentions, replies and commands. */
  can_read_all_group_messages: z.boolean().optional() }).passthrough();
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
  message_thread_id: z.number().int().positive().optional(),
  /** Photo albums as one message: the album a photo came in. */
  media_group_id: z.string().max(64).optional(),
  text: z.string().optional(),
  caption: z.string().optional(),
  voice: voiceSchema.optional(),
  audio: voiceSchema.optional(),
  from: userSchema.optional(),
  chat: z.object({ id: z.number(), type: z.string(), title: z.string().optional() }).passthrough(),
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
  parameters: z.object({ retry_after: z.number().optional() }).passthrough().optional() });
/**
 * Which words are code, as Telegram message entities rather than a parse mode, so nothing in the words needs escaping:
 * a `pre` entity with a language gets Telegram's code block with the language's name and a copy button. `quiet` sends
 * without a notification sound (a progress message; the reply after it is the one that rings).
 */
const formatted = (format?: MessageFormat) => ({
  ...(!format?.plain && format?.spans?.length ? { entities: telegramEntities(format.spans) } : {}),
  ...(format?.quiet ? { disable_notification: true } : {}),
});
/**
 * UP-CHAT-011: words sent with no spans of their own (a reply, a command's answer) have their Markdown shown as Telegram
 * entities (src/channels/chat-markdown.ts), unless the owner chose plain words for this app.
 */
const rich = (text: string, format?: MessageFormat): Record<string, unknown> => {
  if (format?.plain || format?.spans?.length) return { text, ...formatted(format) };
  const read = telegramMarkdown(text);
  return { text: read.text, ...(read.entities.length ? { entities: read.entities } : {}), ...(format?.quiet ? { disable_notification: true } : {}) };
};
/** Telegram refused the styles themselves: the same words go again without them rather than not at all. */
const entitiesRefused = (error: unknown, fields: Record<string, unknown>): boolean =>
  !!fields.entities && /entit/i.test(error instanceof Error ? error.message : String(error));
/** Topic addresses remain distinct in the router; Telegram receives the underlying chat and thread. */
const topicAddress = (chatId: number, threadId?: number): string =>
  threadId === undefined ? String(chatId) : `${chatId}:${threadId}`;
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
  /** Highest update observed; unlike the request offset, this may include unfinished work. */
  private seenThrough = 0;
  private offset = 0;
  private stopping = new AbortController();
  /** P17-D §8: how long to wait before asking again with a token Telegram refused. */
  private readonly refusedRetryMs: number;
  private readonly renumberAfterMs: number;
  /** When an update last arrived (or, at start, when the saved position was last moved on). */
  private lastUpdateAt = Date.now();
  /** Messages handed over but not settled; the oldest bounds Telegram's next offset. */
  private readonly inFlight = new Set<number>();
  private loop: Promise<void> | null = null;
  /** P17-D §8: Telegram's refusal of the bot token while polling (revoked or replaced in BotFather), in words, or null. */
  private refused: string | null = null;
  /** keepTrying: getMe did not get through at start, so the name is still to be learned. */
  private nameUnknown = false;
  constructor(private readonly options: TelegramOptions) {
    this.id = options.id;
    this.base = `${(options.apiBase ?? "https://api.telegram.org").replace(/\/$/, "")}/bot${options.token}`;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.pollTimeout = options.pollTimeoutSeconds ?? 25;
    this.refusedRetryMs = options.refusedRetryMs ?? 30_000;
    this.renumberAfterMs = options.renumberAfterMs ?? 24 * 60 * 60 * 1000;
  }
  botName(): string | null { return this.username; }
  /** P17-D §8: a refused token stops every message arriving, so it is said, not retried in silence. */
  health(): ChannelHealth { return this.refused ? { state: "needs attention", reason: this.refused } : { state: "connected" }; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    // P17-D §8: a token revoked while Branch was closed is refused here first. It still starts, so the refusal shows
    // in its health and it comes back by itself once the token works; any other failure stops the start as before.
    await this.learnName().catch((error: unknown) => {
      if ((error as { status?: unknown }).status === 401) { this.refused = tokenRefused; return; }
      if (!this.options.keepTrying) throw error;
      this.nameUnknown = true; // the poll below keeps asking, and learns the name once Telegram answers
    });
    this.offset = Math.max(this.offset, this.options.position?.load() ?? 0); // mac3/never-break
    const movedAt = this.options.position?.savedAt?.();
    if (this.offset > 0 && movedAt !== undefined && movedAt < this.lastUpdateAt) this.lastUpdateAt = movedAt;
    this.seenThrough = Math.max(this.seenThrough, this.offset);
    this.loop = this.poll(onMessage);
  }
  /** `stoppable`: asked from the poll, so stop() cuts it short instead of waiting up to twenty seconds for it. */
  private async learnName(stoppable = false): Promise<void> {
    const me = userSchema.parse(await this.call("getMe", {}, false, stoppable));
    this.username = me.username ?? null;
    this.me = { id: me.id, firstName: me.first_name ?? null, readsAll: me.can_read_all_group_messages ?? null };
  }
  /** The bot itself, from getMe: its id, the name people call it by, and whether privacy mode lets it read every group message. */
  private me: { id: number; firstName: string | null; readsAll: boolean | null } | null = null;
  /**
   * Group chats: with privacy mode on (BotFather's default) a group hands the bot only messages that @mention it, reply to
   * it or are commands, unless the bot is an admin there. Telegram's own answers decide it: getMe, then getChatMember.
   */
  async groupReading(chatId?: string): Promise<GroupReading> {
    if (!this.me) await this.learnName();
    if (this.me?.readsAll) return { everyMessage: true };
    if (chatId && this.me) {
      const member = z.object({ status: z.string() }).passthrough().safeParse(
        await this.call("getChatMember", { chat_id: telegramTarget(chatId).chat_id, user_id: this.me.id }).catch(() => null));
      if (member.success && ["administrator", "creator"].includes(member.data.status)) return { everyMessage: true };
    }
    return { everyMessage: false, fix: telegramPrivacyFix(this.username) };
  }
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
    const body: Record<string, unknown> = { ...telegramTarget(chatId), ...rich(text, format),
      ...(replyToMessageId && /^\d+$/.test(replyToMessageId) ? { reply_parameters: { message_id: Number(replyToMessageId), allow_sending_without_reply: true } } : {}),
    };
    const result = await this.call("sendMessage", body, false, false, gate).catch((error: unknown) => {
      if (!entitiesRefused(error, body)) throw error;
      const { entities: _dropped, ...plain } = body;
      return this.call("sendMessage", { ...plain, text }, false, false, gate);
    });
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
  /** UP-CHAT-005: a spoken reply is made as OGG/Opus for this app, so it shows as a voice bubble (see `sendVoice`). */
  readonly voiceNoteType = "audio/ogg";
  /**
   * Sends a spoken reply. OGG/Opus goes out with `sendVoice` and shows as a voice bubble; anything else (MP3 or WAV,
   * when this computer could not convert it) goes out with `sendAudio` as an audio file, as OpenClaw's
   * extensions/telegram/src/voice.ts `resolveTelegramVoiceSend` (MIT) falls back. Telegram wants the file as a form upload.
   */
  async sendVoice(chatId: string, audio: Uint8Array, mediaType: string, replyToMessageId?: string): Promise<string | undefined> {
    const form = new FormData();
    const target = telegramTarget(chatId);
    form.append("chat_id", String(target.chat_id));
    if (target.message_thread_id !== undefined) form.append("message_thread_id", String(target.message_thread_id));
    const bubble = isOggOpus(mediaType);
    const method = bubble ? "sendVoice" : "sendAudio";
    const extension = bubble ? "ogg" : mediaType.includes("wav") ? "wav" : "mp3";
    form.append(bubble ? "voice" : "audio", new Blob([new Uint8Array(audio)], { type: mediaType }), `reply.${extension}`);
    // A quoted message that was deleted meanwhile does not stop the reply (as `send` does).
    if (replyToMessageId && /^\d+$/.test(replyToMessageId))
      form.append("reply_parameters", JSON.stringify({ message_id: Number(replyToMessageId), allow_sending_without_reply: true }));
    const response = await this.fetch(`${this.base}/${method}`, { method: "POST", body: form, signal: AbortSignal.timeout(60000) });
    const parsed = responseSchema.parse(await response.json());
    if (!parsed.ok) throw new Error(`Telegram ${method} failed: ${parsed.description ?? response.status}`);
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
  private async poll(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    while (!this.stopping.signal.aborted) {
      try {
        this.advance(); // Retry a failed position write before asking Telegram to acknowledge it.
        // "callback_query" has to be asked for by name, or a pressed button never arrives at all.
        const renumbered = this.mayBeRenumbered();
        const updates = z.array(updateSchema).parse(await this.call("getUpdates", { offset: renumbered ? 0 : this.offset, timeout: this.pollTimeout, allowed_updates: ["message", "edited_message", "callback_query"] }, true));
        this.contactAt = Date.now(); // Staying connected: Telegram answered, even with nothing new
        if (updates.length) this.takeNumbering(updates, renumbered);
        if (this.refused || this.nameUnknown) { // P17-D §8: the token works again, or Telegram is reachable at last
          this.refused = null;
          await this.learnName(true).then(() => { this.nameUnknown = false; }, () => undefined);
        }
        for (const update of updates.sort((a, b) => a.update_id - b.update_id)) {
          // Telegram irrevocably acknowledges every lower id when getUpdates receives offset.
          // Repeated polls at the oldest unfinished id must not hand that id to the router twice.
          if (update.update_id < this.seenThrough) continue;
          this.seenThrough = update.update_id + 1;
          // Handed over without waiting: a message sent while a task works is a note for that task,
          // and it has to be read while the task is still going. The router keeps one task per chat.
          const pressed = update.callback_query && this.fromButton(update.callback_query);
          if (pressed) { this.handOver(update.update_id, pressed, onMessage); continue; }
          const edited = !update.message && update.edited_message ? this.inbound(update.edited_message) : null;
          const message = update.message ? this.inbound(update.message) : edited ? { ...edited, edited: true } : null;
          this.handOver(update.update_id, message || null, onMessage);
        }
      } catch (error) {
        if (this.stopping.signal.aborted) return;
        // P17-D §8: 401 is Telegram refusing the token itself. Nothing arrives until it is replaced, so it is
        // reported in the channel's health and asked again only every half minute.
        const refusedToken = (error as { status?: unknown }).status === 401;
        if (refusedToken) this.refused = tokenRefused;
        await this.pause(refusedToken ? this.refusedRetryMs : 2000);
      }
    }
  }
  /**
   * Telegram numbers a bot's next update afresh after a week without any: "If there are no new updates for at least a
   * week, then identifier of the next update will be chosen randomly instead of sequentially"
   * (https://core.telegram.org/bots/api#update). It can come out below the saved position, and asking with that
   * position would confirm it, and so lose it: "An update is considered confirmed as soon as getUpdates is called with
   * an offset higher than its update_id" (https://core.telegram.org/bots/api#getupdates). So once nothing has arrived
   * for a day, and nothing is being handled, the bot asks without its position (0: "the earliest unconfirmed update").
   * That repeats nothing: every answered update was confirmed long before, and updates "will not be kept longer
   * than 24 hours" (https://core.telegram.org/bots/api#getting-updates).
   */
  private mayBeRenumbered(): boolean {
    return this.offset > 0 && this.inFlight.size === 0 && Date.now() - this.lastUpdateAt >= this.renumberAfterMs;
  }
  /** An update below the position, when asked without it, is Telegram's new numbering: read on from there. */
  private takeNumbering(updates: { update_id: number }[], renumbered: boolean): void {
    this.lastUpdateAt = Date.now();
    const lowest = Math.min(...updates.map((update) => update.update_id));
    if (!renumbered || lowest >= this.offset) return;
    this.offset = 0; // the next position saved is in the new numbering
    this.seenThrough = lowest;
  }
  /**
   * Waits before asking again, cut short by stop(): replacing a refused token on its card stops this bot, and the
   * owner's save must not wait out the half minute before the next attempt.
   */
  private pause(ms: number): Promise<void> {
    const signal = this.stopping.signal;
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
    });
  }
  /**
   * mac3/never-break: hands one update to the router without waiting for it, and saves the read
   * position only up to the oldest message still being handled, so a crash never skips one.
   */
  /** Advances both the durable position and Telegram's requested acknowledgement together. */
  private advance(): void {
    const oldest = Math.min(...this.inFlight);
    const safe = Number.isFinite(oldest) ? oldest : this.seenThrough;
    if (safe <= this.offset) return;
    try { this.options.position?.save(safe); }
    catch { return; } // Do not acknowledge an update whose durable position failed to save.
    this.offset = safe;
  }
  private handOver(id: number, message: InboundMessage | null, onMessage: (message: InboundMessage) => Promise<void>): void {
    const settle = () => {
      this.inFlight.delete(id);
      this.advance();
    };
    if (!message) { settle(); return; }
    this.inFlight.add(id);
    try { void Promise.resolve(onMessage(message)).catch(() => undefined).finally(settle); }
    catch { settle(); }
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
      channel: this.id, chatId: topicAddress(chat.id, query.message?.message_thread_id), chatKind: chat.type === "private" ? "direct" : "group",
      ...(chat.title ? { chatTitle: chat.title } : {}),
      senderId: String(query.from.id),
      senderName: query.from.username ?? query.from.first_name ?? String(query.from.id),
      // The message belongs to the *question*, not the press. Distinct presses on the same
      // keyboard need distinct delivery identities (including a stale-press explanation).
      text: query.data, addressed: true, messageId: query.id,
    };
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
      const body: Record<string, unknown> = { chat_id: telegramTarget(chatId).chat_id, message_id: Number(messageId), ...rich(text, { spans: format?.spans, plain: format?.plain }) };
      await this.call("editMessageText", body, false, false, gate).catch((error: unknown) => {
        if (!entitiesRefused(error, body)) throw error;
        const { entities: _dropped, ...plain } = body;
        return this.call("editMessageText", { ...plain, text }, false, false, gate);
      });
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
    // Called by name ("Branch, …"). With privacy mode on Telegram only hands such a message over to an admin bot.
    const named = !direct && calledByName(written, [this.username, this.me?.firstName]);
    const text = mention && mentioned ? written.replace(new RegExp(mention, "ig"), "").trim() : written;
    return {
      channel: this.id, chatId: topicAddress(message.chat.id, message.message_thread_id), chatKind: direct ? "direct" : "group",
      ...(message.chat.title ? { chatTitle: message.chat.title } : {}),
      senderId: String(message.from.id), senderName: message.from.username ?? message.from.first_name ?? String(message.from.id),
      text: [telegramForwardContext(message.forward_origin), text, extra].filter(Boolean).join("\n"),
      addressed: direct || mentioned || replyToBot || named || (!!spoken && direct), messageId: String(message.message_id),
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
  /** One Bot API request. A `gate` (an owner's own-message edit or delete) is checked last before sending, and its
      signal aborts the request, including while the address is still being checked. */
  private async call(method: string, body: unknown, longPoll = false, stoppable = longPoll, gate?: SendGate): Promise<unknown> {
    const timeout = AbortSignal.timeout(longPoll ? (this.pollTimeout + 10) * 1000 : 20000);
    const signals = [timeout, ...(stoppable ? [this.stopping.signal] : []), ...(gate ? [gate.signal] : [])];
    const signal = signals.length > 1 ? AbortSignal.any(signals) : timeout;
    gate?.check();
    const response = await this.fetch(`${this.base}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
    });
    const parsed = responseSchema.parse(await response.json());
    if (!parsed.ok) throw Object.assign(new Error(`Telegram ${method} failed: ${parsed.description ?? response.status}`),
      { status: response.status, ...(parsed.parameters?.retry_after ? { retryAfter: parsed.parameters.retry_after } : {}) });
    return parsed.result;
  }
}

/** What to change in Telegram so a bot reads every message in its groups, in plain words. */
export function telegramPrivacyFix(username: string | null): string {
  return `Telegram's privacy mode is on for ${username ? `@${username}` : "this bot"}, so in groups it only sees messages that mention it, reply to it or are commands. `
    + "To answer every message, send /setprivacy to @BotFather, choose the bot and pick Disable, then remove the bot from the group and add it again; or make the bot an admin of the group.";
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
