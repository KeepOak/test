import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { canAccessSession } from "./history.js";
import type { AttachmentRef, Message } from "./contracts.js";
import { reconcileTranscript } from "./transcript.js";
import type { Store } from "./store.js";
import type { ToolRegistry } from "./registry.js";
import { accessAgent } from "./trunks/memory-scope.js";

export const BranchSessionSchema = z.object({
  sessionId: z.string().uuid(), messageId: z.number().int().positive(),
}).strict();
type BranchInput = z.input<typeof BranchSessionSchema>;
const sessionIdSchema = z.string().uuid();
const maximumMessages = 1000, maximumBytes = 4 * 1024 * 1024;

/**
 * What a copy of a conversation needs from the file store. Only the part that copies, so nothing
 * here can read or delete a conversation's files.
 */
export interface ConversationFiles {
  /** Bytes that came from outside, written into a conversation's folder under names made here. */
  writeInto(to: string, files: readonly { ref: AttachmentRef; bytes: Buffer }[]): AttachmentRef[];
  /** One file a conversation holds, read back whole, for putting into an archive. */
  bytesOf(sessionId: string, id: string): Buffer;
  /** What a conversation's files weigh, or null when that cannot be answered. */
  bytesHeld(sessionId: string): number | null;
  /** Throws away everything written for a copy whose database work did not go through. */
  discard(sessionId: string): void;
  /** A copy's files, copied ahead of its database work, off the engine thread, keeping the disk's reserve. */
  prepareCopies(from: string, to: string, refs: readonly AttachmentRef[]): Promise<AttachmentRef[]>;
  /** Moves those copies into place and lists them, inside the copy's transaction. */
  commitPrepared(to: string, made: AttachmentRef[]): AttachmentRef[];
}
/**
 * The files a conversation's messages name, one per file however many messages name it (copying per message wrote the
 * bytes again for every mention, and left all but the last pointing at a file nothing named). One id described two
 * different ways is refused: this cannot tell which description is true. `most` caps how many there may be.
 */
export function filesNamed(messages: readonly Message[], most = Infinity): AttachmentRef[] {
  const once = new Map<string, AttachmentRef>();
  for (const message of messages)
    for (const ref of message.attachments ?? []) {
      const first = once.get(ref.id);
      if (first && (first.name !== ref.name || first.mediaType !== ref.mediaType || first.kind !== ref.kind || first.bytes !== ref.bytes))
        throw new Error("This conversation describes one of its files in two different ways");
      if (!first) once.set(ref.id, ref);
    }
  if (once.size > most) throw new Error(`A conversation carries up to ${most} files`);
  return [...once.values()];
}
/** Each message naming the copy made for it, never an id the source chose. */
export const bindFiles = (messages: readonly Message[], bound: ReadonlyMap<string, AttachmentRef>): Message[] => messages.map((message) => message.attachments?.length
  ? { ...message, attachments: message.attachments.map((ref) => bound.get(ref.id)!) }
  : message);
/**
 * A copy's own copy of every file its messages name, made before its database work: off the engine thread, in the new
 * conversation's folder, under names it chooses itself. Messages naming files with nothing to copy them stop the copy:
 * a conversation full of cards that cannot open is worse than not making it. Whatever was written is thrown away when
 * the copy stops here; the caller moves the rest into place inside its transaction (`commit`) or throws it away.
 */
export async function copiedFiles(messages: readonly Message[], from: string, to: string, files: ConversationFiles | null, most = Infinity):
  Promise<{ messages: Message[]; commit: () => void }> {
  const wanted = filesNamed(messages, most);
  if (!wanted.length) return { messages: [...messages], commit: () => undefined };
  if (!files) throw new Error("This conversation has files attached, and this copy cannot be given its own copy of them");
  let made: AttachmentRef[];
  try { made = await files.prepareCopies(from, to, wanted); } catch (error) { files.discard(to); throw error; }
  return { messages: bindFiles(messages, new Map(wanted.map((ref, at) => [ref.id, made[at]!] as const))), commit: () => { files.commitPrepared(to, made); } };
}

