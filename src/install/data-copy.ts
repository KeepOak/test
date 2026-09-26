import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { backupFolder, keepBackups } from "./update-backup.js";

/**
 * A copy of the whole data folder, taken just before an update swaps the program. The safety copy beside it
 * (update-backup.ts) holds the saved work's rows only: not the device key, the task journal, the gateway's files or
 * anything else in the folder, and nothing over 64 MiB. Going to another line of work (Settings › Updates, Dev) can
 * bring a version that changes the saved work's shape, so the folder itself is kept too, and can be put back whole.
 *
 * Copies go in the updater's own folder inside the data folder (`update-backups`, which the assistant may never
 * change, src/never-break/protected.ts), newest three kept. Databases are copied with VACUUM INTO, so a copy taken
 * while Branch runs is whole; their live side files are not copied. A copy is put back only at the next start,
 * before anything opens the saved work, and what was there is moved aside beside it, never deleted.
 */
const stampPattern = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z";
export const dataCopyPattern = new RegExp(`^data-(${stampPattern})-v([0-9A-Za-z.+-]{1,60})$`);
const asidePattern = new RegExp(`^replaced-(${stampPattern})$`);
const partialSuffix = ".partial";
const markerName = "restore-data.json";
const lastName = "restored-data.json";
/** Not copied: the updater's own folders, what says what runs now, and the update record (it describes the program). */
const skipped = new Set([backupFolder, "updates", "running.json", "session-token"]);
const sideFile = /\.sqlite-(wal|shm|journal)$/;
const updateRecord = /^activation\.sqlite/;

const stampOf = (at: Date): string => at.toISOString().replace(/[:.]/g, "-");
const whenOf = (stamp: string): string => stamp.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, "T$1:$2:$3.$4Z");
const copiesDir = (dataDir: string): string => join(dataDir, backupFolder);

export function dataCopyName(version: string, at: Date): string {
  return `data-${stampOf(at)}-v${version.replace(/[^0-9A-Za-z.+-]/g, "").slice(0, 60) || "0"}`;
}

