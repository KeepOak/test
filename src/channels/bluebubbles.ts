import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";
import { ArtifactTooLarge, maxArtifactBytes } from "../artifacts.js";
import type { ChannelHealth, InboundMessage, OutgoingFile } from "./router.js";
import { defineService, PollingChannel, secretName } from "./parity-common.js";

/**
 * iMessage from any computer, through a BlueBubbles server the owner runs on their own Mac (CHAT-153). BlueBubbles is a
 * separate open-source app (bluebubbles.app); Branch never installs it. Branch reads new messages by asking the server
 * every few seconds (Branch has no public address for BlueBubbles to post to), and sends through it by AppleScript, so
 * the Mac needs no Private API.
 *
 * The server only takes its password in the address (`?password=`; bluebubbles-server
 * `packages/server/src/server/api/http/api/v1/middleware/authMiddleware.ts` L7-L10 at f2e2286), so the address is built
 * here and nowhere else, redirects are never followed with it, and every error and health line is written by this file,
 * with the password taken out of anything a lower layer says, so it never reaches a log, a card or a chat.
 *
 * Endpoints, from the same commit (`.../api/v1/httpRoutes.ts` and the message and attachment routers):
 * - `POST /api/v1/message/query` `{ limit, sort, where, with: ["chat", "attachment"] }` (L471-L474; validator
 *   `messageValidator.ts` L50-L62). New messages are read by the Messages database's own row number
 *   (`message.ROWID > :rowid`; the serializer hands it out as `originalROWID`, `MessageSerializer.ts` L130; `where` is
 *   applied as written, `databases/imessage/index.ts` L286-L291), not by date: a message that reaches the Mac late
 *   keeps its sender's earlier time, and a date cursor would pass it by;
 * - `POST /api/v1/message/text` `{ chatGuid, tempGuid, message, method: "apple-script" }` (L429-L432; AppleScript needs
 *   a tempGuid, `messageValidator.ts` L97-L100);
 * - `POST /api/v1/message/attachment`, multipart `attachment` plus `chatGuid, tempGuid, name, method, isAudioMessage`
 *   (L435-L438; `messageValidator.ts` L121-L151);
 * - `GET /api/v1/attachment/:guid/download` (L240-L243), which turns HEIC pictures and CAF audio into common formats.
 */
export interface BlueBubblesOptions {
  id: string;
  /** The server's address as BlueBubbles shows it, for example https://abc.trycloudflare.com or http://192.168.1.20:1234. */
  server: string;
  password: string;
  passwordSecret: string;
  /** The name people call the assistant by in a group, to be answered there. */
  name?: string;
  pollMs?: number;
  retryBaseMs?: number;
  fetch?: typeof fetch;
}

const HandleSchema = z.object({ address: z.string().max(200) }).passthrough();
const ChatSchema = z.object({ guid: z.string().min(1).max(200), style: z.number().nullish(), displayName: z.string().max(200).nullish() }).passthrough();
const FileSchema = z.object({ guid: z.string().regex(/^[\w:.-]{1,120}$/), mimeType: z.string().max(100).nullish(), transferName: z.string().max(300).nullish(),
  totalBytes: z.number().nullish() }).passthrough();
const MessageSchema = z.object({
  guid: z.string().min(1).max(200), text: z.string().nullish(), isFromMe: z.boolean().default(false), originalROWID: z.number().int().nonnegative().nullish(),
  handle: HandleSchema.nullish(), chats: z.array(ChatSchema).default([]), attachments: z.array(z.unknown()).default([]),
  isAudioMessage: z.boolean().nullish(),
}).passthrough();
const ListSchema = z.object({ data: z.array(z.unknown()).default([]) }).passthrough();

/** An address Branch may send the password to: https anywhere, plain http only on this computer or the local network. */
export function serverAllowed(server: string): boolean {
  let url: URL;
  try { url = new URL(server); } catch { return false; }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (isIP(host) === 4) return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  if (isIP(host) === 6) return /^(::1$|fe80:|f[cd])/.test(host);
  return false;
}

export class BlueBubblesChannel extends PollingChannel {
  readonly kind = "bluebubbles";
  /** The highest row number of the Messages database seen, which the next look starts after. */
  private rowid = 0;
  private readonly seen = new Set<string>();
  private refused: string | null = null;
  private readonly fetchImpl: typeof fetch;
  /** iMessage carries large files; this keeps an upload through the Mac quick and sure. */
  readonly maxFileBytes = 100 * 1024 * 1024;
  constructor(private readonly options: BlueBubblesOptions) {
    super(options.id, options.pollMs ?? 3000, options.retryBaseMs ?? 1000);
    if (!serverAllowed(options.server)) throw new Error("BlueBubbles needs an https address, or a plain http address on this computer or your own network");
    this.maxTextLength = 3000;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }
  botName(): string | null { return this.options.name ?? null; }
  override health(): ChannelHealth { return this.refused ? { state: "needs attention", reason: this.refused } : super.health(); }

