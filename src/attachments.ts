import { z } from "zod";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import {
  copyFileSync, createReadStream, createWriteStream, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { basename, join, sep } from "node:path";
import {
  AttachmentRefSchema, maxAttachmentsBytesPerTurn, maximumAttachmentsPerTurn, mediaTypeToken,
  maximumUploadBytes, maximumUploadsPerTurn, maxUploadsBytesPerTurn,
  type AttachmentInput, type AttachmentKind, type AttachmentRef,
} from "./contracts.js";
import { diagnose } from "./diagnostic-log.js";
import { documentBytesLimit } from "./documents.js";

/**
 * Files a person attaches to a message: the original is kept, and the message keeps a reference to it.
 *
 * Until now the only thing that could be attached was a picture, and even that was not kept: its bytes
 * went to the model for one request and the conversation was left with "[attached picture: dot.png]".
 * A sound was turned into words and a video into a few stills, and both originals were dropped. So a
 * conversation could not show, later, what it had actually been given.
 *
 * The originals live here rather than beside what the assistant made, because a run artifact is capped
 * at 8 MB and read back only when it is a picture or a sound — neither suits a 32 MB video or a
 * document. Each conversation owns a folder; deleting the conversation deletes the folder, so a message
 * can never point at a file that is gone. A temporary conversation's folder is marked as such and swept
 * away when it closes, or at the next start if the app stopped before it could.
 */

/**
 * The most one attachment of each kind may weigh when it rides inside the message as base64. A file sent
 * ahead (`stage`) is streamed to disk instead and held to `maximumUploadBytes`. The page mirrors these;
 * this is what decides.
 */
export const attachmentLimits: Record<AttachmentKind, number> = {
  picture: 5 * 1024 * 1024,
  sound: 25 * 1024 * 1024,
  video: 32 * 1024 * 1024,
  document: documentBytesLimit,
  file: 32 * 1024 * 1024,
};
/** Written-out kinds, for a refusal a person can act on. */
const kindWords: Record<AttachmentKind, string> = {
  picture: "Pictures", sound: "Sounds", video: "Videos", document: "Documents", file: "Files",
};
/** The document types the Documents panel already takes. */
const documentTypes = new Set([
  "text/plain", "text/markdown", "text/html", "text/csv", "application/json", "application/pdf",
  "application/rtf", "text/rtf", "application/epub+zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text", "application/vnd.oasis.opendocument.spreadsheet",
]);
/**
 * A browser says nothing about many files (an empty type, or application/octet-stream): the ending of the
 * name is then the best word there is. Only used to choose how a file is read and previewed; the bytes are
 * never run, and a type that could carry script is still handed back as a download (shownInPlace).
 */
const byEnding: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", heic: "image/heic",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", opus: "audio/ogg",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown", csv: "text/csv", json: "application/json",
  html: "text/html", htm: "text/html", rtf: "application/rtf", epub: "application/epub+zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text", ods: "application/vnd.oasis.opendocument.spreadsheet",
};
/** Endings of files that are plain words even when a browser calls them something else (".ts" is not a video). */
export const wordsEndings = new Set([
  "txt", "md", "csv", "json", "log", "ini", "cfg", "conf", "toml", "yaml", "yml", "xml", "sql", "sh", "bash", "ps1", "bat",
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "swift",
  "php", "css", "scss", "html", "htm", "vue", "svelte", "lua", "r", "pl", "dart", "env", "gitignore", "dockerfile",
]);
const endingOf = (name = ""): string => (/\.([a-z0-9]{1,12})$/i.exec(name)?.[1] ?? "").toLowerCase();
/** The type a file is treated as: the name's ending wins for plain words, then whatever the browser said. */
export function typeFor(mediaType: string, name = ""): string {
  const said = mediaType.split(";")[0]!.trim().toLowerCase();
  const ending = endingOf(name);
  if (wordsEndings.has(ending) && !said.startsWith("image/")) return byEnding[ending] ?? "text/plain";
  if (said && said !== "application/octet-stream") return said;
  return byEnding[ending] ?? "application/octet-stream";
}
/** Which kind a file is, by its own type (and its name's ending when the type says nothing). Never refused: anything else is a "file". */
export function kindOf(mediaType: string, name = ""): AttachmentKind {
  const type = typeFor(mediaType, name);
  if (type.startsWith("image/")) return "picture";
  if (type.startsWith("audio/")) return "sound";
  if (type.startsWith("video/")) return "video";
  if (documentTypes.has(type) || type.startsWith("text/")) return "document";
  return "file";
}
/**
 * The name a file is shown by. It is only ever words on a chip and in the message: the file itself is kept
 * under a random id, so nothing here is a path. Even so, anything that reads like one is taken apart: no
 * control characters, no drive or leading slash, no "." or ".." parts, and a folder's own layout is kept
 * only as plain "folder/file" words.
 */
export function cleanName(name: string): string {
  const parts = name.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, "").split("\\").join("/")
    .split("/").map((part) => part.replace(/[<>:"|?*]/g, "_").trim()).filter((part) => part && part !== "." && part !== "..");
  const joined = parts.join("/");
  return (joined.length > 200 ? joined.slice(-200) : joined) || "file";
}
/** A conversation's folder name; a temporary one is marked so it can be swept away later. */
export function folderFor(sessionId: string, temporary = false): string {
  const plain = sessionId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 40);
  if (!plain) throw new Error("A conversation needs a name before a file can be attached to it");
  return temporary ? `tmp-${plain}` : plain;
}
const isTemporaryFolder = (name: string): boolean => name.startsWith("tmp-");

/**
 * The only types shown in the page itself. Everything else — documents above all, and anything that
 * could carry script such as SVG or HTML — is handed over as a download instead, so a file a person
 * was sent can never run as part of Branch's own page.
 */
const shownInPlace = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif",
  "audio/wav", "audio/mpeg", "audio/ogg", "audio/webm", "audio/mp4",
  "video/mp4", "video/webm", "video/ogg",
]);
/** Whether a kept file may be shown in the page, or has to be downloaded. */
export const shownInPage = (mediaType: string): boolean =>
  shownInPlace.has(mediaType.split(";")[0]!.trim().toLowerCase());