/** One database copied whole with VACUUM INTO, through a connection of its own that only reads. */
function copyDatabase(from: string, to: string): void {
  const db = new DatabaseSync(from, { readOnly: true });
  try { db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`); } finally { db.close(); }
}

/** The entries of `from` copied into `into`: databases whole, side files and the skipped names left out. */
async function copyEntries(from: string, into: string): Promise<void> {
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const name = entry.name;
    if (skipped.has(name) || sideFile.test(name) || updateRecord.test(name) || entry.isSymbolicLink()) continue;
    if (entry.isFile() && name.endsWith(".sqlite")) copyDatabase(join(from, name), join(into, name));
    else await cp(join(from, name), join(into, name), { recursive: true, errorOnExist: false, force: true });
  }
}

/** Removes the oldest of one kind of folder beyond the newest `keep`, never the one named `keepAlways`. */
async function prune(dir: string, pattern: RegExp, keep: number, keepAlways: string): Promise<string[]> {
  const mine = (await readdir(dir)).filter((name) => pattern.test(name) && name !== keepAlways).sort();
  const gone = mine.slice(0, Math.max(0, mine.length - (keep - 1)));
  for (const name of gone) await rm(join(dir, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return gone;
}

/**
 * Copies the data folder into `update-backups/data-<when>-v<version>`, and removes the oldest copies beyond three.
 * Written under a `.partial` name first, so a copy cut off half way is never offered as one to put back.
 */
export async function takeDataCopy(input: { dataDir: string; version: string; at?: Date; keep?: number }): Promise<{ name: string; path: string; pruned: string[] }> {
  const dir = copiesDir(input.dataDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = dataCopyName(input.version, input.at ?? new Date());
  const path = join(dir, name), partial = `${path}${partialSuffix}`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { mode: 0o700 });
  try {
    await copyEntries(input.dataDir, partial);
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { recursive: true, force: true }).catch(() => undefined);
    throw new Error(`The copy of the data folder could not be made (${error instanceof Error ? error.message : String(error)}).`);
  }
  return { name, path, pruned: await prune(dir, dataCopyPattern, input.keep ?? keepBackups, name) };
}

export interface DataCopy { name: string; savedAt: string; version: string }

/** The copies there are, newest first. */
export async function listDataCopies(dataDir: string): Promise<DataCopy[]> {
  const names = await readdir(copiesDir(dataDir)).catch(() => [] as string[]);
  return names.filter((name) => dataCopyPattern.test(name)).sort().reverse().map((name) => {
    const match = dataCopyPattern.exec(name)!;
    return { name, savedAt: whenOf(match[1]!), version: match[2]! };
  });
}

const MarkerSchema = z.object({ name: z.string().regex(dataCopyPattern), askedAt: z.iso.datetime() }).strict();
const LastSchema = z.object({ name: z.string().regex(dataCopyPattern), restoredAt: z.iso.datetime(), aside: z.string().regex(asidePattern) }).strict();

/** The copy the owner asked to be put back at the next start, or null. */
export async function pendingDataRestore(dataDir: string): Promise<string | null> {
  try { return MarkerSchema.parse(JSON.parse(await readFile(join(copiesDir(dataDir), markerName), "utf8"))).name; }
  catch { return null; }
}

/** The last copy put back, when, and where what was there before it went. */
export async function lastDataRestore(dataDir: string): Promise<z.infer<typeof LastSchema> | null> {
  try { return LastSchema.parse(JSON.parse(await readFile(join(copiesDir(dataDir), lastName), "utf8"))); }
  catch { return null; }
}

/** Asks for `name` to be put back at the next start; null takes the request back. */
export async function askDataRestore(dataDir: string, name: string | null, at = new Date()): Promise<void> {
  const marker = join(copiesDir(dataDir), markerName);
  if (name === null) { await rm(marker, { force: true }); return; }
  if (!dataCopyPattern.test(name) || !(await listDataCopies(dataDir)).some((copy) => copy.name === name))
    throw new Error("That is not a copy of the data folder this app made.");
  await writeFile(marker, JSON.stringify({ name, askedAt: at.toISOString() }), { mode: 0o600 });
}

/**
 * At start, before anything opens the saved work: puts back the copy the owner asked for. Everything in the data
 * folder but the updater's own folder is first moved aside into `update-backups/replaced-<when>`, then the copy's
 * files are put in. The request is taken away first, so a copy that cannot be put back is never tried at every
 * start. When copying in fails, what was moved aside goes back. Answers what happened, or null when nothing was asked.
 */
export async function applyDataRestore(dataDir: string, at = new Date()): Promise<{ restored: string; aside: string } | { failed: string } | null> {
  const name = await pendingDataRestore(dataDir);
  const dir = copiesDir(dataDir);
  await rm(join(dir, markerName), { force: true }).catch(() => undefined);
  if (!name) return null;
  const copy = join(dir, name);
  if (!(await stat(copy).then((found) => found.isDirectory(), () => false)))
    return { failed: "The copy of the data folder that was to be put back is no longer there, so nothing was changed." };
  const asideName = `replaced-${stampOf(at)}`, aside = join(dir, asideName);
  await mkdir(aside, { mode: 0o700 });
  const moved: string[] = [];
  let copying = false;
  try {
    for (const entry of await readdir(dataDir)) {
      if (entry === backupFolder) continue;
      await rename(join(dataDir, entry), join(aside, entry));
      moved.push(entry);
    }
    copying = true;
    await cp(copy, dataDir, { recursive: true, errorOnExist: false, force: true });
  } catch (error) {
    // Once copying began, everything in the folder (bar the updater's own) came from the copy: it goes. Before that,
    // what was not yet moved is the owner's and stays. Then what was moved comes back.
    if (copying)
      for (const entry of await readdir(dataDir).catch(() => [] as string[]))
        if (entry !== backupFolder) await rm(join(dataDir, entry), { recursive: true, force: true }).catch(() => undefined);
    for (const entry of moved) await rename(join(aside, entry), join(dataDir, entry)).catch(() => undefined);
    return { failed: `The copy of the data folder could not be put back (${error instanceof Error ? error.message : String(error)}), so the data folder was left as it was.` };
  }
  // What was there is kept in `replaced-<when>` and never removed by Branch: it is the owner's to keep or delete.
  await writeFile(join(dir, lastName), JSON.stringify({ name, restoredAt: at.toISOString(), aside: asideName }), { mode: 0o600 });
  return { restored: name, aside };
}

/**
 * GET /api/updates/data-copies: the copies, the one asked to be put back at the next start, and the last one put back.
 * POST { name }: asks for that copy to be put back at the next start; { name: null } takes the request back. The
 * owner's alone (a household person is refused here, a short-lived key before this is reached).
 */
export const dataCopiesPath = "/api/updates/data-copies";
const AskSchema = z.object({ name: z.string().regex(dataCopyPattern).nullable() }).strict();
export async function dataCopyApi(input: { requireOwner: (what: string) => void; dataDir: string; method: string; readBody: () => Promise<unknown> }): Promise<unknown> {
  input.requireOwner("Copies of the data folder");
  if (input.method === "POST") await askDataRestore(input.dataDir, AskSchema.parse(await input.readBody()).name);
  else if (input.method !== "GET") throw new Error(`Use GET or POST for ${dataCopiesPath}`);
  const pending = await pendingDataRestore(input.dataDir);
  return {
    copies: await listDataCopies(input.dataDir), pending, last: await lastDataRestore(input.dataDir),
    ...(input.method === "POST" && pending ? { message: "This copy is put back the next time Branch starts, before your work is opened, and what is in the data folder now is kept beside it. Quit Branch, including the part that keeps working in the background, then open it again." } : {}),
  };
}
