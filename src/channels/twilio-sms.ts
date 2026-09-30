import { z } from "zod";
import { ArtifactTooLarge, maxArtifactBytes } from "../artifacts.js";
import type { ChannelHealth, InboundMessage } from "./router.js";
import { callJson, defineService, PollingChannel, secretName } from "./parity-common.js";

/**
 * Text messages (SMS) through Twilio, or any provider that copies Twilio's REST API. Branch sends
 * from the owner's Twilio number and, every few seconds, lists the messages that number received.
 * Every text is a one-to-one chat with the phone number that sent it.
 * API: https://www.twilio.com/docs/messaging/api/message-resource
 *
 * Pictures and files sent by MMS (CHAT-171) become the task's material. Which files a message carries is read from
 * Twilio's Media list for that message; the bytes are fetched only once the message is answered, from Twilio with the
 * account's key, then (Twilio hands media over by redirect) from the https address it names, without the key.
 * Branch sends no MMS: Twilio fetches an outgoing picture from a public web address, and Branch has none to offer.
 * API: https://www.twilio.com/docs/messaging/api/media-resource
 */
export interface TwilioSmsOptions {
  id: string;
  accountSid: string;
  authToken: string;
  authTokenSecret: string;
  /** The Twilio number texts are sent from and received on, written +15551234567. */
  from: string;
  apiBase?: string;
  pollMs?: number;
  /** The first wait after a failed call, in milliseconds; it grows with each failure. */
  retryBaseMs?: number;
  fetch?: typeof fetch;
}

const TwilioMessageSchema = z.object({
  sid: z.string().min(1).max(64),
  from: z.string().default(""),
  to: z.string().default(""),
  body: z.string().nullable().default(""),
  direction: z.string().default(""),
  /** How many pictures or files came with it (Twilio writes the number as text). */
  num_media: z.union([z.string(), z.number()]).nullish(),
}).passthrough();
const MediaListSchema = z.object({
  media_list: z.array(z.object({ sid: z.string().regex(/^ME[0-9a-fA-F]{32}$/), content_type: z.string().max(100).default("application/octet-stream") }).passthrough()).default([]),
}).passthrough();
const extensionOf = (type: string): string => ({ "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/heic": "heic",
  "video/mp4": "mp4", "video/3gpp": "3gp", "audio/amr": "amr", "audio/mpeg": "mp3", "audio/mp4": "m4a", "application/pdf": "pdf", "text/vcard": "vcf",
  "text/x-vcard": "vcf", "text/plain": "txt" } as Record<string, string>)[type] ?? "bin";
const ListSchema = z.object({ messages: z.array(z.unknown()).default([]) }).passthrough();
const SentSchema = z.object({ sid: z.string().min(1).max(64) }).passthrough();
export const phoneNumber = /^\+[1-9]\d{6,14}$/;
/** How many message ids are remembered; far more than one page, so an old one never comes back. */
const rememberAtMost = 1000;

