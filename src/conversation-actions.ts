import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

/**
 * Conversations, like iMessage: pinned to the top in the owner's order, renamed, archived (out of Recent, still found by
 * search) and deleted into Recently Deleted, where each waits 30 days before it is removed for good. A conversation in
 * Recently Deleted is kept but hidden everywhere else: Recent, search, the history tools and what memory recalls.
 *
 * Every change is made by whoever the conversation belongs to (the profile switched on, src/profiles.ts scope); anyone
 * else's conversation reads as not found. Removing for good is src/store.ts purgeSession, which this never calls itself.
 */
export const recentlyDeletedDays = 30;
const dayMs = 86_400_000;

export const busyStatuses = ["running", "needs_input"] as const;
export const PinSchema = z.object({ pinned: z.boolean() }).strict();
export const RenameSchema = z.object({ title: z.string().trim().max(120).nullable() }).strict();
export const ArchiveSchema = z.object({ archived: z.boolean() }).strict();
export const EmptySchema = z.object({}).strict();

/** Said when a conversation still has work going: nothing is stopped without the person saying so. */
export const busyWords = (verb: "archive" | "delete"): string =>
  `A task is still running in this conversation. Stop it first, then ${verb} the conversation.`;
export const inBinWords = "This conversation is in Recently Deleted. Restore it first.";
export const notInBinWords = "Only a conversation in Recently Deleted can be deleted now.";