export interface BytesWanted { start: number; end: number }
/**
 * One range of a file, for a player that asks for part of a sound or a video. Only a single plain
 * range is understood; anything else is answered whole, and a range outside the file is refused so a
 * player is told plainly rather than handed the wrong bytes.
 */
export function rangeWanted(header: string | undefined, size: number): BytesWanted | "outside" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  const [, from, to] = match;
  const start = from ? Number(from) : Math.max(0, size - Number(to));
  const end = from ? (to ? Math.min(Number(to), size - 1) : size - 1) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return "outside";
  return { start, end };
}

/** Where a path really leads, following links the way the system itself does. */
function trueName(path: string): string | null {
  try { return realpathSync.native(path); } catch { /* a link that leads nowhere, or no such file */ }
  try { return realpathSync(path); } catch { return null; }
}

/**
 * What handing a file back needs: who is at the window, where the files are kept, and whether the
 * conversation they belong to is a temporary one. That last answer comes from the conversation
 * itself, never from the request: a caller that could name the folder could ask for the other one.
 */
export interface DeliveryParts {
  profiles: { isOwner(): boolean; scope(): string };
  attachments: Pick<Attachments, "partOf">;
  temporaryConversation(sessionId: string): boolean;
  /** Whether this conversation is filed under that name (src/store.ts ownsSession). */
  ownsConversation(owner: string, sessionId: string): boolean;
}
/**
 * Hands one kept file back for a window to show or save. Who may is the first thing decided here, so it moves with the
 * operation in a refactor and holds even for a caller that found another way in: the owner, or a household person for a
 * conversation filed under their own name (profiles.scope()), never anybody else's. The route in front of it refuses a
 * short-lived key, and a household person's read is listed in householdReads (src/household-routes.ts); neither layer
 * relies on the other.
 */
export async function attachmentForWindow(
  parts: DeliveryParts, wanted: { session: string; id: string },
): Promise<{ ref: AttachmentRef; size: number; open: (part: BytesWanted | null) => Readable }> {
  if (!parts.profiles.isOwner() && !parts.ownsConversation(parts.profiles.scope(), wanted.session))
    throw new Error("That file is not attached to this conversation");
  return parts.attachments.partOf(wanted.session, wanted.id,
    { temporary: parts.temporaryConversation(wanted.session) });
}

/**
 * Writes a conversation's listing and makes sure it has really reached the disk before saying so.
 * Without the flush the rename can land while the words are still in the operating system's hands,
 * and a machine that loses power there comes back with a name pointing at nothing.
 */
