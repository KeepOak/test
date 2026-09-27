import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { RunArtifacts } from "./artifacts.js";
import { folderFor } from "./attachments.js";
import type { createBranch } from "./index.js";
import { backupFolder } from "./install/update-backup.js";
import { lockdownActive } from "./lockdown.js";
import { memoryProviderSettings, stillHeld } from "./memory-provider.js";

/**
 * Settings › Your data, Delete everything, "for good" (the half that cannot be one database transaction). The purge
 * itself commits in one transaction together with a journal row naming what is left to do outside the database: the
 * files, the facts on an outside memory service, the memory notes, the memory history, the update safety copies and
 * the database's own leftovers. Each step can be run again, and the row stays until every step is done, so a delete
 * cut short finishes the next time Branch starts or the next time the person presses Delete everything.
 * Nothing leaves this computer under Lockdown: the outside service and the history's copy wait until it is off.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
type Step = "files" | "outside" | "notes" | "history" | "copies" | "tidy";
export const steps: readonly Step[] = ["files", "outside", "notes", "history", "copies", "tidy"];
export interface Journal {
  id: string; scope: string; sessions: string[]; runIds: string[];
  outside: { url: string; pending: string[] } | null;
  history: boolean; done: Step[]; removed: string[]; waiting: string[];
}
/** The conversation and memory tables a delete empties, in any copy of the database. Never memory_outside_forgotten. */
export const personTables = ["memory", "memory_archive", "memory_versions", "memory_proposals", "memory_checkpoints", "memory_terms",
  "memory_vectors", "memory_uses", "memory_suppressions", "tasks", "sessions"] as const;

