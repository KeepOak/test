import { randomUUID } from "node:crypto";
import { attachmentKind, fetchCapped, voiceFileName } from "./media.js";
import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage, MessageFormat, OutgoingFile } from "./router.js";
import { matrixHtml } from "./progress-render.js";
import { handle } from "./email.js";
import { ReactionAnswers } from "./reaction-answers.js";
import { reconnectDelay } from "./ws-client.js";
import { catchUpBatch, MarkKeeper, type ChannelMark } from "./catch-up.js"; // mac6/bucket-16

/**
 * Matrix, over the ordinary client-server API with an access token. Matrix is not a webhook
 * service: nothing is posted to this computer. Instead one long request is held open asking "what
 * has happened since?", and when it answers the next one goes out. A dropped connection is retried
 * with a widening wait, and closing the channel stops the loop rather than leaving it retrying.
 *
 * **End-to-end encrypted rooms are not supported.** Messages in them arrive as `m.room.encrypted`
 * and Branch has no key to read them, so they are counted and reported in the channel's health
 * line rather than silently ignored. Invite the assistant to an unencrypted room.
 */
export interface MatrixOptions {
  id: string;
  /** The home server, for example https://matrix.org. */
  homeserver: string;
  /** An access token for the assistant's own Matrix account. */
  accessToken: string;
  /** The assistant's own user id (@branch:example.org), so its own posts are not answered. */
  userId: string;
  /** How long one "what has happened since?" request waits, in milliseconds. */
  syncTimeoutMs?: number;
  fetch?: typeof fetch;
  reconnectBaseMs?: number;
  /** mac6/bucket-16: where the last sync got to, kept across restarts so missed messages are answered. */
  mark?: ChannelMark;
}
const eventSchema = z.object({
  type: z.string(), event_id: z.string().optional(), sender: z.string().optional(),
  content: z.object({ msgtype: z.string().optional(), body: z.string().optional(),
    /** A file's own address on the homeserver (mxc://server/id), and what it is. */
    url: z.string().max(500).optional(),
    info: z.object({ mimetype: z.string().max(100).optional(), size: z.number().optional(), duration: z.number().optional() }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();
const syncSchema = z.object({
  next_batch: z.string(),
  rooms: z.object({
    join: z.record(z.string(), z.object({
      timeline: z.object({ events: z.array(eventSchema).default([]) }).passthrough().optional(),
    }).passthrough()).default({}),
  }).passthrough().optional(),
}).passthrough();

export class MatrixAdapter implements ChannelAdapter {
  readonly kind = "matrix";
  readonly id: string;
  /** Matrix has no hard limit, but a wall of text is unreadable; the ledger splits at this length. */
  readonly maxTextLength = 3500;
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private state: ChannelHealth = { state: "reconnecting", reason: "Connecting to Matrix" };
  private controller: AbortController | undefined;
  private stopping = false;
  private loop: Promise<void> | null = null;
  private since: string | undefined;
  private encryptedSeen = 0;
  /** Who wrote each recent message read here, so only its own sender's edit of it counts. */
  private readonly authors = new Map<string, string>();
  /** Room ids are longer than the delivery ledger allows, so long ones get a short handle. */
  private readonly rooms = new Map<string, string>();
  /** Original event ids are kept only for recent inbound messages, never accepted from a chat handle alone. */
  private readonly received = new Map<string, { roomId: string; eventId: string }>();
  private readonly reactions = new Map<string, { emoji: string; eventId: string }>();
  constructor(private readonly options: MatrixOptions) {
    this.id = options.id;
    this.base = options.homeserver.replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
  }
  botName(): string | null { return this.options.userId; }
  health(): ChannelHealth { return this.state; }
  /** Staying connected: when the home server last answered a sync (an empty one counts; it answers every 30 s). */
  private contactAt = Date.now();
  lastContact(): number { return this.contactAt; }
  /** The watchdog (and a wake from sleep) starts a stalled sync again from where it had got to. */
  async restart(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    await this.stop();
    this.stopping = false;
    await this.start(onMessage);
  }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.loop = this.run(onMessage);
    await Promise.race([this.loop, new Promise((resolve) => setTimeout(resolve, 50))]);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.controller?.abort();
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }
  /** Asks again and again what has happened, waiting longer each time the server will not answer. */
  private async run(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    const keeper = new MarkKeeper(this.options.mark); // mac6/bucket-16
    const saved = keeper.load();
    let resumed = this.since === undefined && !!saved; // mac6/bucket-16 integration: the first sync is capped
    this.since ??= saved ?? undefined;
    for (let attempt = 0; !this.stopping; attempt++) {
      try {
        const synced = await this.sync();
        this.contactAt = Date.now();
        const batch = resumed ? catchUpBatch(synced) : synced;
        resumed = false;
        this.state = { state: "connected", ...(this.encryptedSeen ? { reason: `${this.encryptedSeen} message(s) arrived in an encrypted room, which this assistant cannot read` } : {}) };
        attempt = -1;
        // Handed over without waiting, so a note can reach a task that is still working (see telegram.ts).
        const handling: Promise<unknown>[] = [];
        for (const message of batch) { if (this.stopping) return; handling.push(onMessage(message).catch(() => undefined)); }
        void keeper.after(this.since, handling);
        continue;
      } catch (error) {
        if (this.stopping) return;
        const reason = error instanceof Error ? error.message : String(error);
        this.state = { state: "reconnecting", reason: `Lost the Matrix connection: ${reason}` };
      }
      if (this.stopping) return;
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt + 1, this.options.reconnectBaseMs ?? 1000)));
    }
  }
  /** One long request. Returns the messages worth answering and remembers where we got to. */
  private async sync(): Promise<InboundMessage[]> {
    const wait = this.options.syncTimeoutMs ?? 30000;
    const address = new URL(`${this.base}/_matrix/client/v3/sync`);
    address.searchParams.set("timeout", String(wait));
    if (this.since) address.searchParams.set("since", this.since);
    this.controller = new AbortController();
    const response = await this.fetch(address.href, {
      headers: { authorization: `Bearer ${this.options.accessToken}` },
      redirect: "error", signal: this.controller.signal,
    });
    if (!response.ok) throw new Error(`Matrix would not answer (${response.status})`);
    const body = syncSchema.parse(await response.json());
    const first = this.since === undefined;
    this.since = body.next_batch;
    const messages: InboundMessage[] = [];
    for (const [roomId, room] of Object.entries(body.rooms?.join ?? {}))
      for (const event of room.timeline?.events ?? []) {
        if (event.type === "m.room.encrypted") { this.encryptedSeen++; continue; }
        const inbound = event.type === "m.reaction" ? this.answer(roomId, event) : this.inbound(roomId, event);
        // The first answer carries whatever was already there; answering it would reply to history.
        if (inbound && !first) messages.push(inbound);
      }
    return messages;
  }
  /** Questions a 👍 / 👎 annotation may answer, by the question's own event id (src/channels/reaction-answers.ts). */
  private readonly answers = new ReactionAnswers();
  watchAnswers(chatId: string, messageId: string, senderId: string, fingerprint: string): void {
    const eventId = this.sent.get(messageId);
    if (eventId) this.answers.watch(eventId, chatId, senderId, fingerprint);
  }
  /** An annotation on one of Branch's own questions, by the person it asked, in that room, is that question's answer. */
  private answer(roomId: string, event: z.infer<typeof eventSchema>): InboundMessage | null {
    const relates = z.object({ rel_type: z.literal("m.annotation"), event_id: z.string().max(300), key: z.string().max(40) }).passthrough()
      .safeParse((event.content as Record<string, unknown> | undefined)?.["m.relates_to"]);
    const sender = event.sender ?? "";
    if (!relates.success || !sender || sender === this.options.userId) return null;
    const chatId = handle(roomId, "room"), senderId = handle(sender, "who");
    const said = this.answers.read(relates.data.event_id, chatId, senderId, relates.data.key);
    if (!said) return null;
    if (chatId !== roomId) this.rooms.set(chatId, roomId);
    return { channel: this.id, chatId, chatKind: "group", chatTitle: roomId, senderId, senderName: sender, text: said, addressed: true,
      messageId: handle(event.event_id ?? randomUUID(), "msg") };
  }
  /**
   * Settings › Chat apps › Edited messages: a Matrix edit is a new event that replaces an earlier one (`m.replace`), with
   * the new words in `m.new_content`. It is read as that earlier message again, marked edited, by the same sender only.
   */
  private edited(roomId: string, event: z.infer<typeof eventSchema>): InboundMessage | null {
    const content = event.content as Record<string, unknown> | undefined;
    const relates = z.object({ rel_type: z.literal("m.replace"), event_id: z.string().max(300) }).passthrough().safeParse(content?.["m.relates_to"]);
    const fresh = z.object({ msgtype: z.literal("m.text"), body: z.string().min(1) }).passthrough().safeParse(content?.["m.new_content"]);
    if (!relates.success || !fresh.success) return null;
    const original = this.authors.get(relates.data.event_id);
    if (!original || original !== event.sender) return null; // only its own sender's edit of a message this adapter read
    const inbound = this.inbound(roomId, { ...event, event_id: relates.data.event_id, content: fresh.data });
    return inbound ? { ...inbound, edited: true } : null;
  }
  private inbound(roomId: string, event: z.infer<typeof eventSchema>): InboundMessage | null {
    if (event.type === "m.room.message" && ["m.image", "m.file", "m.video", "m.audio"].includes(event.content?.msgtype ?? "")) return this.fromFile(roomId, event);
    if (event.type === "m.reaction") return this.fromReaction(roomId, event);
    if (event.type !== "m.room.message" || event.content?.msgtype !== "m.text") return null;
    if (event.content && "m.new_content" in event.content) return this.edited(roomId, event);
    if (event.event_id && event.sender) {
      this.authors.set(event.event_id, event.sender);
      if (this.authors.size > 200) this.authors.delete(this.authors.keys().next().value!);
    }
    const text = event.content.body ?? "", sender = event.sender ?? "";
    if (!text || !sender || sender === this.options.userId) return null;
    const chatId = handle(roomId, "room");
    if (chatId !== roomId) this.rooms.set(chatId, roomId);
    const messageId = handle(event.event_id ?? randomUUID(), "msg");
    if (event.event_id) {
      this.received.set(messageId, { roomId, eventId: event.event_id });
      if (this.received.size > 200) this.received.delete(this.received.keys().next().value!);
    }
    const name = this.options.userId.split(":")[0]!.replace(/^@/, "");
    return {
      channel: this.id, chatId, chatKind: "group", chatTitle: roomId,
      senderId: handle(sender, "who"), senderName: sender, text,
      addressed: text.includes(this.options.userId) || text.includes(name),
      messageId,
    };
  }
  /**
   * CHAT-105: a picture, video or file sent to the room comes in as the task's material, and an audio message as a voice
   * note to transcribe. Fetched only once the message is answered, from this homeserver's own authenticated media.
   */
  private fromFile(roomId: string, event: z.infer<typeof eventSchema>): InboundMessage | null {
    const content = event.content!, sender = event.sender ?? "";
    const mxc = /^mxc:\/\/([^/]+)\/([A-Za-z0-9_-]+)$/.exec(content.url ?? "");
    if (!mxc || !sender || sender === this.options.userId) return null;
    const chatId = handle(roomId, "room");
    if (chatId !== roomId) this.rooms.set(chatId, roomId);
    const mediaType = content.info?.mimetype?.split(";")[0] ?? (content.msgtype === "m.image" ? "image/jpeg" : "application/octet-stream");
    const host = new RegExp(`^${new URL(this.base).hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    const bytes = () => fetchCapped(this.fetch, `${this.base}/_matrix/client/v1/media/download/${encodeURIComponent(mxc[1]!)}/${encodeURIComponent(mxc[2]!)}`,
      { headers: { authorization: `Bearer ${this.options.accessToken}` } }, host, content.msgtype === "m.audio" ? "voice note" : "file", content.info?.size ?? 0);
    const base = { channel: this.id, chatId, chatKind: "group" as const, chatTitle: roomId, senderId: handle(sender, "who"), senderName: sender,
      text: "", addressed: false, messageId: handle(event.event_id ?? randomUUID(), "msg") };
    if (content.msgtype === "m.audio")
      return { ...base, voice: { mediaType, seconds: content.info?.duration !== undefined ? content.info.duration / 1000 : undefined, bytes } };
    return { ...base, attachments: [{ name: content.body || "file", sourceId: mxc[2]!, mediaType, kind: attachmentKind(mediaType),
      ...(content.info?.size !== undefined ? { size: content.info.size } : {}), bytes }] };
  }
  /** Matrix homeservers take 50 MB by default; one set lower refuses the upload and says so. */
  readonly maxFileBytes = 50 * 1024 * 1024;
  /** CHAT-105: a file into the room, uploaded to this homeserver first, as a picture, video, audio or file. */
  async sendFile(chatId: string, file: OutgoingFile): Promise<string | undefined> {
    const upload = await this.fetch(`${this.base}/_matrix/media/v3/upload?filename=${encodeURIComponent(file.name)}`, {
      method: "POST", headers: { authorization: `Bearer ${this.options.accessToken}`, "content-type": file.mediaType },
      body: new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }), redirect: "error", signal: AbortSignal.timeout(120000),
    });
    if (upload.status === 413) throw new Error("The Matrix homeserver said the file is too large");
    if (!upload.ok) throw new Error(`The Matrix homeserver refused the file (${upload.status})`);
    const { content_uri: uri } = z.object({ content_uri: z.string().regex(/^mxc:\/\//) }).passthrough().parse(await upload.json());
    const kind = attachmentKind(file.mediaType);
    const msgtype = file.mediaType.startsWith("audio/") ? "m.audio" : kind === "picture" ? "m.image" : kind === "video" ? "m.video" : "m.file";
    const eventId = await this.put(chatId, { msgtype, body: file.name, url: uri, info: { mimetype: file.mediaType, size: file.bytes.byteLength },
      ...(file.voice ? { "org.matrix.msc3245.voice": {}, "org.matrix.msc1767.audio": {} } : {}) });
    if (file.caption) await this.send(chatId, file.caption);
    return eventId ? handle(eventId, "msg") : undefined;
  }
  /** CHAT-094: a spoken reply, as an audio message clients show as a voice message. */
  async sendVoice(chatId: string, audio: Uint8Array, mediaType: string): Promise<string | undefined> {
    return this.sendFile(chatId, { name: voiceFileName(mediaType), mediaType, bytes: audio, voice: true });
  }
  /** The events this adapter sent, by the short handle it gave them, so a message it sent can be edited (the newest 200). */
  private readonly sent = new Map<string, string>();
  /** "typing…" in the room for a few seconds. */
  async sendTyping(chatId: string): Promise<void> {
    const roomId = this.rooms.get(chatId) ?? chatId;
    const address = `${this.base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.options.userId)}`;
    const response = await this.fetch(address, {
      method: "PUT", headers: { authorization: `Bearer ${this.options.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ typing: true, timeout: 6000 }), redirect: "error", signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`Matrix refused the typing notice (${response.status})`);
  }
  /** Status reactions annotate only a recently received event in this exact room. */
  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    const target = this.received.get(messageId), roomId = this.rooms.get(chatId) ?? chatId;
    if (!target || target.roomId !== roomId) throw new Error("Matrix: that message is not in this room");
    const prior = this.reactions.get(messageId);
    if (prior?.emoji === emoji) return;
    if (prior) { await this.redact(roomId, prior.eventId); this.reactions.delete(messageId); }
    const eventId = await this.put(chatId, { "m.relates_to": { rel_type: "m.annotation", event_id: target.eventId, key: emoji } }, "m.reaction");
    if (!eventId) throw new Error("Matrix did not identify the reaction it sent");
    this.reactions.set(messageId, { emoji, eventId });
    if (this.reactions.size > 200) this.reactions.delete(this.reactions.keys().next().value!);
  }
  private async redact(roomId: string, eventId: string): Promise<void> {
    const address = `${this.base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${randomUUID()}`;
    const response = await this.fetch(address, { method: "PUT", headers: { authorization: `Bearer ${this.options.accessToken}`, "content-type": "application/json" },
      body: "{}", redirect: "error", signal: AbortSignal.timeout(20000) });
    if (response.status === 429) {
      const body = z.object({ retry_after_ms: z.number().optional() }).passthrough().safeParse(await response.json().catch(() => ({})));
      throw Object.assign(new Error("Matrix asked us to slow down"), { retryAfter: ((body.success ? body.data.retry_after_ms : undefined) ?? 1000) / 1000 });
    }
    if (!response.ok) throw new Error(`Matrix refused to replace the status reaction (${response.status})`);
  }
  async send(chatId: string, text: string, replyTo?: string, format?: MessageFormat): Promise<string | undefined> {
    // CHAT-116: a reply quotes the person's own message (m.in_reply_to), only one received in this same room.
    const quoted = replyTo ? this.received.get(replyTo) : undefined;
    const inReply = quoted && quoted.roomId === (this.rooms.get(chatId) ?? chatId) ? { "m.relates_to": { "m.in_reply_to": { event_id: quoted.eventId } } } : {};
    const eventId = await this.put(chatId, { ...MatrixAdapter.content(text.slice(0, this.maxTextLength), format), ...inReply });
    if (!eventId) return undefined;
    const short = handle(eventId, "msg");
    this.sent.set(short, eventId);
    if (this.sent.size > 200) this.sent.delete(this.sent.keys().next().value!);
    return short;
  }
  /**
   * Replaces the words of a message this adapter sent, the Matrix way: a new event that says it replaces the old one
   * (`m.replace`), which every client shows in the old one's place.
   */
  async edit(chatId: string, messageId: string, text: string, format?: MessageFormat): Promise<void> {
    const eventId = this.sent.get(messageId);
    if (!eventId) throw new Error("Matrix: that message was not sent from here, so it cannot be edited");
    const content = MatrixAdapter.content(text.slice(0, this.maxTextLength), format);
    await this.put(chatId, { ...content, body: `* ${content.body}`, "m.new_content": content,
      "m.relates_to": { rel_type: "m.replace", event_id: eventId } });
  }
  /** Redacts an event this adapter sent (only its own, by the handle it gave it). */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    const eventId = this.sent.get(messageId);
    if (!eventId) throw new Error("Matrix: that message was not sent from here, so it cannot be removed");
    await this.redact(this.rooms.get(chatId) ?? chatId, eventId);
  }
  /** Plain words, with the code as Matrix's HTML beside them when there is any. */
  private static content(text: string, format?: MessageFormat): Record<string, unknown> {
    return { msgtype: "m.text", body: text,
      ...(!format?.plain && format?.spans?.length ? { format: "org.matrix.custom.html", formatted_body: matrixHtml(text, format.spans) } : {}) };
  }
  /**
   * CHAT-063: Matrix has no buttons, so a question carries reactions to tap. The words go out with the answers named,
   * then the assistant puts each answer's reaction on its own question, so a tap is one touch; a reaction by anybody
   * else on that question is read back as that answer (the homeserver vouches for who reacted).
   */
  async sendButtons(chatId: string, text: string, buttons: { label: string; value: string }[]): Promise<string | undefined> {
    const choices = buttons.map((button) => ({ ...button, emoji: button.value.startsWith("y") ? "👍" : button.value.startsWith("n") ? "👎" : "✅" }));
    const named = choices.map((choice) => `${choice.emoji} ${choice.label}`).join("   ");
    const short = await this.send(chatId, `${text}\n\nReact ${named} (or reply y or n).`);
    const eventId = short ? this.sent.get(short) : undefined;
    if (!eventId) return short;
    this.questions.set(eventId, new Map(choices.map((choice) => [choice.emoji, choice.value])));
    if (this.questions.size > 50) this.questions.delete(this.questions.keys().next().value!);
    for (const choice of choices)
      await this.put(chatId, { "m.relates_to": { rel_type: "m.annotation", event_id: eventId, key: choice.emoji } }, "m.reaction").catch(() => undefined);
    return short;
  }
  /** A reaction on one of its questions, by anybody but the assistant, as an addressed message carrying that answer. */
  private fromReaction(roomId: string, event: z.infer<typeof eventSchema>): InboundMessage | null {
    const relates = z.object({ rel_type: z.literal("m.annotation"), event_id: z.string(), key: z.string() }).passthrough()
      .safeParse((event.content as Record<string, unknown> | undefined)?.["m.relates_to"]);
    const sender = event.sender ?? "";
    if (!relates.success || !sender || sender === this.options.userId) return null;
    const value = this.questions.get(relates.data.event_id)?.get(relates.data.key.replace(/️/g, ""));
    if (!value) return null;
    const chatId = handle(roomId, "room");
    if (chatId !== roomId) this.rooms.set(chatId, roomId);
    return { channel: this.id, chatId, chatKind: "group", chatTitle: roomId, senderId: handle(sender, "who"), senderName: sender,
      text: value, addressed: true, messageId: handle(event.event_id ?? randomUUID(), "msg") };
  }
  /** Questions this adapter asked with reactions: the question's event, and what each reaction on it answers. */
  private readonly questions = new Map<string, Map<string, string>>();
  private async put(chatId: string, content: Record<string, unknown>, eventType = "m.room.message"): Promise<string | undefined> {
    const roomId = this.rooms.get(chatId) ?? chatId;
    const address = `${this.base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${randomUUID()}`;
    const response = await this.fetch(address, {
      method: "PUT", headers: { authorization: `Bearer ${this.options.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(content), redirect: "error", signal: AbortSignal.timeout(20000),
    });
    if (response.status === 429) {
      const wait = z.object({ retry_after_ms: z.number().optional() }).passthrough().safeParse(await response.json().catch(() => ({})));
      throw Object.assign(new Error("Matrix asked us to slow down"), { retryAfter: ((wait.success ? wait.data.retry_after_ms : undefined) ?? 1000) / 1000 });
    }
    if (!response.ok) throw new Error(`Matrix refused the message (${response.status})`);
    const parsed = z.object({ event_id: z.string().optional() }).passthrough().safeParse(await response.json().catch(() => ({})));
    return parsed.success ? parsed.data.event_id : undefined;
  }
}