async function flushToFile(path: string, text: string): Promise<void> {
  const handle = await open(path, "w", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class Attachments {
  /**
   * Everything after the first argument exists so a test can hold the folder listing still, make the
   * listing's own write fail, and make a delete fail the way a locked file does. None of it is part
   * of the app's own surface: `createBranch` builds this with one argument and gets `readdirSync`, a
   * real flushed write and a real recursive delete.
   */
  constructor(
    readonly root: string,
    private readonly listFolders: (path: string) => string[] = readdirSync,
    private readonly writeListing: (path: string, text: string) => Promise<void> = flushToFile,
    private readonly remove: (path: string) => Promise<void> = (path) => rm(path, { recursive: true, force: true }),
    private readonly openRange: (path: string, part: BytesWanted | null) => Readable =
      (path, part) => createReadStream(path, part ? { start: part.start, end: part.end } : {}),
    private readonly disk: { free?: (path: string) => Promise<number>; now?: () => number; move?: (from: string, to: string) => Promise<void>;
      readList?: (path: string) => Promise<string> } = {},
  ) {}
  private freeBytes(path: string): Promise<number> {
    return this.disk.free ? this.disk.free(path) : freeBytesAt(path);
  }
  private now(): number { return this.disk.now ? this.disk.now() : Date.now(); }
  /** One queue per conversation, so its listing is never written by two turns at once. */
  private readonly turns = new Map<string, Promise<void>>();
  /** Only for tests: how many conversations still have a turn waiting or running. */
  get queuedTurns(): number {
    return this.turns.size;
  }

  /**
   * Files sent ahead of their message, by upload id. They wait in `.incoming` under the store (a name no
   * conversation folder can have: `folderFor` keeps letters and digits only), each bound to whoever sent
   * it, until a message takes them or they are taken off. Kept in memory on purpose: a restart forgets
   * them and `sweepIncoming` clears their bytes, so nothing half-sent outlives the app.
   */
  private readonly incoming = new Map<string, StagedFile>();
  private get incomingFolder(): string { return join(this.root, ".incoming"); }
  /**
   * attach-3: the list of files waiting, kept on disk beside them (never a path, only ids), so an engine restart forgets
   * none of them: a file pasted from the desktop's clipboard has no copy in the page to send again (src/desktop/
   * clipboard-files-ipc.ts). Written in order, whole, and moved into place, so it is never half a list.
   */
  private get waitingList(): string { return join(this.incomingFolder, waitingListName); }
  private saving: Promise<void> = Promise.resolve();
  /** Files being written right now, which a sweep must not take for leftovers of an earlier run. */
  private readonly writing = new Set<string>();
  /** attach-4: files a message is moving into its conversation right now, held from the sweep the same way. */
  private readonly moving = new Set<string>();
  /** attach-5: the start-up restore of files still waiting, while it runs (`restoreIncoming`). */
  private restoring: Promise<void> | null = null;
  /** True while the start-up restore runs: a message naming files sent ahead waits for `restored` first. */
  get restoringNow(): boolean { return this.restoring !== null; }
  /** Settles once the start-up restore is done, whether or not it read anything back; at once when none runs. */
  get restored(): Promise<void> { return this.restoring ?? Promise.resolve(); }
  private saveWaiting(): Promise<void> {
    const text = JSON.stringify([...this.incoming.values()].map(({ path: _path, ...kept }) => kept));
    const list = this.waitingList;
    // Kept for a restart only, so a list that cannot be written never fails the send or the message it is written for:
    // one left behind mends itself at the next start (a file no longer whole or no longer there is not taken back).
    this.saving = this.saving.then(async () => {
      await mkdir(this.incomingFolder, { recursive: true, mode: 0o700 });
      await writeFile(`${list}.next`, text, { mode: 0o600 });
      await rename(`${list}.next`, list);
    }).catch((error: unknown) => {
      diagnose("attachments", "error", "The list of files waiting to be sent could not be saved",
        { fields: { reason: error instanceof Error ? error.message : String(error) } });
    });
    return this.saving;
  }
  /** Bytes still arriving, per sender, so files sent side by side count against the same room. */
  private readonly arriving = new Map<string, number>();
  /** Files still arriving, per sender, so side-by-side sends count against how many may wait. */
  private readonly arrivingFiles = new Map<string, number>();

  /** Bytes waiting and still arriving: one sender's, or everyone's (`null`). */
  private waitingBytes(who: string | null): number {
    let sum = 0;
    for (const one of this.incoming.values()) if (who === null || one.who === who) sum += one.bytes;
    for (const [sender, bytes] of this.arriving) if (who === null || sender === who) sum += bytes;
    return sum;
  }

  /**
   * Streams one file to disk as it arrives: counted as it goes, stopped the moment it passes the limit,
   * and removed if it is refused, too big, empty, or the sender goes away half way. Nothing is held whole
   * in memory and nothing is ever run. Four rooms hold it: one file, one sender's waiting files, everyone's
   * waiting files, and the disk itself, which always keeps `reserve` free for everything else on it.
   */
  async stage(who: string, input: { name: string; mediaType: string; length?: number | null },
    body: AsyncIterable<Buffer | string>, limits: Partial<StageLimits> = {}): Promise<StagedView> {
    const cap: StageLimits = { ...stageLimits, ...limits };
    if (!mediaTypeToken.safeParse(input.mediaType).success)
      throw new Error("That file does not say what kind of file it is in a way Branch can use.");
    const name = cleanName(input.name);
    // attach-5: the waiting files an earlier run left are counted, and kept, before anything new joins them.
    await this.restored;
    await this.expireIncoming();
    // From the count to the count going up is one synchronous step, so side-by-side sends each see the others.
    const arrivingFiles = this.arrivingFiles.get(who) ?? 0;
    if ([...this.incoming.values()].filter((one) => one.who === who).length + arrivingFiles >= maximumUploadsPerTurn * 2)
      throw new Error("Too many files are waiting to be sent. Send or take some off first.");
    const room = Math.min(cap.file, cap.waiting - this.waitingBytes(who), cap.total - this.waitingBytes(null));
    if (input.length != null && input.length > room) throw this.tooBig(name, who, cap, input.length, input.length);
    this.arrivingFiles.set(who, arrivingFiles + 1);
    try {
      await mkdir(this.incomingFolder, { recursive: true, mode: 0o700 });
      if ((await this.freeBytes(this.incomingFolder)) - (input.length ?? 0) < cap.reserve) throw noDisk(name, cap);
      const { path, bytes } = await this.write(who, name, cap, room, body);
      const mediaType = typeFor(input.mediaType, name);
      const staged: StagedFile = { id: basename(path), who, path, name, mediaType, kind: kindOf(mediaType, name), bytes, at: this.now() };
      this.incoming.set(staged.id, staged);
      await this.saveWaiting();
      return viewOf(staged);
    } finally {
      const left = (this.arrivingFiles.get(who) ?? 1) - 1;
      if (left > 0) this.arrivingFiles.set(who, left); else this.arrivingFiles.delete(who);
    }
  }
  /** The sentence for a file that does not fit, naming the room it did not fit in that room's own size. */
  private tooBig(name: string, who: string, cap: StageLimits, size: number, extra: number): Error {
    if (size > cap.file) return new Error(`${name} is too big: one file can be up to ${sizeWords(cap.file)}.`);
    if (this.waitingBytes(null) + extra > cap.total && this.waitingBytes(who) + extra <= cap.waiting)
      return new Error(`${name} does not fit: files waiting to be sent, from everyone here, can add up to ${sizeWords(cap.total)}. Send or take some off first.`);
    return new Error(`${name} does not fit: files waiting to be sent can add up to ${sizeWords(cap.waiting)}. Send or take some off first.`);
  }
  /** Writes the arriving bytes under a new random id, measuring every room again as it goes. */
  private async write(who: string, name: string, cap: StageLimits, room: number, body: AsyncIterable<Buffer | string>):
    Promise<{ path: string; bytes: number }> {
    const path = join(this.incomingFolder, randomBytes(12).toString("hex"));
    const arriving = this.arriving, folder = this.incomingFolder, rooms = this;
    this.writing.add(basename(path));
    let bytes = 0, nextDiskCheck = diskCheckBytes;
    // Measured again with every piece, so files sent side by side cannot each find the whole room free.
    const over = () => bytes > room || rooms.waitingBytes(who) > cap.waiting || rooms.waitingBytes(null) > cap.total;
    const counter = new Transform({
      transform(chunk: Buffer | string, _encoding, done) {
        const size = Buffer.byteLength(chunk);
        bytes += size;
        arriving.set(who, (arriving.get(who) ?? 0) + size);
        if (over()) return done(rooms.tooBig(name, who, cap, bytes, 0));
        if (bytes < nextDiskCheck) return done(null, chunk);
        // Other files may be filling the same disk: the reserve is looked at again as it goes, not only at the start.
        nextDiskCheck += diskCheckBytes;
        rooms.freeBytes(folder).then((free) => done(free < cap.reserve ? noDisk(name, cap) : null, chunk), done);
      },
    });
    try {
      await pipeline(body, counter, createWriteStream(path, { flags: "wx", mode: 0o600 }));
      if (!bytes) throw new Error(`${name} came through empty`);
      return { path, bytes };
    } catch (error) {
      await rm(path, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      this.writing.delete(basename(path));
      const left = (arriving.get(who) ?? 0) - bytes;
      if (left > 0) arriving.set(who, left); else arriving.delete(who);
    }
  }
  /** Clears files sent ahead that no message took within `stagedLifeMs`: the page that sent them went away. */
  private async expireIncoming(): Promise<void> {
    const oldest = this.now() - stagedLifeMs;
    let expired = false;
    for (const [id, one] of [...this.incoming]) {
      if (one.at > oldest) continue;
      this.incoming.delete(id);
      expired = true;
      await rm(one.path, { force: true }).catch(() => undefined);
    }
    if (expired) await this.saveWaiting();
  }
  /** Takes a file that was sent ahead off again, before its message goes. Only the one who sent it can. */
  async unstage(who: string, id: string): Promise<boolean> {
    // attach-5: a file an earlier run left waiting is taken off only once it is back, never restored after it went.
    await this.restored;
    const staged = this.incoming.get(id);
    if (!staged || staged.who !== who) return false;
    this.incoming.delete(id);
    await this.saveWaiting();
    await rm(staged.path, { force: true }).catch(() => undefined);
    return true;
  }
  /**
   * The files sent ahead that a message names, checked before its task starts (#190): each must still be
   * waiting, must have been sent by the same person, and together they must fit one message.
   */
  staged(who: string, ids: readonly string[]): StagedView[] {
    if (ids.length > maximumUploadsPerTurn) throw new Error(`Up to ${maximumUploadsPerTurn} files can go with one message.`);
    if (new Set(ids).size !== ids.length) throw new Error("The same file was named twice.");
    const found = ids.map((id) => {
      const one = this.incoming.get(id);
      if (!one || one.who !== who) throw new Error("A file is no longer waiting to be sent. Attach it again.");
      return one;
    });
    const total = found.reduce((sum, one) => sum + one.bytes, 0);
    if (total > maxUploadsBytesPerTurn)
      throw new Error(`Everything on one message can add up to ${sizeWords(maxUploadsBytesPerTurn)}; that is ${sizeWords(total)}.`);
    return found.map(viewOf);
  }
  /** Moves files sent ahead into a conversation's folder, under new ids; the caller holds the turn. */
  private async claim(who: string, ids: readonly string[], folder: string): Promise<{ ref: AttachmentRef; path: string }[]> {
    this.staged(who, ids);
    // All taken off the waiting list at once, before any move, so no second message can have one of them meanwhile;
    // the ones not moved go back if a move fails. Each is held (`moving`) until its move is done, so the start-up
    // sweep of old files, however slow, never takes one for a leftover (attach-4).
    const taken = ids.map((id) => this.incoming.get(id)!);
    for (const id of ids) { this.moving.add(id); this.incoming.delete(id); }
    const move = this.disk.move ?? rename;
    const moved: { ref: AttachmentRef; path: string }[] = [];
    try {
      for (const [at, one] of taken.entries()) {
        const ref: AttachmentRef = { id: randomBytes(8).toString("hex"), kind: one.kind, mediaType: one.mediaType, name: one.name, bytes: one.bytes };
        try {
          await move(one.path, join(folder, ref.id));
        } catch (error) {
          for (const left of taken.slice(at)) this.incoming.set(left.id, left);
          await this.saveWaiting();
          throw error;
        }
        moved.push({ ref, path: join(folder, ref.id) });
      }
    } finally { for (const id of ids) this.moving.delete(id); }
    await this.saveWaiting();
    return moved;
  }
  /** At start: `restoreIncoming`, then `clearIncoming`. */
  async sweepIncoming(): Promise<void> {
    await this.restoreIncoming();
    await this.clearIncoming();
  }
  /**
   * At start, before the engine takes a message: files sent ahead in an earlier run that were still waiting, and are
   * still whole and within their `stagedLifeMs`, wait again for the message that takes them, bound to whoever sent them
   * (attach-3: the engine was restarted between a paste and its message). A time ahead of the clock counts as now
   * (attach-4), so such a file still goes after `stagedLifeMs`.
   */
  restoreIncoming(): Promise<void> {
    const restoring = this.readBack();
    const settled = restoring.catch(() => undefined).then(() => { if (this.restoring === settled) this.restoring = null; });
    this.restoring = settled;
    return restoring;
  }
  private async readBack(): Promise<void> {
    const text = await (this.disk.readList ?? ((path: string) => readFile(path, "utf8")))(this.waitingList).catch(() => "[]");
    let read: unknown = [];
    try { read = JSON.parse(text); } catch { read = []; } // not a list this app wrote whole: nothing in it is taken back
    const listed = z.array(StagedRecordSchema).safeParse(read);
    const oldest = this.now() - stagedLifeMs;
    for (const one of listed.success ? listed.data : []) {
      if (one.at <= oldest || this.incoming.has(one.id)) continue;
      const path = join(this.incomingFolder, one.id);
      if ((await stat(path).then((found) => found.size, () => -1)) !== one.bytes) continue;
      this.incoming.set(one.id, { ...one, at: Math.min(one.at, this.now()), path });
    }
  }
  /**
   * At start, once `restoreIncoming` is done: everything else in the folder is cleared, since nothing can name it. It
   * may run while messages are taken: a file waiting, being written or being moved into its conversation is never
   * touched.
   */
  async clearIncoming(): Promise<void> {
    const names = await readdir(this.incomingFolder).catch(() => [] as string[]);
    for (const name of names)
      if (!this.incoming.has(name) && !this.writing.has(name) && !this.moving.has(name) && name !== waitingListName && name !== `${waitingListName}.next`)
        await rm(join(this.incomingFolder, name), { force: true }).catch(() => undefined);
    if (names.length) await this.saveWaiting();
  }
  /** Where a kept file of a conversation is, for reading it out to the model. */
  pathOf(sessionId: string, id: string, options: { temporary?: boolean } = {}): string | null {
    return this.contained(this.folder(sessionId, options.temporary), id);
  }

  private folder(sessionId: string, temporary = false): string {
    return join(this.root, folderFor(sessionId, temporary));
  }
  private async listing(folder: string): Promise<AttachmentRef[]> {
    const text = await readFile(join(folder, "kept.json"), "utf8").catch(() => "");
    if (!text) return [];
    const read = z.array(AttachmentRefSchema).safeParse(JSON.parse(text) as unknown);
    return read.success ? read.data : [];
  }

  /**
   * Every file checked and decoded, with nothing written. The runtime asks this before a task starts (NAS's
   * adversarial of #190): a file refused after the task was marked running left the conversation stuck.
   */
  check(inputs: readonly AttachmentInput[]): { ref: AttachmentRef; bytes: Buffer }[] {
    if (inputs.length > maximumAttachmentsPerTurn)
      throw new Error(`Up to ${maximumAttachmentsPerTurn} files can go with one message.`);
    const ready = inputs.map((input) => this.ready(input));
    const total = ready.reduce((sum, one) => sum + one.bytes.byteLength, 0);
    if (total > maxAttachmentsBytesPerTurn)
      throw new Error(`Everything on one message can add up to ${Math.round(maxAttachmentsBytesPerTurn / 1048576)} MB; that is ${Math.round(total / 1048576)} MB.`);
    return ready;
  }

  /** Keeps the originals and hands back what the message will carry. */
  async keep(sessionId: string, inputs: readonly AttachmentInput[],
    options: { temporary?: boolean; uploads?: { who: string; ids: readonly string[] } } = {}): Promise<AttachmentRef[]> {
    const uploads = options.uploads?.ids.length ? options.uploads : null;
    if (!inputs.length && !uploads) return [];
    // Everything is checked and decoded before a single byte is written: a bad third file must not
    // leave the first two behind as bytes nothing points at.
    const ready = this.check(inputs);
    // One conversation's folder is written by one turn at a time, so two messages at once cannot each
    // write a listing that forgets the other's files.
    return this.inTurn(sessionId, options.temporary, async () => {
      const folder = this.folder(sessionId, options.temporary);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const kept = await this.listing(folder);
      const written: AttachmentRef[] = [];
      // The listing is never written over in place. It goes to a file of its own beside it, is flushed,
      // and is then renamed on top — one step the file system either takes or does not. A write that
      // fails half way through the old way would have left the conversation with a listing naming
      // nothing, and every file it already held unreachable.
      const beingWritten = join(folder, `kept.json.${randomBytes(6).toString("hex")}.part`);
      try {
        for (const one of ready) {
          await writeFile(join(folder, one.ref.id), one.bytes, { mode: 0o600 });
          written.push(one.ref);
        }
        // Files sent ahead are moved in, not copied: they are already on this disk, in this store.
        if (uploads) for (const one of await this.claim(uploads.who, uploads.ids, folder)) written.push(one.ref);
        await this.writeListing(beingWritten, JSON.stringify([...kept, ...written]));
        await rename(beingWritten, join(folder, "kept.json"));
      } catch (error) {
        // Nothing half-written is left lying about, even when the disk is what failed: not the bytes
        // of this turn's files, and not the listing that was being built.
        await rm(beingWritten, { force: true }).catch(() => undefined);
        for (const ref of written) await rm(join(folder, ref.id), { force: true }).catch(() => undefined);
        throw error;
      }
      return written;
    });
  }
  /** Holds one conversation's writes in a queue, so two at once cannot lose each other's files. */
  private inTurn<T>(sessionId: string, temporary: boolean | undefined, work: () => Promise<T>): Promise<T> {
    const key = folderFor(sessionId, temporary);
    const next = (this.turns.get(key) ?? Promise.resolve()).then(work, work);
    const settled = next.then(() => undefined, () => undefined);
    this.turns.set(key, settled);
    // A finished turn takes its own place in the queue away again, or an app answering conversations
    // all day would keep one entry per conversation for as long as it runs. Only its own: by the time
    // this runs another turn may have queued behind it, and that one is not this one's to remove.
    void settled.then(() => {
      if (this.turns.get(key) === settled) this.turns.delete(key);
    });
    return next;
  }
  /** One file checked and decoded, with nothing written yet. */
  private ready(input: AttachmentInput): { ref: AttachmentRef; bytes: Buffer } {
    // Checked here as well as at the route: this is a public way in, and a media type that is not one
    // must never reach the place where it becomes a header. Said in a sentence, not a schema dump.
    if (!mediaTypeToken.safeParse(input.mediaType).success)
      throw new Error(`${input.name} does not say what kind of file it is in a way Branch can use.`);
    const kind = kindOf(input.mediaType, input.name);
    const bytes = Buffer.from(input.data.replace(/^data:[^,]*,/, ""), "base64");
    if (!bytes.length) throw new Error(`${input.name} came through empty`);
    if (bytes.byteLength > attachmentLimits[kind])
      throw new Error(`${kindWords[kind]} up to ${Math.round(attachmentLimits[kind] / 1048576)} MB can be attached, so ${input.name} was skipped.`);
    return {
      ref: { id: randomBytes(8).toString("hex"), kind, mediaType: typeFor(input.mediaType, input.name), name: cleanName(input.name), bytes: bytes.byteLength },
      bytes,
    };
  }
  /**
   * One kept file, found by its conversation and its id. Nothing a caller sends is ever used as a
   * path: the id is looked up in the conversation's own listing, and the file it names is checked to
   * be really inside this store before it is opened, so a link or a name that climbs out cannot be
   * followed.
   */
  /**
   * Where one file of a conversation is, or nothing. **The only way any part of this class turns an
   * id into a path.** Everything it checks was already checked in one place and then walked around
   * by two callers that built the path themselves: an id must be sixteen plain hex characters, and
   * the path it names must really be inside the store — `realpath.native` because on Windows a plain
   * one does not resolve a junction, so a folder that is a link to somewhere else would be followed
   * straight out of it.
   */
  private contained(folder: string, id: string): string | null {
    if (!/^[a-f0-9]{16}$/.test(id)) return null;
    const file = trueName(join(folder, id));
    const root = trueName(this.root);
    if (!file || !root || !(file === root || file.startsWith(root + sep))) return null;
    return file;
  }

  /**
   * Where a kept file really is, and how big it really is, after every check reading it makes. The
   * path is what lets one second of a film be sent without the whole film being held in memory
   * first; the size is the file's own, not the number written down when it arrived.
   */
  async locate(sessionId: string, id: string, options: { temporary?: boolean } = {}):
    Promise<{ ref: AttachmentRef; path: string; size: number }> {
    const folder = this.folder(sessionId, options.temporary);
    const ref = (await this.listing(folder)).find((one) => one.id === id);
    const file = ref && this.contained(folder, ref.id);
    if (!ref || !file) throw new Error("That file is not attached to this conversation");
    return { ref, path: file, size: (await stat(file)).size };
  }
  async read(sessionId: string, id: string, options: { temporary?: boolean } = {}): Promise<{ ref: AttachmentRef; bytes: Buffer }> {
    const { ref, path } = await this.locate(sessionId, id, options);
    return { ref, bytes: await readFile(path) };
  }
  /**
   * The part of a kept file somebody asked for, read from the file itself. Asking for the first
   * kilobyte of a thirty-megabyte film used to cost thirty megabytes: the whole thing was read into
   * memory and then a slice of it was sent. A window with a few films open could spend a gigabyte
   * answering scrubs of a few kilobytes each.
   */
  async partOf(sessionId: string, id: string, options: { temporary?: boolean } = {}):
    Promise<{ ref: AttachmentRef; size: number; open: (wanted: BytesWanted | null) => Readable }> {
    const { ref, path, size } = await this.locate(sessionId, id, options);
    // How big it is has to be known before which part was asked for can be worked out, so the part
    // is chosen afterwards — without looking the file up a second time.
    return { ref, size, open: (wanted) => this.openRange(path, wanted) };
  }
  /**
   * Gives a second conversation its own copy of files the first one holds: the same bytes, written
   * into the second conversation's own folder, under **new** names of its own.
   *
   * The new names are the point. Handing the copy the source's own ids would leave two conversations
   * pointing at one folder, so deleting the first would quietly break the second — and an id that
   * came from outside this computer would be a name somebody else chose, used as a path. Nothing
   * from a message is trusted here: an id that is not sixteen plain hex characters never reaches the
   * file system, and a file that is missing stops the whole copy rather than leaving half of one.
   *
   * Synchronous on purpose: the one caller copies a conversation inside a database transaction, and
   * a half-written copy either rolls back with it or does not happen at all.
   */
  /**
   * One file a conversation holds, read back whole. For putting a conversation into an archive, where
   * the bytes themselves have to travel; everything else reads a part at a time.
   */
  bytesOf(sessionId: string, id: string): Buffer {
    const file = this.contained(this.folder(sessionId, false), id);
    if (!file) throw new Error("That file is not attached to this conversation");
    return readFileSync(file);
  }
  /**
   * How one file is copied for a duplicate: off the engine thread (Node's file pool), as a clone where the file system
   * can make one. Tests hold a copy here to show the engine keeps answering meanwhile.
   */
  copier: (from: string, to: string) => Promise<void> = (from, to) => copyFile(from, to, fsConstants.COPYFILE_FICLONE);
  /**
   * A duplicate's files, copied before its database work: each file of `from` that `refs` names is written beside its
   * final name in `to`'s folder ("." + a new id), off the engine thread, however big, once the disk is known to keep
   * its reserve (`stageLimits.reserve`) after all of them. Nothing is listed yet: `commitPrepared` moves them into
   * place inside the duplicate's transaction, and `discard` throws them away when it does not go through.
   */
  async prepareCopies(from: string, to: string, refs: readonly AttachmentRef[]): Promise<AttachmentRef[]> {
    if (!refs.length) return [];
    const source = this.folder(from, false), target = this.folder(to, false);
    const files = refs.map((ref) => {
      const file = this.contained(source, ref.id);
      if (!file) throw new Error("That file is not attached to this conversation");
      return { ref, file };
    });
    const sizes = await Promise.all(files.map((one) => stat(one.file).then((found) => found.size)));
    const total = sizes.reduce((sum, size) => sum + size, 0);
    const [disk, free] = await Promise.all([diskOf(source), this.freeBytes(source)]);
    const release = holdDisk("A copy of this conversation's files", disk, free, total);
    try {
      await mkdir(target, { recursive: true, mode: 0o700 });
      const made: AttachmentRef[] = [];
      for (const [at, one] of files.entries()) {
        const ref = { ...one.ref, id: randomBytes(8).toString("hex"), bytes: sizes[at]! };
        made.push(ref);
        await this.copier(one.file, join(target, "." + ref.id));
      }
      return made;
    } finally { release(); }
  }
  /** Moves a duplicate's prepared copies into place and lists them (inside its transaction). */
  commitPrepared(to: string, made: AttachmentRef[]): AttachmentRef[] {
    return made.length ? this.commitCopies(this.folder(to, false), made) : [];
  }
  /**
   * Writes files a copy is to keep into its folder, under the names it will know them by, and adds
   * them to its listing. Each file is written beside its final name first and moved into place only
   * once every one of them has been written, so a conversation is never left holding a listing that
   * names a file that is not there.
   */
  private commitCopies(target: string, made: AttachmentRef[]): AttachmentRef[] {
    for (const ref of made) renameSync(join(target, "." + ref.id), join(target, ref.id));
    let kept: AttachmentRef[] = [];
    try { kept = z.array(AttachmentRefSchema).parse(JSON.parse(readFileSync(join(target, "kept.json"), "utf8"))); }
    catch { /* a folder with no listing yet is an empty one */ }
    writeFileSync(join(target, "kept.json"), JSON.stringify([...kept, ...made]), { mode: 0o600 });
    return made;
  }
  /**
   * The same, for files that arrived in an archive rather than from a conversation on this computer:
   * the bytes are given, and the names they will be known by are made here.
   */
  writeInto(to: string, files: readonly { ref: AttachmentRef; bytes: Buffer }[]): AttachmentRef[] {
    if (!files.length) return [];
    const target = this.folder(to, false);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const made = files.map((one) => {
      const ref = { ...one.ref, id: randomBytes(8).toString("hex"), bytes: one.bytes.byteLength };
      writeFileSync(join(target, "." + ref.id), one.bytes, { mode: 0o600 });
      return ref;
    });
    return this.commitCopies(target, made);
  }
  /**
   * What one conversation's files weigh, or `null` when that cannot be answered. A conversation with
   * no files at all answers 0, which is certain; a listing that will not be read answers `null`,
   * which is not the same thing and must not be treated as none.
   */
  bytesHeld(sessionId: string): number | null {
    const folder = this.folder(sessionId, false);
    let listing: AttachmentRef[];
    try {
      listing = z.array(AttachmentRefSchema).parse(JSON.parse(readFileSync(join(folder, "kept.json"), "utf8")));
    } catch (error) {
      // `ENOENT` says one of two things and they are not the same. No folder at all is a conversation
      // that was never given a file: a true zero. A folder that is there with no listing in it is a
      // conversation whose files may well be sitting right there, with nothing left to say what they
      // are — a number nobody has. Answering 0 to the second put a conversation with a film in it at
      // the front of the queue to be deleted for being small.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      try { statSync(folder); } catch { return 0; }
      return null;
    }
    // The files themselves, not what the listing says about them. The listing records what each file
    // weighed when it arrived; it is not re-read when one changes, so adding those numbers up answers
    // for a conversation as it used to be. A file swapped for a bigger one reported its old size and
    // said the number had been checked.
    let total = 0;
    for (const ref of listing) {
      const file = this.contained(folder, ref.id);
      if (!file) return null;
      try { total += statSync(file).size; } catch { return null; }
    }
    return total;
  }
  /**
   * Throws away everything written for a conversation that is not going to exist. Synchronous and
   * best effort, because the one caller is a database transaction rolling back: the bytes were put
   * on disk before the row that would have pointed at them, and a copy that did not happen must not
   * leave a folder of files behind that nothing will ever name or delete.
   */
  discard(sessionId: string): void {
    try { rmSync(this.folder(sessionId, false), { recursive: true, force: true }); }
    catch (error) {
      diagnose("attachments", "error", "Files of a copy that did not happen could not be removed",
        { fields: { sessionId, reason: error instanceof Error ? error.message : String(error) } });
    }
  }
  /** Everything attached to one conversation, oldest first. */
  async list(sessionId: string, options: { temporary?: boolean } = {}): Promise<AttachmentRef[]> {
    return this.listing(this.folder(sessionId, options.temporary));
  }
  /** The conversation is gone, so its files go with it: nothing is left pointing at nothing. */
  /**
   * Says whether the files really went. It never throws, because the one caller is a listener that
   * may not throw and is never awaited — but it does not stay quiet either. A delete that fails, as
   * one does when something still holds a file open, leaves the bytes of a conversation the owner
   * threw away sitting on disk with nothing pointing at them; saying nothing meant nobody could ever
   * find out, not even afterwards.
   */
  async forget(sessionId: string, options: { temporary?: boolean } = {}): Promise<boolean> {
    const folder = this.folder(sessionId, options.temporary);
    try {
      await this.remove(folder);
      return true;
    } catch (error) {
      diagnose("attachments", "error", "A conversation's files could not be deleted",
        { fields: { folder, reason: error instanceof Error ? error.message : String(error) } });
      return false;
    }
  }
  /**
   * Temporary conversations leave nothing behind. Closing one sweeps its folder; this sweeps any that
   * an earlier run could not, so a stop in the wrong moment cannot turn them into permanent files.
   *
   * The names are taken **before** anything else can happen and only those are removed. A sweep that
   * outlives the app becoming ready therefore cannot delete a conversation started afterwards: that
   * folder is not on the list it is working from. Racing a timer against this would not have given
   * that promise, because the losing sweep carries on with a listing read after readiness.
   */
  async sweepTemporary(): Promise<number> {
    // Read synchronously, so the list is finished before this function first gives up the thread. An
    // asynchronous listing could resolve after the app is ready and include a folder made since.
    // Taken once, synchronously, before this function first gives up the thread: everything removed
    // afterwards comes from this list, so a folder made later cannot be on it.
    let folders: string[] = [];
    try { folders = this.listFolders(this.root); } catch { return 0; }
    const leftovers = folders.filter(isTemporaryFolder);
    let swept = 0, left = 0;
    for (const name of leftovers) {
      // Counting a folder as swept whether or not it went made the number a promise the sweep had
      // not kept: temporary files that outlived their conversation were reported as gone.
      try { await this.remove(join(this.root, name)); swept += 1; }
      catch { left += 1; }
    }
    if (left) diagnose("attachments", "error",
      "Temporary conversation files are still here after the sweep", { fields: { left, swept } });
    return swept;
  }
}

/** A file sent ahead of its message, waiting in `.incoming` for the message that takes it. */
interface StagedFile { id: string; who: string; path: string; name: string; mediaType: string; kind: AttachmentKind; bytes: number; at: number }
/** The waiting list's own name in `.incoming`; no file sent ahead can have it (their names are 24 hex characters). */
const waitingListName = "waiting.json";
/** One file of the waiting list as it is kept on disk: its id is its name there, and nothing is a path. */
const StagedRecordSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{24}$/), who: z.string().min(1).max(200),
  name: AttachmentRefSchema.shape.name, mediaType: AttachmentRefSchema.shape.mediaType, kind: AttachmentRefSchema.shape.kind,
  bytes: z.number().int().positive(), at: z.number(),
});
/** The rooms a file sent ahead must fit (`Attachments.stage`). */
export interface StageLimits {
  /** One file. */
  file: number;
  /** One sender's files waiting to be sent, and still arriving. */
  waiting: number;
  /** Everyone's files waiting to be sent, and still arriving. */
  total: number;
  /** What the disk always keeps free for everything else on it. */
  reserve: number;
}
export const stageLimits: StageLimits = {
  file: maximumUploadBytes, waiting: maxUploadsBytesPerTurn * 2, total: maxUploadsBytesPerTurn * 4, reserve: 1024 ** 3,
};
/** How long a file sent ahead waits for its message; one that no message took by then is cleared. */
export const stagedLifeMs = 6 * 60 * 60 * 1000;
/** How often, in bytes written, the disk's free space is looked at again while a file arrives. */
const diskCheckBytes = 64 * 1024 * 1024;
const noDisk = (name: string, cap: StageLimits): Error =>
  new Error(`${name} does not fit: Branch keeps ${sizeWords(cap.reserve)} of this computer's disk free.`);
