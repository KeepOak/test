import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  AttachmentRefSchema, attachmentKinds, maxAttachmentBytes, maximumAttachmentsPerTurn, maximumUploadsPerTurn, mediaTypeToken,
  ToolCallSchema, type AttachmentRef, type Message,
} from "./contracts.js";
import { attachmentLimits, kindOf } from "./attachments.js";
import { bindFiles, copiedFiles, type ConversationFiles } from "./sessions.js";
import { participation } from "./history.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { ensureMarks, inBinWords, notInBin, notPutAway } from "./conversation-actions.js";
import { steerShown } from "./steer.js"; // dogfood D23

/** What a conversation's words may come to in an archive. */
export const maximumArchiveBytes = 4 * 1024 * 1024;
/** What all the files in one archive may come to, before base64 makes them a third larger again. */
export const maximumArchiveFileBytes = 64 * 1024 * 1024;
/** How much an archive may weigh as it is read or written: the words, the files, and room around them. */
export const archiveBodyLimit = maximumArchiveBytes + Math.ceil(maximumArchiveFileBytes / 3) * 4 + 128 * 1024;
/** The most files one archive may carry, whatever they weigh. */
const maximumArchiveFiles = 200;
/** The first bytes of the picture types a window will render in place, so a claim can be checked. */
const pictureSignatures: Record<string, readonly number[][]> = {
  "image/png": [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  "image/jpeg": [[0xff, 0xd8, 0xff]],
  "image/gif": [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
  "image/webp": [[0x52, 0x49, 0x46, 0x46]],
};
/**
 * One file inside an archive. Everything a conversation keeps about it, plus the bytes themselves
 * and a digest of them — an archive is a file somebody can write, so nothing in it is believed
 * without being checked against the bytes it came with.
 */
const ArchivedFileSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{16}$/),
  kind: z.enum(attachmentKinds),
  mediaType: mediaTypeToken,
  name: z.string().trim().min(1).max(200),
  bytes: z.number().int().nonnegative().max(maxAttachmentBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  data: z.string().min(1).max(Math.ceil(maxAttachmentBytes / 3) * 4 + 1024),
}).strict();
const StoredMessageSchema = z.object({
  role: z.enum(["user", "assistant", "tool"]), content: z.string(),
  toolCalls: z.array(ToolCallSchema).max(16).optional(),
  toolCallId: z.string().min(1).max(200).optional(),
  /**
   * A message that was given a file carries these, so the key has to be allowed through or one
   * picture is enough to stop a whole conversation ever being exported, imported or copied. They
   * are taken off again just below.
   */
  attachments: z.array(AttachmentRefSchema).max(maximumAttachmentsPerTurn + maximumUploadsPerTurn).optional(),
  /** The engine's own ask (src/contracts.ts Message.system), so a Trunk's conversation still copies. */
  system: z.literal("trunk-intro").optional(),
}).strict().superRefine((message, context) => {
  if ((message.toolCalls !== undefined && message.role !== "assistant") ||
      (message.role === "tool") !== (message.toolCallId !== undefined))
    context.addIssue({ code: "custom", message: "Message fields do not match its role" });
});
/**
 * A copy of a conversation gets its own copy of every file, under names of its own, written into
 * its own folder. The references travel so the copy knows what it was given; what must never travel
 * is the *source's* name for a file, because that is a name inside another conversation's folder —
 * deleting the source would take the copy's cards with it, and a name in an archive somebody else
 * wrote is a name of their choosing. Every reference is bound again on the way in (`copy` below and
 * `filesFrom`), so no id from outside is ever used as a path.
 */
const MessageSchema = StoredMessageSchema;
const ArchiveSchema = z.object({
  format: z.literal("branch-agent-conversation"), version: z.literal(1),
  exportedAt: z.iso.datetime(), messages: z.array(MessageSchema).min(1).max(1000),
  /** The files the messages name, so an archive is a conversation and not a set of dead cards. */
  files: z.array(ArchivedFileSchema).max(maximumArchiveFiles).optional(),
}).strict();
export const SessionSearchSchema = z.object({
  query: z.string().trim().max(500).default(""),
  offset: z.number().int().min(0).max(1000000).default(0),
  /** Wave 6: only conversations carrying every one of these labels. */
  labels: z.array(z.string().trim().min(1).max(40)).max(5).default([]),
}).strict();
type Archive = z.infer<typeof ArchiveSchema>;
type ArchivedFile = z.infer<typeof ArchivedFileSchema>;

