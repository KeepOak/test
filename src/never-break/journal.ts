import { createHash } from "node:crypto";
import { chmodSync, renameSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ToolCall } from "../contracts.js";
import { isReadOnlyPermission } from "../policy.js";
import { migrate, type Migration } from "./migrations.js";

/**
 * The task journal: every model turn and every tool call written down, and flushed to the disk,
 * before it happens. A tool call is written twice: as an intent when the model asks for it (before
 * the request reaches the conversation), and as started just before it runs. So a call the
 * conversation holds is always in the journal, and one that never got past its intent is known not
 * to have run. It lives in its own file, `journal.sqlite`, with `synchronous=FULL`, so a
 * power cut cannot lose a step that was about to run. After a restart it says which steps were in
 * flight, what kind of step each was, and what the world looked like just before it — enough to
 * decide whether to do it again, check it, or ask the owner. See docs/never-break.md, threats 3–4.
 */
export type Effects = "none" | "idempotent" | "external";

/** Steps that give the same result however often they run. Everything unlisted that can change something counts as external. */
const idempotentTools = new Set(["files.write", "files.restore", "files.mkdir", "memory.forget", "todos.done", "git.branch",
  // selfdev (SELF-314): sending the same commits again changes nothing, and a remote that moved refuses it (no force).
  "git.push"]);
/**
 * selfdev (SELF-314): tools held by a permission that can change things, which themselves only look. A restart
 * while one ran (a long github.wait_for_checks, say) looks again rather than asking the owner what happened.
 */
const lookOnlyTools = new Set(["github.checks", "github.wait_for_checks", "github.check_logs", "github.issues", "github.release"]);
/** Tools whose effect on a file can be checked afterwards. */
const fileTools = new Set(["files.write", "files.edit", "files.patch", "files.restore"]);
const gitTools = /^git\.(commit|branch|worktree_add|worktree_remove)$/;

export function effectsOf(tool: string, permission: string): Effects {
  if (isReadOnlyPermission(permission) || /\.read$/.test(permission) || lookOnlyTools.has(tool)) return "none";
  return idempotentTools.has(tool) ? "idempotent" : "external";
}

export function idempotencyKey(runId: string, call: Pick<ToolCall, "id" | "name" | "arguments">): string {
  return createHash("sha256").update(`${runId}\n${call.id}\n${call.name}\n${call.arguments}`).digest("hex");
}

const sha = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

/** What can be checked after a restart: a file's contents, or a repository's current commit. */
export type Evidence =
  | { kind: "file"; path: string; before: string | null; intended: string | null }
  | { kind: "git"; repo: string; before: string | null };

async function fileHash(path: string): Promise<string | null> {
  return readFile(path).then(sha, () => null);
}
/** The commit a repository is on, read from its files rather than by running git. */
export async function gitHead(repo: string): Promise<string | null> {
  try {
    const head = (await readFile(join(repo, ".git", "HEAD"), "utf8")).trim();
    if (!head.startsWith("ref: ")) return head;
    const ref = head.slice(5);
    const loose = await readFile(join(repo, ".git", ref), "utf8").catch(() => null);
    if (loose) return loose.trim();
    const packed = await readFile(join(repo, ".git", "packed-refs"), "utf8").catch(() => "");
    return packed.split("\n").find((line) => line.endsWith(` ${ref}`))?.split(" ")[0] ?? null;
  } catch { return null; }
}

/** The evidence to keep for one call, or null when there is nothing to check afterwards. */
export async function evidenceFor(tool: string, args: unknown, workspace: string): Promise<Evidence | null> {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  if (fileTools.has(tool) && typeof a.path === "string") {
    const path = resolve(workspace, a.path);
    const rel = relative(workspace, path);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    const intended = tool === "files.write" && typeof a.content === "string" ? sha(a.content) : null;
    return { kind: "file", path, before: await fileHash(path), intended };
  }
  if (gitTools.test(tool)) return { kind: "git", repo: workspace, before: await gitHead(workspace) };
  return null;
}

