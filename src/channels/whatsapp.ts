import { attachmentKind, voiceFileName } from "./media.js";
import { z } from "zod";
import { ReactionAnswers } from "./reaction-answers.js";
import type { ChannelAdapter, ChannelHealth, InboundMessage, OutgoingFile } from "./router.js";
import { assertMetaSigned, metaChallenge } from "./meta-graph.js";

/**
 * WhatsApp through Meta's Cloud API. WhatsApp pushes messages to a web address instead of holding a
 * socket open, so this adapter waits to be handed requests by the server route rather than
 * connecting anywhere itself. Meta checks the address once with a challenge, and signs every later
 * request; a request without a matching signature is refused. Replies go out through the Graph API.
 *
 * WhatsApp only allows a free-form reply within twenty-four hours of the person's last message.
 * Outside that window the send is refused with a plain reason, so the delivery ledger holds the
 * message, tries again, and finally shows it to the owner under "Messages still to send".
 */
export interface WhatsAppOptions {
  id: string;
  /** Graph API access token for the WhatsApp business account. */
  token: string;
  /** The phone number id the business sends from. */
  phoneNumberId: string;
  /** Shared with Meta when the address is first verified. */
  verifyToken: string;
  /** The app secret, used to check the signature on every request Meta sends. */
  appSecret: string;
  apiBase?: string;
  fetch?: typeof fetch;
  /** How long after someone writes we may still reply; twenty-four hours by default. */
  sessionWindowMs?: number;
  now?: () => number;
}
const mediaSchema = z.object({ id: z.string().min(1).max(200), mime_type: z.string().max(100).optional(),
  caption: z.string().max(4096).optional(), filename: z.string().max(300).optional() }).passthrough();
const valueSchema = z.object({
  messaging_product: z.string().optional(),
  contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string().optional() }).passthrough().optional() }).passthrough()).default([]),
  messages: z.array(z.object({
    id: z.string(), from: z.string(), timestamp: z.string().optional(), type: z.string().optional(),
    text: z.object({ body: z.string() }).passthrough().optional(),
    audio: z.object({ id: z.string().min(1).max(200), mime_type: z.string().max(100).optional() }).passthrough().optional(),
    voice: z.object({ id: z.string().min(1).max(200), mime_type: z.string().max(100).optional() }).passthrough().optional(),
    // CHAT-105: pictures, videos and files, each with an optional caption.
    image: mediaSchema.optional(), video: mediaSchema.optional(), document: mediaSchema.optional(),
    reaction: z.object({ message_id: z.string().min(1).max(200), emoji: z.string().max(40).optional() }).passthrough().optional(),
  }).passthrough()).default([]),
}).passthrough();
const webhookSchema = z.object({
  object: z.string().optional(),
  entry: z.array(z.object({ changes: z.array(z.object({ value: valueSchema }).passthrough()).default([]) }).passthrough()).default([]),
}).passthrough();

