import type { BrowserWindow, IpcMain, PowerMonitor } from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UpdateDeferredError } from "./updater.js";
import { invisibleMoment, markShellUp, takeHandOver, writeHandOver } from "./shell-switch.js";
import { folderPath, PointerSchema, pruneAppFolders, readPointer, retireFlatCopy, tidyRetirement, type Layout, type Pointer } from "./app-folders.js";
import { programInUse } from "./program-in-use.js";
import { daemonLauncherName } from "../install/daemon.js";
import { runKey, runValueName, shippedIconPath } from "../install/installer.js";
import { readRegistryValue, writeRegistryValues } from "../install/windows.js";

/**
 * The window's side of a shell switch with versioned app folders (shell-switch.ts), in main.
 *
 * Old version: `handOverHook` waits for the invisible moment, takes what the page has open, and writes it where the new
 * version finds it. New version: `resumeWindow` hands that to its first page (through the preload, before any of the
 * page's scripts run), waits for the page to say it put everything back and drew it, and only then says its window is
 * up; `settleLayout` points the shortcuts, "start with Windows" and the background engine's launcher at this version,
 * and removes versions nothing uses any more.
 */
export const shellKeptChannel = "branch:shell-kept";

type Win = Pick<BrowserWindow, "isVisible" | "isMinimized" | "isDestroyed" | "isFocused"> & { webContents: Pick<BrowserWindow["webContents"], "executeJavaScript"> };

/** What the page has open, as text; "" when the page has no such record (not loaded yet), null while it must wait. */
async function keptByPage(window: Win | null): Promise<string | null> {
  if (!window || window.isDestroyed()) return "";
  const kept: unknown = await window.webContents.executeJavaScript("window.branchKeepForShell ? window.branchKeepForShell() : ''", true).catch(() => "");
  return typeof kept === "string" ? kept : kept === null ? null : "";
}

/** `window` answers the window open now, or null: with none open (a start in the tray), any moment is invisible. */
export function handOverHook(options: { window: () => Win | null; userData: string; power: Pick<PowerMonitor, "getSystemIdleState">; pollMs?: number;
  sleep?: (ms: number) => Promise<void> }) {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  return async (target: { version: string; stillWanted?: () => boolean }): Promise<{ minimized: boolean }> => {
    for (;;) {
      if (target.stillWanted && !target.stillWanted()) throw new UpdateDeferredError("The update was called off before it took over.");
      const found = options.window(), window = found && !found.isDestroyed() ? found : null;
      const idle = options.power.getSystemIdleState(120);
      const visible = !!window?.isVisible(), minimized = !!window?.isMinimized(), focused = !!window?.isFocused();
      if (invisibleMoment({ visible, minimized, focused, idle })) {
        const kept = await keptByPage(window);
        if (kept !== null) {
          await writeHandOver(options.userData, { version: target.version, visible: visible && !minimized, at: new Date().toISOString(), kept: kept || null });
          return { minimized: !visible || minimized };
        }
      }
      await sleep(options.pollMs ?? 2000);
    }
  };
}

/**
 * The new version's first window after a switch. Call before the page loads: the preload asks for what was kept once,
 * and the restore it leads to is armed. Answers a function to call once the page has loaded, which waits for the
 * restore (bounded by the live window's own wait) and then says the window is up for the switch script.
 */
export async function resumeWindow(options: { ipc: Pick<IpcMain, "on" | "removeAllListeners">; window: Pick<BrowserWindow, "webContents">; origin: string;
  userData: string; version: string; scratchDir: string; expectRestore: (token: string) => Promise<boolean> }): Promise<() => Promise<void>> {
  const handOver = await takeHandOver(options.userData, options.version);
  let pending: string | null = null, restored: Promise<boolean | null> = Promise.resolve(null);
  if (handOver?.kept) {
    try {
      const token = `shell-${randomUUID()}`;
      // The page's own record, with the token its restore answers with, dated now so it is never taken for a stale one.
      pending = JSON.stringify({ ...JSON.parse(handOver.kept), commit: token, at: Date.now() });
      restored = options.expectRestore(token);
    } catch { pending = null; }
  }
  options.ipc.removeAllListeners(shellKeptChannel);
  options.ipc.on(shellKeptChannel, (event) => {
    let origin = "";
    try { origin = new URL(event.senderFrame?.url ?? "").origin; } catch { origin = ""; }
    event.returnValue = event.sender === options.window.webContents && origin === options.origin ? pending : null;
    if (event.returnValue !== null) pending = null;
  });
  return async () => {
    await markShellUp(options.scratchDir, options.version, process.pid, await restored);
  };
}

