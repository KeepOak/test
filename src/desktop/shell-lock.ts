import { processAlive as running } from "../install/process-alive.js";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * One Branch window per data folder. Electron's own single-instance lock is kept per program settings folder
 * (userData), so two copies of Branch that share a data folder (a portable copy and an installed one, two installs, a
 * launch with BRANCH_DATA_DIR) would both open it: two apps working on one person's saved work. The first to start takes
 * `shell.lock` in the data folder (its process id); a second waits a few seconds, in case the first is just quitting (a
 * restart, an update's hand-over), then leaves without touching anything. A lock whose process is gone is taken over.
 */
export const shellLockName = "shell.lock";

export interface ShellLockDeps {
  pid?: number;
  /** Whether a process id is still running. */
  alive?: (pid: number) => boolean;
  waitMs?: number;
  pollMs?: number;
  settleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}
export type ShellLock = { held: true; release(): Promise<void> } | { held: false; by: number };


async function owner(path: string): Promise<number | null> {
  try {
    const pid = Number((JSON.parse(await readFile(path, "utf8")) as { pid?: unknown }).pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

export async function takeShellLock(dataDir: string, deps: ShellLockDeps = {}): Promise<ShellLock> {
  const path = join(dataDir, shellLockName), pid = deps.pid ?? process.pid, alive = deps.alive ?? running;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const until = Date.now() + (deps.waitMs ?? 10_000);
  for (;;) {
    try {
      await writeFile(path, JSON.stringify({ pid, at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
      // Two starts that both found the same gone owner could each clear it; the one whose lock is still there holds it.
      await sleep(deps.settleMs ?? 100);
      if (await owner(path) === pid) return { held: true, release: async () => { if (await owner(path) === pid) await rm(path, { force: true }); } };
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const by = await owner(path);
    if (by === pid) return { held: true, release: async () => { if (await owner(path) === pid) await rm(path, { force: true }); } };
    // Gone, or unreadable for longer than a start takes to write it (a program that stopped half-way): taken over.
    const unread = by === null && Date.now() - ((await stat(path).catch(() => null))?.mtimeMs ?? 0) > 5_000;
    if (unread || (by !== null && !alive(by))) { await rm(path, { force: true }); continue; }
    if (Date.now() >= until) return { held: false, by: by ?? 0 };
    await sleep(deps.pollMs ?? 250);
  }
}