/**
 * attach-followups: a working copy made of a kept file elsewhere on this computer (a video copied for ffmpeg, src/media-
 * understand.ts) keeps the same reserve free on the disk it lands on, or is refused in the same words.
 */
export function refuseWithoutReserve(name: string, free: number, bytes: number): void {
  if (free - bytes < stageLimits.reserve) throw noDisk(name, stageLimits);
}
/**
 * attach-3: bytes promised to copies being made right now (a video's working copy, a duplicate's or a branch's files).
 * Each copy counts the others on its own disk: the check and the promise are one synchronous step after the free space is read, so two
 * copies started together cannot each find the same room free. A copy holds its bytes until its file is gone, or, for
 * a copy that stays, until it has been written (the disk's free space then counts it).
 */
const promisedBytes = new Map<string, number>();
/** `disk` names the disk the copy lands on (`diskOf`): promises count only against their own disk's reserve. */
export function holdDisk(name: string, disk: string, free: number, bytes: number): () => void {
  refuseWithoutReserve(name, free - (promisedBytes.get(disk) ?? 0), bytes);
  promisedBytes.set(disk, (promisedBytes.get(disk) ?? 0) + bytes);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (promisedBytes.get(disk) ?? 0) - bytes;
    if (left > 0) promisedBytes.set(disk, left); else promisedBytes.delete(disk);
  };
}
/** Which disk holds `path`, for `holdDisk`. */
export const diskOf = (path: string): Promise<string> => stat(path).then((found) => String(found.dev));
/** How much of the disk holding `path` is free for this app to use. */
export const freeBytesAt = (path: string): Promise<number> => statfs(path).then((found) => Number(found.bavail) * Number(found.bsize));
/** What the page is told about a file it sent ahead: never where it is on disk, nor who sent it. */
export interface StagedView { upload: string; name: string; mediaType: string; kind: AttachmentKind; bytes: number }
const viewOf = (one: StagedFile): StagedView => ({ upload: one.id, name: one.name, mediaType: one.mediaType, kind: one.kind, bytes: one.bytes });
/** A size in the words a limit message uses: "2 GB", "700 MB". */
export function sizeWords(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
  if (bytes >= 1048576) return `${Math.round((bytes / 1048576) * 10) / 10} MB`;
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;
}