/**
 * A start with no window (in the tray, the window made only when the owner opens it): this version is up once main is
 * ready and its engine answers, so the switch script keeps it. What the old window had open waits for the first window
 * (resumeWindow takes it then, for as long as a hand-over is kept).
 */
export async function shellUpWithoutWindow(options: { scratchDir: string; version: string }): Promise<void> {
  await markShellUp(options.scratchDir, options.version, process.pid, null);
}

/** Old program folders a persisted path may still name: the flat copy and every app-<version> in this root. */
export function sameInstall(root: string, path: string): boolean {
  const norm = (value: string) => value.replace(/\//g, "\\").toLowerCase();
  const inside = norm(path), base = norm(root).replace(/\\$/, "");
  if (!inside.startsWith(`${base}\\`)) return false;
  const rest = inside.slice(base.length + 1);
  return !rest.includes("\\") || /^app-[0-9a-z._+-]+\\[^\\]+$/.test(rest);
}

export interface SettleDeps {
  readRegistry?: typeof readRegistryValue;
  writeRegistry?: typeof writeRegistryValues;
  readText?: (path: string) => Promise<string | null>;
  writeText?: (path: string, text: string) => Promise<void>;
  prune?: typeof pruneAppFolders;
  retire?: typeof retireFlatCopy;
  inUse?: (program: string) => Promise<boolean>;
}

/**
 * After this version is in use: "start with Windows" and the background engine's launcher name this version's program
 * instead of an older one of the same install (shortcuts are refreshed at every start, windows-identity.ts). Older
 * versions go once nothing runs from them. Paths of any other program are never touched.
 */
export async function settleLayout(layout: Layout, executableName: string, dataDir: string, deps: SettleDeps = {}): Promise<{ runKey: boolean; launcher: boolean; pruned: string[]; retired: boolean }> {
  const program = join(folderPath(layout.root, layout.folder), executableName);
  const readRegistry = deps.readRegistry ?? readRegistryValue, writeRegistry = deps.writeRegistry ?? writeRegistryValues;
  let runKeyMoved = false, launcherMoved = false;
  const command = await readRegistry(runKey, runValueName).catch(() => null);
  const named = command ? /^"([^"]+)"(.*)$/.exec(command) : null;
  if (named && sameInstall(layout.root, named[1]!) && named[1]!.toLowerCase() !== program.toLowerCase()) {
    await writeRegistry(runKey, [{ name: runValueName, type: "REG_SZ", value: `"${program}"${named[2]}` }]);
    runKeyMoved = true;
  }
  const launcher = join(dataDir, daemonLauncherName);
  const readText = deps.readText ?? ((path: string) => readFile(path, "utf8").catch(() => null));
  const text = await readText(launcher);
  const quoted = text ? /""([^"]+?\\Branch Agent\.exe)""/i.exec(text) : null; // inside the script host's doubled quotes
  if (text && quoted && sameInstall(layout.root, quoted[1]!) && quoted[1]!.toLowerCase() !== program.toLowerCase()) {
    const oldFolder = quoted[1]!.slice(0, -executableName.length - 1), newFolder = folderPath(layout.root, layout.folder);
    await (deps.writeText ?? ((path: string, body: string) => writeFile(path, body, "utf8")))(launcher, text.split(oldFolder).join(newFolder));
    launcherMoved = true;
  }
  const pointer = await readPointer(layout.root);
  const settled = pointer !== null && pointer.folder === layout.folder;
  const pruned = settled ? await (deps.prune ?? pruneAppFolders)(layout.root, pointer) : [];
  // The one-time move off the flat layout: once the flat copy is not needed to go back, its app becomes the stable
  // launcher (app-folders.ts, retireFlatCopy). Only after the shortcuts, the Run key and the engine's launcher above
  // name this version, so nothing still starts the flat app itself.
  let retired = false;
  if (settled) {
    await tidyRetirement(layout.root);
    retired = await (deps.retire ?? retireFlatCopy)(layout.root, pointer, { executableName,
      icon: join(folderPath(layout.root, layout.folder), shippedIconPath), inUse: deps.inUse ?? ((program) => programInUse(program)) });
  }
  return { runKey: runKeyMoved, launcher: launcherMoved, pruned, retired };
}

/** Whether this start follows a switch to this very version (its pointer names this folder). */
export function switchedHere(layout: Layout | null): boolean {
  if (!layout?.folder) return false;
  try { return JSON.parse(readFileSync(join(layout.root, "current.json"), "utf8"))?.folder === layout.folder; } catch { return false; }
}

/** Set on a start forwarded to the version in use, so that one never forwards again (no loop, whatever the disk says). */
export const forwardedVariable = "BRANCH_FORWARDED_FROM";

/**
 * A start of a version that is not the one `current.json` names (a shortcut, the taskbar or "start with Windows" still
 * naming an older folder, or the version before after a switch with no window open): the program of the version in use,
 * to start in its place, or null to start this one. Only another version of this same install is ever named.
 */
export function forwardTarget(layout: Layout | null, executableName: string, env: NodeJS.ProcessEnv,
  deps: { readText: (path: string) => string | null; exists: (path: string) => boolean }): { program: string; version: string } | null {
  if (!layout || env[forwardedVariable]) return null;
  let pointer: Pointer | null = null;
  try { pointer = PointerSchema.parse(JSON.parse(deps.readText(join(layout.root, "current.json")) ?? "null")); } catch { pointer = null; }
  if (!pointer || pointer.folder === layout.folder) return null;
  const program = join(layout.root, pointer.folder, executableName);
  return deps.exists(program) ? { program, version: pointer.version } : null;
}

export interface ForwardDeps {
  /** Starts the program with this start's own arguments; answers its process id. */
  start: (program: string) => number | null;
  /** Whether that version has said its window is up, now or ever before (`shellUpMarker`, written at every window start). */
  up: (version: string) => boolean;
  /** Ends one process, with what it started, by its id. */
  end: (pid: number) => Promise<void>;
  /** Whether the version doing the forwarding can still read the saved work (version-switch.ts, goingBackIsSafe). */
  safe: () => Promise<boolean>;
  /** One rename of `current.json` back to the version before (app-folders.ts, rollBackPointer); false when there is none. */
  rollBack: () => Promise<boolean>;
  /** Leaves the note this version reads once it is up (shell-switch.ts, SwitchFailure). */
  tell: (tried: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  upSeconds?: number;
}

/**
 * Forwarding a start to the version in use, guarded. A version that has had a window up before is simply started. One
 * that never has (put in use by the gateway with no window open, so nothing watched it) is watched here the way the
 * switch watches it: if its window does not come up in time, that process is ended and, when the saved work allows it,
 * the pointer goes back and this version starts as itself ("went-back"), so a broken update can never leave Branch
 * unable to open. Answers "forwarded" (this start ends) or "went-back" (this start goes on as itself).
 */
export async function guardedForward(target: { program: string; version: string }, deps: ForwardDeps): Promise<"forwarded" | "went-back"> {
  const confirmed = deps.up(target.version);
  const pid = deps.start(target.program);
  if (confirmed) return "forwarded";
  for (let waited = 0; waited < (deps.upSeconds ?? 120); waited++) {
    if (deps.up(target.version)) return "forwarded";
    await deps.sleep(1000);
  }
  if (deps.up(target.version)) return "forwarded";
  if (pid) await deps.end(pid).catch(() => undefined);
  // Not safe for the saved work, or no version before: the version in use is started once more rather than this one.
  if (!(await deps.safe()) || !(await deps.rollBack())) { deps.start(target.program); return "forwarded"; }
  await deps.tell(target.version).catch(() => undefined);
  return "went-back";
}