const table = "your_data_deletes";
function ensure(app: Branch): void {
  app.store.sqlite.exec(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY, scope TEXT NOT NULL, data TEXT NOT NULL,
    finished INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
}
/** Writes a new journal row: call it inside the delete's own transaction, so it commits with the purge or not at all. */
export function openJournal(app: Branch, input: Omit<Journal, "id" | "done" | "removed" | "waiting">, removed: string[]): Journal {
  ensure(app);
  const journal: Journal = { ...input, id: randomUUID(), done: [], removed, waiting: [] };
  const now = new Date().toISOString();
  app.store.sqlite.prepare(`INSERT INTO ${table} VALUES(?,?,?,0,?,?)`).run(journal.id, journal.scope, JSON.stringify(journal), now, now);
  return journal;
}
function save(app: Branch, journal: Journal): void {
  const finished = steps.every((step) => journal.done.includes(step)) ? 1 : 0;
  app.store.sqlite.prepare(`UPDATE ${table} SET data=?, finished=?, updated_at=? WHERE id=?`)
    .run(JSON.stringify(journal), finished, new Date().toISOString(), journal.id);
}
/** This person's deletes that have steps left, oldest first. */
export function unfinished(app: Branch, scope?: string): Journal[] {
  ensure(app);
  const rows = (scope === undefined
    ? app.store.sqlite.prepare(`SELECT data FROM ${table} WHERE finished=0 ORDER BY created_at`).all()
    : app.store.sqlite.prepare(`SELECT data FROM ${table} WHERE finished=0 AND scope=? ORDER BY created_at`).all(scope)) as { data: string }[];
  return rows.map((row) => JSON.parse(row.data) as Journal);
}
/** The sentence the page shows while a delete of this person's still has steps left, or null. */
export function unfinishedSentence(app: Branch, scope: string): string | null {
  const left = unfinished(app, scope);
  return left.length
    ? `Delete everything has not finished yet: ${left.flatMap((journal) => journal.waiting).join(" ") || "some steps are still to do."} It finishes the next time Branch starts, or press Delete everything again.`
    : null;
}

const words = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const hostOf = (url: string): string => { try { return new URL(url).host; } catch { return url; } };
const locked = (app: Branch): boolean => lockdownActive(app.store, app.runtime.owner);

/** Runs every step not done yet. Never throws; what is still to do is kept in `waiting`. */
export async function finish(app: Branch, journal: Journal): Promise<Journal> {
  journal.waiting = [];
  for (const step of steps) {
    if (journal.done.includes(step)) continue;
    try {
      const outcome = await run(app, journal, step);
      if (outcome.removed) journal.removed.push(outcome.removed);
      if (outcome.waiting) journal.waiting.push(outcome.waiting); else journal.done.push(step);
    } catch (error) {
      journal.waiting.push(`${failed[step]} (${words(error)}).`);
    }
    try { save(app, journal); } catch { return journal; } // the app is closing; the row says where it got to
  }
  return journal;
}
const failed: Record<Step, string> = {
  files: "The files of the deleted conversations could not all be removed",
  outside: "The outside memory service could not be asked to delete them",
  notes: "The memory notes in your workspace could not be written again",
  history: "The history of what is remembered could not be started again",
  copies: "The update safety copies could not all be made again without them",
  tidy: "The database could not clear the space the deleted things used",
};
type Outcome = { removed?: string; waiting?: string };

async function run(app: Branch, journal: Journal, step: Step): Promise<Outcome> {
  switch (step) {
    case "files": return removeFiles(app, journal);
    case "outside": return forgetOutside(app, journal);
    case "notes": return rewriteNotes(app, journal);
    case "history": return rewriteHistory(app, journal);
    case "copies": return scrubCopies(app, journal);
    case "tidy": return tidy(app);
  }
}

async function removeFiles(app: Branch, journal: Journal): Promise<Outcome> {
  const root = join(app.store.folder, "attachments");
  for (const id of journal.sessions)
    for (const temporary of [false, true]) await rm(join(root, folderFor(id, temporary)), { recursive: true, force: true, maxRetries: 3 });
  app.store.runFiles.forget(journal.runIds);
  return {};
}

async function forgetOutside(app: Branch, journal: Journal): Promise<Outcome> {
  const outside = journal.outside;
  if (!outside || !outside.pending.length) return {};
  if (locked(app)) return { waiting: "Lockdown is on, so the facts on the outside memory service are deleted once it is off." };
  const before = outside.pending.length;
  const notRemoved = await app.memory.backend.forgetOutsideAt(journal.scope, outside.url, outside.pending);
  outside.pending = notRemoved.map((entry) => entry.id);
  const gone = before - outside.pending.length;
  const removed = gone ? `${gone === 1 ? "One fact" : `${gone} facts`} on the outside memory service at ${hostOf(outside.url)}.` : undefined;
  if (!outside.pending.length) return removed ? { removed } : {};
  const changed = memoryProviderSettings(app.store, journal.scope).url !== outside.url;
  return { ...(removed ? { removed } : {}), waiting: changed
    ? `The outside memory service was changed, so ${outside.pending.length === 1 ? "one fact" : `${outside.pending.length} facts`} waiting to be deleted at ${hostOf(outside.url)} ${outside.pending.length === 1 ? "is" : "are"} not sent anywhere else. Switch back to it to finish.`
    : stillHeld(outside.pending.length) };
}

async function rewriteNotes(app: Branch, journal: Journal): Promise<Outcome> {
  if (!await app.memoryMirror.exists().catch(() => false)) return {};
  await app.memoryMirror.regenerate(journal.scope, { force: true });
  return { removed: "The memory notes in your workspace, written again without them." };
}

async function rewriteHistory(app: Branch, journal: Journal): Promise<Outcome> {
  if (!journal.history || !await app.memoryHistory.kept()) return {};
  const remote = app.memoryHistory.settings(journal.scope).remote;
  const push = !!remote && !locked(app);
  const { pushed } = await app.memoryHistory.rewrite(journal.scope, push);
  const here = "The history of what is remembered, started again without them";
  if (remote && !pushed) return { removed: `${here} on this computer.`, waiting: `Lockdown is on, so the copy of that history at ${hostOf(remote)} is replaced once it is off.` };
  return { removed: pushed ? `${here}, here and at ${hostOf(remote!)}. That service may still keep old versions it no longer shows.` : `${here}.` };
}

/** The database's own leftovers: the space the deleted rows used is cleared and its side file emptied. */
async function tidy(app: Branch): Promise<Outcome> {
  app.store.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return {};
}

/* ---------- The update safety copies: made again without the person's conversations and memory ---------- */

async function scrubCopies(app: Branch, journal: Journal): Promise<Outcome> {
  const dir = join(app.store.folder, backupFolder);
  const names = await readdir(dir).catch(() => [] as string[]);
  let made = 0, waiting = false;
  for (const name of names) {
    const path = join(dir, name);
    if (name.endsWith(".partial")) { waiting = true; continue; }
    if (/^before-format-\d+\.sqlite$/.test(name)) { scrubDatabase(path, journal.scope); made++; continue; }
    if (/^before-.+\.json$/.test(name)) { await scrubArchive(path, journal.scope); made++; continue; }
    if (/^(data|replaced)-/.test(name) && (await stat(path)).isDirectory()) { await scrubFolder(path, journal); made++; }
  }
  return {
    ...(made ? { removed: `${made === 1 ? "One update safety copy" : `${made} update safety copies`}, made again without them.` } : {}),
    ...(waiting ? { waiting: "An update safety copy was still being taken, so it is made again without them the next time Branch starts." } : {}),
  };
}

/**
 * One database file of a copy, opened on its own (never through the store, which would change its shape and break
 * going back to the version it belongs to): the person's conversations, their tasks and everything naming them, and
 * their memory, deleted; then the file rewritten so nothing deleted is left in its free space.
 */
export function scrubDatabase(path: string, scope: string): { sessions: string[]; runs: string[] } {
  const db = new DatabaseSync(path);
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((row) => row.name);
    const has = (name: string) => tables.includes(name);
    const columns = (name: string) => (db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).map((row) => row.name);
    const sessions = has("sessions") ? (db.prepare("SELECT id FROM sessions WHERE owner=?").all(scope) as { id: string }[]).map((row) => row.id) : [];
    const runs = has("tasks") ? (db.prepare(`SELECT id FROM tasks WHERE owner=? OR session_id IN (SELECT value FROM json_each(?))`)
      .all(scope, JSON.stringify(sessions)) as { id: string }[]).map((row) => row.id) : [];
    db.exec("PRAGMA secure_delete=ON");
    db.exec("BEGIN");
    try {
      db.exec("PRAGMA defer_foreign_keys=ON"); // tables are emptied in any order; the links are checked at the commit
      const S = JSON.stringify(sessions), R = JSON.stringify(runs);
      for (const name of tables) {
        const has2 = columns(name);
        if (has2.includes("session_id")) db.prepare(`DELETE FROM "${name}" WHERE session_id IN (SELECT value FROM json_each(?))`).run(S);
        if (has2.includes("run_id")) db.prepare(`DELETE FROM "${name}" WHERE run_id IN (SELECT value FROM json_each(?))`).run(R);
      }
      if (has("memory_search") && has("memory_terms"))
        db.prepare("DELETE FROM memory_search WHERE rowid IN (SELECT row_id FROM memory_terms WHERE owner=?)").run(scope);
      for (const name of personTables) if (has(name)) db.prepare(`DELETE FROM "${name}" WHERE owner=?`).run(scope);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    if (has("memory_search")) db.exec("INSERT INTO memory_search(memory_search) VALUES('optimize')");
    db.exec("VACUUM");
    return { sessions, runs };
  } finally { db.close(); }
}

/** A row archive (before-*.json): the same rows left out, written to a new file that then takes the old one's place. */
async function scrubArchive(path: string, scope: string): Promise<void> {
  const archive = JSON.parse(await readFile(path, "utf8")) as { tables?: Record<string, Record<string, unknown>[]> };
  const tables = archive.tables ?? {};
  const sessions = new Set((tables.sessions ?? []).filter((row) => row.owner === scope).map((row) => String(row.id)));
  const runs = new Set((tables.tasks ?? []).filter((row) => row.owner === scope || sessions.has(String(row.session_id))).map((row) => String(row.id)));
  const person = new Set<string>(personTables);
  for (const [name, rows] of Object.entries(tables))
    tables[name] = rows.filter((row) => !(sessions.has(String(row.session_id ?? "")) || runs.has(String(row.run_id ?? ""))
      || (person.has(name) && row.owner === scope) || (name === "sessions" && sessions.has(String(row.id)))));
  const temporary = `${path}.scrub`;
  await writeFile(temporary, JSON.stringify(archive), { mode: 0o600 });
  await rename(temporary, path);
}

/** A whole copy of the data folder: its database scrubbed, and the person's attachments, task files and history removed. */
async function scrubFolder(folder: string, journal: Journal): Promise<void> {
  const database = join(folder, "branch.sqlite");
  const found = existsSync(database) ? scrubDatabase(database, journal.scope) : { sessions: [], runs: [] };
  const sessions = [...new Set([...found.sessions, ...journal.sessions])], runs = [...new Set([...found.runs, ...journal.runIds])];
  for (const id of sessions)
    for (const temporary of [false, true]) await rm(join(folder, "attachments", folderFor(id, temporary)), { recursive: true, force: true, maxRetries: 3 });
  new RunArtifacts(join(folder, "artifacts")).forget(runs);
  if (journal.history) await rm(join(folder, "memory-history"), { recursive: true, force: true, maxRetries: 3 });
}