/** The marks table; every reader that leaves Recently Deleted out makes sure it is there. */
export function ensureMarks(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS conversation_marks(session_id TEXT PRIMARY KEY, owner TEXT NOT NULL,
    pin_order INTEGER, title TEXT, archived_at TEXT, deleted_at TEXT)`);
}

export interface PutAwayRow { sessionId: string; opening: string; title: string; at: string; daysLeft?: number }
export interface PutAway {
  archived: PutAwayRow[]; deleted: PutAwayRow[];
  totals: { archived: number; deleted: number }; next: { archived: number | null; deleted: number | null };
}
/** GET /api/sessions/put-away?kind=deleted&offset=50: the next page of one list. */
export const PutAwayQuerySchema = z.object({
  kind: z.enum(["archived", "deleted"]).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export class ConversationMarks {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) { ensureMarks(db); }
  private owned(owner: string, sessionId: string): void {
    if (!this.db.prepare("SELECT 1 AS found FROM sessions WHERE id=? AND owner=? AND temporary=0").get(sessionId, owner))
      throw new Error("Conversation not found");
  }
  private mark(sessionId: string) {
    return this.db.prepare("SELECT * FROM conversation_marks WHERE session_id=?").get(sessionId);
  }
  private set(owner: string, sessionId: string, fields: Record<string, string | number | null>): void {
    this.db.prepare("INSERT OR IGNORE INTO conversation_marks(session_id,owner) VALUES(?,?)").run(sessionId, owner);
    const names = Object.keys(fields);
    this.db.prepare(`UPDATE conversation_marks SET ${names.map((name) => `${name}=?`).join(",")} WHERE session_id=?`)
      .run(...names.map((name) => fields[name]!), sessionId);
  }
  private requireNotInBin(sessionId: string): void {
    if (this.mark(sessionId)?.deleted_at) throw new Error(inBinWords);
  }
  /** Whether any of these conversations has a task still going (running, or waiting on an answer); `statuses` narrows it. */
  busy(sessionIds: readonly string[], statuses: readonly string[] = busyStatuses): boolean {
    if (!sessionIds.length || !statuses.length) return false;
    return !!this.db.prepare(`SELECT 1 AS found FROM tasks WHERE session_id IN (${sessionIds.map(() => "?").join(",")})
      AND status IN (${statuses.map(() => "?").join(",")}) LIMIT 1`).get(...sessionIds, ...statuses);
  }
  pin(owner: string, sessionId: string, input: unknown) {
    const { pinned } = PinSchema.parse(input);
    this.owned(owner, sessionId);
    this.requireNotInBin(sessionId);
    const next = Number(this.db.prepare("SELECT COALESCE(MAX(pin_order),0) AS top FROM conversation_marks WHERE owner=?").get(owner)?.top) + 1;
    this.set(owner, sessionId, { pin_order: pinned ? (this.mark(sessionId)?.pin_order as number | null) ?? next : null });
    return { sessionId, pinned };
  }
  rename(owner: string, sessionId: string, input: unknown) {
    const { title } = RenameSchema.parse(input);
    this.owned(owner, sessionId);
    this.requireNotInBin(sessionId);
    this.set(owner, sessionId, { title: title || null });
    return { sessionId, title: title || "" };
  }
  /** `companions`: conversations that go with this one (a room's Trunks' sides), whose work counts as its own. */
  archive(owner: string, sessionId: string, input: unknown, companions: readonly string[] = []) {
    const { archived } = ArchiveSchema.parse(input);
    this.owned(owner, sessionId);
    this.requireNotInBin(sessionId);
    if (archived && this.busy([sessionId, ...companions])) throw new Error(busyWords("archive"));
    this.set(owner, sessionId, { archived_at: archived ? new Date(this.now()).toISOString() : null });
    return { sessionId, archived };
  }
  /** Into Recently Deleted: kept, hidden everywhere else, and removed for good after 30 days. */
  delete(owner: string, sessionId: string, companions: readonly string[] = []) {
    this.owned(owner, sessionId);
    if (this.busy([sessionId, ...companions])) throw new Error(busyWords("delete"));
    const at = new Date(this.now()).toISOString();
    if (!this.mark(sessionId)?.deleted_at) this.set(owner, sessionId, { deleted_at: at });
    return { sessionId, deleted: true, daysLeft: recentlyDeletedDays };
  }
  /** Out of Recently Deleted, with its pin, name and archive as they were. */
  restore(owner: string, sessionId: string) {
    this.owned(owner, sessionId);
    this.set(owner, sessionId, { deleted_at: null });
    return { sessionId, restored: true };
  }
  /** Before removing one for good: it has to be in Recently Deleted, and have nothing still going. */
  requireDeletable(owner: string, sessionId: string, companions: readonly string[] = []): void {
    this.owned(owner, sessionId);
    if (!this.mark(sessionId)?.deleted_at) throw new Error(notInBinWords);
    if (this.busy([sessionId, ...companions])) throw new Error(busyWords("delete"));
  }
  inBin(sessionId: string): boolean { return !!this.mark(sessionId)?.deleted_at; }
  /** A new message in an archived or deleted conversation brings it back to Recent, as a new text does in iMessage. */
  revive(sessionId: string): void {
    this.db.prepare("UPDATE conversation_marks SET archived_at=NULL, deleted_at=NULL WHERE session_id=?").run(sessionId);
  }
  daysLeft(deletedAt: string): number {
    return Math.max(0, Math.ceil((Date.parse(deletedAt) + recentlyDeletedDays * dayMs - this.now()) / dayMs));
  }
  /** The owner's conversations in Recently Deleted, newest first. */
  deletedIds(owner: string): string[] {
    return this.db.prepare("SELECT session_id FROM conversation_marks WHERE owner=? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC")
      .all(owner).map((row) => String(row.session_id));
  }
  /** Every conversation whose 30 days in Recently Deleted are over, whoever it belongs to. */
  expired(): string[] {
    const cutoff = new Date(this.now() - recentlyDeletedDays * dayMs).toISOString();
    return this.db.prepare("SELECT session_id FROM conversation_marks WHERE deleted_at IS NOT NULL AND deleted_at<=?")
      .all(cutoff).map((row) => String(row.session_id));
  }
  /** The name a conversation is listed by: the one the person gave it, else its opening words. Titles only, for the audit record. */
  titleOf(sessionId: string): string {
    const row = this.db.prepare(`SELECT c.title, (SELECT substr(json_extract(m.body,'$.content'),1,120) FROM messages m WHERE m.session_id=c.session_id
      AND json_extract(m.body,'$.role') IN ('user','assistant') ORDER BY m.id LIMIT 1) AS opening FROM conversation_marks c WHERE c.session_id=?`).get(sessionId);
    return String(row?.title || row?.opening || sessionId);
  }
  /**
   * Archived and Recently Deleted, a page of each (newest first, `offset` into the one `kind` asked for), with how many
   * each holds in all and where the next page starts (null at the end). `hidden`: a room's Trunks' sides, never listed.
   */
  putAway(owner: string, input: unknown, hidden: readonly string[] = []): PutAway {
    const { kind, offset, limit } = PutAwayQuerySchema.parse(input);
    const page = (which: "archived" | "deleted", from: number) => {
      const at = which === "deleted" ? "c.deleted_at" : "c.archived_at", where = which === "deleted" ? "c.deleted_at IS NOT NULL" : "c.archived_at IS NOT NULL AND c.deleted_at IS NULL";
      const scope = `FROM conversation_marks c JOIN sessions s ON s.id=c.session_id
        WHERE c.owner=? AND s.owner=? AND ${where} AND c.session_id NOT IN (SELECT value FROM json_each(?))`, args = [owner, owner, JSON.stringify(hidden)];
      const total = Number(this.db.prepare(`SELECT COUNT(*) AS n ${scope}`).get(...args)?.n ?? 0);
      const rows = this.db.prepare(`SELECT c.session_id, c.title, ${at} AS at,
        (SELECT substr(json_extract(m.body,'$.content'),1,240) FROM messages m WHERE m.session_id=c.session_id
          AND json_extract(m.body,'$.role') IN ('user','assistant') ORDER BY m.id LIMIT 1) AS opening
        ${scope} ORDER BY ${at} DESC, c.session_id LIMIT ? OFFSET ?`).all(...args, limit, from);
      const shaped = rows.map((row): PutAwayRow => ({ sessionId: String(row.session_id), opening: String(row.opening ?? ""), title: String(row.title ?? ""),
        at: String(row.at), ...(which === "deleted" ? { daysLeft: this.daysLeft(String(row.at)) } : {}) }));
      return { rows: shaped, total, next: from + rows.length < total ? from + rows.length : null };
    };
    const archived = page("archived", kind === "archived" ? offset : 0), deleted = page("deleted", kind === "deleted" ? offset : 0);
    return { archived: archived.rows, deleted: deleted.rows, totals: { archived: archived.total, deleted: deleted.total },
      next: { archived: archived.next, deleted: deleted.next } };
  }
  forget(sessionId: string): void {
    this.db.prepare("DELETE FROM conversation_marks WHERE session_id=?").run(sessionId);
  }
}

/** SQL for the conversations in Recently Deleted, to leave out of a list (`s` is the sessions table). */
export const notInBin = "AND s.id NOT IN (SELECT session_id FROM conversation_marks WHERE deleted_at IS NOT NULL)";
/** SQL for the conversations archived or in Recently Deleted, to leave out of Recent. */
export const notPutAway = "AND s.id NOT IN (SELECT session_id FROM conversation_marks WHERE archived_at IS NOT NULL OR deleted_at IS NOT NULL)";

/** The tasks of conversations in Recently Deleted, so what memory recalls leaves out the facts they taught. */
export function binnedRuns(db: DatabaseSync): Set<string> {
  if (!db.prepare("SELECT 1 AS found FROM sqlite_schema WHERE name='conversation_marks'").get()) return new Set();
  return new Set(db.prepare(`SELECT t.id FROM tasks t JOIN conversation_marks c ON c.session_id=t.session_id
    WHERE c.deleted_at IS NOT NULL`).all().map((row) => String(row.id)));
}
/** Whether a remembered fact came from a task of a conversation in Recently Deleted. */
export const learnedInBin = (binned: ReadonlySet<string>, data: { originRunId?: unknown; sourceRunId?: unknown }): boolean =>
  binned.size > 0 && (binned.has(String(data.originRunId ?? "")) || binned.has(String(data.sourceRunId ?? "")));
