import type { BrowserWindow, IpcMain, PowerMonitor } from "electron";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { UpdateDeferredError } from "./updater.js";
import { invisibleMoment, markShellUp, takeHandOver, writeHandOver } from "./shell-switch.js";
import { folderPath, pruneAppFolders, readPointer, type Layout } from "./app-folders.js";
import { daemonLauncherName } from "../install/daemon.js";
import { runKey, runValueName } from "../install/installer.js";
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
}

/**
 * After this version is in use: "start with Windows" and the background engine's launcher name this version's program
 * instead of an older one of the same install (shortcuts are refreshed at every start, windows-identity.ts). Older
 * versions go once nothing runs from them. Paths of any other program are never touched.
 */
export async function settleLayout(layout: Layout, executableName: string, dataDir: string, deps: SettleDeps = {}): Promise<{ runKey: boolean; launcher: boolean; pruned: string[] }> {
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
  const pruned = pointer && pointer.folder === layout.folder ? await (deps.prune ?? pruneAppFolders)(layout.root, pointer) : [];
  return { runKey: runKeyMoved, launcher: launcherMoved, pruned };
}

/** Whether this start follows a switch to this very version (its pointer names this folder). */
export function switchedHere(layout: Layout | null): boolean {
  if (!layout?.folder) return false;
  try { return JSON.parse(readFileSync(join(layout.root, "current.json"), "utf8"))?.folder === layout.folder; } catch { return false; }
}
