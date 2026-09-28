import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import { z } from "zod";
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
const envelopeSchema = z.object({
  method: z.string().optional(),
  params: z.object({
    envelope: z.object({
      source: z.string().optional(), sourceName: z.string().optional(), timestamp: z.number().optional(),
      dataMessage: z.object({ message: z.string().optional(), groupInfo: z.object({ groupId: z.string().optional() }).passthrough().optional(),
        /** Who a group message @mentions, by number or account id. */
        mentions: z.array(z.object({ number: z.string().nullish(), uuid: z.string().nullish() }).passthrough()).optional(),
        /** The message this one replies to, and who wrote it. */
        quote: z.object({ author: z.string().nullish(), authorNumber: z.string().nullish() }).passthrough().optional(),
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
    let parsed: z.infer<typeof envelopeSchema>;
    try { parsed = envelopeSchema.parse(JSON.parse(line)); } catch { return null; }
    const envelope = parsed.params?.envelope;
    const text = envelope?.dataMessage?.message;
    if (!envelope?.source || !text) return null;
    const group = envelope.dataMessage?.groupInfo?.groupId;
    // In a group: an @mention of the assistant's number, or a reply to one of its messages (Signal groups were never answered).
    const me = this.options.account;
    const mentioned = (envelope.dataMessage?.mentions ?? []).some((mention) => mention.number === me);
    const quote = envelope.dataMessage?.quote;
    const repliedTo = !!quote && (quote.authorNumber === me || quote.author === me);
    return {
      channel: this.id, chatId: group ?? envelope.source, chatKind: group ? "group" : "direct",
      ...(group ? { chatTitle: `group ${group.slice(0, 12)}` } : {}),
      senderId: envelope.source, senderName: envelope.sourceName ?? envelope.source,
      text, addressed: !group || mentioned || repliedTo, messageId: String(envelope.timestamp ?? Date.now()),
    };
  }
  async send(chatId: string, text: string): Promise<string | undefined> {
    if (!this.child?.stdin?.writable) throw new Error("signal-cli is not running, so the message could not be sent");
    const id = this.nextId++;
    const isGroup = !chatId.startsWith("+");
    const params = isGroup ? { groupId: chatId, message: text.slice(0, this.maxTextLength) }
      : { recipient: [chatId], message: text.slice(0, this.maxTextLength) };
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "send", params, id }) + "\n");
    return String(id);
  }
}
