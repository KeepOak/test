import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { z } from "zod";
import { ArtifactTooLarge, maxArtifactBytes } from "../artifacts.js";
import type { InboundMessage, OutgoingFile } from "./router.js";
import { defineService, PollingChannel } from "./parity-common.js";

/**
 * iMessage, by driving the Messages app on the owner's own Mac. There is no iMessage API: this is
 * the same route BlueBubbles and ZeroClaw take. Replies are sent through AppleScript; new messages
 * are read from the Messages database on this Mac. It works only on a Mac, and only once the owner
 * has given Branch Full Disk Access (to read the database) and allowed it to control Messages.
 *
 * The words and the address are handed to `osascript` as arguments, never written into the script
 * itself, so nothing a person types can become AppleScript. The script is fixed text.
 *
 * Files: a picture, file or audio message someone sends is read from the Messages attachments folder
 * (only from inside it) once the message is answered. A file Branch sends is first written into a
 * folder of its own inside that same attachments folder, then handed to Messages by path; recent macOS
 * versions have been seen to refuse a scripted send of a file kept elsewhere, and this is the folder other
 * Messages bridges use for the same reason. Old ones are cleared after a day.
 *
 * Reading the typed-stream `attributedBody` follows the format notes in ZeroClaw's imessage channel
 * (MIT OR Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
export type CommandRunner = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
export interface MessageRow {
  id: number; sender: string; text: string | null; body: Uint8Array | null; chat: string | null; style: number | null; title: string | null;
  /** The files on the message, from the attachment table; absent when there are none. */
  files?: AttachmentRow[];
  /** 1 for a recorded audio message. */
  audio?: number | null;
}
/** One file on a message: where Messages keeps it (often starting with ~), its type, its name as sent, and its size. */
export interface AttachmentRow { id: number; path: string | null; type: string | null; name: string | null; size: number | null }
/** Returns the rows after `afterId`; with `afterId` null, returns only the newest row, to take stock. */
export type MessageReader = (afterId: number | null) => Promise<MessageRow[]>;

/** Sends to one person (a phone number or Apple ID) or, for a group, to the chat by its id. */
export const sendScript = [
  "on run argv",
  "set targetName to item 1 of argv",
  "set messageText to item 2 of argv",
  "set isGroup to item 3 of argv",
  'tell application "Messages"',
  'if isGroup is "yes" then',
  "send messageText to chat id targetName",
  "else",
  "set targetService to 1st account whose service type = iMessage",
  "send messageText to participant targetName of targetService",
  "end if",
  "end tell",
  "end run",
];

/** Sends one file, by its path, to one person or a group, the same way the words go. */
export const sendFileScript = [
  "on run argv",
  "set targetName to item 1 of argv",
  "set theFile to POSIX file (item 2 of argv)",
  "set isGroup to item 3 of argv",
  'tell application "Messages"',
  'if isGroup is "yes" then',
  "send theFile to chat id targetName",
  "else",
  "set targetService to 1st account whose service type = iMessage",
  "send theFile to participant targetName of targetService",
  "end if",
  "end tell",
  "end run",
];

export const realRunner: CommandRunner = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 30000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
    if (error) reject(new Error(String(stderr || error.message).split("\n")[0]!.slice(0, 200)));
    else resolve({ stdout: String(stdout), stderr: String(stderr) });
  });
});

/** Pulls the plain words out of the typed-stream blob newer macOS versions store instead of `text`. */
export function textFromAttributedBody(blob: Uint8Array | null): string {
  if (!blob) return "";
  const bytes = Buffer.from(blob);
  let at = -1;
  for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === 0x01 && bytes[i + 1] === 0x2b) { at = i + 2; break; }
  if (at < 0 || at >= bytes.length) return "";
  const lead = bytes[at]!;
  let length: number, start: number;
  if (lead === 0x81 && at + 3 <= bytes.length) { length = bytes.readUInt16LE(at + 1); start = at + 3; }
  else if (lead === 0x82 && at + 5 <= bytes.length) { length = bytes.readUInt32LE(at + 1); start = at + 5; }
  else if (lead <= 0x7f) { length = lead; start = at + 1; }
  else return "";
  if (start + length > bytes.length) return "";
  return bytes.subarray(start, start + length).toString("utf8");
}

const rowQuery = `SELECT m.ROWID AS id, h.id AS sender, m.text AS text, m.attributedBody AS body,
  c.guid AS chat, c.style AS style, c.display_name AS title, m.cache_has_attachments AS hasFiles, m.is_audio_message AS audio
  FROM message m JOIN handle h ON m.handle_id = h.ROWID
  LEFT JOIN chat_message_join j ON j.message_id = m.ROWID LEFT JOIN chat c ON c.ROWID = j.chat_id
  WHERE m.is_from_me = 0 AND m.ROWID > ? ORDER BY m.ROWID ASC LIMIT 50`;

