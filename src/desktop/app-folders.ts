import { randomBytes } from "node:crypto";
import { copyFile, link, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep, win32 } from "node:path";
import { z } from "zod";
import { removeTree } from "./remove-tree.js";
import { compareVersions } from "./versions.js";

/**
 * Versioned app folders (Windows): each version of Branch in a folder of its own, `<root>/app-<version>/`, beside the
 * others, and `<root>/current.json` naming the one in use and the one before it.
 *
 * - No executable is ever made: a new folder's program is a hard link to the one already in use (the same file, the
 *   stock Electron program, byte for byte), or, when Electron itself changed, a copy of Electron's own stock program
 *   checked equal to it. The program keeps the name `Branch Agent.exe`, so everything that finds Branch's processes by
 *   name (the uninstaller, the background engine's check) keeps working; its bytes are Electron's own.
 * - Nothing in use is ever written to: a new version is made beside the one running, and the switch is one rename of
 *   `current.json` (all or nothing). The gateway and its engine keep running from their folder through the switch.
 * - The version before is kept whole, so going back is the same one rename.
 * - Older folders go once nothing runs from them (a folder a process runs from cannot be renamed on Windows).
 *
 * A copy installed before this layout ("flat": the program directly in `<root>`) is the first "previous" version, named
 * by an empty folder name; its files are never removed here. Portable copies (portable.txt beside the program) keep
 * the flat layout and the old swap: their data lives beside the program.
 */
export const pointerName = "current.json";
export const appFolderPattern = /^app-[0-9A-Za-z._+-]{1,100}$/;
/** The folder a version goes in; anything a folder name may not hold is replaced. */
export const appFolderName = (version: string): string => `app-${version.replace(/[^0-9A-Za-z._+-]/g, "_").slice(0, 100)}`;

const Slot = z.object({ folder: z.union([z.literal(""), z.string().regex(appFolderPattern)]), version: z.string().min(1).max(100) }).strict();
export const PointerSchema = z.object({ folder: z.string().regex(appFolderPattern), version: z.string().min(1).max(100),
  previous: Slot.nullable(), at: z.iso.datetime() }).strict();
export type Pointer = z.infer<typeof PointerSchema>;
export type Slot = z.infer<typeof Slot>;

export interface Layout { root: string; folder: string }
/**
 * Where this copy sits, from its program's path: `<root>/app-<version>/Branch Agent.exe` (versioned), or the flat
 * `<root>/Branch Agent.exe` of a copy installed before (folder ""). Null off Windows and for a portable copy.
 */
export function versionedLayout(executablePath: string, platform: NodeJS.Platform, portable: boolean): Layout | null {
  if (platform !== "win32" || portable) return null;
  const dir = win32.dirname(executablePath), name = win32.basename(dir);
  return appFolderPattern.test(name) ? { root: win32.dirname(dir), folder: name } : { root: dir, folder: "" };
}

export const folderPath = (root: string, folder: string): string => (folder ? join(root, folder) : root);

export async function readPointer(root: string): Promise<Pointer | null> {
  try { return PointerSchema.parse(JSON.parse(await readFile(join(root, pointerName), "utf8"))); } catch { return null; }
}

/** A pointer file's text, written beside `current.json` for a rename to put in place (see `pointerFiles`). */
export const pointerText = (pointer: Pointer): string => `${JSON.stringify(PointerSchema.parse(pointer), null, 2)}\n`;

/** Puts `pointer` in place in one rename, so `current.json` is always whole. */
export async function writePointer(root: string, pointer: Pointer): Promise<void> {
  const part = join(root, `${pointerName}.${randomBytes(4).toString("hex")}.part`);
  await writeFile(part, pointerText(pointer));
  await rename(part, join(root, pointerName));
}

/**
 * The two pointers a switch needs, written ahead as whole files, so the hand-over only renames: `current.next.json`
 * (the new version in use, this one kept as the one before) and `current.rollback.json` (exactly what is in use now).
 */
export async function pointerFiles(root: string, running: Slot, next: Slot, now = new Date()): Promise<{ next: string; rollback: string; pointer: Pointer }> {
  if (!next.folder) throw new Error("A new version always goes in a folder of its own.");
  const before = await readPointer(root);
  const pointer: Pointer = { folder: next.folder, version: next.version, previous: running, at: now.toISOString() };
  const back: Pointer | null = running.folder
    ? { folder: running.folder, version: running.version, previous: before?.folder === running.folder ? before.previous : null, at: now.toISOString() }
    : null;
  const files = { next: join(root, "current.next.json"), rollback: join(root, "current.rollback.json") };
  await writeFile(files.next, pointerText(pointer));
  // Going back to a flat copy: no pointer at all, as before the first switch (its program is found without one).
  if (back) await writeFile(files.rollback, pointerText(back)); else await rm(files.rollback, { force: true });
  return { ...files, pointer };
}

