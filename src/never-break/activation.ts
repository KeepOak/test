import { createHash } from "node:crypto";
import { chmodSync, renameSync } from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { formatOf, migrate, type Migration } from "./migrations.js";

/**
 * The activation journal: what an install or an update actually changed, written down before it
 * happens, so an undo knows exactly what it is undoing. It records, for the version that was there
 * and the version that replaced it, a fingerprint of the files on the disk (a digest over the tree
 * and the place the file system keeps it), which format each database was in on both sides, which
 * format changes ran, the newest format the older version understood, and where the safety copies
 * went. Every step of an undo is appended to the same file as it is attempted, so a rollback cut
 * off half-way still says how far it got.
 *
 * It lives in its own file, `activation.sqlite`, with `synchronous=FULL`, beside the task journal.
 * Every change here keeps `readableBy: 1`, because the version being rolled *back to* has to be able
 * to read it. A file that cannot be read is moved aside and a new one started, exactly as the task
 * journal does, so a torn activation journal can never stop Branch coming up. See
 * docs/never-break.md and the re-audit's A1.
 */

export const activationJournalName = "activation.sqlite";

const sha = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

/**
 * What the files of one version looked like. `digest` is over the sorted tree (each file's path,
 * size and contents), so any edit anywhere changes it. `identity` is the place the file system keeps
 * the folder (`device:inode`), which catches a folder swapped for another one without reading it;
 * it is *not* a contents check, since an edit in place keeps the same inode. `partial` is true when
 * the walk ran out of its time or file budget: such a fingerprint proves nothing and a rollback
 * refuses on it rather than treating it as verified.
 */
export interface Fingerprint {
  digest: string;
  identity: string | null;
  files: number;
  bytes: number;
  partial: boolean;
}

export interface FingerprintOptions {
  /** How long the walk may take. Past it the fingerprint comes back `partial`. */
  budgetMs?: number;
  /** How many files it may read. Past it the fingerprint comes back `partial`. */
  maxFiles?: number;
  now?: () => number;
}

/** The place the file system keeps a path, as `device:inode`; null when it cannot be read. */
export async function identityOf(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    return `${info.dev}:${info.ino}`;
  } catch { return null; }
}

/**
 * Fingerprints a version's files. Links are recorded by where they point rather than followed, so a
 * bundle full of them (every macOS `.app`) is described without walking the same files twice.
 */
export async function fingerprintTree(root: string, options: FingerprintOptions = {}): Promise<Fingerprint | null> {
  const budgetMs = options.budgetMs ?? 20_000, maxFiles = options.maxFiles ?? 50_000;
  const now = options.now ?? Date.now;
  const until = now() + budgetMs;
  const identity = await identityOf(root);
  if (identity === null) return null;
  const lines: string[] = [];
  let files = 0, bytes = 0, partial = false;
  const walk = async (dir: string, prefix: string): Promise<void> => {
    if (partial) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (entries === null) { partial = true; return; }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (partial) return;
      if (now() > until || files >= maxFiles) { partial = true; return; }
      const path = join(dir, entry.name), rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { await walk(path, rel); continue; }
      if (entry.isSymbolicLink()) {
        const { readlink } = await import("node:fs/promises");
        const points = await readlink(path).catch(() => null);
        if (points === null) { partial = true; return; }
        lines.push(`${rel}\0link\0${points}`);
        files += 1;
        continue;
      }
      const info = await stat(path).catch(() => null);
      const body = await readFile(path).catch(() => null);
      if (info === null || body === null) { partial = true; return; }
      lines.push(`${rel}\0${info.size}\0${sha(body)}`);
      files += 1;
      bytes += info.size;
    }
  };
  await walk(root, "");
  return { digest: sha(lines.join("\n")), identity, files, bytes, partial };
}

/** One database's format on each side of an activation. */
export interface DatabaseChange {
  name: string;
  before: { version: number; readableBy: number };
  after: { version: number; readableBy: number };
  /** The format changes that ran, oldest first. Empty when the update changed nothing. */
  ran: number[];
  /** The copy taken before those changes ran, when one was taken. */
  backup: string | null;
}

/** The format of a database as it stands, for recording or for checking against a record. */
export function databaseFormat(db: DatabaseSync): { version: number; readableBy: number } {
  return formatOf(db);
}

export type ActivationState = "staged" | "activated" | "rolling-back" | "rolled-back" | "superseded" | "failed";