/**
 * The files an archive carries, checked against themselves and against the messages that name them.
 * An archive is an ordinary file somebody can write and hand over, so nothing written in it is
 * believed: the length is measured, the digest is recomputed, the kind is derived from the type
 * rather than read, and a picture that a window will render in place has to begin the way that kind
 * of picture begins. What comes back is bytes and a reference made here — never the archive's own
 * name for anything, which is why no id from outside can reach the file system.
 */
export function filesFrom(archive: Archive): { ref: AttachmentRef; bytes: Buffer }[] {
  const named = new Map<string, number>();
  for (const message of archive.messages)
    for (const ref of message.attachments ?? []) named.set(ref.id, (named.get(ref.id) ?? 0) + 1);
  const files = archive.files ?? [];
  if (!named.size && !files.length) return [];
  if (new Set(files.map((one) => one.id)).size !== files.length)
    throw new Error("The archive names one of its files twice");
  const byId = new Map(files.map((one) => [one.id, one] as const));
  for (const id of named.keys())
    if (!byId.has(id)) throw new Error("A message in the archive names a file the archive does not carry");
  for (const one of files)
    if (!named.has(one.id)) throw new Error("The archive carries a file no message in it names");

  let total = 0;
  const made: { ref: AttachmentRef; bytes: Buffer }[] = [];
  for (const one of files) {
    // A name is shown to a person, never used as a path — and it stays that way only if nothing
    // that could be read as one is let in.
    if (one.name.includes("/") || one.name.includes(String.fromCharCode(92))
      || one.name.includes(String.fromCharCode(0)) || one.name === "." || one.name === "..")
      throw new Error("A file in the archive has a name that is a path");
    const bytes = Buffer.from(one.data, "base64");
    if (bytes.byteLength !== one.bytes)
      throw new Error("A file in the archive is not the size the archive says it is");
    if (createHash("sha256").update(bytes).digest("hex") !== one.sha256)
      throw new Error("A file in the archive is not the file the archive says it is");
    if (kindOf(one.mediaType, one.name) !== one.kind)
      throw new Error("A file in the archive says it is one kind of thing and another at the same time");
    if (bytes.byteLength > attachmentLimits[one.kind])
      throw new Error("A file in the archive is larger than a file of its kind may be");
    const signatures = pictureSignatures[one.mediaType.split(";")[0]!.trim().toLowerCase()];
    if (signatures && !signatures.some((start) => start.every((byte, at) => bytes[at] === byte)))
      throw new Error("A file in the archive is not the kind of picture it says it is");
    total += bytes.byteLength;
    if (total > maximumArchiveFileBytes)
      throw new Error(`The files in the archive come to more than ${maximumArchiveFileBytes / 1048576} MB`);
    made.push({ ref: { id: one.id, kind: one.kind, mediaType: one.mediaType, name: one.name, bytes: one.bytes }, bytes });
  }
  return made;
}

/** Imported tool messages are historical evidence, never executable requests. */
export function parseConversationArchive(input: unknown): Archive {
  const serialized = JSON.stringify(input);
  if (!serialized || Buffer.byteLength(serialized) > archiveBodyLimit)
    throw new Error(`Conversation archive exceeds ${Math.round(archiveBodyLimit / 1048576)} MiB`);
  const archive = ArchiveSchema.parse(input);
  // The words have a ceiling of their own, and it is the one it always was. Carrying files raised
  // what an archive may weigh; it did not raise what a conversation may say, and measuring only the
  // whole would have let four megabytes of words in wherever there was room left over from a film.
  const { files: _carried, ...words } = archive;
  if (Buffer.byteLength(JSON.stringify(words)) > maximumArchiveBytes)
    throw new Error("Conversation archive exceeds 4 MiB");
  const pending = new Set<string>();
  for (const message of archive.messages) {
    if (message.role === "tool") {
      if (!pending.delete(message.toolCallId!)) throw new Error("Unmatched or repeated tool result");
    } else {
      if (pending.size) throw new Error("Conversation contains unfinished tool requests");
      for (const call of message.toolCalls ?? []) {
        let args: unknown;
        try { args = JSON.parse(call.arguments) as unknown; }
        catch { throw new Error("Saved tool arguments must be valid JSON objects"); }
        if (!args || typeof args !== "object" || Array.isArray(args))
          throw new Error("Saved tool arguments must be valid JSON objects");
        if (pending.has(call.id)) throw new Error("Repeated tool request identifier");
        pending.add(call.id);
      }
    }
  }
  if (pending.size) throw new Error("Conversation contains unfinished tool requests");
  return archive;
}

