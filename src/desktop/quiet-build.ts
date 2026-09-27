import { execFile } from "node:child_process";
import os from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);

/**
 * Keeps a Beta build out of the owner's way (the owner, 2026-09-27: "when my app is in the middle of updating in the
 * background everything is slow"). The build runs in a process of its own (build-host.ts) that lowers itself before it
 * starts anything, and every program it starts inherits that: on Windows the below-normal priority class (children
 * inherit it, measured on Windows 11 down to npm's grandchildren); on macOS and Linux nice 10, which Linux also uses for
 * I/O priority. While the owner types or a task works, the next step waits (pauseReason), and the program running then
 * is held: stopped on macOS and Linux, dropped to the idle class on Windows (see windowsHold).
 *
 * Below normal rather than idle while nothing waits: every program the owner runs comes first either way, but measured
 * on a busy computer, the idle class made writing many small files (npm ci, packaging) several times slower, so a cold
 * build took a quarter of an hour.
 */
export const quietPriority = os.constants.priority.PRIORITY_BELOW_NORMAL;

/** Why a build is waiting: the owner is typing in Branch, or a task is working. */
export type PauseReason = "typing" | "task";
/** How long after the last key the owner still counts as typing (a pause, not a stop between every word). */
export const typingQuietMs = 5_000;

/**
 * Whether the build should wait right now, and why. Typing wins over a task, so the words say what the owner is doing.
 * Only tasks at work count: one waiting on the owner's answer uses nothing, and would otherwise hold the build for an hour.
 */
export function pauseReason(input: { now: number; lastKeyAt: number | null; workingTasks: number }): PauseReason | null {
  if (input.lastKeyAt !== null && input.now - input.lastKeyAt < typingQuietMs) return "typing";
  if (input.workingTasks > 0) return "task";
  return null;
}

/**
 * While an install is under way it waits for the owner (quiet-build.ts pauseReason): a key pressed in this window
 * counts as typing for a few seconds, and the engine is asked every few seconds how many tasks are at work. Only
 * keys are looked at (never what they are), and only here in the app; the page is not asked anything.
 */
export interface OwnerWindow {
  isDestroyed(): boolean;
  webContents: { on(event: "before-input-event", fn: (event: unknown, input: { type: string }) => void): unknown; off(event: "before-input-event", fn: (event: unknown, input: { type: string }) => void): unknown };
}
export function watchForOwner(window: OwnerWindow, updater: { setPaused(reason: PauseReason | null): void },
  workingTasks: () => Promise<number>, everyMs = 1_000, tasksEveryMs = 5_000): () => void {
  let lastKeyAt: number | null = null, working = 0, lookedAt = 0, looking = false;
  const heard = (_event: unknown, input: { type: string }) => { if (input.type === "keyDown") lastKeyAt = Date.now(); };
  window.webContents.on("before-input-event", heard);
  const look = () => {
    const now = Date.now();
    if (!looking && now - lookedAt >= tasksEveryMs) {
      looking = true;
      lookedAt = now;
      // A look that fails counts no task, so a count from before the engine stopped answering never holds the install
      // for ever: the gate before the swap asks again and waits itself.
      void workingTasks().then((count) => { working = count; }, () => { working = 0; }).finally(() => { looking = false; });
    }
    updater.setPaused(pauseReason({ now, lastKeyAt, workingTasks: working }));
  };
  look();
  const timer = setInterval(look, everyMs);
  return () => {
    clearInterval(timer);
    if (!window.isDestroyed()) window.webContents.off("before-input-event", heard);
    updater.setPaused(null);
  };
}

/** Holds a program with everything it started and lets it go again, and ends it whole. */
export interface TreeHold {
  pause(pid: number): Promise<void>;
  resume(pid: number): Promise<void>;
  end(pid: number): Promise<void>;
}

/**
 * Where the build may start its next program, and which running ones are held while it is paused. A program marked
 * `pausable` (compiling, packaging: nothing that holds a network connection) is held in place; any other is left to
 * finish, and the next one waits. A running program's time limit does not count the time it was held.
 */
export class BuildGate {
  private held = false;
  private waiters: (() => void)[] = [];
  /** Each running program: whether it may be held, the time it has been held, and since when it is held now. */
  private readonly running = new Map<number, { pausable: boolean; heldMs: number; since: number | null }>();
  constructor(private readonly hold: TreeHold | null, private readonly now: () => number = Date.now) {}
  get paused(): boolean { return this.held; }
  /** Resolves once the build may go on. */
  ready(): Promise<void> {
    return this.held ? new Promise((resolve) => this.waiters.push(resolve)) : Promise.resolve();
  }
  /**
   * Holds or lets go. The time held is counted at once; the programs are held or let go one change at a time, each
   * change applying whatever is wanted when its turn comes, so a pause and a going-on that overlap (each is a slow look
   * at Windows' process list) always end in the state asked for last.
   */
  set(paused: boolean): Promise<void> {
    if (paused === this.held) return this.applying;
    this.held = paused;
    const at = this.now();
    for (const one of this.running.values()) {
      if (!one.pausable) continue;
      if (paused) one.since = at;
      else if (one.since !== null) { one.heldMs += at - one.since; one.since = null; }
    }
    if (!paused) for (const wake of this.waiters.splice(0)) wake();
    return this.queue(() => [...this.running].filter(([, one]) => one.pausable).map(([pid]) => pid));
  }
  private applying: Promise<void> = Promise.resolve();
  private queue(pids: () => number[]): Promise<void> {
    this.applying = this.applying.then(async () => {
      const paused = this.held;
      for (const pid of pids()) await (paused ? this.hold?.pause(pid) : this.hold?.resume(pid))?.catch((error: Error) => console.error(`pause: ${error.message}`));
    });
    return this.applying;
  }
  /** A program started: held at once when the build is paused and it may be. */
  started(pid: number, pausable: boolean): void {
    const held = pausable && this.held;
    this.running.set(pid, { pausable, heldMs: 0, since: held ? this.now() : null });
    if (held) void this.queue(() => (this.held && this.running.has(pid) ? [pid] : []));
  }
  ended(pid: number): void { this.running.delete(pid); }
  /** How long this program has been held so far: its time limit does not count that. */
  heldMs(pid: number): number {
    const one = this.running.get(pid);
    if (!one) return 0;
    return one.heldMs + (one.since === null ? 0 : this.now() - one.since);
  }
  /** Ends a program with everything it started; resolves once asked (a gate with no helper ends nothing itself). */
  async end(pid: number): Promise<void> { await this.hold?.end(pid).catch((error: Error) => console.error(`end: ${error.message}`)); }
  /** Ends every program still running (the app went away mid-build). */
  async endAll(): Promise<void> { await Promise.all([...this.running.keys()].map((pid) => this.end(pid))); }
}

