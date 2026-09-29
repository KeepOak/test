import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { z } from "zod";
import { audit } from "../audit.js";
import type { ChannelAdapter } from "../channels/router.js";
import { tryReadDocument } from "../document-readers.js";
import type { WorkspaceFiles } from "../files.js";
import { findLeaks } from "../leak-guard.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { partSettings, requirePersonal, savePartSettings } from "./settings.js";

/**
 * R17-022: a file Branch made — a chart, a PDF, a spreadsheet — delivered into a chat as the chat
 * app's own attachment, through the adapter that is already connected (any app whose adapter has `sendFile`).
 *
 * Before anything leaves this computer:
 *   - only the owner may send, and only to a chat that has already talked to the assistant after
 *     the sender list let it in, or one the owner linked to a conversation (the chats list);
 *   - the file must be inside the workspace (the same path checks every file tool has);
 *   - it must fit both the owner's limit and the chat app's own;
 *   - its words — the plain text, or what the document readers lift out of a PDF or an Office
 *     file — are run through the leak guard, and a key-shaped value or a known secret stops it;
 *   - the caption goes through the same last look as every reply (Lockdown, personal details).
 */
export const ChatFileSettingsSchema = z.object({
  /** The largest file sent, in megabytes, whatever the chat app would take. */
  maxMegabytes: z.number().int().min(1).max(100).default(20),
}).strict();
const settingsKey = "personal-chat-files-settings";

export const SendFileSchema = z.object({
  channel: z.string().trim().min(1).max(64),
  chatId: z.string().trim().min(1).max(64),
  /** A file in the workspace, as the file tools name it. */
  path: z.string().trim().min(1).max(500),
  caption: z.string().max(1000).optional(),
  replyTo: z.string().max(64).optional(),
}).strict();

const mediaTypes: Record<string, string> = {
  ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".csv": "text/csv", ".txt": "text/plain", ".md": "text/markdown",
  ".json": "application/json", ".html": "text/html", ".mp3": "audio/mpeg", ".ogg": "audio/ogg",
  ".mp4": "video/mp4", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const packed = /\.(zip|gz|tgz|bz2|xz|7z|rar|tar|zst|jar|apk|dmg|iso)$/i;
export const mediaTypeOf = (name: string): string => mediaTypes[extname(name).toLowerCase()] ?? "application/octet-stream";

export interface ChatFilesDeps {
  store: Store;
  owner: string;
  files: WorkspaceFiles;
  /** The connected chat app with this id. */
  adapter: (channel: string) => ChannelAdapter | undefined;
  /** Whether this chat may be written to: it has talked to the assistant, or its sender is allowed. */
  reachable: (channel: string, chatId: string) => boolean;
  /** The last look before words leave this computer (Lockdown, personal details, content check). */
  outboundGuard: (text: string) => Promise<{ text: string; blocked: boolean; reason?: string }>;
  /** True when the text holds a secret the locker knows. */
  holdsKnownSecret: (text: string) => boolean;
  requireOwner: (what: string) => void;
}

/** The words a file carries, for the leak check: its own text, and what a document reader finds. */
export function wordsOf(bytes: Buffer, name: string): string {
  const read = tryReadDocument(bytes, name);
  const lifted = read.document?.text ?? "";
  // Keys hide in binary files too (an uncompressed PDF, a config inside a zip's name list).
  return `${lifted}\n${bytes.toString("utf8")}`;
}

export class ChatFiles {
  constructor(private readonly deps: ChatFilesDeps) {}
  settings() { return partSettings(this.deps.store, this.deps.owner, settingsKey, ChatFileSettingsSchema); }
  save(input: unknown) { return savePartSettings(this.deps.store, this.deps.owner, settingsKey, ChatFileSettingsSchema, input); }

  /** Everything that must be true before the bytes are read, in the order a person would ask. */
  private async target(value: z.infer<typeof SendFileSchema>): Promise<{ adapter: ChannelAdapter; path: string; limit: number }> {
    const { deps } = this;
    requirePersonal(deps.store, deps.owner, "chat-files");
    deps.requireOwner("Sending files to your chats");
    const adapter = deps.adapter(value.channel);
    if (!adapter) throw new Error(`No chat app called ${value.channel} is connected`);
    if (!adapter.sendFile) throw new Error(`${adapter.kind} cannot take files from Branch yet; send a link or the words instead`);
    if (!deps.reachable(value.channel, value.chatId))
      throw new Error("That chat has never talked to the assistant and its sender is not on your list, so nothing is sent to it");
    const path = await deps.files.checked(value.path);
    const limit = Math.min(this.settings().maxMegabytes * 1024 * 1024, adapter.maxFileBytes ?? 0);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`${value.path} is not a file`);
    // Integration review: the leak guard cannot look inside a packed file, so none is sent.
    if (packed.test(value.path)) throw new Error(`${value.path} is a packed file whose insides cannot be checked for keys; send the files themselves`);
    const size = info.size;
    if (size > limit) throw new Error(`${value.path} is ${Math.ceil(size / 1048576)} MB, over the ${Math.floor(limit / 1048576)} MB this chat may be sent`);
    return { adapter, path, limit };
  }

  async send(input: unknown) {
    const value = SendFileSchema.parse(input);
    const { adapter, path, limit } = await this.target(value);
    const bytes = await readFile(path);
    if (bytes.byteLength > limit) throw new Error(`${value.path} grew past the ${Math.floor(limit / 1048576)} MB this chat may be sent`);
    const name = basename(path);
    const words = wordsOf(bytes, name);
    const leaks = [...new Set(findLeaks(words).map((hit) => hit.kind))];
    if (leaks.length) throw new Error(`${name} holds something that looks like a key or password (${leaks.join(", ")}), so it was not sent`);
    if (this.deps.holdsKnownSecret(words)) throw new Error(`${name} holds one of your saved secrets, so it was not sent`);
    const checked = await this.deps.outboundGuard(value.caption || name);
    if (checked.blocked) throw new Error(checked.reason ?? "The file was held back before it was sent");
    const caption = value.caption ? checked.text : undefined;
    const messageId = await adapter.sendFile!(value.chatId, { name, mediaType: mediaTypeOf(name), bytes,
      ...(caption ? { caption } : {}) }, value.replyTo);
    audit(this.deps.store, this.deps.owner, { action: "data.exported", actor: this.deps.owner,
      subject: `${name} to ${value.chatId} on ${value.channel}`, reason: "A file was sent into a chat", outcome: "sent" });
    return { sent: name, bytes: bytes.byteLength, channel: value.channel, chatId: value.chatId, messageId: messageId ?? null };
  }
}

export function registerChatFiles(registry: Pick<ToolRegistry, "register">, chatFiles: ChatFiles): void {
  registry.register({ name: "chat.send_file", permission: "channels.send",
    description: "Send a file from the workspace (a chart, PDF, spreadsheet…) into a linked chat (Telegram, Slack, Discord, Signal, email, iMessage and the other apps that take files), as that app's own attachment.",
    parameters: SendFileSchema, target: (input) => input.path, execute: async (input) => chatFiles.send(input) });
}