/** Top-level names in a program folder that are the person's or the installer's, never Electron's runtime. */
const notRuntime = new Set(["current.json", "current.next.json", "current.rollback.json", "uninstall branch agent.cmd", "portable.txt", "branch data"]);
/**
 * The Electron runtime files in a program folder, as relative paths: every file at its top (except what is kept apart
 * above and pointer files), and everything under `locales/`. Never `resources/` (the app), `live/`, or other versions.
 */
export async function runtimeFiles(folder: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (entry.isFile() && !notRuntime.has(entry.name.toLowerCase()) && !entry.name.endsWith(".part")) out.push(entry.name);
  }
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out.push(relative(folder, path).split(sep).join("/"));
    }
  };
  await walk(join(folder, "locales"));
  return out.sort();
}

/** A hard link (the same file, nothing new written); a copy only when the two folders are on different drives. */
export async function linkOrCopy(from: string, to: string, deps: { link?: typeof link; copy?: typeof copyFile } = {}): Promise<"link" | "copy"> {
  await mkdir(dirname(to), { recursive: true });
  try { await (deps.link ?? link)(from, to); return "link"; }
  catch (error) {
    if (!["EXDEV", "EPERM", "ENOTSUP", "EMLINK"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    await (deps.copy ?? copyFile)(from, to);
    return "copy";
  }
}

/** Links the running version's Electron runtime into `into`: the program and everything beside it, never the app. */
export async function linkRuntime(running: string, into: string, executableName: string, deps?: Parameters<typeof linkOrCopy>[2]): Promise<{ files: number; copied: number }> {
  const files = await runtimeFiles(running);
  if (!files.includes(executableName)) throw new Error("The version in use has no program to share, so nothing was changed.");
  let copied = 0;
  for (const name of files) if ((await linkOrCopy(join(running, ...name.split("/")), join(into, ...name.split("/")), deps)) === "copy") copied++;
  return { files: files.length, copied };
}

/** Electron's version, from a program folder's own `version` file (Electron writes it beside the program). */
export async function runtimeVersion(folder: string): Promise<string | null> {
  const text = await readFile(join(folder, "version"), "utf8").catch(() => null);
  const version = text?.trim() ?? "";
  return /^\d+\.\d+\.\d+/.test(version) ? version : null;
}

/** Whether an app folder holds a version newer than `version`: one made and waiting for its switch is never removed. */
function newerThan(name: string, version: string): boolean {
  try { return compareVersions(name.slice("app-".length), version) > 0; } catch { return true; } // unreadable: kept, never guessed away
}

/**
 * Removes app folders that are neither in use, nor the one before, nor newer than the one in use (a version already
 * made and waiting for its moment to switch), and any half-made one. A folder something still runs from (the gateway
 * started before a switch, say) cannot be renamed on Windows, so it is left for a later look.
 */
export async function pruneAppFolders(root: string, pointer: Pointer | null, deps: { rename?: typeof rename } = {}): Promise<string[]> {
  if (!pointer) return [];
  const keep = new Set([pointer.folder, pointer.previous?.folder].filter(Boolean) as string[]);
  const removed: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const half = /\.part$/.test(entry.name) && appFolderPattern.test(entry.name.slice(0, -5));
    const trash = /^app-.*\.trash-[0-9a-f]{8}$/.test(entry.name);
    if (!half && !trash && (!appFolderPattern.test(entry.name) || keep.has(entry.name) || newerThan(entry.name, pointer.version))) continue;
    const from = join(root, entry.name), to = trash ? from : `${from.replace(/\.part$/, "")}.trash-${randomBytes(4).toString("hex")}`;
    try { if (!trash) await (deps.rename ?? rename)(from, to); }
    catch { continue; } // in use: a later look removes it
    await removeTree(to).catch(() => undefined);
    if (!(await lstat(to).catch(() => null))) removed.push(entry.name);
  }
  return removed;
}

/** The half-made folder a new version is put together in, then renamed to its own name when whole. */
export const partFolder = (root: string, version: string): string => join(root, `${appFolderName(version)}.part`);

/** Renames a whole new version into place; one already there under that name (an earlier try) is replaced unless in use. */
export async function sealAppFolder(root: string, version: string, pointer: Pointer | null): Promise<string> {
  const name = appFolderName(version), target = join(root, name);
  if (pointer && (pointer.folder === name || pointer.previous?.folder === name))
    throw new Error(`Version ${version} is already installed here, so it was not made again.`);
  if (await lstat(target).catch(() => null)) {
    const aside = `${target}.trash-${randomBytes(4).toString("hex")}`;
    await rename(target, aside); // fails when something runs from it: then nothing changes
    await removeTree(aside).catch(() => undefined);
  }
  await rename(partFolder(root, version), target);
  return target;
}


/**
 * Going back one version: `current.json` names the version before again, in one rename, and forgets it as "the one
 * before" (the version gone back from is removed by a later tidy once nothing runs from it). When the version before is
 * the flat copy from before this layout, the pointer is removed instead, as before the first switch. Answers the version
 * now in use, or null when there is no whole version before to go back to (then nothing is changed).
 */
export async function rollBackPointer(root: string, executableName: string, now = new Date()): Promise<Slot | null> {
  const pointer = await readPointer(root);
  const back = pointer?.previous;
  if (!pointer || !back) return null;
  if (!(await lstat(join(folderPath(root, back.folder), executableName)).catch(() => null))) return null;
  if (!back.folder) {
    const aside = join(root, `${pointerName}.${randomBytes(4).toString("hex")}.gone`);
    await rename(join(root, pointerName), aside);
    await rm(aside, { force: true });
    return back;
  }
  await writePointer(root, { folder: back.folder, version: back.version, previous: null, at: now.toISOString() });
  return back;
}

/** The stable launcher's package name: a flat copy whose app is this has been retired already. */
export const launcherName = "branch-agent-launcher";

/**
 * The stable launcher left in the flat copy's place (the Squirrel and VS Code pattern: shortcuts to the top of the
 * install keep working whichever version is in use). Electron's stock program at the top runs this instead of Branch:
 * it starts the version `current.json` names, with the same arguments, and ends. Plain CommonJS, nothing to import.
 */
export function launcherMain(): string {
  return `"use strict";
const { app, dialog } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { basename, dirname, join } = require("node:path");
const root = dirname(process.execPath);
app.disableHardwareAcceleration();
let target = null;
try {
  const folder = JSON.parse(readFileSync(join(root, "current.json"), "utf8")).folder;
  if (${appFolderPattern.toString()}.test(folder)) target = join(root, folder, basename(process.execPath));
} catch { target = null; }
if (target && existsSync(target)) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(target, process.argv.slice(1), { detached: true, stdio: "ignore", env }).unref();
  app.exit(0);
} else {
  app.whenReady().then(() => {
    dialog.showErrorBox("Branch Agent", "Branch Agent could not find the version to start. Install it again from its release page; your conversations are kept.");
    app.exit(1);
  });
}
`;
}

/**
 * The one-time move off the flat layout, once the flat copy is neither the version in use nor the one before (so it is
 * no longer needed to go back): its app (`resources/`, the only part that is its own; its Electron files are the same
 * files as the versions after it, hard linked) is replaced by the stable launcher above, in two renames. Anything in
 * use stops it with nothing changed, and a later tidy tries again. The uninstaller, a portable marker, `Branch Data`
 * and the pointer files are never touched. Answers whether the flat copy was retired now.
 */
export async function retireFlatCopy(root: string, pointer: Pointer | null, options: { executableName: string; icon: string | null;
  /** Whether a process runs from this program path (a gateway started from the flat copy outlives shell switches). */
  inUse: (program: string) => Promise<boolean> }, deps: { rename?: typeof rename } = {}): Promise<boolean> {
  if (!pointer || pointer.previous?.folder === "") return false;
  const program = join(root, options.executableName);
  if (!(await lstat(program).catch(() => null))) return false;
  const resources = join(root, "resources");
  const current = await readFile(join(resources, "app", "package.json"), "utf8").catch(() => null);
  if (current === null || current.includes(`"${launcherName}"`)) return false;
  if (await options.inUse(program).catch(() => true)) return false;
  const hex = randomBytes(4).toString("hex"), next = join(root, `resources.next-${hex}`), trash = join(root, `resources.trash-${hex}`);
  const app = join(next, "app");
  await mkdir(app, { recursive: true });
  await writeFile(join(app, "package.json"), `${JSON.stringify({ name: launcherName, private: true, main: "main.js" }, null, 2)}\n`);
  await writeFile(join(app, "main.js"), launcherMain());
  // The shortcuts and the Add or remove programs entry name the icon at the top's resources; it stays there.
  if (options.icon) {
    const icon = join(app, "public", "assets", "branch.ico");
    await mkdir(dirname(icon), { recursive: true });
    await copyFile(options.icon, icon).catch(() => undefined);
  }
  const move = deps.rename ?? rename;
  try { await move(resources, trash); }
  catch { await removeTree(next).catch(() => undefined); return false; } // in use: nothing changed
  try { await move(next, resources); }
  catch {
    await move(trash, resources).catch(() => undefined);
    await removeTree(next).catch(() => undefined);
    return false;
  }
  await removeTree(trash).catch(() => undefined);
  return true;
}

/** Leftovers of a retirement cut off part-way (a `resources.next-*` or `resources.trash-*` folder), removed. */
export async function tidyRetirement(root: string): Promise<void> {
  if (!(await lstat(join(root, "resources")).catch(() => null))) {
    // Cut between the two renames: the flat app is put back whole first, so the top still starts something.
    const trash = (await readdir(root).catch(() => [])).find((name) => /^resources\.trash-[0-9a-f]{8}$/.test(name));
    if (trash) await rename(join(root, trash), join(root, "resources")).catch(() => undefined);
  }
  for (const name of await readdir(root).catch(() => []))
    if (/^resources\.(next|trash)-[0-9a-f]{8}$/.test(name)) await removeTree(join(root, name)).catch(() => undefined);
}