/** What the evidence says now: the step took effect, it did not, or it cannot be told. */
export async function checkEvidence(evidence: Evidence | null): Promise<"done" | "not-done" | "unknown"> {
  if (!evidence) return "unknown";
  if (evidence.kind === "git") {
    const now = await gitHead(evidence.repo);
    return now === null ? "unknown" : now === evidence.before ? "not-done" : "done";
  }
  const now = await fileHash(evidence.path);
  if (evidence.intended !== null) return now === evidence.intended ? "done" : "not-done";
  return now === evidence.before ? "not-done" : "done";
}

export class JournalWriteError extends Error {
  constructor(cause: unknown) {
    super(`Branch could not write this step down before doing it (${cause instanceof Error ? cause.message : String(cause)}), so it stopped rather than do something it could not keep track of. The disk may be full.`);
  }
}

export interface OpenStep {
  id: number; runId: string; sessionId: string; callId: string; tool: string; arguments: string;
  key: string; effects: Effects; evidence: Evidence | null; startedAt: string;
  /** "intent": asked for and written down, but never started. "started": it may have run. */
  state: "intent" | "started";
  /** True when something secret-looking was hidden from the stored arguments, so they cannot be used to run the step again. */
  redacted?: boolean;
}

const migrations: Migration[] = [
  { version: 1, readableBy: 1, up: (db) => db.exec(`CREATE TABLE IF NOT EXISTS steps(
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL,
      call_id TEXT, tool TEXT, arguments TEXT, key TEXT, effects TEXT, evidence TEXT, state TEXT NOT NULL,
      started_at TEXT NOT NULL, finished_at TEXT);
    CREATE INDEX IF NOT EXISTS steps_open ON steps(state, run_id);`),
    down: (db) => db.exec("DROP TABLE IF EXISTS steps") },
  // Integration review: arguments are kept with keys and passwords hidden; such a step is never re-run from the journal.
  { version: 2, readableBy: 1, up: (db) => db.exec("ALTER TABLE steps ADD COLUMN redacted INTEGER NOT NULL DEFAULT 0"),
    down: (db) => db.exec("ALTER TABLE steps DROP COLUMN redacted") },
];

const effectKinds = new Set<string>(["none", "idempotent", "external"]);
function openStep(row: Record<string, unknown>): OpenStep {
  let evidence: Evidence | null = null;
  try { evidence = row.evidence ? JSON.parse(String(row.evidence)) as Evidence : null; } catch { evidence = null; }
  if (evidence && !((evidence.kind === "file" && typeof evidence.path === "string") || (evidence.kind === "git" && typeof evidence.repo === "string"))) evidence = null;
  const effects = String(row.effects);
  return {
    id: Number(row.id), runId: String(row.run_id), sessionId: String(row.session_id), callId: String(row.call_id),
    tool: String(row.tool), arguments: String(row.arguments ?? "{}"), key: String(row.key),
    effects: effectKinds.has(effects) ? effects as Effects : "external", evidence, startedAt: String(row.started_at),
    state: row.state === "intent" ? "intent" : "started",
    redacted: Number(row.redacted ?? 0) === 1,
  };
}

/**
 * Opens the journal. A journal that cannot be opened (a damaged file, a format from the future) is
 * moved aside and a fresh one started, so Branch still starts; `reset` then tells the start-up not to
 * carry anything on by itself, since what was in flight is no longer known.
 */
