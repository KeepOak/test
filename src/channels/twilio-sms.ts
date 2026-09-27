import { z } from "zod";
import type { ChannelHealth, InboundMessage } from "./router.js";
import { callJson, defineService, PollingChannel, secretName } from "./parity-common.js";

/**
 * Text messages (SMS) through Twilio, or any provider that copies Twilio's REST API. Branch sends
 * from the owner's Twilio number and, every few seconds, lists the messages that number received.
 * Every text is a one-to-one chat with the phone number that sent it.
 * API: https://www.twilio.com/docs/messaging/api/message-resource
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
}).passthrough();
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
      if (!phoneNumber.test(row.from) || !row.body?.trim()) continue;
      out.push({ channel: this.id, chatId: row.from, chatKind: "direct", senderId: row.from, senderName: row.from,
        text: row.body, addressed: true, messageId: row.sid });
    }
    return out;
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