/** phase2/rooms: leaves the given conversations out of a list (bound as parameters, never written in). */
const notIn = (hidden: readonly string[]): string => (hidden.length ? `AND s.id NOT IN (${hidden.map(() => "?").join(",")})` : "");
/** fix399: a conversation made only of tasks the engine kept out of Recent (Store.markAside recent: false: a learning pass,
    reading words, their helpers) is left out of Recent and search, and kept. One task of anyone else's shows it again.
    Pass 18a: so is a conversation made only of helpers (tasks another task started, run.started `parentRunId`): a helper
    is seen from its parent's helpers frame, view only, and never joins the sidebar. */
const notEngineOnly = `AND NOT (EXISTS(SELECT 1 FROM tasks t WHERE t.session_id=s.id) AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.session_id=s.id
  AND NOT EXISTS(SELECT 1 FROM events e WHERE e.run_id=t.id AND ((e.kind='run.aside' AND json_extract(e.data,'$.recent')=0)
    OR (e.kind='run.started' AND json_extract(e.data,'$.parentRunId') IS NOT NULL)))))`;
/**
 * The project a conversation is in: the one its latest task ran under (every task records its project when it starts,
 * src/store.ts createRun, and src/session-carry.ts carries the same one back), or the default project before any task.
 * It reads one conversation's tasks through the tasks_session_created index (src/store.ts).
 */
export const projectOf = "COALESCE((SELECT t.project FROM tasks t WHERE t.session_id=s.id ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1),'default')";