export interface ActivationRecord {
  kind: "update" | "install" | "rollback";
  fromVersion: string;
  toVersion: string;
  /** The installed program: the `.app` bundle on macOS, the program folder elsewhere. */
  target: string;
  /** The version that was there, as it will be kept at `<target>.previous`. */
  previous: Fingerprint | null;
  /** The version that replaced it, as it was unpacked. */
  candidate: Fingerprint | null;
  /** The thing that starts Branch, fingerprinted on its own so a swapped launcher is caught cheaply. */
  launcher: { path: string; digest: string } | null;
  /** What the launcher is called inside the program folder, so the version put back can be started. */
  executableName: string;
  /**
   * The newest data format the *older* version understood, read from that version while it was still
   * the one running. A rollback is only safe while the data on the disk can still be read by it.
   */
  understood: number;
  databases: DatabaseChange[];
  /** Safety copies written before the update, so a refusal can name them. */
  backups: string[];
}

export interface ActivationEntry extends ActivationRecord {
  id: number;
  state: ActivationState;
  startedAt: string;
  finishedAt: string | null;
  /** Which process holds the undo, so two copies at once cannot both run one. */
  claimedBy: string | null;
}

export interface LedgerLine { at: string; step: string; ok: boolean; detail: string }

const migrations: Migration[] = [
  { version: 1, readableBy: 1, up: (db) => db.exec(`CREATE TABLE IF NOT EXISTS activations(
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, from_version TEXT NOT NULL, to_version TEXT NOT NULL,
      target TEXT NOT NULL, previous TEXT, candidate TEXT, launcher TEXT, executable_name TEXT NOT NULL DEFAULT '',
      understood INTEGER NOT NULL,
      databases TEXT NOT NULL, backups TEXT NOT NULL, state TEXT NOT NULL, started_at TEXT NOT NULL,
      finished_at TEXT, claimed_by TEXT);
    CREATE TABLE IF NOT EXISTS activation_ledger(
      id INTEGER PRIMARY KEY AUTOINCREMENT, activation_id INTEGER NOT NULL, at TEXT NOT NULL,
      step TEXT NOT NULL, ok INTEGER NOT NULL, detail TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS activations_state ON activations(state, id);
    CREATE INDEX IF NOT EXISTS activation_ledger_of ON activation_ledger(activation_id, id);`),
    down: (db) => db.exec("DROP TABLE IF EXISTS activation_ledger; DROP TABLE IF EXISTS activations") },
];

export class ActivationWriteError extends Error {
  constructor(cause: unknown) {
    super(`Branch could not write down what this update changed (${cause instanceof Error ? cause.message : String(cause)}), so it stopped rather than change something it could not undo. The disk may be full.`);
  }
}

const parse = <T>(text: unknown, fallback: T): T => {
  try { return text === null || text === undefined ? fallback : JSON.parse(String(text)) as T; } catch { return fallback; }
};
const states = new Set<string>(["staged", "activated", "rolling-back", "rolled-back", "superseded", "failed"]);

function entryOf(row: Record<string, unknown>): ActivationEntry {
  const state = String(row.state);
  const kind = String(row.kind);
  return {
    id: Number(row.id),
    kind: kind === "install" || kind === "rollback" ? kind : "update",
    fromVersion: String(row.from_version), toVersion: String(row.to_version), target: String(row.target),
    previous: parse<Fingerprint | null>(row.previous, null), candidate: parse<Fingerprint | null>(row.candidate, null),
    launcher: parse<{ path: string; digest: string } | null>(row.launcher, null),
    understood: Number(row.understood), databases: parse<DatabaseChange[]>(row.databases, []),
    executableName: String(row.executable_name ?? ""),
    backups: parse<string[]>(row.backups, []),
    state: states.has(state) ? state as ActivationState : "failed",
    startedAt: String(row.started_at), finishedAt: row.finished_at === null ? null : String(row.finished_at),
    claimedBy: row.claimed_by === null || row.claimed_by === undefined ? null : String(row.claimed_by),
  };
}

/**
 * Opens the activation journal. One that cannot be read is put aside and a new one started, so
 * Branch always comes up; `reset` then says so, and an undo that has nothing recorded refuses in
 * words rather than guessing.
 */
