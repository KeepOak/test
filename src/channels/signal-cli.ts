import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import { z } from "zod";
import { ReactionAnswers } from "./reaction-answers.js";
import type { ChannelAdapter, ChannelHealth, InboundMessage } from "./router.js";

/**
 * Signal, through the `signal-cli` program the owner installed themselves. Signal has no bot API:
 * the only supported way in is a registered account driven by that program, so Branch will not
 * pretend to offer Signal unless the program is actually on this computer. Nothing is downloaded
 * and nothing is installed; if the path is not a program that is here, the channel refuses to start
 * and says so.
 *
 * Messages come over its JSON-RPC mode: one JSON document per line on the program's output, and
 * one per line written back to send a reply. No network call is made from this file at all.
 */
export interface SignalOptions {
  id: string;
  /** Full path to the signal-cli program, for example C:/tools/signal-cli/bin/signal-cli.bat. */
  path: string;
  /** The registered phone number this account answers as, in +country form. */
  account: string;
  spawnProcess?: typeof spawn;
  /** Checks the program is there; tests replace it so no real program is needed. */
  exists?: (path: string) => Promise<boolean>;
}
/** signal-cli's answer to one of Branch's own requests: a send says the timestamp that names the message it made. */
const resultSchema = z.object({ id: z.union([z.number(), z.string()]), result: z.object({ timestamp: z.number() }).passthrough() }).passthrough();
const envelopeSchema = z.object({
  method: z.string().optional(),
  params: z.object({
    envelope: z.object({
      source: z.string().optional(), sourceName: z.string().optional(), timestamp: z.number().optional(),
      dataMessage: z.object({ message: z.string().optional(), groupInfo: z.object({ groupId: z.string().optional() }).passthrough().optional(),
        reaction: z.object({ emoji: z.string().max(40).optional(), targetAuthor: z.string().optional(), targetAuthorNumber: z.string().optional(),
          targetSentTimestamp: z.number().optional(), isRemove: z.boolean().optional() }).passthrough().optional(),
      }).passthrough().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

/** True when the path really is a file on this computer. Nothing is run to find out. */
export async function signalCliInstalled(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return !!info?.isFile();
}

export class SignalAdapter implements ChannelAdapter {
  readonly kind = "signal";
  readonly id: string;
  readonly maxTextLength = 2000;
  private child: ChildProcessWithoutNullStreams | undefined;
  private lines: Interface | undefined;
  private state: ChannelHealth = { state: "reconnecting", reason: "Looking for signal-cli" };
  private nextId = 1;
  /** Who sent each recent message (by its timestamp), for a reaction or a quote on it. */
  private readonly authors = new Map<string, string>();
  /** When each of Branch's sends was made (signal-cli's timestamp), by the request id `send` returned. */
  private readonly sentAt = new Map<string, number>();
  /** Questions a 👍 / 👎 reaction may answer, by the question's send request id (src/channels/reaction-answers.ts). */
  private readonly answers = new ReactionAnswers();
  watchAnswers(chatId: string, messageId: string, senderId: string, fingerprint: string): void {
    this.answers.watch(messageId, chatId, senderId, fingerprint);
  }
  constructor(private readonly options: SignalOptions) { this.id = options.id; }
  botName(): string | null { return this.options.account; }
  health(): ChannelHealth { return this.state; }
  async start(onMessage: (message: InboundMessage) => Promise<void>): Promise<void> {
    const exists = this.options.exists ?? signalCliInstalled;
    if (!await exists(this.options.path)) {
      this.state = { state: "needs attention", reason: `signal-cli is not installed at ${this.options.path}` };
      throw new Error(`Signal needs the signal-cli program, and there is nothing at ${this.options.path}. Install it and register your number first.`);
    }
    const start = this.options.spawnProcess ?? spawn;
    const child = start(this.options.path, ["-a", this.options.account, "--output=json", "jsonRpc"], { stdio: "pipe", windowsHide: true });
    this.child = child;
    child.on("error", (error: Error) => { this.state = { state: "needs attention", reason: `signal-cli stopped: ${error.message}` }; });
    child.on("exit", () => { this.state = { state: "needs attention", reason: "signal-cli is no longer running" }; });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line: string) => { const inbound = this.inbound(line); if (inbound) void onMessage(inbound).catch(() => undefined); });
    this.state = { state: "connected" };
  }
  async stop(): Promise<void> {
    this.lines?.close();
    this.child?.kill();
    this.child = undefined;
  }
  private inbound(line: string): InboundMessage | null {
    let parsed: z.infer<typeof envelopeSchema>, raw: unknown;
    try { raw = JSON.parse(line); parsed = envelopeSchema.parse(raw); } catch { return null; }
    const result = resultSchema.safeParse(raw);
    if (result.success) {
      this.sentAt.set(String(result.data.id), result.data.result.timestamp);
      while (this.sentAt.size > 200) this.sentAt.delete(this.sentAt.keys().next().value!);
      return null;
    }
    const envelope = parsed.params?.envelope;
    const reaction = envelope?.dataMessage?.reaction;
    if (reaction) return this.answer(envelope, reaction);
    const text = envelope?.dataMessage?.message;
    if (!envelope?.source || !text) return null;
    const group = envelope.dataMessage?.groupInfo?.groupId;
    if (envelope.timestamp !== undefined) {
      this.authors.set(String(envelope.timestamp), envelope.source);
      if (this.authors.size > 200) this.authors.delete(this.authors.keys().next().value!);
    }
    return {
      channel: this.id, chatId: group ?? envelope.source, chatKind: group ? "group" : "direct",
      ...(group ? { chatTitle: `group ${group.slice(0, 12)}` } : {}),
      senderId: envelope.source, senderName: envelope.sourceName ?? envelope.source,
      text, addressed: !group, messageId: String(envelope.timestamp ?? Date.now()),
    };
  }
  /** A reaction on one of Branch's own questions (sent by this account, at that timestamp), by the person it asked. */
  private answer(envelope: { source?: string | undefined; sourceName?: string | undefined; timestamp?: number | undefined;
    dataMessage?: { groupInfo?: { groupId?: string | undefined } | undefined } | undefined },
  reaction: { emoji?: string | undefined; targetAuthor?: string | undefined; targetAuthorNumber?: string | undefined;
    targetSentTimestamp?: number | undefined; isRemove?: boolean | undefined }): InboundMessage | null {
    const author = reaction.targetAuthorNumber ?? reaction.targetAuthor;
    if (!envelope.source || reaction.isRemove || author !== this.options.account || reaction.targetSentTimestamp === undefined) return null;
    const request = [...this.sentAt].find(([, at]) => at === reaction.targetSentTimestamp)?.[0];
    const group = envelope.dataMessage?.groupInfo?.groupId, chatId = group ?? envelope.source;
    const said = request ? this.answers.read(request, chatId, envelope.source, reaction.emoji ?? "") : null;
    return said ? { channel: this.id, chatId, chatKind: group ? "group" : "direct", ...(group ? { chatTitle: `group ${group.slice(0, 12)}` } : {}),
      senderId: envelope.source, senderName: envelope.sourceName ?? envelope.source, text: said, addressed: true,
      messageId: String(envelope.timestamp ?? Date.now()) } : null;
  }
  async send(chatId: string, text: string, replyToMessageId?: string): Promise<string | undefined> {
    // CHAT-116: a reply quotes the person's own message (signal-cli's quoteTimestamp and quoteAuthor).
    const author = replyToMessageId ? this.authors.get(replyToMessageId) : undefined;
    const quote = author ? { quoteTimestamp: Number(replyToMessageId), quoteAuthor: author } : {};
    return this.request("send", { ...this.target(chatId), message: text.slice(0, this.maxTextLength), ...quote });
  }
  /** CHAT-109: Signal's typing indicator (it lasts about 15 seconds; the live status asks again while the task works). */
  async sendTyping(chatId: string): Promise<void> {
    this.request("sendTyping", this.target(chatId));
  }
  /** CHAT-112: a status reaction on the person's message; Signal keeps one reaction per sender, so the new one replaces it. */
  async react(chatId: string, messageId: string, emoji: string): Promise<void> {
    const author = this.authors.get(messageId);
    if (!author) throw new Error("Signal: that message is not one Branch received");
    this.request("sendReaction", { ...this.target(chatId), emoji, targetAuthor: author, targetTimestamp: Number(messageId) });
  }
  private target(chatId: string): Record<string, unknown> {
    return chatId.startsWith("+") ? { recipient: [chatId] } : { groupId: chatId };
  }
  private request(method: string, params: Record<string, unknown>): string {
    if (!this.child?.stdin?.writable) throw new Error("signal-cli is not running, so the message could not be sent");
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n");
    return String(id);
  }
}