const fileQuery = `SELECT a.ROWID AS id, a.filename AS path, a.mime_type AS type, a.transfer_name AS name, a.total_bytes AS size
  FROM attachment a JOIN message_attachment_join j ON j.attachment_id = a.ROWID WHERE j.message_id = ? LIMIT 10`;

/**
 * The bytes of one received file, read only from inside the Messages attachments folder (links followed first, so a
 * link cannot lead out of it), and never past the size a task takes.
 */
export async function readAttachment(folder: string, path: string): Promise<Uint8Array> {
  const expanded = path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  const [real, inside] = await Promise.all([realpath(expanded), realpath(folder)]);
  if (!real.startsWith(inside + sep)) throw new Error("That file is not in the Messages attachments folder, so it was not read");
  if ((await stat(real)).size > maxArtifactBytes) throw new ArtifactTooLarge("That file is too large");
  return new Uint8Array(await readFile(real));
}

/** Reads the Messages database read-only. A missing permission is said in words the owner can act on. */
export function databaseReader(path: string): MessageReader {
  return async (afterId) => {
    const { DatabaseSync } = await import("node:sqlite");
    try {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        if (afterId !== null) {
          const rows = db.prepare(rowQuery).all(afterId) as unknown as (MessageRow & { hasFiles?: number | null })[];
          const files = db.prepare(fileQuery);
          return rows.map(({ hasFiles, ...row }) => (hasFiles ? { ...row, files: files.all(row.id) as unknown as AttachmentRow[] } : row));
        }
        const newest = db.prepare("SELECT MAX(ROWID) AS id FROM message").get() as { id: number | null } | undefined;
        return [{ id: Number(newest?.id ?? 0), sender: "", text: null, body: null, chat: null, style: null, title: null }];
      } finally { db.close(); }
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error);
      if (/authori[sz]|unable to open|not permitted|operation not permitted/i.test(said))
        throw new Error("Branch cannot read your messages yet. Give it Full Disk Access in System Settings, Privacy & Security");
      throw error;
    }
  };
}

export interface IMessageOptions {
  id: string;
  reader: MessageReader;
  runner: CommandRunner;
  /** The owner's own address, shown as the assistant's name. */
  account?: string;
  pollMs?: number;
  /** The Messages attachments folder (~/Library/Messages/Attachments): received files are read only from inside it. */
  attachments?: string;
  /** Reads a received file; tests replace it. */
  readFile?: (path: string) => Promise<Uint8Array>;
}