export class TwilioSmsChannel extends PollingChannel {
  readonly kind = "sms";
  /** Each text message costs the owner money, so nothing unasked is added to a reply (ChannelAdapter.paidPerMessage). */
  readonly paidPerMessage = true;
  private readonly fetchImpl: typeof fetch;
  private readonly seen = new Set<string>();
  private refused: string | null = null;
  constructor(private readonly options: TwilioSmsOptions) {
    super(options.id, options.pollMs ?? 5000, options.retryBaseMs ?? 1000);
    this.maxTextLength = 1600;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }
  botName(): string | null { return this.options.from; }
  override health(): ChannelHealth {
    return this.refused ? { state: "needs attention", reason: this.refused } : super.health();
  }
  private get messagesUrl(): string {
    const base = (this.options.apiBase ?? "https://api.twilio.com").replace(/\/+$/, "");
    return `${base}/2010-04-01/Accounts/${encodeURIComponent(this.options.accountSid)}/Messages.json`;
  }
  private headers(): Record<string, string> {
    return { authorization: `Basic ${Buffer.from(`${this.options.accountSid}:${this.options.authToken}`).toString("base64")}` };
  }
  private noteRefusal(error: unknown): never {
    if (/\((401|403)\)/.test(error instanceof Error ? error.message : String(error)))
      this.refused = `Twilio refused the account SID or auth token. Check the account SID and save the auth token as ${this.options.authTokenSecret}`;
    throw error;
  }
  private remember(sid: string): void {
    this.seen.add(sid);
    if (this.seen.size > rememberAtMost) this.seen.delete(this.seen.values().next().value!);
  }
  protected async poll(first: boolean): Promise<InboundMessage[]> {
    const query = new URLSearchParams({ To: this.options.from, PageSize: "50" });
    const answer = await callJson(this.fetchImpl, "Twilio", `${this.messagesUrl}?${query}`, { headers: this.headers() })
      .catch((error: unknown) => this.noteRefusal(error));
    this.refused = null;
    const rows = ListSchema.parse(answer).messages.flatMap((row) => {
      const one = TwilioMessageSchema.safeParse(row);
      return one.success ? [one.data] : [];
    });
    const out: InboundMessage[] = [];
    // Twilio lists the newest first; answer them in the order they were written.
    for (const row of rows.reverse()) {
      if (this.seen.has(row.sid)) continue;
      this.remember(row.sid);
      if (first || row.direction !== "inbound" || row.from === this.options.from) continue;
      const media = Math.min(10, Number(row.num_media ?? 0) || 0);
      if (!phoneNumber.test(row.from) || (!row.body?.trim() && !media)) continue;
      const attachments = media ? await this.mediaOf(row.sid).catch(() => []) : [];
      if (!row.body?.trim() && !attachments.length) continue;
      out.push({ channel: this.id, chatId: row.from, chatKind: "direct", senderId: row.from, senderName: row.from,
        text: row.body ?? "", addressed: true, messageId: row.sid, ...(attachments.length ? { attachments } : {}) });
    }
    return out;
  }
  /** The pictures and files on one received MMS: their types from Twilio's Media list, their bytes only when asked. */
  private async mediaOf(messageSid: string): Promise<NonNullable<InboundMessage["attachments"]>> {
    if (!/^(SM|MM)[0-9a-fA-F]{32}$/.test(messageSid)) return [];
    const listed = MediaListSchema.parse(await callJson(this.fetchImpl, "Twilio", this.mediaUrl(messageSid, ".json"), { headers: this.headers() }));
    return listed.media_list.slice(0, 10).map((item) => {
      const mediaType = item.content_type.split(";")[0]!.trim().toLowerCase();
      return { name: `mms-${item.sid.slice(-8)}.${extensionOf(mediaType)}`, sourceId: item.sid, mediaType,
        kind: mediaType.startsWith("image/") ? "picture" as const : mediaType.startsWith("video/") ? "video" as const : "document" as const,
        bytes: () => this.mediaBytes(this.mediaUrl(messageSid, `/${item.sid}`)) };
    });
  }
  private mediaUrl(messageSid: string, rest: string): string {
    return this.messagesUrl.replace(/\.json$/, `/${messageSid}/Media${rest}`);
  }
  /**
   * One file: asked of Twilio with the key and without following redirects, then fetched from the https address Twilio
   * points to, without the key. Stopped past the size a task takes, whether the size was said or only found out.
   */
  private async mediaBytes(url: string): Promise<Uint8Array> {
    let response = await this.fetchImpl(url, { headers: this.headers(), redirect: "manual", signal: AbortSignal.timeout(60000) });
    if (response.status >= 300 && response.status < 400) {
      const next = new URL(response.headers.get("location") ?? "", url);
      if (next.protocol !== "https:") throw new Error("Twilio pointed the file at an address that is not https, so it was not fetched");
      response = await this.fetchImpl(next.href, { redirect: "error", signal: AbortSignal.timeout(60000) });
    }
    if (!response.ok) throw new Error(`Twilio would not hand over that file (${response.status})`);
    if (Number(response.headers.get("content-length") ?? 0) > maxArtifactBytes) throw new ArtifactTooLarge("That file is too large");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxArtifactBytes) throw new ArtifactTooLarge("That file is too large");
    return bytes;
  }
  async send(chatId: string, text: string): Promise<string | undefined> {
    if (!phoneNumber.test(chatId)) throw new Error("A text can only be sent to a phone number written like +15551234567");
    const answer = await callJson(this.fetchImpl, "Twilio", this.messagesUrl, {
      method: "POST", headers: this.headers(),
      form: { To: chatId, From: this.options.from, Body: text.slice(0, this.maxTextLength) },
    }).catch((error: unknown) => this.noteRefusal(error));
    const sent = SentSchema.safeParse(answer);
    if (!sent.success) return undefined;
    this.remember(sent.data.sid);
    return sent.data.sid;
  }
}

export const smsService = defineService({
  kind: "sms", name: "Text messages (Twilio)", docs: "https://www.twilio.com/docs/messaging/api/message-resource",
  needs: ["A Twilio account and a phone number in it that can send and receive texts",
    "The account SID (it starts with AC), written in the settings", "The account's auth token, saved as a secret"],
  receives: "polls",
  settings: z.object({
    accountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/),
    authTokenSecret: z.string().regex(secretName).default("TWILIO_AUTH_TOKEN"),
    from: z.string().regex(phoneNumber),
    /** A provider that copies Twilio's API can be used by giving its address. */
    apiBase: z.string().url().default("https://api.twilio.com"),
    pollSeconds: z.number().int().min(2).max(300).default(5),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.apiBase), "text message provider");
    return new TwilioSmsChannel({ id: deps.id, accountSid: settings.accountSid, authToken: await deps.secret(settings.authTokenSecret),
      authTokenSecret: settings.authTokenSecret, from: settings.from, apiBase: settings.apiBase,
      pollMs: settings.pollSeconds * 1000, fetch: deps.fetch });
  },
});