export class SessionLibrary {
  constructor(private readonly db: DatabaseSync, private readonly files: () => ConversationFiles | null = () => null) {
    ensureMarks(db);
    db.function("branch_fold", { deterministic: true }, value => String(value ?? "").normalize("NFC").toLowerCase());
    db.exec(`CREATE TABLE IF NOT EXISTS session_origins(
      session_id TEXT PRIMARY KEY REFERENCES sessions(id), imported INTEGER NOT NULL,
      duplicated_from TEXT, created_at TEXT NOT NULL)`);
  }
  imported(sessionId: string): boolean {
    return this.db.prepare(`WITH RECURSIVE lineage(id) AS (
      SELECT ? UNION SELECT b.parent_session_id FROM session_branches b JOIN lineage l ON b.session_id=l.id)
      SELECT 1 AS found FROM session_origins o JOIN lineage l ON o.session_id=l.id WHERE o.imported=1 LIMIT 1`)
      .get(sessionId)?.found === 1;
  }
  /**
   * The conversations to show on a small screen: the most recent ones, each with how it started
   * and what was last said, so picking up on a phone what was begun at the desk needs one request.
   * It is the same list the app already shows, served through the same door and the same key.
   */
  /** `hidden`: conversations kept out of every list (phase2/rooms: a Trunk's side of a room). */
  /** `project`: only the conversations in that project (see projectOf). */
  /** Pinned conversations come first, in the order they were pinned; archived and deleted ones are left out. */
  recent(owner: string, limit = 20, hidden: readonly string[] = [], project?: string, offset = 0) {
    const size = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 20;
    const start = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    const rows = this.db.prepare(`SELECT s.id, s.created_at, c.pin_order, c.title,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id) AS message_count,
      (SELECT substr(json_extract(m.body,'$.content'),1,240) FROM messages m
        WHERE m.session_id=s.id AND json_extract(m.body,'$.role') IN ('user','assistant')
        ORDER BY m.id LIMIT 1) AS opening,
      (SELECT substr(json_extract(m.body,'$.content'),1,240) FROM messages m
        WHERE m.session_id=s.id AND json_extract(m.body,'$.role') IN ('user','assistant')
        ORDER BY m.id DESC LIMIT 1) AS latest,
      (SELECT json_extract(m.body,'$.role') FROM messages m
        WHERE m.session_id=s.id AND json_extract(m.body,'$.role') IN ('user','assistant')
        ORDER BY m.id DESC LIMIT 1) AS latest_role,
      (SELECT m.created_at FROM messages m
        WHERE m.session_id=s.id AND json_extract(m.body,'$.role') IN ('user','assistant')
        ORDER BY m.id DESC LIMIT 1) AS latest_at
      FROM sessions s LEFT JOIN conversation_marks c ON c.session_id=s.id
      WHERE s.owner=? AND s.temporary=0 ${notIn(hidden)} ${notEngineOnly} ${notPutAway} ${project === undefined ? "" : `AND ${projectOf}=?`}
      ORDER BY c.pin_order IS NULL, c.pin_order, s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`).all(owner, ...hidden, ...(project === undefined ? [] : [project]), size + 1, start);
    return {
      nextOffset: rows.length > size ? start + size : null,
      sessions: rows.slice(0, size).map((row) => ({
        sessionId: String(row.id), createdAt: String(row.created_at), messageCount: Number(row.message_count),
        // Dogfood D23: a steer reads as the owner's own words here too, never the marker the model was given it in.
        opening: steerShown(String(row.opening ?? "")), lastMessage: steerShown(String(row.latest ?? "")),
        lastSpeaker: row.latest_role === null ? "" : String(row.latest_role),
        // trunk-one-row: when its last message was written, so the window lists a Trunk by its newest message
        ...(row.latest_at == null ? {} : { updatedAt: String(row.latest_at) }),
        ...(row.pin_order == null ? {} : { pinned: true }), ...(row.title ? { title: String(row.title) } : {}),
      })),
    };
  }
  /** How many conversations each project has, by project id (see projectOf); a project with none is left out. */
  /** The conversations each project lists: those Recent keeps out (a helper's, a learning pass's) are not counted. */
  projectCounts(owner: string, hidden: readonly string[] = []): Record<string, number> {
    const rows = this.db.prepare(`SELECT ${projectOf} AS project, COUNT(*) AS n FROM sessions s
      WHERE s.owner=? AND s.temporary=0 ${notIn(hidden)} ${notPutAway} ${notEngineOnly} GROUP BY 1`).all(owner, ...hidden);
    return Object.fromEntries(rows.map((row) => [String(row.project), Number(row.n)]));
  }
  /** `agent`: only the conversations that agent may look back on (src/history.ts `participation`); unset for the owner. */
  search(owner: string, input: unknown, hidden: readonly string[] = [], agent?: string) {
    const { query, offset, labels } = SessionSearchSchema.parse(input);
    const scope = participation(agent);
    const wanted = labels.map((label) => label.toLocaleLowerCase("en"));
    // Only conversations carrying every wanted label; an empty list means no label filter at all.
    const labelFilter = wanted.length
      ? `AND s.id IN (SELECT target_id FROM labels WHERE owner=? AND target='conversation'
          AND label IN (${wanted.map(() => "?").join(",")}) GROUP BY target_id HAVING COUNT(DISTINCT label)=?)`
      : "";
    const labelArgs = wanted.length ? [owner, ...wanted, wanted.length] : [];
    const rows = this.db.prepare(`SELECT s.id,s.created_at,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id) AS message_count,
      (SELECT substr(json_extract(m.body,'$.content'),1,240) FROM messages m
        WHERE m.session_id=s.id AND json_extract(m.body,'$.role') IN ('user','assistant')
        ORDER BY m.id LIMIT 1) AS preview,
      (SELECT substr(json_extract(m.body,'$.content'),1,400) FROM messages m
        WHERE m.session_id=s.id AND json_extract(m.body,'$.role') IN ('user','assistant') AND ?<>''
        AND instr(branch_fold(json_extract(m.body,'$.content')),branch_fold(?))>0
        ORDER BY m.id LIMIT 1) AS matched
      FROM sessions s WHERE s.owner=? AND s.temporary=0 AND EXISTS(SELECT 1 FROM messages m WHERE m.session_id=s.id
        AND json_extract(m.body,'$.role') IN ('user','assistant')
        AND (?='' OR instr(branch_fold(json_extract(m.body,'$.content')),branch_fold(?))>0))
      ${labelFilter} ${notIn(hidden)} ${notEngineOnly} ${notInBin}${scope.clause}
      ORDER BY s.created_at DESC,s.id DESC LIMIT 21 OFFSET ?`).all(query, query, owner, query, query, ...labelArgs, ...hidden, ...scope.args, offset);
    return {
      sessions: rows.slice(0, 20).map(row => ({ sessionId: String(row.id),
        createdAt: String(row.created_at), preview: String(row.preview ?? ""),
        // The first message with the words, so a search result can show the line it was found by.
        ...(row.matched == null ? {} : { match: String(row.matched) }),
        messageCount: Number(row.message_count) })),
      nextOffset: rows.length > 20 && offset + 20 <= 1000000 ? offset + 20 : null,
    };
  }
  export(owner: string, input: string): Archive {
    const sessionId = z.string().uuid().parse(input);
    // Room setup is local routing context, not a conversation message or an imported instruction.
    const messages = (this.wordsOf(owner, sessionId) as Message[]).filter((message) => message.role !== "system");
    if (!messages.length) throw new Error("This conversation has no messages to export yet.");
    return parseConversationArchive({ format: "branch-agent-conversation", version: 1,
      exportedAt: new Date().toISOString(), messages, ...this.carried(sessionId, messages as Message[]) });
  }
  /** One idle conversation's messages as they are kept, within what an archive's words may hold; no file is read. */
  private wordsOf(owner: string, sessionId: string): unknown[] {
    this.requireIdleOwner(owner, sessionId);
    const size = this.db.prepare(`SELECT COUNT(*) AS count,
      COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes FROM messages WHERE session_id=?`).get(sessionId)!;
    if (Number(size.count) > 1000 || Number(size.bytes) > maximumArchiveBytes)
      throw new Error("Conversation archive exceeds 1000 messages or 4 MiB");
    return this.db.prepare("SELECT body FROM messages WHERE session_id=? ORDER BY id")
      .all(sessionId).map(row => JSON.parse(String(row.body)) as unknown);
  }
  /**
   * Batch 26 (wave 8): the conversations a retention rule would sweep up — the ones older than the
   * owner's cut-off, and, when the whole history is bigger than the ceiling they set, the oldest
   * ones until it fits again. Nothing is deleted here: this only says what would be, so the owner
   * can be shown the list before anything happens.
   */
  prunable(owner: string, days: number, megabytes: number, now = Date.now()) {
    const rows = this.db.prepare(`SELECT s.id, s.created_at,
      (SELECT COUNT(*) FROM messages m WHERE m.session_id=s.id) AS message_count,
      (SELECT COALESCE(SUM(length(CAST(m.body AS BLOB))),0) FROM messages m WHERE m.session_id=s.id) AS bytes
      FROM sessions s WHERE s.owner=? AND s.temporary=0 ORDER BY s.created_at ASC, s.id ASC`).all(owner);
    // What a conversation weighs is its words **and** its files. Measuring only the message JSON made
    // a conversation holding thirty megabytes of video count as a few kilobytes, so "keep everything
    // under N MB" was blind to the only thing that now makes a conversation big.
    const all = rows.map((row) => {
      const sessionId = String(row.id), words = Number(row.bytes);
      const held = this.weightOfFiles(sessionId);
      return { sessionId, createdAt: String(row.created_at), messageCount: Number(row.message_count),
        bytes: words + held.bytes, words, files: held.bytes, measured: held.measured, why: "" };
    });
    const cutoff = days > 0 ? now - days * 86_400_000 : null;
    const wanted = new Map<string, typeof all[number]>();
    for (const entry of all)
      if (cutoff !== null && Date.parse(entry.createdAt) < cutoff)
        wanted.set(entry.sessionId, { ...entry, why: `older than ${days} day${days === 1 ? "" : "s"}` });
    let total = all.reduce((sum, entry) => sum + entry.bytes, 0);
    const ceiling = megabytes > 0 ? megabytes * 1_048_576 : null;
    // Every conversation offered on size says the files are why, when the words on their own were
    // inside the limit. Until this the rule could not see the files at all, so the owner set that
    // limit without them in it, and being told "your history is too big" with no explanation the
    // first time the app counts honestly is exactly the surprise worth avoiding.
    const overOnlyWithFiles = ceiling !== null && all.reduce((sum, entry) => sum + entry.words, 0) <= ceiling;
    for (const entry of wanted.values()) total -= entry.bytes;
    if (ceiling !== null)
      for (const entry of all) {
        if (total <= ceiling) break;
        if (wanted.has(entry.sessionId)) continue;
        // A conversation whose files could not be measured still counts towards the total — leaving
        // it out would make the history look smaller than it is — but it is never the one offered up
        // on the strength of a number nobody could check.
        if (!entry.measured) continue;
        wanted.set(entry.sessionId, { ...entry, why: overOnlyWithFiles
          ? `the whole history is over ${megabytes} MB, once the files attached to it are counted`
          : `the whole history is over ${megabytes} MB` });
        total -= entry.bytes;
      }
    return { conversations: [...wanted.values()], bytes: all.reduce((sum, entry) => sum + entry.bytes, 0) };
  }
  /**
   * The files this conversation's messages name, read back and put into the archive with a digest of
   * each one, so the archive is a conversation somebody can open elsewhere rather than a set of
   * cards that cannot. A conversation whose files are gone, or one opened by a store that was never
   * given the folder they live in, is refused rather than exported as something it is not.
   */
  private carried(sessionId: string, messages: Message[]): { files?: ArchivedFile[] } {
    const wanted = messages.flatMap((message) => message.attachments ?? []);
    // The files themselves are the owner's, as at their own route: a short-lived key gets the words and the
    // references, never the bytes (NAS's review of #190).
    if (!wanted.length || startedWithShortLivedKey()) return {};
    const files = this.files();
    if (!files) throw new Error("This conversation has files attached, and they cannot be read to put in the archive");
    let total = 0;
    const carried = wanted.map((ref) => {
      // Measured by what the listing says before anything is read: a two-gigabyte film is refused, not loaded.
      if (total + ref.bytes > maximumArchiveFileBytes)
        throw new Error(`This conversation's files come to more than the ${maximumArchiveFileBytes / 1048576} MB an archive carries. `
          + "Export it after taking some of them off, or copy it on this computer instead.");
      const bytes = files.bytesOf(sessionId, ref.id);
      total += bytes.byteLength;
      if (total > maximumArchiveFileBytes)
        throw new Error(`This conversation's files come to more than the ${maximumArchiveFileBytes / 1048576} MB an archive carries. `
          + "Export it after taking some of them off, or copy it on this computer instead.");
      return { id: ref.id, kind: ref.kind, mediaType: ref.mediaType, name: ref.name,
        bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
        data: bytes.toString("base64") };
    });
    return { files: carried };
  }
  /**
   * What one conversation's files weigh. A conversation the file store cannot answer for is measured
   * by what its own messages say they were given — the recorded size of every file they name —  and
   * marked unmeasured, so the history's total stays honest while nothing is offered for deletion on
   * the strength of a number that could not be checked.
   */
  private weightOfFiles(sessionId: string): { bytes: number; measured: boolean } {
    const files = this.files();
    if (!files) return { bytes: this.bytesMessagesName(sessionId), measured: false };
    const held = files.bytesHeld(sessionId);
    return held === null ? { bytes: this.bytesMessagesName(sessionId), measured: false } : { bytes: held, measured: true };
  }
  private bytesMessagesName(sessionId: string): number {
    let total = 0;
    for (const row of this.db.prepare("SELECT body FROM messages WHERE session_id=?").all(sessionId)) {
      let message: Message;
      try { message = JSON.parse(String(row.body)) as Message; } catch { continue; }
      for (const ref of message.attachments ?? []) total += ref.bytes;
    }
    return total;
  }
  import(owner: string, input: unknown) {
    return this.copy(owner, parseConversationArchive(input), true);
  }
  /**
   * A copy of one conversation on this computer, with its own copy of every file it holds, however big. Everything
   * that can refuse it (who owns it, a task still working, the words' size, how the files are described) is decided
   * before the first await; the files are then copied off the engine thread (src/attachments.ts prepareCopies), and
   * only then is the copy written, in one transaction that also moves the files into place.
   */
  async duplicate(owner: string, input: string) {
    const sessionId = z.string().uuid().parse(input);
    const archive = parseConversationArchive({ format: "branch-agent-conversation", version: 1,
      exportedAt: new Date().toISOString(), messages: this.wordsOf(owner, sessionId) });
    // A duplicate keeps when each message was first written (in the order the words were read); an imported archive
    // carries no times, so its messages are stamped when they land.
    const times = this.db.prepare("SELECT created_at FROM messages WHERE session_id=? ORDER BY id").all(sessionId)
      .map((row) => (row.created_at == null ? null : String(row.created_at)));
    const target = randomUUID(), imported = this.imported(sessionId);
    const copied = await copiedFiles(archive.messages as Message[], sessionId, target, this.files(), maximumArchiveFiles);
    return this.copy(owner, archive, imported, sessionId, times, { sessionId: target, messages: copied.messages, commit: copied.commit });
  }
  private requireIdleOwner(owner: string, sessionId: string) {
    const session = this.db.prepare("SELECT temporary FROM sessions WHERE id=? AND owner=?").get(sessionId, owner);
    if (!session) throw new Error("Conversation not found");
    if (Number(session.temporary) === 1) throw new Error("Temporary conversations cannot be exported or copied");
    if (this.db.prepare("SELECT 1 AS found FROM conversation_marks WHERE session_id=? AND deleted_at IS NOT NULL").get(sessionId))
      throw new Error(inBinWords);
    if (this.db.prepare("SELECT id FROM tasks WHERE session_id=? AND status='running'").get(sessionId))
      throw new Error("Wait for this conversation's active task before exporting or duplicating it");
  }
  /** An archive's messages, each naming the copy of its files written for this conversation from the archive's own bytes. */
  private withFiles(archive: Archive, sessionId: string): Message[] {
    const messages = archive.messages as Message[];
    if (!messages.some((message) => message.attachments?.length)) return messages;
    const files = this.files();
    if (!files) throw new Error("This conversation has files attached, and this copy cannot be given its own copy of them");
    // An archive carries its own bytes, already measured and checked against their digests.
    const bound = new Map<string, AttachmentRef>();
    for (const one of filesFrom(archive)) bound.set(one.ref.id, files.writeInto(sessionId, [one])[0]!);
    return bindFiles(messages, bound);
  }
  private copy(owner: string, archive: Archive, imported: boolean, source?: string, times: (string | null)[] = [],
    prepared?: { sessionId: string; messages: Message[]; commit: () => void }) {
    const sessionId = prepared?.sessionId ?? randomUUID(), now = new Date().toISOString();
    // The bytes go on disk before the rows that point at them, because a row pointing at a file that
    // is not there is worse than a file nothing points at yet. That ordering is only safe if the
    // files go too when the rows do not, which is what the catch below is for.
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO sessions(id,owner,created_at) VALUES(?,?,?)").run(sessionId, owner, now);
      const insert = this.db.prepare("INSERT INTO messages(session_id,body,created_at) VALUES(?,?,?)");
      // The copy is given its own copy of every file, in its own folder, under names it chooses
      // itself. A duplicate takes them from the conversation it came from; an archive brings its
      // own, checked first. Either way the references are bound again here, so an id written by
      // somebody else never becomes a path.
      (prepared ? prepared.messages : this.withFiles(archive, sessionId))
        .forEach((message, i) => insert.run(sessionId, JSON.stringify(message), times[i] ?? null));
      prepared?.commit();
      this.db.prepare("INSERT INTO session_origins VALUES(?,?,?,?)")
        .run(sessionId, Number(imported), source ?? null, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      // The conversation does not exist, so neither may its files. Without this the database went
      // back and the folder stayed: bytes on disk belonging to a conversation that was never made,
      // which nothing names, nothing counts and nothing will ever delete.
      this.files()?.discard(sessionId);
      throw error;
    }
    return { sessionId, copiedMessages: archive.messages.length };
  }
}
