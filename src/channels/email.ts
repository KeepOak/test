import { createHash, randomUUID } from "node:crypto";
import { ArtifactTooLarge, maxArtifactBytes } from "../artifacts.js";
import type { ChannelAdapter, ChannelHealth, InboundMessage, OutgoingFile } from "./router.js";
import { ImapClient, sendMail, type MailFile, type MailMessage, type MailServer } from "./mail-client.js";

/**
 * Email as a chat channel: the assistant checks the inbox every so often, answers each unread
 * message, and marks it read so it is never answered twice. The reply is threaded onto the original
 * with In-Reply-To and References, so it lands in the same conversation in the person's mail app.
 * A formatted message is read as its words; files attached to it become the task's material, and a
 * file Branch sends goes as an ordinary attachment on a reply in the same thread.
 */
export interface EmailOptions {
  id: string;
  /** The address the assistant sends from and receives at. */
  address: string;
  imap: MailServer;
  smtp: MailServer;
  /** How often to look for new mail; every minute by default. */
  pollMs?: number;
  /** Most messages to answer in one look, so a full inbox cannot flood the assistant. */
  batch?: number;
}
/** What is needed to answer a message, kept out of the delivery ledger because ids are long. */
interface Thread { address: string; messageId: string; references: string; subject: string }

const kindOf = (type: string): "picture" | "video" | "document" => (type.startsWith("image/") ? "picture" : type.startsWith("video/") ? "video" : "document");
/** Ids and addresses can be longer than a chat id may be, so a long one is shortened predictably. */
export function handle(value: string, prefix: string): string {
  if (value.length <= 60) return value;
  return `${prefix}:${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

export class EmailAdapter implements ChannelAdapter {
  readonly kind = "email";
  readonly id: string;
  /** Long replies are split so no single mail becomes unreadable. */
  readonly maxTextLength = 3500;
  /** Most mail services refuse a message over 25 MB; attached files grow by a third on the way, so this is the most that fits. */
  readonly maxFileBytes = 18 * 1024 * 1024;
  private state: ChannelHealth = { state: "reconnecting", reason: "Looking at the inbox for the first time" };
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking: Promise<void> = Promise.resolve();
  private stopping = false;
  /** Short handles to the long address, message id and subject each reply needs. */
  private readonly threads = new Map<string, Thread>();
  constructor(private readonly options: EmailOptions) { this.id = options.id; }
  botName(): string | null { return this.options.address; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    // The first look is not waited for: a mail server that is slow or unreachable must not hold up
    // starting the assistant. Until it lands, the channel reports that it has not read the inbox yet.
    void this.check(onMessage);
    this.timer = setInterval(() => void this.check(onMessage), this.options.pollMs ?? 60000);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.checking.catch(() => undefined);
  }
  /** One look at the inbox; overlapping looks are queued so the mailbox is opened once at a time. */
  private check(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    return (this.checking = this.checking.then(async () => {
      if (this.stopping) return;
      const client = new ImapClient(this.options.imap);
      try {
        await client.connect();
        const unread = await client.unread(this.options.batch ?? 10);
        this.state = { state: "connected" };
        for (const mail of unread) {
          const inbound = this.inbound(mail);
          if (inbound) await onMessage(inbound).catch(() => undefined);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.state = reason.includes("LOGIN")
          ? { state: "needs attention", reason: "The mail server would not accept the address and password." }
          : { state: "reconnecting", reason: `Could not read the inbox: ${reason}` };
      } finally { await client.close().catch(() => undefined); }
    }).catch(() => undefined));
  }
  private inbound(mail: MailMessage): InboundMessage | null {
    const files = mail.attachments ?? [];
    if (!mail.from || (!mail.text && !files.length) || mail.from === this.options.address.toLowerCase()) return null;
    const chatId = handle(mail.from, "who");
    const messageId = handle(mail.messageId || `<${mail.seq}@branch>`, "msg");
    this.remember(chatId, messageId, mail);
    return {
      channel: this.id, chatId, chatKind: "direct", senderId: chatId, senderName: mail.fromName || mail.from,
      // Quoted history below the reply marker is not part of the new question.
      text: mail.text.split(/\n>*\s*On .+ wrote:\n/)[0]!.trim() || mail.text,
      addressed: true, messageId,
      ...(files.length ? { attachments: files.map((file, index) => ({ name: file.name, sourceId: `${messageId}-${index}`, mediaType: file.mediaType,
        kind: kindOf(file.mediaType), size: file.bytes.byteLength, bytes: async () => {
          if (file.bytes.byteLength > maxArtifactBytes) throw new ArtifactTooLarge("That file is too large");
          return file.bytes;
        } })) } : {}),
    };
  }
  /** Keeps the details a reply needs, bounded so a busy inbox cannot grow this without limit. */
  private remember(chatId: string, messageId: string, mail: MailMessage): void {
    const references = `${mail.references} ${mail.messageId}`.trim();
    this.threads.set(messageId, { address: mail.from, messageId: mail.messageId, references, subject: mail.subject });
    this.threads.set(chatId, { address: mail.from, messageId: mail.messageId, references, subject: mail.subject });
    while (this.threads.size > 400) this.threads.delete(this.threads.keys().next().value!);
  }
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    return this.mail(chatId, text, replyToMessageId);
  }
  /** A file as an attachment on a reply in the same thread, with its caption as the words. */
  async sendFile(chatId: string, file: OutgoingFile, replyToMessageId?: string): Promise<string | undefined> {
    if (file.bytes.byteLength > this.maxFileBytes) throw new Error("That file is larger than the 18 MB a mail can carry");
    return this.mail(chatId, file.caption ?? "", replyToMessageId, [{ name: file.name, mediaType: file.mediaType, bytes: file.bytes }]);
  }
  private async mail(chatId: string, text: string, replyToMessageId?: string, attachments?: MailFile[]): Promise<string | undefined> {
    const thread = (replyToMessageId && this.threads.get(replyToMessageId)) || this.threads.get(chatId);
    const to = thread?.address ?? (chatId.startsWith("who:") ? "" : chatId);
    if (!to) throw new Error("That address is not known yet; the assistant can only answer mail it has received");
    const messageId = `<${randomUUID()}@branch-agent>`;
    const subject = thread?.subject ? (/^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`) : "Message from your assistant";
    await sendMail(this.options.smtp, {
      from: this.options.address, to, subject, text, messageId, ...(attachments ? { attachments } : {}),
      ...(thread?.messageId ? { inReplyTo: thread.messageId, references: thread.references } : {}),
    });
    return messageId.slice(0, 64);
  }
}