  /** Anything a lower layer said, with the password taken out, in whatever form it could appear. */
  private clean(words: string): string {
    const secret = this.options.password;
    let out = words;
    for (const form of new Set([secret, encodeURIComponent(secret), new URLSearchParams({ p: secret }).toString().slice(2)]))
      if (form) out = out.split(form).join("…");
    return out.replace(/([?&](password|guid|token)=)[^&\s]*/gi, "$1…").slice(0, 300);
  }
  private address(path: string, query: Record<string, string> = {}): string {
    const base = this.options.server.replace(/\/+$/, "");
    return `${base}/api/v1/${path}?${new URLSearchParams({ ...query, password: this.options.password })}`;
  }
  /** One call to the server. The password never leaves this function in an error. */
  private async call(method: "GET" | "POST", path: string, body?: BodyInit, json = true): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.address(path), {
        method, redirect: "error", signal: AbortSignal.timeout(60000),
        ...(body !== undefined ? { body } : {}), ...(json && body !== undefined ? { headers: { "content-type": "application/json" } } : {}),
      });
    } catch (error) {
      throw new Error(`The BlueBubbles server could not be reached: ${this.clean(error instanceof Error ? error.message : String(error))}`);
    }
    if (response.status === 401) {
      this.refused = `The BlueBubbles server refused the password. Save the one in its settings as ${this.options.passwordSecret}`;
      throw new Error("The BlueBubbles server refused the password");
    }
    if (!response.ok) throw new Error(`The BlueBubbles server refused the request (${response.status})`);
    this.refused = null;
    return response;
  }
  private async json(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    const response = await this.call(method, path, body === undefined ? undefined : JSON.stringify(body));
    return response.json().catch(() => ({}));
  }

  protected async poll(first: boolean): Promise<InboundMessage[]> {
    const query = first ? { limit: 1, sort: "DESC" }
      : { limit: 100, sort: "ASC", where: [{ statement: "message.ROWID > :rowid", args: { rowid: this.rowid } }], with: ["chat", "attachment"] };
    const rows = ListSchema.parse(await this.json("POST", "message/query", query)).data.flatMap((row) => {
      const parsed = MessageSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    });
    // An empty Mac has no history, so starting after row 0 then answers only what arrives next.
    const out: InboundMessage[] = [];
    for (const row of rows) {
      this.rowid = Math.max(this.rowid, row.originalROWID ?? 0);
      if (this.seen.has(row.guid)) continue;
      this.seen.add(row.guid);
      if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);
      if (first || row.isFromMe) continue;
      const inbound = this.inbound(row);
      if (inbound) out.push(inbound);
    }
    return out;
  }
  private inbound(row: z.infer<typeof MessageSchema>): InboundMessage | null {
    const sender = row.handle?.address ?? "", chat = row.chats[0];
    const text = (row.text ?? "").replace(/￼/g, "").trim();
    const files = row.attachments.flatMap((item) => { const parsed = FileSchema.safeParse(item); return parsed.success ? [parsed.data] : []; }).slice(0, 10);
    if (!sender || !chat || (!text && !files.length)) return null;
    const group = chat.style === 43;
    const chatId = this.ids.short(chat.guid, "chat");
    const name = (this.options.name ?? "").toLowerCase();
    return {
      channel: this.id, chatId, chatKind: group ? "group" : "direct", ...(group ? { chatTitle: chat.displayName || "iMessage group" } : {}),
      senderId: this.ids.short(sender, "who"), senderName: sender, text,
      addressed: !group || (!!name && text.toLowerCase().includes(name)), messageId: this.ids.short(row.guid, "msg"),
      ...this.filesOf(files, row.isAudioMessage === true),
    };
  }
  /** A recorded audio message to transcribe, or pictures and files for the task; each downloaded only once it is answered. */
  private filesOf(files: z.infer<typeof FileSchema>[], audio: boolean): Partial<InboundMessage> {
    if (!files.length) return {};
    const type = (file: z.infer<typeof FileSchema>) => (file.mimeType ?? "application/octet-stream").split(";")[0]!.toLowerCase();
    const bytes = (file: z.infer<typeof FileSchema>) => () => this.download(file);
    if (audio && files.length === 1) return { voice: { mediaType: type(files[0]!), seconds: undefined, bytes: bytes(files[0]!) } };
    return { attachments: files.map((file) => ({ name: file.transferName || `imessage-${file.guid.slice(-8)}`, sourceId: file.guid, mediaType: type(file),
      kind: type(file).startsWith("image/") ? "picture" as const : type(file).startsWith("video/") ? "video" as const : "document" as const,
      ...(file.totalBytes != null ? { size: file.totalBytes } : {}), bytes: bytes(file) })) };
  }
  private async download(file: z.infer<typeof FileSchema>): Promise<Uint8Array> {
    if ((file.totalBytes ?? 0) > maxArtifactBytes) throw new ArtifactTooLarge("That file is too large");
    const response = await this.call("GET", `attachment/${encodeURIComponent(file.guid)}/download`);
    if (Number(response.headers.get("content-length") ?? 0) > maxArtifactBytes) throw new ArtifactTooLarge("That file is too large");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxArtifactBytes) throw new ArtifactTooLarge("That file is too large");
    return bytes;
  }

  async send(chatId: string, text: string): Promise<string | undefined> {
    const answer = await this.json("POST", "message/text", { chatGuid: this.ids.long(chatId), tempGuid: randomUUID(), message: text.slice(0, this.maxTextLength), method: "apple-script" });
    return this.sentId(answer);
  }
  /** A file into the chat through the Mac, with its caption after it as words. */
  async sendFile(chatId: string, file: OutgoingFile): Promise<string | undefined> {
    const id = await this.upload(chatId, file.name, file.mediaType, file.bytes, false);
    if (file.caption) await this.send(chatId, file.caption);
    return id;
  }
  /** A spoken reply, marked as an audio message; without the Private API the Mac may show it as an audio file. */
  async sendVoice(chatId: string, audio: Uint8Array, mediaType: string): Promise<string | undefined> {
    const extension = /mpeg|mp3/.test(mediaType) ? "mp3" : /ogg|opus/.test(mediaType) ? "ogg" : /wav/.test(mediaType) ? "wav" : "m4a";
    return this.upload(chatId, `reply.${extension}`, mediaType, audio, true);
  }
  private async upload(chatId: string, name: string, mediaType: string, bytes: Uint8Array, audio: boolean): Promise<string | undefined> {
    if (bytes.byteLength > this.maxFileBytes) throw new Error("That file is larger than the 100 MB Branch sends through BlueBubbles");
    const form = new FormData();
    const safeName = name.replace(/[/\\:\u0000-\u001f]+/g, "_").slice(0, 150) || "file";
    form.set("attachment", new Blob([new Uint8Array(bytes)], { type: mediaType }), safeName);
    form.set("chatGuid", this.ids.long(chatId));
    form.set("tempGuid", randomUUID());
    form.set("name", safeName);
    form.set("method", "apple-script");
    form.set("isAudioMessage", audio ? "true" : "false");
    const response = await this.call("POST", "message/attachment", form, false);
    return this.sentId(await response.json().catch(() => ({})));
  }
  private sentId(answer: unknown): string | undefined {
    const guid = (answer as { data?: { guid?: unknown } } | null)?.data?.guid;
    return typeof guid === "string" ? this.ids.short(guid, "msg") : undefined;
  }
}