export function openJournal(path: string): { journal: TaskJournal; reset: string | null } {
  try { return { journal: new TaskJournal(path), reset: null }; }
  catch (error) {
    const aside = `${path}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    for (const suffix of ["", "-wal", "-shm"]) { try { renameSync(`${path}${suffix}`, `${aside}${suffix}`); } catch { /* not there */ } }
    const why = error instanceof Error ? error.message : String(error);
    let journal: TaskJournal;
    // Last resort: a journal in memory, so Branch still starts; nothing is kept across a restart then.
    try { journal = new TaskJournal(path); } catch { journal = new TaskJournal(":memory:"); }
    return { journal, reset: `The task journal could not be read (${why.slice(0, 200)}); it was put aside as ${aside} and a new one started.` };
  }
}

export class TaskJournal {
  private readonly db: DatabaseSync;
  /** Tests hand in a failure here to act out a full disk. */
  failWrites: (() => Error | null) | null = null;
  constructor(readonly path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000;");
      migrate(this.db, migrations, { backupTo: null });
      // Tidiness only: a disk that keeps no permissions must not stop the journal opening.
      if (process.platform !== "win32") { try { chmodSync(path, 0o600); } catch { /* see above */ } }
    } catch (error) { this.db.close(); throw error; }
  }
  private write<T>(work: () => T): T {
    try {
      const failure = this.failWrites?.();
      if (failure) throw failure;
      return work();
    } catch (error) { throw new JournalWriteError(error); }
  }
  turn(runId: string, sessionId: string, round: number): void {
    this.write(() => this.db.prepare("INSERT INTO steps(run_id,session_id,kind,tool,state,started_at,finished_at) VALUES(?,?,?,?,?,?,?)")
      .run(runId, sessionId, "turn", `round ${round}`, "finished", new Date().toISOString(), new Date().toISOString()));
  }
  begin(step: Omit<OpenStep, "id" | "startedAt" | "state">): number {
    return this.write(() => Number(this.db.prepare(
      "INSERT INTO steps(run_id,session_id,kind,call_id,tool,arguments,key,effects,evidence,state,started_at,redacted) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(step.runId, step.sessionId, "tool", step.callId, step.tool, step.arguments.slice(0, 65536), step.key, step.effects,
      step.evidence ? JSON.stringify(step.evidence) : null, "started", new Date().toISOString(), step.redacted ? 1 : 0).lastInsertRowid));
  }
  /** The calls one model turn asks for, written in one go before the turn reaches the conversation. */
  intend(steps: Omit<OpenStep, "id" | "startedAt" | "state" | "evidence">[]): number[] {
    return this.write(() => {
      const insert = this.db.prepare(
        "INSERT INTO steps(run_id,session_id,kind,call_id,tool,arguments,key,effects,state,started_at,redacted) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const ids = steps.map((step) => Number(insert.run(step.runId, step.sessionId, "tool", step.callId, step.tool, step.arguments.slice(0, 65536),
          step.key, step.effects, "intent", new Date().toISOString(), step.redacted ? 1 : 0).lastInsertRowid));
        this.db.exec("COMMIT");
        return ids;
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    });
  }
  /** An intended call is about to run. Like `begin`, this must be on the disk first, or the call is not made. */
  start(id: number, evidence: Evidence | null): void {
    this.write(() => this.db.prepare("UPDATE steps SET state='started', evidence=?, started_at=? WHERE id=? AND state='intent'")
      .run(evidence ? JSON.stringify(evidence) : null, new Date().toISOString(), id));
  }
  /** Closing a step is best effort: failing to write "finished" only means it is checked again after a restart. */
  finish(id: number, state: "finished" | "failed" | "redone" | "verified" | "asked" | "abandoned" | "not-started"): void {
    try { this.db.prepare("UPDATE steps SET state=?, finished_at=? WHERE id=?").run(state, new Date().toISOString(), id); }
    catch { /* see above */ }
  }
  /**
   * Steps still open: started and never closed, or intended and never started. (A version from before
   * intents reads only the started ones, which is what it wrote.) A row that cannot be read is treated
   * as the riskiest kind rather than stopping the rest.
   */
  open(): OpenStep[] {
    return this.db.prepare("SELECT * FROM steps WHERE state IN ('started','intent') AND kind='tool' ORDER BY id").all().map(openStep);
  }
  steps(runId: string): { kind: string; tool: string; state: string; effects: string | null; callId: string | null }[] {
    return this.db.prepare("SELECT kind, tool, state, effects, call_id FROM steps WHERE run_id=? ORDER BY id").all(runId)
      .map((row) => ({ kind: String(row.kind), tool: String(row.tool), state: String(row.state), effects: row.effects === null ? null : String(row.effects),
        callId: row.call_id === null ? null : String(row.call_id) }));
  }
  /** Keeps the file small: finished steps older than a week go. */
  prune(olderThanMs = 7 * 86_400_000): void {
    try { this.db.prepare("DELETE FROM steps WHERE state NOT IN ('started','intent') AND started_at < ?").run(new Date(Date.now() - olderThanMs).toISOString()); }
    catch { /* tidying never matters enough to fail over */ }
  }
  /** The open database, for taking a copy of it (`VACUUM INTO`) before an update. */
  get database(): DatabaseSync { return this.db; }
  close(): void { try { this.db.close(); } catch { /* already closed */ } }
}

/** Where the runtime writes steps. The no-op journal is what a runtime has until createBranch connects one. */
export interface JournalHook {
  /** The calls a model turn asks for, written down before the turn is saved to the conversation. */
  intend(input: { runId: string; sessionId: string; calls: { call: ToolCall; permission: string }[] }): void;
  around<T>(input: { runId: string; sessionId: string; call: ToolCall; permission: string; workspace: string; signal?: AbortSignal }, work: () => Promise<T>): Promise<T>;
  turn(runId: string, sessionId: string, round: number): void;
}
export const noJournal: JournalHook = { intend: () => undefined, around: (_input, work) => work(), turn: () => undefined };

/** `hide` takes keys, passwords and other secret-looking values out of text before it is stored. */
export function journalHook(journal: TaskJournal, hide: (text: string) => string = (text) => text): JournalHook {
  /** Intended calls not yet started, by run and call id. */
  const intended = new Map<string, number>();
  const which = (runId: string, callId: string): string => `${runId}\n${callId}`;
  const row = (runId: string, sessionId: string, call: ToolCall, permission: string) => {
    let stored: string;
    try { stored = hide(call.arguments); } catch { stored = "{}"; }
    return { runId, sessionId, callId: call.id, tool: call.name, arguments: stored, key: idempotencyKey(runId, call),
      effects: effectsOf(call.name, permission), redacted: stored !== call.arguments };
  };
  return {
    intend(input) {
      const ids = journal.intend(input.calls.map(({ call, permission }) => row(input.runId, input.sessionId, call, permission)));
      input.calls.forEach(({ call }, index) => intended.set(which(input.runId, call.id), ids[index]!));
    },
    async around(input, work) {
      let args: unknown = null;
      try { args = JSON.parse(input.call.arguments); } catch { /* the tool refuses it itself */ }
      const step = row(input.runId, input.sessionId, input.call, input.permission);
      const evidence = step.effects === "none" ? null : await evidenceFor(input.call.name, args, input.workspace).catch(() => null);
      const planned = intended.get(which(input.runId, input.call.id));
      intended.delete(which(input.runId, input.call.id));
      let id: number;
      if (planned === undefined) id = journal.begin({ ...step, evidence });
      else { journal.start(planned, evidence); id = planned; }
      try {
        const result = await work();
        journal.finish(id, "finished");
        return result;
      } catch (error) {
        // A call cut off by the task being stopped may or may not have taken effect: it stays open,
        // so a restart looks at it again.
        if (!input.signal?.aborted) journal.finish(id, "failed");
        throw error;
      }
    },
    turn(runId, sessionId, round) {
      // A call from an earlier turn that never ran (the turn ended early) stays an intent in the file.
      for (const key of intended.keys()) if (key.startsWith(`${runId}\n`)) intended.delete(key);
      journal.turn(runId, sessionId, round);
    },
  };
}
