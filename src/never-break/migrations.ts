import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync as DatabaseSyncClass, type DatabaseSync } from "node:sqlite";

/**
 * Versioned changes to a database's shape. Each change has a way back, and says the oldest data
 * format that can still read the result, so an update can go back one release without losing the
 * owner's work. The rules, in docs/never-break.md:
 *
 * - a change adds; it never renames or drops what the previous release reads, so for most changes
 *   "the way back" is to leave the extra column alone, and `readableBy` stays the old number;
 * - a copy is taken before any change runs (`VACUUM INTO`), and the change runs in one transaction;
 * - a program that finds data newer than it can read stops with a sentence instead of touching it.
 */
export interface Migration {
  version: number;
  /** The oldest format that can still read data at this version. */
  readableBy: number;
  up(db: DatabaseSync): void;
  down(db: DatabaseSync): void;
}

export class DataTooNewError extends Error {
  constructor(readonly found: number, readonly readableBy: number, readonly understood: number) {
    super(`Your saved work was last opened by a newer version of Branch (data format ${found}), which this version (format ${understood}) cannot read safely. Nothing was changed. Install the newer version again, or go back to the copy taken before the update.`);
  }
}

const formatTable = "CREATE TABLE IF NOT EXISTS branch_format(id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, readable_by INTEGER NOT NULL, changed_at TEXT NOT NULL)";

export function formatOf(db: DatabaseSync): { version: number; readableBy: number } {
  const version = Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='branch_format'").get();
  const row = table ? db.prepare("SELECT readable_by FROM branch_format WHERE id=1").get() as { readable_by: number } | undefined : undefined;
  return { version, readableBy: row ? Number(row.readable_by) : version };
}

function stamp(db: DatabaseSync, version: number, readableBy: number): void {
  db.exec(formatTable);
  db.prepare("INSERT INTO branch_format(id,version,readable_by,changed_at) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, readable_by=excluded.readable_by, changed_at=excluded.changed_at")
    .run(version, readableBy, new Date().toISOString());
  db.exec(`PRAGMA user_version=${Math.trunc(version)}`);
}

export interface MigrateOptions {
  /** Where to write the copy taken first; null when the caller took one already or the data is disposable. */
  backupTo: string | null;
}
export interface MigrateReport { from: number; to: number; backup: string | null }

/** Brings a database up to the newest version this program knows, or refuses data it cannot read. */
export function migrate(db: DatabaseSync, list: Migration[], options: MigrateOptions): MigrateReport {
  const ordered = [...list].sort((a, b) => a.version - b.version);
  const newest = ordered.at(-1)?.version ?? 0;
  const found = formatOf(db);
  if (found.version > newest) {
    if (found.readableBy > newest) throw new DataTooNewError(found.version, found.readableBy, newest);
    return { from: found.version, to: found.version, backup: null };
  }
  const pending = ordered.filter((step) => step.version > found.version);
  if (!pending.length) return { from: found.version, to: found.version, backup: null };
  let backup: string | null = null;
  if (options.backupTo && found.version > 0) {
    if (existsSync(options.backupTo)) throw new Error(`A copy is already waiting at ${options.backupTo}; move it before trying again.`);
    // mac7/install-torture: the copy is taken first, so a disk with no room, or an `update-backups`
    // that is not a folder any more, must stop the change in plain words rather than SQLite's.
    try { db.exec(`VACUUM INTO '${options.backupTo.replace(/'/g, "''")}'`); }
    catch (error) {
      throw new Error(`Branch could not take the copy of your saved work that it takes before changing its shape, so nothing was changed. It tried to write it to ${options.backupTo}. Free some space on this disk, or move anything that is in the way out of the \`update-backups\` folder beside your data, and start Branch again.`);
    }
    backup = options.backupTo;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const step of pending) step.up(db);
    const last = pending.at(-1)!;
    stamp(db, last.version, last.readableBy);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { from: found.version, to: newest, backup };
}

/** Takes a database back to an earlier version, running each change's way back, newest first. */
export function migrateDown(db: DatabaseSync, list: Migration[], to: number): MigrateReport {
  const found = formatOf(db);
  const undo = [...list].filter((step) => step.version > to && step.version <= found.version).sort((a, b) => b.version - a.version);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const step of undo) step.down(db);
    const kept = [...list].filter((step) => step.version <= to).sort((a, b) => a.version - b.version).at(-1);
    stamp(db, to, kept?.readableBy ?? to);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { from: found.version, to, backup: null };
}

/**
 * The saved-work database's own format. Version 1 is everything Branch wrote before formats were
 * numbered: the store creates and extends its own tables, only ever adding, so there is nothing to
 * run in either direction. Later changes are added here with their way back.
 */