export class WhatsAppAdapter implements ChannelAdapter {
  readonly kind = "whatsapp";
  /** A reply to a message only quotes it here, so Settings › Chat apps › Replies in each app decides (reply-style.ts). */
  readonly replyQuotes = true;
  readonly id: string;
  /** WhatsApp text messages stop at 4096 characters. */
  readonly maxTextLength = 4000;
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly now: () => number;
  private state: ChannelHealth = { state: "connected" };
  private deliver: ((message: InboundMessage) => Promise<void>) | null = null;
  /** When each person last wrote, so we know whether we may still answer them. */
  private readonly lastHeard = new Map<string, number>();
  /** The newest message each person sent, which WhatsApp's typing indicator is shown against. */
  private readonly lastMessage = new Map<string, string>();
  /** Questions a 👍 / 👎 reaction may answer (src/channels/reaction-answers.ts). */
  private readonly answers: ReactionAnswers;
  constructor(private readonly options: WhatsAppOptions) {
    this.id = options.id;
    this.base = (options.apiBase ?? "https://graph.facebook.com/v21.0").replace(/\/$/, "");
    this.fetch = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.answers = new ReactionAnswers(this.now);
  }
  watchAnswers(chatId: string, messageId: string, senderId: string, fingerprint: string): void {
    this.answers.watch(messageId, chatId, senderId, fingerprint);
  }
  botName(): string | null { return this.options.phoneNumberId; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    this.deliver = onMessage;
    this.state = { state: "connected", reason: "Waiting for WhatsApp to send messages to this computer's web address" };
  }
  async stop(): Promise<void> { this.deliver = null; }
  /** Answers Meta's one-off check that this address belongs to the owner. */
  verify(query: URLSearchParams): string { return metaChallenge(query, this.options.verifyToken, "WhatsApp"); }
  /**
   * Checks the signature over the exact bytes Meta sent, then turns each message into one the
   * router can answer. An unsigned or wrongly signed request is refused before anything is read.
   */
  async receive(raw: Buffer, signature: string | undefined): Promise<{ accepted: number }> {
    assertMetaSigned(raw, signature, this.options.appSecret, "WhatsApp");
    const body = webhookSchema.parse(JSON.parse(raw.toString("utf8")));
    let accepted = 0;
    for (const entry of body.entry) for (const change of entry.changes) {
      for (const message of change.value.messages) {
        const name = change.value.contacts.find((contact) => contact.wa_id === message.from)?.profile?.name;
        this.lastHeard.set(message.from, this.now());
        if (message.type !== "reaction") this.lastMessage.set(message.from, message.id);
        const inbound = message.type === "reaction" ? this.answer(message, name) : this.inbound(message, name);
        if (!inbound || !this.deliver) continue;
        accepted++;
        await this.deliver(inbound).catch(() => undefined);
      }
    }
    return { accepted };
  }
  /** A reaction on one of Branch's own questions, from the person it asked, is that question's answer. */
  private answer(message: { id: string; from: string; reaction?: { message_id: string; emoji?: string | undefined } | undefined }, name?: string): InboundMessage | null {
    const said = message.reaction ? this.answers.read(message.reaction.message_id, message.from, message.from, message.reaction.emoji ?? "") : null;
    return said ? { channel: this.id, chatId: message.from, chatKind: "direct", senderId: message.from, senderName: name ?? message.from,
      text: said, addressed: true, messageId: message.id } : null;
  }
  private inbound(
    message: {
      id: string; from: string; type?: string | undefined; text?: { body: string } | undefined;
      audio?: { id: string; mime_type?: string | undefined } | undefined;
      voice?: { id: string; mime_type?: string | undefined } | undefined;
      image?: z.infer<typeof mediaSchema> | undefined; video?: z.infer<typeof mediaSchema> | undefined; document?: z.infer<typeof mediaSchema> | undefined;
    },
    name?: string,
  ): InboundMessage | null {
    const spoken = message.voice ?? message.audio;
    const media = message.image ?? message.video ?? message.document;
    const kind = message.type ?? "text";
    if (!spoken && !media && (kind !== "text" || !message.text?.body)) return null;
    const mediaType = media?.mime_type?.split(";")[0] ?? (message.image ? "image/jpeg" : "application/octet-stream");
    return {
      channel: this.id, chatId: message.from, chatKind: "direct", senderId: message.from,
      senderName: name ?? message.from, text: message.text?.body ?? media?.caption ?? "", addressed: true, messageId: message.id,
      ...(media ? { attachments: [{ name: media.filename ?? `${message.image ? "photo" : message.video ? "video" : "file"}-${message.id.slice(-8)}`,
        sourceId: media.id, mediaType, kind: attachmentKind(mediaType), bytes: () => this.downloadAudio(media.id, "file") }] } : {}),
      ...(spoken ? { voice: {
        mediaType: spoken.mime_type?.split(";")[0] ?? "audio/ogg",
        seconds: undefined,
        bytes: () => this.downloadAudio(spoken.id),
      } } : {}),
    };
  }
  /**
   * WhatsApp hands over media in two steps: ask what address it lives at, then fetch it with the
   * same key. Both go to WhatsApp's own hosts and nowhere else.
   */
  private async downloadAudio(mediaId: string, what = "voice note"): Promise<Uint8Array> {
    const headers = { authorization: `Bearer ${this.options.token}` };
    const info = await this.fetch(`${this.base}/${encodeURIComponent(mediaId)}`, {
      headers, redirect: "error", signal: AbortSignal.timeout(20000),
    });
    if (!info.ok) throw new Error(`WhatsApp would not say where that ${what} is (${info.status})`);
    const where = z.object({ url: z.string().min(1).max(2000) }).passthrough().parse(await info.json());
    const target = new URL(where.url);
    // The hosts Meta serves media from. `fbsbx.com` is the one the media lookup usually answers
    // with, so it is listed alongside the others rather than being refused in practice.
    if (target.protocol !== "https:" || !/(^|\.)(whatsapp\.net|whatsapp\.com|fbcdn\.net|fbsbx\.com|facebook\.com)$/i.test(target.hostname))
      throw new Error(`That ${what} is not hosted by WhatsApp, so it was not downloaded`);
    const response = await this.fetch(target.href, { headers, redirect: "error", signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`WhatsApp would not hand over that ${what} (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > 20 * 1024 * 1024) throw new Error(`That ${what} is larger than 20 MB, so it was not used`);
    return bytes;
  }
  /**
   * CHAT-109: WhatsApp's typing indicator, shown against the person's newest message (it marks that message read, as
   * the Cloud API does) and dropped by WhatsApp after 25 seconds or when the reply arrives.
   */
  async sendTyping(chatId: string): Promise<void> {
    const messageId = this.lastMessage.get(chatId);
    if (!messageId) throw new Error("WhatsApp shows typing only against a message the person sent");
    await this.postRaw({ messaging_product: "whatsapp", status: "read", message_id: messageId, typing_indicator: { type: "text" } });
  }
  /** CHAT-112: a status reaction on the person's message; WhatsApp keeps one reaction per sender, so the new one replaces it. */
  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    await this.postRaw({ messaging_product: "whatsapp", recipient_type: "individual", to: chatId, type: "reaction",
      reaction: { message_id: messageId, emoji } });
  }
  private async postRaw(body: Record<string, unknown>): Promise<void> {
    const response = await this.fetch(`${this.base}/${encodeURIComponent(this.options.phoneNumberId)}/messages`, {
      method: "POST", headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    if (response.status === 429) throw Object.assign(new Error("WhatsApp asked us to slow down"), { retryAfter: 5 });
    if (!response.ok) throw new Error(`WhatsApp refused that (${response.status})`);
  }
  /** WhatsApp's own limit for a document; pictures, video and audio have smaller ones, said when refused. */
  readonly maxFileBytes = 100 * 1024 * 1024;
  /**
   * CHAT-105: a file into the chat, uploaded to WhatsApp first, then sent as a picture, video, audio or document (each
   * with WhatsApp's own size limit: 5 MB, 16 MB, 16 MB and 100 MB). The 24-hour reply window applies as for words.
   */
  async sendFile(chatId: string, file: OutgoingFile, replyToMessageId?: string): Promise<string | undefined> {
    this.assertWindow(chatId);
    const type = file.mediaType.split(";")[0]!.toLowerCase();
    const kind = ["image/jpeg", "image/png"].includes(type) ? "image" : ["video/mp4", "video/3gpp"].includes(type) ? "video"
      : type.startsWith("audio/") ? "audio" : "document";
    const limit = { image: 5, video: 16, audio: 16, document: 100 }[kind] * 1024 * 1024;
    if (file.bytes.byteLength > limit) throw new Error(`WhatsApp takes ${kind === "document" ? "files" : `${kind === "image" ? "pictures" : kind}`} up to ${limit / 1024 / 1024} MB`);
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", type);
    form.append("file", new Blob([new Uint8Array(file.bytes)], { type }), file.name);
    const uploaded = await this.fetch(`${this.base}/${encodeURIComponent(this.options.phoneNumberId)}/media`, {
      method: "POST", headers: { authorization: `Bearer ${this.options.token}` }, body: form, signal: AbortSignal.timeout(120000) });
    if (!uploaded.ok) throw new Error(`WhatsApp refused the file (${uploaded.status})`);
    const { id } = z.object({ id: z.string().min(1) }).passthrough().parse(await uploaded.json());
    const media = { id, ...(file.caption && kind !== "audio" ? { caption: file.caption.slice(0, 1024) } : {}), ...(kind === "document" ? { filename: file.name } : {}) };
    return this.post(chatId, { type: kind, [kind]: media }, replyToMessageId);
  }
  /** CHAT-094: a spoken reply as an audio message (an OGG/Opus one shows as a voice note). */
  async sendVoice(chatId: string, audio: Uint8Array, mediaType: string, replyToMessageId?: string): Promise<string | undefined> {
    return this.sendFile(chatId, { name: voiceFileName(mediaType), mediaType, bytes: audio }, replyToMessageId);
  }
  private assertWindow(chatId: string): void {
    const heard = this.lastHeard.get(chatId);
    const window = this.options.sessionWindowMs ?? 24 * 60 * 60 * 1000;
    if (heard !== undefined && this.now() - heard > window)
      throw new Error("Outside WhatsApp's 24-hour reply window; waiting until they write again");
  }
  private async post(chatId: string, message: Record<string, unknown>, replyToMessageId?: string): Promise<string | undefined> {
    const response = await this.fetch(`${this.base}/${encodeURIComponent(this.options.phoneNumberId)}/messages`, {
      method: "POST", headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: chatId, ...message,
        ...(replyToMessageId ? { context: { message_id: replyToMessageId } } : {}) }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`WhatsApp refused the message (${response.status})`);
    const parsed = z.object({ messages: z.array(z.object({ id: z.string() }).passthrough()).default([]) }).passthrough().safeParse(await response.json().catch(() => ({})));
    return parsed.success ? parsed.data.messages[0]?.id : undefined;
  }
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    this.assertWindow(chatId);
    const response = await this.fetch(`${this.base}/${encodeURIComponent(this.options.phoneNumberId)}/messages`, {
      method: "POST", headers: { authorization: `Bearer ${this.options.token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: chatId,
        type: "text", text: { body: text.slice(0, this.maxTextLength), preview_url: false },
        ...(replyToMessageId ? { context: { message_id: replyToMessageId } } : {}) }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`WhatsApp refused the message (${response.status})`);
    const parsed = z.object({ messages: z.array(z.object({ id: z.string() }).passthrough()).default([]) }).passthrough().safeParse(await response.json().catch(() => ({})));
    return parsed.success ? parsed.data.messages[0]?.id : undefined;
  }
}
