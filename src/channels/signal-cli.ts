import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import { z } from "zod";
import { ArtifactTooLarge, maxArtifactBytes } from "../artifacts.js";
import type { ChannelAdapter, ChannelHealth, InboundMessage, OutgoingFile } from "./router.js";

/**
 * Signal, through the `signal-cli` program the owner installed themselves. Signal has no bot API:
 * the only supported way in is a registered account driven by that program, so Branch will not
 * pretend to offer Signal unless the program is actually on this computer. Nothing is downloaded
 * and nothing is installed; if the path is not a program that is here, the channel refuses to start
 * and says so.
 *
 * Messages come over its JSON-RPC mode: one JSON document per line on the program's output, and
 * one per line written back to send a reply. No network call is made from this file at all.
 *
 * Files: a picture, file or voice note someone sends is fetched from signal-cli (its `getAttachment`
 * call) only once the message is answered. Branch's files and spoken replies go out as attachments on
 * `send`, written inline as `data:` addresses, so nothing is left on disk for signal-cli to pick up.
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
      dataMessage: z.object({ message: z.string().optional(), groupInfo: z.object({ groupId: z.string().optional() }).passthrough().optional() }).passthrough().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();

/** One file on a received message, as signal-cli describes it; read apart from the envelope so a strange one is skipped alone. */
const attachmentSchema = z.object({
  id: z.string().min(1).max(200), contentType: z.string().max(100).nullish(), filename: z.string().max(300).nullish(),
  size: z.number().nonnegative().nullish(),
  /** signal-cli's own flag for a recorded voice note (src/main/java/org/asamk/signal/json/JsonAttachment.java). */
  isVoiceNote: z.boolean().nullish(),
}).passthrough();
type SignalAttachment = z.infer<typeof attachmentSchema>;
const attachmentsOf = (dataMessage: unknown): SignalAttachment[] => {
  const list = (dataMessage as { attachments?: unknown } | undefined)?.attachments;
  if (!Array.isArray(list)) return [];
  return list.slice(0, 10).flatMap((item) => { const parsed = attachmentSchema.safeParse(item); return parsed.success ? [parsed.data] : []; });
};
const kindOf = (type: string): "picture" | "video" | "document" => (type.startsWith("image/") ? "picture" : type.startsWith("video/") ? "video" : "document");
/** A file name that cannot break out of the `data:` address it is written into. */
const dataName = (name: string) => name.replace(/[;,\s\u0000-\u001f"\\]+/g, "_").slice(0, 120) || "file";
const mimeOf = (type: string) => (/^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : "application/octet-stream");

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
  /** Answers signal-cli still owes, by the id of the call that asked. */
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  /** Signal takes files up to 100 MB; Branch writes each one inline on a single line, so it keeps well under that. */
  readonly maxFileBytes = 50 * 1024 * 1024;
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
    this.lines.on("line", (line: string) => {
      if (this.answered(line)) return;
      const inbound = this.inbound(line); if (inbound) void onMessage(inbound).catch(() => undefined);
    });
    this.state = { state: "connected" };
  }
  async stop(): Promise<void> {
    for (const waiting of this.pending.values()) waiting.reject(new Error("signal-cli stopped before it handed over the file"));
    this.pending.clear();
    this.lines?.close();
    this.child?.kill();
    this.child = undefined;
  }
  private inbound(line: string): InboundMessage | null {
    let parsed: z.infer<typeof envelopeSchema>;
    try { parsed = envelopeSchema.parse(JSON.parse(line)); } catch { return null; }
    const envelope = parsed.params?.envelope;
    const text = envelope?.dataMessage?.message ?? "";
    const files = attachmentsOf(envelope?.dataMessage);
    if (!envelope?.source || (!text && !files.length)) return null;
    const group = envelope.dataMessage?.groupInfo?.groupId;
    return {
      channel: this.id, chatId: group ?? envelope.source, chatKind: group ? "group" : "direct",
      ...(group ? { chatTitle: `group ${group.slice(0, 12)}` } : {}),
      senderId: envelope.source, senderName: envelope.sourceName ?? envelope.source,
      text, addressed: !group, messageId: String(envelope.timestamp ?? Date.now()),
      ...this.filesOf(files, group ? { groupId: group } : { recipient: envelope.source }),
    };
  }
  /** A voice note to transcribe, or pictures and files as the task's material; each fetched only once it is answered. */
  private filesOf(files: SignalAttachment[], from: { groupId: string } | { recipient: string }): Partial<InboundMessage> {
    if (!files.length) return {};
    const fetch = (file: SignalAttachment) => async () => {
      if ((file.size ?? 0) > maxArtifactBytes) throw new ArtifactTooLarge("That file is too large");
      const bytes = await this.attachment(file.id, from);
      if (bytes.byteLength > maxArtifactBytes) throw new ArtifactTooLarge("That file is too large");
      return bytes;
    };
    const type = (file: SignalAttachment) => (file.contentType ?? "application/octet-stream").split(";")[0]!.toLowerCase();
    // Only an attachment signal-cli marks as a voice note is one; any other audio file is a file like the rest.
    const voice = files.length === 1 && files[0]!.isVoiceNote === true ? files[0]! : null;
    if (voice) return { voice: { mediaType: type(voice), seconds: undefined, bytes: fetch(voice) } };
    return { attachments: files.map((file) => ({ name: file.filename || `signal-${file.id.slice(0, 12)}`, sourceId: file.id, mediaType: type(file),
      kind: kindOf(type(file)), ...(file.size != null ? { size: file.size } : {}), bytes: fetch(file) })) };
  }
  /** One received file, asked of signal-cli by the id it gave it. */
  private async attachment(id: string, from: { groupId: string } | { recipient: string }): Promise<Uint8Array> {
    const result = await this.call("getAttachment", { id, ...from });
    const data = typeof result === "string" ? result : (result as { data?: unknown } | null)?.data;
    if (typeof data !== "string") throw new Error("signal-cli did not hand over that file");
    return new Uint8Array(Buffer.from(data, "base64"));
  }
  /** A JSON-RPC call whose answer is waited for, for at most a minute. */
  private call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.child?.stdin?.writable) return Promise.reject(new Error("signal-cli is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("signal-cli did not answer in time")); }, 60000);
      timer.unref?.();
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.child!.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n");
    });
  }
  /** True when the line is signal-cli answering one of those calls, which settles it. */
  private answered(line: string): boolean {
    if (!this.pending.size || !line.includes('"id"')) return false;
    let parsed: { id?: unknown; method?: unknown; result?: unknown; error?: { message?: unknown } };
    try { parsed = JSON.parse(line) as typeof parsed; } catch { return false; }
    const waiting = typeof parsed.id === "number" && parsed.method === undefined ? this.pending.get(parsed.id) : undefined;
    if (!waiting) return false;
    this.pending.delete(parsed.id as number);
    if (parsed.error) waiting.reject(new Error(`signal-cli: ${String(parsed.error.message ?? "the call failed").slice(0, 200)}`));
    else waiting.resolve(parsed.result);
    return true;
  }
  /** A file into the chat as a Signal attachment, with its caption as the message. */
  async sendFile(chatId: string, file: OutgoingFile): Promise<string | undefined> {
    if (file.bytes.byteLength > this.maxFileBytes) throw new Error("That file is larger than the 50 MB Branch sends through Signal");
    return this.write(chatId, (file.caption ?? "").slice(0, this.maxTextLength),
      [`data:${mimeOf(file.mediaType)};filename=${dataName(file.name)};base64,${Buffer.from(file.bytes).toString("base64")}`]);
  }
  /** A spoken reply as a Signal voice note, shown inline (signal-cli's `--voice-note`, `voiceNote` over JSON-RPC). */
  async sendVoice(chatId: string, audio: Uint8Array, mediaType: string): Promise<string | undefined> {
    if (audio.byteLength > this.maxFileBytes) throw new Error("That spoken reply is larger than the 50 MB Branch sends through Signal");
    const extension = /ogg|opus/.test(mediaType) ? "ogg" : /mpeg|mp3/.test(mediaType) ? "mp3" : /wav/.test(mediaType) ? "wav" : "m4a";
    return this.write(chatId, "", [`data:${mimeOf(mediaType)};filename=reply.${extension};base64,${Buffer.from(audio).toString("base64")}`], true);
  }
  async send(chatId: string, text: string): Promise<string | undefined> {
    return this.write(chatId, text.slice(0, this.maxTextLength));
  }
  private async write(chatId: string, message: string, attachments?: string[], voiceNote = false): Promise<string | undefined> {
    if (!this.child?.stdin?.writable) throw new Error("signal-cli is not running, so the message could not be sent");
    const id = this.nextId++;
    const isGroup = !chatId.startsWith("+");
    const params = { ...(isGroup ? { groupId: chatId } : { recipient: [chatId] }), message, ...(attachments ? { attachments } : {}), ...(voiceNote ? { voiceNote } : {}) };
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "send", params, id }) + "\n");
    return String(id);
  }
}
