import { calledByName, type GroupReading } from "./addressing.js";
import { matrixPictureContent } from "./matrix-picture.js";
import { createHash, randomUUID } from "node:crypto";
import { attachmentKind, fetchCapped, voiceFileName } from "./media.js";
import { z } from "zod";
import type { ChannelAdapter, ChannelHealth, InboundMessage, MessageFormat, OutgoingFile, SendGate } from "./router.js";
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
  content: z.object({ msgtype: z.string().optional(), body: z.string().optional(), formatted_body: z.string().optional(),
    /** Intentional mentions (Matrix 1.7): the users a message is for. */
    "m.mentions": z.object({ user_ids: z.array(z.string()).optional() }).passthrough().optional(),
    "m.relates_to": z.object({ "m.in_reply_to": z.object({ event_id: z.string().optional() }).passthrough().optional() }).passthrough().optional(),
    /** A file's own address on the homeserver (mxc://server/id), and what it is. */
    url: z.string().max(500).optional(),
    info: z.object({ mimetype: z.string().max(100).optional(), size: z.number().optional(), duration: z.number().optional() }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();
const syncSchema = z.object({
  next_batch: z.string(),
  account_data: z.object({ events: z.array(eventSchema).default([]) }).passthrough().optional(),
  rooms: z.object({
    join: z.record(z.string(), z.object({
      timeline: z.object({ events: z.array(eventSchema).default([]) }).passthrough().optional(),
      state: z.object({ events: z.array(eventSchema).default([]) }).passthrough().optional(),
      /** How many have joined, when the server says: two is a direct chat with the assistant. */
      summary: z.object({ "m.joined_member_count": z.number().int().min(0).optional() }).passthrough().optional(),
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
  readonly pictureViewOnly = true;
  private readonly directPeers = new Map<string, string | null>();
  private readonly encryptedRooms = new Set<string>();
  private privacyOverflow = false;
  private readonly memberCounts = new Map<string, number>();
  private readonly pictures = new Map<string, { eventId: string; roomId: string; peer: string }>();
  /** Who wrote each recent message read here, so only its own sender's edit of it counts. */
  private readonly authors = new Map<string, string>();
  /** Room ids are longer than the delivery ledger allows, so long ones get a short handle. */
  private readonly rooms = new Map<string, string>();
  /** Original event ids are kept only for recent inbound messages, never accepted from a chat handle alone. */
  private readonly received = new Map<string, { roomId: string; eventId: string; chatId: string }>();
  /** Thread roots stay case-sensitive, following OpenClaw monitor/threads.ts (MIT); Branch-specific implementation. */
  private readonly threads = new Map<string, string>();
  private readonly eventChats = new Map<string, string>();
  private readonly sentChats = new Map<string, string>();
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
    this.roomPrivacy(body);
    const messages: InboundMessage[] = [];
    for (const [roomId, room] of Object.entries(body.rooms?.join ?? {})) {
      for (const event of room.timeline?.events ?? []) {
        if (event.type === "m.room.encrypted") { this.encryptedSeen++; continue; }
        const inbound = event.type === "m.reaction" ? this.answer(roomId, event) : this.inbound(roomId, event);
        // The first answer carries whatever was already there; answering it would reply to history.
        if (inbound && !first) messages.push(inbound);
      }
    }
    for (const [index, message] of messages.entries()) {
      const target = this.replyTargets.get(message);
      if (target && await this.repliedToMe(target)) messages[index] = { ...message, addressed: true };
    }
    return messages;
  }
  /** Only this account's direct-room data plus a known two-member room can select the direct-chat path. */
  private roomPrivacy(body: z.infer<typeof syncSchema>): void {
    const direct = body.account_data?.events.find(event => event.type === "m.direct");
    if (direct) {
      this.directPeers.clear();
      const parsed = z.record(z.string(), z.array(z.string().max(500)).max(1000)).safeParse(direct.content);
      if (parsed.success) for (const [peer, rooms] of Object.entries(parsed.data).slice(0, 1000)) {
        if (peer === this.options.userId) continue;
        for (const room of rooms) {
          if (this.directPeers.size >= 1000 && !this.directPeers.has(room)) continue;
          const before = this.directPeers.get(room);
          this.directPeers.set(room, before === undefined || before === peer ? peer : null);
        }
      }
    }
    for (const [roomId, room] of Object.entries(body.rooms?.join ?? {})) {
      const events = [...room.state?.events ?? [], ...room.timeline?.events ?? []];
      if (events.some(event => event.type === "m.room.encryption" || event.type === "m.room.encrypted")) {
        if (this.encryptedRooms.size >= 1000 && !this.encryptedRooms.has(roomId)) this.privacyOverflow = true;
        else this.encryptedRooms.add(roomId);
      }
      const count = room.summary?.["m.joined_member_count"];
      if (count !== undefined) this.memberCounts.set(roomId, count);
      else if (room.timeline?.limited === true || events.some(event => event.type === "m.room.member")) this.memberCounts.delete(roomId);
    }
    while (this.memberCounts.size > 1000) this.memberCounts.delete(this.memberCounts.keys().next().value!);
  }
  private directRoom(roomId: string): boolean {
    return !this.privacyOverflow && !!this.directPeers.get(roomId) && this.memberCounts.get(roomId) === 2 && !this.encryptedRooms.has(roomId);
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
    const chatId = this.eventChats.get(`${roomId}:${relates.data.event_id}`), senderId = handle(sender, "who");
    if (!chatId) return null;
    const said = this.answers.read(relates.data.event_id, chatId, senderId, relates.data.key);
    if (!said) return null;
    if (chatId !== roomId) this.rooms.set(chatId, roomId);
    return { channel: this.id, chatId, chatKind: this.directRoom(roomId) ? "direct" : "group", chatTitle: roomId, senderId, senderName: sender, text: said, addressed: true,
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
    const chatId = this.eventChats.get(`${roomId}:${relates.data.event_id}`);
    if (!chatId) return null;
    const root = this.threads.get(chatId);
    const renewed = root ? { ...fresh.data, "m.relates_to": { rel_type: "m.thread", event_id: root } } : fresh.data;
    const inbound = this.inbound(roomId, { ...event, event_id: relates.data.event_id, content: renewed });
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
    const chatId = this.chat(roomId, event.content);
    const messageId = handle(event.event_id ?? randomUUID(), "msg");
    if (event.event_id) {
      this.received.set(messageId, { roomId, eventId: event.event_id, chatId });
      this.rememberEvent(roomId, event.event_id, chatId);
      if (this.received.size > 200) this.received.delete(this.received.keys().next().value!);
    }
    const name = this.options.userId.split(":")[0]!.replace(/^@/, "");
    // A direct room (directRoom: a known direct peer, two members, unencrypted) is a direct chat; elsewhere it is addressed.
    const direct = this.directRoom(roomId);
    const content = event.content ?? {};
    const mentioned = text.includes(this.options.userId) || (content.formatted_body ?? "").includes(this.options.userId)
      || (content["m.mentions"]?.user_ids ?? []).includes(this.options.userId);
    const replyTo = content["m.relates_to"]?.["m.in_reply_to"]?.event_id;
    const repliedTo = !!replyTo && [...this.sent.values()].includes(replyTo);
    const message: InboundMessage = {
      channel: this.id, chatId, chatKind: direct ? "direct" : "group", chatTitle: roomId,
      senderId: handle(sender, "who"), senderName: sender, text,
      addressed: direct || mentioned || repliedTo || calledByName(text, [name]),
      messageId,
    };
    if (replyTo && !message.addressed) this.replyTargets.set(message, { roomId, eventId: replyTo });
    return message;
  }
  /** An unencrypted room hands the assistant every message in it. */
  async groupReading(): Promise<GroupReading> { return { everyMessage: true }; }
  /**
   * CHAT-105: a picture, video or file sent to the room comes in as the task's material, and an audio message as a voice
   * note to transcribe. Fetched only once the message is answered, from this homeserver's own authenticated media.
   */
  private fromFile(roomId: string, event: z.infer<typeof eventSchema>): InboundMessage | null {
    const content = event.content!, sender = event.sender ?? "";
    const mxc = /^mxc:\/\/([^/]+)\/([A-Za-z0-9_-]+)$/.exec(content.url ?? "");
    if (!mxc || !sender || sender === this.options.userId) return null;
    const chatId = this.chat(roomId, content);
    if (event.event_id) {
      this.received.set(handle(event.event_id, "msg"), { roomId, eventId: event.event_id, chatId });
      if (this.received.size > 200) this.received.delete(this.received.keys().next().value!);
      this.rememberEvent(roomId, event.event_id, chatId);
    }
    const mediaType = content.info?.mimetype?.split(";")[0] ?? (content.msgtype === "m.image" ? "image/jpeg" : "application/octet-stream");
    const host = new RegExp(`^${new URL(this.base).hostname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    const bytes = () => fetchCapped(this.fetch, `${this.base}/_matrix/client/v1/media/download/${encodeURIComponent(mxc[1]!)}/${encodeURIComponent(mxc[2]!)}`,
      { headers: { authorization: `Bearer ${this.options.accessToken}` } }, host, content.msgtype === "m.audio" ? "voice note" : "file", content.info?.size ?? 0);
    // #649: a room of two is a direct chat, so a file sent there is for the assistant; in a group it waits to be asked about.
    const direct = this.directRoom(roomId);
    const base = { channel: this.id, chatId, chatKind: direct ? "direct" as const : "group" as const, ...(direct ? {} : { chatTitle: roomId }),
      senderId: handle(sender, "who"), senderName: sender, text: "", addressed: direct, messageId: handle(event.event_id ?? randomUUID(), "msg") };
    if (content.msgtype === "m.audio")
      return { ...base, voice: { mediaType, seconds: content.info?.duration !== undefined ? content.info.duration / 1000 : undefined, bytes } };
    return { ...base, attachments: [{ name: content.body || "file", sourceId: mxc[2]!, mediaType, kind: attachmentKind(mediaType),
      ...(content.info?.size !== undefined ? { size: content.info.size } : {}), bytes }] };
  }
  /** Matrix homeservers take 50 MB by default; one set lower refuses the upload and says so. */
  readonly maxFileBytes = 50 * 1024 * 1024;
  /** CHAT-105: a file into the room, uploaded to this homeserver first, as a picture, video, audio or file. */
  async sendFile(chatId: string, file: OutgoingFile): Promise<string | undefined> {
    const uri = await this.uploadFile(file);
    const kind = attachmentKind(file.mediaType);
    const msgtype = file.mediaType.startsWith("audio/") ? "m.audio" : kind === "picture" ? "m.image" : kind === "video" ? "m.video" : "m.file";
    const eventId = await this.put(chatId, { msgtype, body: file.name, url: uri, info: { mimetype: file.mediaType, size: file.bytes.byteLength },
      ...(file.voice ? { "org.matrix.msc3245.voice": {}, "org.matrix.msc1767.audio": {} } : {}) });
    if (file.caption) await this.send(chatId, file.caption);
    return eventId ? handle(eventId, "msg") : undefined;
  }
  private async uploadFile(file: OutgoingFile): Promise<string> {
    const upload = await this.fetch(`${this.base}/_matrix/media/v3/upload?filename=${encodeURIComponent(file.name)}`, {
      method: "POST", headers: { authorization: `Bearer ${this.options.accessToken}`, "content-type": file.mediaType },
      body: new Blob([new Uint8Array(file.bytes)], { type: file.mediaType }), redirect: "error", signal: AbortSignal.timeout(120000),
    });
    if (upload.status === 413) throw new Error("The Matrix homeserver said the file is too large");
    if (!upload.ok) throw new Error(`The Matrix homeserver refused the file (${upload.status})`);
    const { content_uri: uri } = z.object({ content_uri: z.string().regex(/^mxc:\/\//) }).passthrough().parse(await upload.json());
    return uri;
  }
  /** Recheck current membership and encryption before and after an upload. */
  private async pictureRoom(chatId: string, expectedPeer?: string): Promise<{ roomId: string; peer: string }> {
    const roomId = this.rooms.get(chatId) ?? chatId, peer = this.directPeers.get(roomId);
    if (!peer || (expectedPeer && peer !== expectedPeer) || !this.directRoom(roomId)) throw new Error("Matrix pictures require a known unencrypted direct room.");
    const base = `${this.base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}`;
    const options = { headers: { authorization: `Bearer ${this.options.accessToken}` }, redirect: "error" as const, signal: AbortSignal.timeout(20000) };
    const members = await this.fetch(`${base}/joined_members`, options);
    if (!members.ok) throw new Error("Matrix could not verify the picture audience.");
    const joined = z.object({ joined: z.record(z.string(), z.unknown()) }).parse(await members.json()).joined;
    if (Object.keys(joined).length !== 2 || !(this.options.userId in joined) || !(peer in joined)) throw new Error("Matrix pictures are limited to two-member direct rooms.");
    const encryption = await this.fetch(`${base}/state/m.room.encryption`, options);
    const missing = encryption.status === 404 && z.object({ errcode: z.literal("M_NOT_FOUND") }).passthrough().safeParse(await encryption.json()).success;
    if (!missing || !this.directRoom(roomId) || this.directPeers.get(roomId) !== peer) throw new Error("Matrix pictures require a currently unencrypted direct room.");
    return { roomId, peer };
  }
  private async pictureContent(chatId: string, file: OutgoingFile): Promise<{ roomId: string; peer: string; content: Record<string, unknown> }> {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.mediaType) || !file.bytes.byteLength || file.bytes.byteLength > 2 * 1024 * 1024)
      throw new Error("Matrix live pictures must be supported images of at most 2 MB.");
    const { roomId, peer } = await this.pictureRoom(chatId), url = await this.uploadFile(file);
    if ((await this.pictureRoom(chatId, peer)).roomId !== roomId) throw new Error("The Matrix picture audience changed.");
    return { roomId, peer, content: matrixPictureContent(file, url) };
  }
  /** View-only: Matrix has no inline owner browser control buttons. */
  async sendPicture(chatId: string, file: OutgoingFile, _buttons: { label: string; value: string }[], replyToMessageId?: string): Promise<string | undefined> {
    const { roomId, peer, content } = await this.pictureContent(chatId, file), reply = replyToMessageId ? this.received.get(replyToMessageId) : undefined;
    const eventId = await this.put(chatId, { ...content, ...(reply?.roomId === roomId ? { "m.relates_to": { "m.in_reply_to": { event_id: reply.eventId } } } : {}) });
    if (!eventId) throw new Error("Matrix did not identify the picture it sent.");
    const short = handle(eventId, "msg"); this.pictures.set(short, { roomId, eventId, peer });
    if (this.pictures.size > 200) this.pictures.delete(this.pictures.keys().next().value!);
    return short;
  }
  async editPicture(chatId: string, messageId: string, file: OutgoingFile, _buttons: { label: string; value: string }[]): Promise<void> {
    const original = this.pictures.get(messageId), roomId = this.rooms.get(chatId) ?? chatId;
    if (!original || original.roomId !== roomId) throw new Error("Matrix: that picture was not sent in this room.");
    if (this.directPeers.get(roomId) !== original.peer) throw new Error("The Matrix direct-room peer changed.");
    const { content, peer } = await this.pictureContent(chatId, file);
    if (peer !== original.peer) throw new Error("The Matrix direct-room peer changed.");
    if (!await this.put(chatId, { ...content, body: `* ${content.body}`, "m.new_content": content,
      "m.relates_to": { rel_type: "m.replace", event_id: original.eventId } })) throw new Error("Matrix did not identify the picture edit.");
  }
  /** CHAT-094: a spoken reply, as an audio message clients show as a voice message. */
  async sendVoice(chatId: string, audio: Uint8Array, mediaType: string): Promise<string | undefined> {
    return this.sendFile(chatId, { name: voiceFileName(mediaType), mediaType, bytes: audio, voice: true });
  }
  /** Replies to an event no longer in `sent` (sent before a restart, or older than the newest 200): asked about in `sync`. */
  private readonly replyTargets = new WeakMap<InboundMessage, { roomId: string; eventId: string }>();
  /** A reply to one of this account's own events is addressed; the server says who sent it. A failed lookup is not addressed. */
  private async repliedToMe(target: { roomId: string; eventId: string }): Promise<boolean> {
    const address = `${this.base}/_matrix/client/v3/rooms/${encodeURIComponent(target.roomId)}/event/${encodeURIComponent(target.eventId)}`;
    try {
      const response = await this.fetch(address, { headers: { authorization: `Bearer ${this.options.accessToken}` },
        redirect: "error", signal: AbortSignal.timeout(10000) });
      if (!response.ok) return false;
      const parsed = z.object({ sender: z.string() }).passthrough().safeParse(await response.json());
      return parsed.success && parsed.data.sender === this.options.userId;
    } catch { return false; }
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
    if (target.chatId !== chatId) throw new Error("Matrix: that message is not in this thread");
    if (prior?.emoji === emoji) return;
    if (prior) { await this.redact(roomId, prior.eventId); this.reactions.delete(messageId); }
    const eventId = await this.put(chatId, { "m.relates_to": { rel_type: "m.annotation", event_id: target.eventId, key: emoji } }, "m.reaction");
    if (!eventId) throw new Error("Matrix did not identify the reaction it sent");
    this.reactions.set(messageId, { emoji, eventId });
    if (this.reactions.size > 200) this.reactions.delete(this.reactions.keys().next().value!);
  }
  /** A `gate` (an owner's own-message delete) is checked last before sending, and its signal aborts the request. */
  private async redact(roomId: string, eventId: string, gate?: SendGate): Promise<void> {
    const address = `${this.base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${randomUUID()}`;
    const timeout = AbortSignal.timeout(20000), signal = gate ? AbortSignal.any([timeout, gate.signal]) : timeout;
    gate?.check();
    const response = await this.fetch(address, { method: "PUT", headers: { authorization: `Bearer ${this.options.accessToken}`, "content-type": "application/json" },
      body: "{}", redirect: "error", signal });
    if (response.status === 429) {
      const body = z.object({ retry_after_ms: z.number().optional() }).passthrough().safeParse(await response.json().catch(() => ({})));
      throw Object.assign(new Error("Matrix asked us to slow down"), { retryAfter: ((body.success ? body.data.retry_after_ms : undefined) ?? 1000) / 1000 });
    }
    if (!response.ok) throw new Error(`Matrix refused to replace the status reaction (${response.status})`);
  }
  async send(chatId: string, text: string, replyTo?: string, format?: MessageFormat, gate?: SendGate): Promise<string | undefined> {
    // CHAT-116: a reply quotes the person's own message (m.in_reply_to), only one received in this same room.
    const quoted = replyTo ? this.received.get(replyTo) : undefined;
    const inReply = quoted && quoted.chatId === chatId ? { "m.relates_to": { "m.in_reply_to": { event_id: quoted.eventId } } } : {};
    const eventId = await this.put(chatId, { ...MatrixAdapter.content(text.slice(0, this.maxTextLength), format), ...inReply }, "m.room.message", gate);
    if (!eventId) return undefined;
    const short = handle(eventId, "msg");
    this.sent.set(short, eventId);
    this.sentChats.set(short, chatId);
    this.rememberEvent(this.rooms.get(chatId) ?? chatId, eventId, chatId);
    if (this.sent.size > 200) {
      const oldest = this.sent.keys().next().value!;
      this.sent.delete(oldest); this.sentChats.delete(oldest);
    }
    return short;
  }
  /**
   * Replaces the words of a message this adapter sent, the Matrix way: a new event that says it replaces the old one
   * (`m.replace`), which every client shows in the old one's place.
   */
  async edit(chatId: string, messageId: string, text: string, format?: MessageFormat, gate?: SendGate): Promise<void> {
    const eventId = this.sent.get(messageId);
    if (!eventId || this.sentChats.get(messageId) !== chatId) throw new Error("Matrix: that message was not sent in this conversation, so it cannot be edited");
    const content = this.threadContent(chatId, MatrixAdapter.content(text.slice(0, this.maxTextLength), format));
    await this.put(chatId, { ...content, body: `* ${content.body}`, "m.new_content": content,
      "m.relates_to": { rel_type: "m.replace", event_id: eventId } }, "m.room.message", gate);
  }
  /** Redacts an event this adapter sent (only its own, by the handle it gave it). */
  async deleteMessage(chatId: string, messageId: string, gate?: SendGate): Promise<void> {
    const eventId = this.sent.get(messageId);
    if (!eventId || this.sentChats.get(messageId) !== chatId) throw new Error("Matrix: that message was not sent in this conversation, so it cannot be removed");
    await this.redact(this.rooms.get(chatId) ?? chatId, eventId, gate);
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
    const chatId = this.eventChats.get(`${roomId}:${relates.data.event_id}`);
    if (!chatId) return null;
    return { channel: this.id, chatId, chatKind: this.directRoom(roomId) ? "direct" : "group", chatTitle: roomId, senderId: handle(sender, "who"), senderName: sender,
      text: value, addressed: true, messageId: handle(event.event_id ?? randomUUID(), "msg") };
  }
  /** A thread is its own router conversation; room-only messages keep their existing address. */
  private chat(roomId: string, content?: Record<string, unknown>): string {
    const relation = z.object({ rel_type: z.literal("m.thread"), event_id: z.string().min(1).max(300) }).passthrough()
      .safeParse(content?.["m.relates_to"]);
    const root = relation.success ? relation.data.event_id : undefined;
    const chatId = root ? `thread:${createHash("sha256").update(JSON.stringify([roomId, root])).digest("hex").slice(0, 32)}` : handle(roomId, "room");
    this.rooms.set(chatId, roomId);
    if (root) this.threads.set(chatId, root);
    return chatId;
  }
  private rememberEvent(roomId: string, eventId: string, chatId: string): void {
    this.eventChats.set(`${roomId}:${eventId}`, chatId);
    if (this.eventChats.size > 400) this.eventChats.delete(this.eventChats.keys().next().value!);
  }
  /** Replies, files and progress stay in their thread. Edits keep their m.replace relation. */
  private threadContent(chatId: string, content: Record<string, unknown>): Record<string, unknown> {
    const root = this.threads.get(chatId);
    if (!root) return content;
    const relation = content["m.relates_to"] as Record<string, unknown> | undefined;
    if (relation?.rel_type === "m.replace") return content;
    return { ...content, "m.relates_to": { ...relation, rel_type: "m.thread", event_id: root,
      is_falling_back: !relation?.["m.in_reply_to"],
      "m.in_reply_to": relation?.["m.in_reply_to"] ?? { event_id: root } } };
  }
  /** Questions this adapter asked with reactions: the question's event, and what each reaction on it answers. */
  private readonly questions = new Map<string, Map<string, string>>();
  /** A `gate` (an owner's own-message edit) is checked last before sending, and its signal aborts the request. */
  private async put(chatId: string, content: Record<string, unknown>, eventType = "m.room.message", gate?: SendGate): Promise<string | undefined> {
    if (chatId.startsWith("thread:") && !this.threads.has(chatId))
      throw new Error("Matrix: this thread has not been read since reconnecting; send a message there first");
    const roomId = this.rooms.get(chatId) ?? chatId;
    const address = `${this.base}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/${randomUUID()}`;
    const timeout = AbortSignal.timeout(20000), signal = gate ? AbortSignal.any([timeout, gate.signal]) : timeout;
    gate?.check();
    const response = await this.fetch(address, {
      method: "PUT", headers: { authorization: `Bearer ${this.options.accessToken}`, "content-type": "application/json" },
      body: JSON.stringify(eventType === "m.room.message" ? this.threadContent(chatId, content) : content), redirect: "error", signal,
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
