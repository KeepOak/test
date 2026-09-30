import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Run } from "./contracts.js";
import type { SnapshotStore } from "./checkpoints.js";
import type { WorkspaceFiles } from "./files.js";
import type { CutConversation, SessionTree } from "./session-tree.js";
import type { WorkspaceHistory } from "./workspace-history.js";
import type { FeatureMode } from "./goal-mode.js";

/**
 * Wave mac2: going back to an earlier message. Before every task the workspace is recorded in the
 * hidden snapshot store (src/checkpoints.ts), keyed by the message that started the task. Editing an
 * earlier message can then take back the conversation, the files, or both, to how they were just
 * before that message; "undo that" puts everything back the way it was before the rewind.
 *
 * Undo is a stack per conversation, like workspace.undo: each rewind can be undone once, newest first.
 * Without git the files come back from the per-file copies the assistant's own file tools keep, and
 * the answer says plainly that changes made by commands were not covered.
 */
export const RewindSchema = z.object({
  messageId: z.number().int().positive(),
  restore: z.enum(["conversation", "files", "both"]),
}).strict();
export type RewindInput = z.infer<typeof RewindSchema>;
export type FilesMethod = "snapshot" | "copies" | "none";
export interface FilesOutcome { method: FilesMethod; changed: number; removed: number; note: string }
export interface RewindOutcome { id: string; restore: RewindInput["restore"]; messagesRemoved: number; files: FilesOutcome | null }

const copiesOnly = "Only the changes Branch made with its own file tools can be put back.";
const noGitNote = "Git is not installed, so only the changes Branch made with its own file tools were put back; changes made by commands were not.";
const sessionIdSchema = z.string().uuid();