export class IMessageChannel extends PollingChannel {
  readonly kind = "imessage";
  private lastId = 0;
  /** Group chats and the people in them, so a reply goes back to the right place. */
  private readonly groups = new Set<string>();
  constructor(private readonly options: IMessageOptions) {
    super(options.id, options.pollMs ?? 3000);
    this.maxTextLength = 3000;
  }
  /** iMessage itself carries files of 100 MB and more; this keeps a send through AppleScript quick and sure. */
  readonly maxFileBytes = 100 * 1024 * 1024;
  private get folder(): string { return this.options.attachments ?? join(homedir(), "Library", "Messages", "Attachments"); }
  botName(): string | null { return this.options.account ?? null; }
  protected async poll(first: boolean): Promise<InboundMessage[]> {
    const rows = await this.options.reader(first ? null : this.lastId);
    const messages: InboundMessage[] = [];
    for (const row of rows) {
      this.lastId = Math.max(this.lastId, Number(row.id));
      if (first) continue;
      const inbound = this.inbound(row);
      if (inbound) messages.push(inbound);
    }
    return messages;
  }
  private inbound(row: MessageRow): InboundMessage | null {
    // A message that carries a file holds U+FFFC where the file sits; that is not words.
    const said = (row.text && row.text.replace(/\uFFFC/g, "").trim()) ? row.text : textFromAttributedBody(row.body);
    const text = said.replace(/\uFFFC/g, "").trim();
    const files = (row.files ?? []).filter((file) => !!file.path);
    if ((!text && !files.length) || !row.sender) return null;
    const group = row.style === 43 && !!row.chat;
    const chatId = this.ids.short(group ? row.chat! : row.sender, "chat");
    if (group) this.groups.add(chatId);
    const name = (this.options.account ?? "").split("@")[0]!.toLowerCase();
    return {
      channel: this.id, chatId, chatKind: group ? "group" : "direct",
      ...(group ? { chatTitle: row.title || "iMessage group" } : {}),
      senderId: this.ids.short(row.sender, "who"), senderName: row.sender, text,
      addressed: !group || (!!name && text.toLowerCase().includes(name)),
      messageId: String(row.id),
      ...this.filesOf(files, row.audio === 1),
    };
  }
  /** A recorded audio message to transcribe, or pictures and files as the task's material; each read only once it is answered. */
  private filesOf(files: AttachmentRow[], audio: boolean): Partial<InboundMessage> {
    if (!files.length) return {};
    const read = this.options.readFile ?? ((path: string) => readAttachment(this.folder, path));
    const type = (file: AttachmentRow) => (file.type ?? "application/octet-stream").toLowerCase();
    if (audio && files.length === 1) return { voice: { mediaType: type(files[0]!), seconds: undefined, bytes: () => read(files[0]!.path!) } };
    return { attachments: files.map((file) => ({ name: file.name || file.path!.split("/").pop() || `imessage-${file.id}`, sourceId: String(file.id),
      mediaType: type(file), kind: type(file).startsWith("image/") ? "picture" as const : type(file).startsWith("video/") ? "video" as const : "document" as const,
      ...(file.size != null ? { size: Number(file.size) } : {}), bytes: () => read(file.path!) })) };
  }
  /** A file into the chat: written into Branch's own folder where Messages may read it, then sent by path, with its caption after it. */
  async sendFile(chatId: string, file: OutgoingFile): Promise<string | undefined> {
    if (file.bytes.byteLength > this.maxFileBytes) throw new Error("That file is larger than the 100 MB Branch sends through Messages");
    const outbox = join(this.folder, "Branch");
    await this.clearOld(outbox);
    const folder = join(outbox, randomUUID());
    await mkdir(folder, { recursive: true });
    const path = join(folder, file.name.replace(/[/\\:\u0000-\u001f]+/g, "_").replace(/^[.-]+/, "").slice(0, 150) || "file");
    await writeFile(path, file.bytes, { flag: "wx" });
    await this.osascript(sendFileScript, chatId, path.split(sep).join("/"));
    if (file.caption) await this.send(chatId, file.caption);
    return undefined;
  }
  /** A spoken reply, sent as an audio file (Messages has no way to send a recorded audio message from a script). */
  async sendVoice(chatId: string, audio: Uint8Array, mediaType: string): Promise<string | undefined> {
    const extension = /mpeg|mp3/.test(mediaType) ? "mp3" : /ogg|opus/.test(mediaType) ? "ogg" : /wav/.test(mediaType) ? "wav" : "m4a";
    return this.sendFile(chatId, { name: `reply.${extension}`, mediaType, bytes: audio });
  }
  /** Files Branch sent more than a day ago; Messages has copied them by then. */
  private async clearOld(outbox: string): Promise<void> {
    const entries = await readdir(outbox, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const at = join(outbox, entry.name);
      const info = await stat(at).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 24 * 3600 * 1000) await rm(at, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  async send(chatId: string, text: string): Promise<string | undefined> {
    await this.osascript(sendScript, chatId, text.slice(0, this.maxTextLength));
    return undefined;
  }
  private async osascript(script: string[], chatId: string, what: string): Promise<void> {
    const target = this.ids.long(chatId);
    // osascript reads a leading "-" as one of its own options; no address or chat id starts with one.
    if (target.startsWith("-")) throw new Error("That is not an address Messages can send to");
    const group = this.groups.has(chatId) ? "yes" : "no";
    const args = script.flatMap((line) => ["-e", line]);
    await this.options.runner("/usr/bin/osascript", [...args, target, what, group])
      .catch((error: unknown) => {
        throw new Error(`Messages would not send it: ${error instanceof Error ? error.message : String(error)}. Allow Branch to control Messages in System Settings, Privacy & Security, Automation`);
      });
  }
}

export const imessageService = defineService({
  kind: "imessage", name: "iMessage", docs: "https://support.apple.com/guide/mac-help/control-access-to-files-and-folders-on-mac-mchld5a35146/mac",
  needs: ["A Mac signed in to Messages with your Apple Account",
    "Full Disk Access for Branch, so it can read new messages", "Permission for Branch to control Messages"],
  receives: "polls",
  platforms: ["darwin"],
  settings: z.object({
    /** Your own address in Messages, used as the assistant's name in groups. */
    account: z.string().min(3).max(120).optional(),
    database: z.string().min(3).max(400).optional(),
    pollSeconds: z.number().int().min(2).max(300).default(3),
  }).strict(),
  async build(settings, deps) {
    const database = settings.database ?? join(homedir(), "Library", "Messages", "chat.db");
    return new IMessageChannel({ id: deps.id, reader: databaseReader(database), runner: realRunner, attachments: join(dirname(database), "Attachments"),
      pollMs: settings.pollSeconds * 1000, ...(settings.account ? { account: settings.account } : {}) });
  },
});