export const storeMigrations: Migration[] = [
  { version: 1, readableBy: 1, up: () => undefined, down: () => undefined },
];

/* ---------- looking at the saved work before anything opens it (mac7/install-torture) ---------- */

/**
 * What is wrong with a saved-work file, in words the owner can act on. The raw words SQLite uses
 * ("database disk image is malformed", "attempt to write a readonly database", "file is not a
 * database") say nothing about which file, whether anything was lost, or what to do next.
 */
/** SQLite's own numbers for what went wrong, which are steadier than the words it puts with them. */
const sqliteCode = (error: unknown): number =>
  typeof (error as { errcode?: unknown }).errcode === "number" ? (error as { errcode: number }).errcode : 0;
/** The low byte carries the family: 8 is read-only, 11 corrupt, 13 full, 14 cannot open, 26 not a database. */
const family = (error: unknown): number => sqliteCode(error) & 0xff;

/**
 * What the owner can do about damaged saved work. QA retest 2026-09-28 (TRUNK-180): it always said "your last three
 * safety copies are in `update-backups`", also when no update had ever made one and the folder did not exist.
 */
function safetyCopies(path: string): string {
  let copies: string[] = [];
  try { copies = readdirSync(join(dirname(path), "update-backups")).filter((name) => /^data-|\.sqlite$/.test(name)); } catch { /* none yet */ }
  return copies.length
    ? "Your last safety copies are in the `update-backups` folder beside it; `branch restore` puts one back."
    : "Branch has made no safety copy of it yet (one is made before each update). To start again with nothing saved, move this file somewhere else and start Branch.";
}

export function dataProblemSentence(path: string, error: unknown): string | null {
  const why = (error instanceof Error ? error.message : String(error)).toLowerCase();
  const kind = family(error);
  const restore = safetyCopies(path);
  // The order matters: a disk with no room left and a folder that has gone can both come back as
  // "unable to open database file", and neither is a permissions problem to send the owner chasing.
  if (kind === 13 || /database or disk is full|no space|disk full/.test(why))
    return `Branch could not write its saved work at ${path}: this disk has no room left. Nothing was changed. Free some space, or move Branch's folder to a disk that has room, and start Branch again.`;
  if (kind === 11 || kind === 26 || /malformed|not a database|encrypted|corrupt/.test(why))
    return `Branch's saved work at ${path} is damaged and cannot be opened, so nothing was changed. ${restore}`;
  if (kind === 8 || /readonly|read-only/.test(why))
    return `Branch cannot write to its saved work at ${path}. Nothing was changed. Check that you are allowed to write to the folder it is in (on a Mac, select it in Finder and press Command-I), then start Branch again.`;
  if (kind === 14 || /unable to open database|permission denied|no such file/.test(why))
    return `Branch could not open its saved work at ${path}, so nothing was changed. The folder may have been moved, renamed or taken off this computer, the disk may be full, or you may not be allowed to read it. Put the folder back, or free some space, and start Branch again.`;
  return null;
}

/**
 * True when another Branch is holding the file, rather than the file itself being wrong. SQLite's
 * own numbers are used, not its words: 5 is busy and 6 is locked, and nothing else means "wait".
 */
const heldByAnother = (error: unknown): boolean => [5, 6].includes(family(error));

/** Wraps whatever went wrong while the saved work was being opened in a sentence a person can act on. */
export function dataOpenError(path: string, error: unknown): Error {
  if (error instanceof DataTooNewError) return error;
  const sentence = dataProblemSentence(path, error);
  return sentence ? new Error(sentence) : (error instanceof Error ? error : new Error(String(error)));
}

/**
 * The format check that must happen BEFORE the saved work is opened for writing. Opening it first
 * and checking afterwards means an older Branch has already added columns, rewritten tasks that
 * were running and thrown temporary sessions away by the time it says "Nothing was changed".
 * This reads the file only, and leaves it exactly as it was.
 */
export function assertFormatReadable(path: string, list: Migration[] = storeMigrations): void {
  if (!existsSync(path)) return;
  const newest = [...list].sort((a, b) => a.version - b.version).at(-1)?.version ?? 0;
  let found: { version: number; readableBy: number };
  let db: DatabaseSync;
  try { db = new DatabaseSyncClass(path, { readOnly: true }); }
  catch (error) {
    // A Branch that is already open holds the file to itself; that is not damage, and the store's
    // own refusal says it better, so this check steps aside.
    if (heldByAnother(error)) return;
    throw dataOpenError(path, error);
  }
  try { found = formatOf(db); }
  catch (error) {
    if (heldByAnother(error)) return;
    throw dataOpenError(path, error);
  }
  finally { try { db.close(); } catch { /* already gone */ } }
  if (found.version > newest && found.readableBy > newest) throw new DataTooNewError(found.version, found.readableBy, newest);
}