export function openActivationJournal(path: string): { journal: ActivationJournal; reset: string | null } {
  try { return { journal: new ActivationJournal(path), reset: null }; }
  catch (error) {
    const aside = `${path}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    for (const suffix of ["", "-wal", "-shm"]) { try { renameSync(`${path}${suffix}`, `${aside}${suffix}`); } catch { /* not there */ } }
    const why = error instanceof Error ? error.message : String(error);
    let journal: ActivationJournal;
    try { journal = new ActivationJournal(path); } catch { journal = new ActivationJournal(":memory:"); }
    return { journal, reset: `The record of what updates changed could not be read (${why.slice(0, 200)}); it was put aside as ${aside} and a new one started. Going back to an earlier version is not possible until the next update writes a new record.` };
  }
}

/**
 * On every start, decides what became of an activation that was written down but never confirmed —
 * the app's Update button hands over to a script and quits, so nothing in that process is left to
 * say whether the swap landed. The version running now answers it: if it is the one the update was
 * going to, the swap landed; anything else means it did not. Best effort throughout, and it never
 * touches an entry that was already settled.
 */
export function settleActivation(path: string, runningVersion: string): "activated" | "failed" | "none" {
  const { journal } = openActivationJournal(path);
  try {
    const staged = journal.recent(5).find((one) => one.state === "staged");
    if (!staged) return "none";
    if (staged.toVersion === runningVersion) { journal.activated(staged.id); return "activated"; }
    journal.failed(staged.id);
    return "failed";
  } catch { return "none"; }
  finally { journal.close(); }
}

/**
 * Q55: the newest recorded activation, read without opening the journal for writing (a journal that
 * cannot be read is simply "nothing recorded" here). Settings says what a failed update left running.
 * A failed update is only news to the start that settled it: one settled before `since` (when this
 * process started) is answered as nothing, so a later start stops repeating it. A later update is a
 * newer row, so it takes the failure's place.
 */
export function lastActivation(dataDir: string, since: Date): { kind: ActivationEntry["kind"]; fromVersion: string; toVersion: string; state: string } | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(join(dataDir, activationJournalName), { readOnly: true });
    const row = db.prepare("SELECT kind, from_version, to_version, state, finished_at FROM activations ORDER BY id DESC LIMIT 1").get() as Record<string, unknown> | undefined;
    if (!row) return null;
    const kind = String(row.kind), state = String(row.state);
    const settledAt = typeof row.finished_at === "string" ? Date.parse(row.finished_at) : Number.NaN;
    if (state === "failed" && !(settledAt >= since.getTime())) return null;
    return { kind: kind === "install" || kind === "rollback" ? kind : "update", fromVersion: String(row.from_version), toVersion: String(row.to_version), state };
  } catch { return null; }
  finally { db?.close(); }
}

/**
 * p17 (the never-break journal in Settings › Gateway): the newest activations, newest first, read without opening
 * the journal for writing. Only what the owner needs to read it: the kind, the two versions, how it ended and when.
 * A journal that cannot be read, or none at all, is an empty list.
 */
export function recentActivations(dataDir: string, limit = 20): { kind: string; fromVersion: string; toVersion: string; state: string; startedAt: string; finishedAt: string | null }[] {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(join(dataDir, activationJournalName), { readOnly: true });
    const rows = db.prepare("SELECT kind, from_version, to_version, state, started_at, finished_at FROM activations ORDER BY id DESC LIMIT ?")
      .all(Math.max(1, Math.min(50, Math.trunc(limit)))) as Record<string, unknown>[];
    return rows.map((row) => ({ kind: String(row.kind), fromVersion: String(row.from_version), toVersion: String(row.to_version),
      state: String(row.state), startedAt: String(row.started_at), finishedAt: typeof row.finished_at === "string" ? row.finished_at : null }));
  } catch { return []; }
  finally { db?.close(); }
}

export class ActivationJournal {
  private readonly db: DatabaseSync;
  /** Tests hand in a failure here to act out a full disk, as the task journal does. */
  failWrites: (() => Error | null) | null = null;
  constructor(readonly path: string) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000;");
      migrate(this.db, migrations, { backupTo: null });
      if (process.platform !== "win32") { try { chmodSync(path, 0o600); } catch { /* a disk that keeps no permissions must not stop this opening */ } }
    } catch (error) { this.db.close(); throw error; }
  }
  private write<T>(work: () => T): T {
    try {
      const failure = this.failWrites?.();
      if (failure) throw failure;
      return work();
    } catch (error) { throw new ActivationWriteError(error); }
  }
  /** Writes down what is about to be activated, before anything on the disk moves. */
  stage(record: ActivationRecord, at = new Date()): number {
    return this.write(() => Number(this.db.prepare(
      `INSERT INTO activations(kind,from_version,to_version,target,previous,candidate,launcher,executable_name,understood,databases,backups,state,started_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(record.kind, record.fromVersion, record.toVersion, record.target,
      JSON.stringify(record.previous), JSON.stringify(record.candidate), JSON.stringify(record.launcher),
      record.executableName, Math.trunc(record.understood), JSON.stringify(record.databases), JSON.stringify(record.backups),
      "staged", at.toISOString()).lastInsertRowid));
  }
  /**
   * The swap happened. Everything activated before this one is marked superseded in the same
   * transaction, so only the newest activation is ever the one an undo offers.
   */
  activated(id: number, at = new Date()): void {
    this.write(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("UPDATE activations SET state='superseded' WHERE state IN ('staged','activated') AND id<>?").run(id);
        this.db.prepare("UPDATE activations SET state='activated', finished_at=? WHERE id=?").run(at.toISOString(), id);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    });
  }
  /** An activation that never landed. It is not something to undo. */
  failed(id: number, at = new Date()): void {
    this.write(() => this.db.prepare("UPDATE activations SET state='failed', finished_at=? WHERE id=?").run(at.toISOString(), id));
  }
  /**
   * Takes the undo, once. The change is conditional on the entry still being the activated one, so
   * two copies of Branch running at the same time cannot both start rolling the same update back:
   * the second gets false and refuses.
   */
  claim(id: number, by: string, at = new Date()): boolean {
    return this.write(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = this.db.prepare("UPDATE activations SET state='rolling-back', claimed_by=?, finished_at=? WHERE id=? AND state='activated'")
          .run(by, at.toISOString(), id);
        this.db.exec("COMMIT");
        return Number(result.changes) === 1;
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    });
  }
  /** Gives the undo back when it refused or could not finish, so a later attempt can take it. */
  release(id: number): void {
    this.write(() => this.db.prepare("UPDATE activations SET state='activated', claimed_by=NULL WHERE id=? AND state='rolling-back'").run(id));
  }
  /**
   * The version that was just installed has migrated the saved work. The record of what to undo
   * learns which format changes ran and what the data is in now, so the gate can answer exactly
   * rather than assume the update left the data where it found it. `before` is kept from the
   * activation, because that is the shape the older version was reading.
   */
  noteMigration(id: number, change: DatabaseChange): void {
    this.write(() => {
      const entry = this.entry(id);
      if (!entry) return;
      const existing = entry.databases.find((one) => one.name === change.name);
      const merged: DatabaseChange = existing
        ? { ...change, before: existing.before, ran: [...new Set([...existing.ran, ...change.ran])].sort((a, b) => a - b) }
        : change;
      const databases = [...entry.databases.filter((one) => one.name !== change.name), merged];
      this.db.prepare("UPDATE activations SET databases=? WHERE id=?").run(JSON.stringify(databases), id);
    });
  }
  rolledBack(id: number, at = new Date()): void {
    this.write(() => this.db.prepare("UPDATE activations SET state='rolled-back', finished_at=? WHERE id=?").run(at.toISOString(), id));
  }
  /** Appends one step of an undo, before it is attempted and again with how it went. */
  step(id: number, step: string, ok: boolean, detail: string, at = new Date()): void {
    // Best effort on purpose: a step that cannot be written down must not stop the undo that is
    // already half-way, and the shapes on the disk are what `repairRollback` reads anyway.
    try { this.db.prepare("INSERT INTO activation_ledger(activation_id,at,step,ok,detail) VALUES(?,?,?,?,?)").run(id, at.toISOString(), step, ok ? 1 : 0, detail.slice(0, 4000)); }
    catch { /* see above */ }
  }
  ledger(id: number): LedgerLine[] {
    return this.db.prepare("SELECT at, step, ok, detail FROM activation_ledger WHERE activation_id=? ORDER BY id").all(id)
      .map((row) => ({ at: String(row.at), step: String(row.step), ok: Number(row.ok) === 1, detail: String(row.detail) }));
  }
  entry(id: number): ActivationEntry | null {
    const row = this.db.prepare("SELECT * FROM activations WHERE id=?").get(id);
    return row ? entryOf(row as Record<string, unknown>) : null;
  }
  /** The activation an undo would work on: the newest one that landed and has not been undone. */
  current(): ActivationEntry | null {
    const row = this.db.prepare("SELECT * FROM activations WHERE state IN ('activated','rolling-back') ORDER BY id DESC LIMIT 1").get();
    return row ? entryOf(row as Record<string, unknown>) : null;
  }
  recent(limit = 20): ActivationEntry[] {
    return this.db.prepare("SELECT * FROM activations ORDER BY id DESC LIMIT ?").all(Math.max(1, Math.trunc(limit)))
      .map((row) => entryOf(row as Record<string, unknown>));
  }
  /** Keeps the file small: rolled-back and superseded entries older than three months go. */
  prune(olderThanMs = 90 * 86_400_000): void {
    try {
      const cutoff = new Date(Date.now() - olderThanMs).toISOString();
      this.db.prepare("DELETE FROM activation_ledger WHERE activation_id IN (SELECT id FROM activations WHERE state IN ('rolled-back','superseded','failed') AND started_at < ?)").run(cutoff);
      this.db.prepare("DELETE FROM activations WHERE state IN ('rolled-back','superseded','failed') AND started_at < ?").run(cutoff);
    } catch { /* tidying never matters enough to fail over */ }
  }
  close(): void { try { this.db.close(); } catch { /* already closed */ } }
}