/**
 * A time limit that does not count the time a program was held (`heldMs`, so far), looked at every `stepMs`.
 * `onExpire` runs once. Returns the function that cancels it.
 */
export function activeDeadline(limitMs: number, heldMs: () => number, onExpire: () => void, stepMs = 1_000, now = Date.now): () => void {
  const start = now();
  const timer = setInterval(() => {
    if (now() - start - heldMs() < limitMs) return;
    clearInterval(timer);
    onExpire();
  }, stepMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** macOS and Linux: every program runs in a group of its own (spawned `detached`), stopped and continued as one. */
export const posixHold: TreeHold = {
  pause: async (pid) => { process.kill(-pid, "SIGSTOP"); },
  resume: async (pid) => { process.kill(-pid, "SIGCONT"); },
  end: async (pid) => { try { process.kill(-pid, "SIGKILL"); } catch { /* the group is already gone */ } },
};

/**
 * Windows has no way to suspend a program without native code, and Branch compiles nothing on the owner's computer.
 * So a held program, with everything it started, drops to the idle priority class: it runs only on cores nothing else
 * wants, and the next program waits. Going on puts it back below normal. The programs are found from Windows' own list
 * (their parent and when they started: a child is never older than its parent, so a process number handed on to
 * another program after its parent ended is not followed), and set with Node's own call.
 */
export interface ProcessRow { pid: number; parent: number; created: number }
export function descendants(rows: ProcessRow[], root: number): number[] {
  const born = new Map(rows.map((row) => [row.pid, row.created]));
  if (!born.has(root)) return [];
  const found = [root];
  for (let index = 0; index < found.length; index++) {
    const parent = found[index]!, parentBorn = born.get(parent)!;
    for (const row of rows) if (row.parent === parent && row.pid !== parent && !found.includes(row.pid) && row.created >= parentBorn) found.push(row.pid);
  }
  return found;
}

/** Windows' own PowerShell, by its full path: never one found on PATH. */
export const windowsPowerShell = (): string =>
  join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
/** Every process: its number, its parent's, and when it started. A fixed command; nothing is filled in. */
const listCommand = "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToFileTimeUtc() }";

export async function windowsProcesses(): Promise<ProcessRow[]> {
  const { stdout } = await runFile(windowsPowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", listCommand],
    { windowsHide: true, timeout: 60_000, maxBuffer: 16 << 20 });
  return String(stdout).split(/\r?\n/).map((line) => line.trim().split(" ").map(Number))
    .filter((parts) => parts.length === 3 && parts.every(Number.isFinite)).map(([pid, parent, created]) => ({ pid: pid!, parent: parent!, created: created! }));
}

/** Sets one priority on a program and everything it started; one that has ended meanwhile is passed over. */
async function setTreePriority(root: number, priority: number, list: () => Promise<ProcessRow[]>): Promise<number[]> {
  const tree = descendants(await list(), root);
  for (const pid of tree) try { os.setPriority(pid, priority); } catch { /* it ended meanwhile */ }
  return tree;
}

export function windowsHold(list: () => Promise<ProcessRow[]> = windowsProcesses): TreeHold {
  return {
    pause: async (pid) => { await setTreePriority(pid, os.constants.priority.PRIORITY_LOW, list); },
    resume: async (pid) => { await setTreePriority(pid, quietPriority, list); },
    end: async (pid) => {
      // The whole tree is found before anything is ended, while every parent is still there to follow.
      const tree = descendants(await list(), pid);
      for (const one of tree.reverse()) try { process.kill(one); } catch { /* it ended meanwhile */ }
    },
  };
}

/**
 * Lowers the process it runs in, before it starts anything, so everything it starts inherits the low priority.
 * Answers the gate the build's programs run through, and in words what was lowered, for the build's log.
 */
export function lowerBuildProcess(platform: NodeJS.Platform = process.platform): { gate: BuildGate; lowered: string } {
  os.setPriority(0, quietPriority);
  return platform === "win32"
    ? { gate: new BuildGate(windowsHold()), lowered: `priority class ${os.getPriority(0)} (below normal)` }
    : { gate: new BuildGate(posixHold), lowered: `nice ${os.getPriority(0)}` };
}