/** Conversation copies use new source IDs; workspace state is shared. */
export class SessionBranches {
  constructor(private readonly db: DatabaseSync, private readonly files: () => ConversationFiles | null = () => null) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_branches(
      session_id TEXT PRIMARY KEY REFERENCES sessions(id),
      parent_session_id TEXT NOT NULL REFERENCES sessions(id),
      branch_point_message_id INTEGER NOT NULL, created_at TEXT NOT NULL)`);
  }
  /**
   * `before` (pass 17, "Branch from here" on one of your own messages): the copy stops just before
   * that message, so the new path can answer it again without the words appearing twice. The branch
   * record still names the message it came off.
   */
  async branch(owner: string, input: BranchInput, agent?: string, before = false) {
    const { sessionId: parentSessionId, messageId } = BranchSessionSchema.parse(input);
    this.requireOwner(owner, parentSessionId);
    if (agent && !canAccessSession(this.db, parentSessionId, agent))
      throw new Error("Conversation not found");
    const point = this.db.prepare("SELECT id,body FROM messages WHERE session_id=? AND source_id=?")
      .get(parentSessionId, messageId);
    if (!point) throw new Error("Branch message not found");
    if (Number(this.db.prepare("SELECT temporary FROM sessions WHERE id=?").get(parentSessionId)?.temporary) === 1)
      throw new Error("Temporary conversations cannot be branched");
    const selected = JSON.parse(String(point.body)) as Message;
    if (!["user", "assistant"].includes(selected.role) || selected.toolCalls?.length)
      throw new Error("Choose a user message or an assistant reply without tool requests");
    if (before && selected.role !== "user") throw new Error("Only one of your own messages can be answered again");
    const rows = this.rows(parentSessionId, Number(point.id) - (before ? 1 : 0));
    if (reconcileTranscript(rows.map(row => JSON.parse(String(row.body)) as Message), "branch check").added)
      throw new Error("The selected conversation contains unfinished tool requests");
    const sessionId = randomUUID(), createdAt = new Date().toISOString();
    // The branch gets its own copy of every file, in its own folder, under its own names, copied off the engine thread
    // before anything is written. Copying the parent's references instead would have put cards here that cannot open,
    // and would have tied this conversation's files to the lifetime of the one it came off.
    const copied = await copiedFiles(rows.map((row) => JSON.parse(String(row.body)) as Message), parentSessionId, sessionId, this.files());
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO sessions(id,owner,created_at) VALUES(?,?,?)").run(sessionId, owner, createdAt);
      const insert = this.db.prepare("INSERT INTO messages(session_id,body,created_at) VALUES(?,?,?)");
      // Each copied message keeps when it was first written.
      copied.messages.forEach((message, i) => insert.run(sessionId, JSON.stringify(message), rows[i]?.created_at == null ? null : String(rows[i]!.created_at)));
      this.db.prepare("INSERT INTO session_branches VALUES(?,?,?,?)")
        .run(sessionId, parentSessionId, messageId, createdAt);
      copied.commit();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      // The branch does not exist, so neither may its files.
      this.files()?.discard(sessionId);
      throw error;
    }
    return { sessionId, parentSessionId, branchPointMessageId: messageId, copiedMessages: rows.length };
  }
  view(owner: string, input: string) {
    const sessionId = sessionIdSchema.parse(input);
    this.requireOwner(owner, sessionId);
    const branch = this.db.prepare("SELECT * FROM session_branches WHERE session_id=?").get(sessionId);
    return {
      sessionId,
      branch: branch ? { parentSessionId: String(branch.parent_session_id),
        branchPointMessageId: Number(branch.branch_point_message_id), createdAt: String(branch.created_at) } : null,
      messages: this.rows(sessionId).map(row => ({
        ...JSON.parse(String(row.body)) as Message, messageId: Number(row.source_id),
        // Parity B1: when it was written (kept beside the message, never inside what a model is sent).
        ...(row.created_at == null ? {} : { at: String(row.created_at) }),
      })),
    };
  }
  private requireOwner(owner: string, sessionId: string): void {
    if (!this.db.prepare("SELECT id FROM sessions WHERE id=? AND owner=?").get(sessionId, owner))
      throw new Error("Conversation not found");
  }
  private rows(sessionId: string, through = Number.MAX_SAFE_INTEGER) {
    const size = this.db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes
      FROM messages WHERE session_id=? AND id<=?`).get(sessionId, through)!;
    if (Number(size.count) > maximumMessages || Number(size.bytes) > maximumBytes)
      throw new Error("Conversation exceeds 1000 messages or 4 MiB; choose an earlier branch point");
    return this.db.prepare("SELECT id,source_id,body,created_at FROM messages WHERE session_id=? AND id<=? ORDER BY id")
      .all(sessionId, through);
  }
}

export function registerSessions(registry: ToolRegistry, store: Store): void {
  registry.register({
    name: "sessions.branch", permission: "sessions.branch", parameters: BranchSessionSchema,
    description: "Start a separate conversation from an earlier message. Needs history.read as well; the original is kept.",
    execute: async (input, context) => {
      if (!context.permissions.has("history.read")) throw new Error("Permission denied: history.read");
      return store.branchSession(context.owner, input, accessAgent(context)); // Q123
    },
  });
}