export const blueBubblesService = defineService({
  kind: "bluebubbles", name: "iMessage through BlueBubbles", docs: "https://docs.bluebubbles.app/server",
  needs: ["A Mac that stays on, signed in to Messages, running the BlueBubbles server app",
    "The server's https address, as the BlueBubbles server shows it (its Cloudflare or dynamic DNS link)",
    "The server password, saved as a secret",
    "Only for an address on your own network instead: private addresses allowed under Computer → Network reach"],
  receives: "polls",
  settings: z.object({
    server: z.string().url().max(300).refine(serverAllowed, "Use an https address, or a plain http address on this computer or your own network"),
    passwordSecret: z.string().regex(secretName).default("BLUEBUBBLES_PASSWORD"),
    /** The name people call the assistant by in a group. */
    name: z.string().min(2).max(60).optional(),
    pollSeconds: z.number().int().min(2).max(300).default(3),
  }).strict(),
  async build(settings, deps) {
    await deps.assertAllowed(new URL(settings.server), "BlueBubbles server");
    return new BlueBubblesChannel({ id: deps.id, server: settings.server, password: await deps.secret(settings.passwordSecret),
      passwordSecret: settings.passwordSecret, pollMs: settings.pollSeconds * 1000, fetch: deps.fetch,
      ...(settings.name ? { name: settings.name } : {}) });
  },
});