export class Rewinds {
  constructor(
    private readonly db: DatabaseSync,
    private readonly owner: string,
    private readonly tree: SessionTree,
    private readonly history: WorkspaceHistory,
    private readonly snapshots: SnapshotStore,
    private readonly files: WorkspaceFiles,
    /** The owner's switch for snapshots; off takes none. */
    private readonly mode: () => FeatureMode = () => "on",
    /** Whether a tool can change anything, for "when needed". */
    private readonly changes: (tool: string) => boolean = () => true,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS turn_snapshots(row_id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL,
        tree TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS turn_snapshots_session ON turn_snapshots(session_id, row_id);
      CREATE TABLE IF NOT EXISTS rewinds(id TEXT PRIMARY KEY, owner TEXT NOT NULL, session_id TEXT NOT NULL, restore TEXT NOT NULL,
        cut TEXT, files_method TEXT NOT NULL, before_tree TEXT, before_copy TEXT, undone INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS rewinds_session ON rewinds(owner, session_id, undone, created_at);`);
  }

  /**
   * The runtime hook: called once as a task starts, after its message is written. Records which
   * message started which task and, when git is here, the workspace as it stood. Never fails a task.
   *
   * chat-speed: the snapshot is begun here but not waited for. Three git runs took 8 and 23 seconds on the owner's
   * computer (2026-09-29), all of it before the model was even asked, so a Telegram "Hi" waited on the disk. Nothing
   * can change the workspace before a tool call, and every call that can waits for it first (beforeChange).
   */
  async turnStarted(run: Run): Promise<void> {
    const last = this.db.prepare("SELECT MAX(id) AS id FROM messages WHERE session_id=?").get(run.sessionId);
    if (!last?.id) return;
    const rowId = Number(last.id);
    // The row is kept whatever the switch says: it is what ties a message to its task for the copies.
    this.db.prepare("INSERT OR REPLACE INTO turn_snapshots VALUES(?,?,?,?,?)")
      .run(rowId, run.sessionId, run.id, null, new Date().toISOString());
    if (this.mode() !== "on") return;
    const taking = this.snapshotNow().then((tree) => {
      try { if (tree) this.db.prepare("UPDATE turn_snapshots SET tree=? WHERE row_id=? AND run_id=? AND tree IS NULL").run(tree, rowId, run.id); }
      catch { /* Branch closed meanwhile; like a snapshot that could not be taken, it never fails anything */ }
    }).finally(() => this.begun.delete(taking));
    this.begun.add(taking);
  }
  /** Snapshots begun as tasks started and not yet written down. */
  private readonly begun = new Set<Promise<void>>();
  /** Resolves once every snapshot begun so far is written down (never rejects). */
  async settled(): Promise<void> {
    await Promise.all([...this.begun]);
  }

  /**
   * Called before every tool call. A call that can change something first waits for the snapshot begun as its task
   * started ("on"). "When needed": the first such call in a task records the workspace as it still is; reading
   * calls, and every later call, cost nothing.
   */
  async beforeChange(runId: string, tool: string): Promise<void> {
    if (!runId || !this.changes(tool)) return;
    await this.settled();
    if (this.mode() !== "when-needed") return;
    const row = this.db.prepare("SELECT row_id, tree FROM turn_snapshots WHERE run_id=?").get(runId);
    if (!row || row.tree !== null) return;
    let pending = this.taking.get(runId);
    if (!pending) {
      pending = this.snapshotNow().then((tree) => {
        if (tree) this.db.prepare("UPDATE turn_snapshots SET tree=? WHERE row_id=? AND tree IS NULL").run(tree, Number(row.row_id));
      }).finally(() => this.taking.delete(runId));
      this.taking.set(runId, pending);
    }
    await pending;
  }
  private readonly taking = new Map<string, Promise<void>>();

  /** A snapshot, or null when there cannot be one; never throws, because it never fails a task. */
  private async snapshotNow(): Promise<string | null> {
    try { return await this.snapshots.available() ? await this.snapshots.take() : null; } catch { return null; }
  }
  private async snapshotsReady(): Promise<boolean> {
    return this.mode() !== "off" && await this.snapshots.available();
  }

  /** What can be done in this conversation now: whether files can be covered, and the undo waiting. */
  async status(owner: string, input: string): Promise<{ method: FilesMethod; snapshots: FeatureMode; note: string; undo: { id: string; restore: string; createdAt: string } | null }> {
    const id = this.owned(owner, input);
    const git = await this.snapshotsReady();
    const row = this.lastRewind(owner, id);
    return {
      method: git ? "snapshot" : "copies", snapshots: this.mode(), note: git ? "" : await this.copiesNote(),
      undo: row ? { id: String(row.id), restore: String(row.restore), createdAt: String(row.created_at) } : null,
    };
  }

  /** Takes the conversation, the files, or both back to just before one message. */
  async rewind(owner: string, input: string, body: unknown): Promise<RewindOutcome> {
    const id = this.owned(owner, input);
    const wanted = RewindSchema.parse(body);
    const start = this.db.prepare("SELECT id FROM messages WHERE session_id=? AND source_id=?").get(id, wanted.messageId);
    if (!start) throw new Error("That message is not in this conversation");
    const fromRow = Number(start.id);
    await this.settled(); // a snapshot still being taken for that message's task is the one to go back to
    const record = { id: randomUUID(), cut: null as CutConversation | null, method: "none" as FilesMethod, beforeTree: null as string | null, beforeCopy: null as string | null };
    this.requireIdle(id);
    let files: FilesOutcome | null = null;
    if (wanted.restore !== "conversation") files = await this.restoreFiles(id, fromRow, record);
    if (wanted.restore !== "files") record.cut = this.tree.cutFrom(owner, id, wanted.messageId);
    this.db.prepare("INSERT INTO rewinds VALUES(?,?,?,?,?,?,?,?,?,?)").run(record.id, owner, id, wanted.restore,
      record.cut ? JSON.stringify(record.cut) : null, record.method, record.beforeTree, record.beforeCopy, 0, new Date().toISOString());
    return { id: record.id, restore: wanted.restore, messagesRemoved: record.cut?.rows.length ?? 0, files };
  }

  /** "Undo that": puts back the conversation and files as they were before the newest rewind. */
  async unrevert(owner: string, input: string): Promise<{ id: string; messagesRestored: number; files: FilesOutcome | null }> {
    const id = this.owned(owner, input);
    const row = this.lastRewind(owner, id);
    if (!row) throw new Error("There is no rewind to undo in this conversation.");
    this.requireIdle(id);
    let files: FilesOutcome | null = null;
    const method = String(row.files_method) as FilesMethod;
    if (method === "snapshot" && row.before_tree) {
      const back = await this.snapshots.restore(String(row.before_tree));
      files = { method, changed: back.changed.length, removed: back.removed.length, note: "" };
    } else if (method === "copies" && row.before_copy) {
      const back = await this.history.restoreSnapshot(String(row.before_copy));
      files = { method, changed: back.restored, removed: 0, note: noGitNote };
    }
    const cut = row.cut ? JSON.parse(String(row.cut)) as CutConversation : null;
    if (cut) this.tree.putBack(owner, id, cut);
    this.db.prepare("UPDATE rewinds SET undone=1 WHERE id=?").run(String(row.id));
    return { id: String(row.id), messagesRestored: cut?.rows.length ?? 0, files };
  }

  /**
   * The files part. With git: record the workspace now (so this can be undone), then put back the
   * snapshot taken when that message's task started, or the next one after it. Without git: the
   * per-file copies from before each write in this conversation's later tasks.
   */
  private async restoreFiles(sessionId: string, fromRow: number, record: { method: FilesMethod; beforeTree: string | null; beforeCopy: string | null }): Promise<FilesOutcome> {
    const turn = this.db.prepare("SELECT tree FROM turn_snapshots WHERE session_id=? AND row_id>=? AND tree IS NOT NULL ORDER BY row_id LIMIT 1").get(sessionId, fromRow);
    if (turn && await this.snapshots.available()) { // a snapshot already kept can be used even if the switch is off now
      record.beforeTree = await this.snapshots.take();
      const back = await this.snapshots.restore(String(turn.tree));
      record.method = "snapshot";
      return { method: "snapshot", changed: back.changed.length, removed: back.removed.length, note: "" };
    }
    return this.restoreCopies(sessionId, fromRow, record);
  }

  private async restoreCopies(sessionId: string, fromRow: number, record: { method: FilesMethod; beforeCopy: string | null }): Promise<FilesOutcome> {
    const since = this.db.prepare("SELECT MIN(created_at) AS at FROM tasks WHERE session_id=? AND id IN (SELECT run_id FROM turn_snapshots WHERE session_id=? AND row_id>=?)").get(sessionId, sessionId, fromRow);
    const note = await this.copiesNote();
    if (!since?.at) return { method: "none", changed: 0, removed: 0, note: "No file changes were recorded after that message." };
    const versions = this.db.prepare(`SELECT id, path, existed FROM file_versions WHERE owner=? AND reason='before write'
      AND run_id IN (SELECT id FROM tasks WHERE session_id=? AND created_at>=?) ORDER BY created_at, rowid`).all(this.owner, sessionId, String(since.at));
    const earliest = new Map<string, { id: string; existed: boolean }>();
    for (const v of versions) if (!earliest.has(String(v.path))) earliest.set(String(v.path), { id: String(v.id), existed: Number(v.existed) === 1 });
    if (!earliest.size) return { method: "none", changed: 0, removed: 0, note: "No file changes were recorded after that message." };
    record.beforeCopy = (await this.history.checkpoint(sessionId, "Before going back to an earlier message").catch(() => null))?.id ?? null;
    record.method = "copies";
    let changed = 0, removed = 0;
    for (const [path, version] of earliest) {
      if (version.existed) { await this.history.restore(version.id); changed++; }
      else { await rm(await this.files.checked(path), { force: true }); removed++; }
    }
    return { method: "copies", changed, removed, note };
  }

  /** Why the files come back from per-file copies rather than a snapshot, in plain words. */
  private async copiesNote(): Promise<string> {
    if (this.mode() === "off") return `Snapshots are switched off in Settings. ${copiesOnly}`;
    if (await this.snapshots.available()) return `No snapshot was taken before that message. ${copiesOnly}`;
    return this.snapshots.unavailableReason ? `${this.snapshots.unavailableReason} ${copiesOnly}` : noGitNote;
  }

  /** Nothing is taken back underneath a task that is still working. */
  private requireIdle(id: string): void {
    if (this.db.prepare("SELECT id FROM tasks WHERE session_id=? AND status IN ('running','needs_input')").get(id))
      throw new Error("Wait for the task that is still working in this conversation, or stop it, first.");
  }

  private lastRewind(owner: string, id: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM rewinds WHERE owner=? AND session_id=? AND undone=0 ORDER BY created_at DESC, rowid DESC LIMIT 1").get(owner, id) as Record<string, unknown> | undefined;
  }
  private owned(owner: string, input: string): string {
    const id = sessionIdSchema.parse(input);
    if (!this.db.prepare("SELECT id FROM sessions WHERE id=? AND owner=?").get(id, owner)) throw new Error("Conversation not found");
    return id;
  }
}

/** The HTTP side: `/api/sessions/<id>/rewind` (GET status, POST rewind) and `/unrevert` (POST). */
export async function rewindApi(rewinds: Rewinds, owner: string, method: string, path: string, body: () => Promise<unknown>): Promise<unknown> {
  const match = /^\/api\/sessions\/([a-f0-9-]{36})\/(rewind|unrevert)$/.exec(path);
  if (!match) return undefined;
  if (match[2] === "rewind" && method === "GET") return rewinds.status(owner, match[1]!);
  if (match[2] === "rewind" && method === "POST") return rewinds.rewind(owner, match[1]!, await body());
  if (match[2] === "unrevert" && method === "POST") { z.object({}).strict().parse(await body()); return rewinds.unrevert(owner, match[1]!); }
  return undefined;
}
