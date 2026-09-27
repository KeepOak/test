import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/**
 * Keeps a Beta build out of the owner's way (the owner, 2026-09-27: "when my app is in the middle of updating in the
 * background everything is slow"). The build runs in a process of its own (build-host.ts) that lowers itself before it
 * starts anything, and every program it starts inherits that: on Windows the below-normal priority class, low I/O
 * priority and low memory priority (children inherit all three, measured on Windows 11), and EcoQoS, which keeps it on
 * the efficient cores; on macOS and Linux nice 10, which Linux also uses for I/O priority. While the owner types or a
 * task runs, the build waits (pauseReason), and the programs that only compute or write files are suspended in place.
 *
 * Below normal rather than idle, and low rather than very low I/O: every program the owner runs still comes first
 * either way, but measured on a busy computer, the idle class with very low I/O made writing many small files (npm ci,
 * packaging) 5 to 20 times slower than this, so a cold build took a quarter of an hour.
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

/** Suspends and resumes a program with everything it started, and ends it whole. */
export interface TreeHold {
  pause(pid: number): Promise<void>;
  resume(pid: number): Promise<void>;
  end(pid: number): Promise<void>;
}

/**
 * Where the build may start its next program, and which running ones are held while it is paused. A program marked
 * `pausable` (compiling, packaging: nothing that holds a network connection) is suspended in place; any other is left
 * to finish, and the next one waits. A running program's time limit counts only the time it was not held.
 */
export class BuildGate {
  private held = false;
  private waiters: (() => void)[] = [];
  private readonly running = new Map<number, boolean>();
  constructor(private readonly hold: TreeHold | null) {}
  get paused(): boolean { return this.held; }
  /** Resolves once the build may go on. */
  ready(): Promise<void> {
    return this.held ? new Promise((resolve) => this.waiters.push(resolve)) : Promise.resolve();
  }
  async set(paused: boolean): Promise<void> {
    if (paused === this.held) return;
    this.held = paused;
    for (const [pid, pausable] of this.running)
      if (pausable) await (paused ? this.hold?.pause(pid) : this.hold?.resume(pid))?.catch((error: Error) => console.error(`pause: ${error.message}`));
    if (!paused) for (const wake of this.waiters.splice(0)) wake();
  }
  /** A program started: suspended at once when the build is paused and it may be. */
  started(pid: number, pausable: boolean): void {
    this.running.set(pid, pausable);
    if (pausable && this.held) void this.hold?.pause(pid).catch((error: Error) => console.error(`pause: ${error.message}`));
  }
  ended(pid: number): void { this.running.delete(pid); }
  /** Whether this program is held now (its time limit does not count). */
  holding(pid: number): boolean { return this.held && this.running.get(pid) === true; }
  /** Ends a program with everything it started; resolves once asked (a gate with no helper ends nothing itself). */
  async end(pid: number): Promise<void> { await this.hold?.end(pid).catch((error: Error) => console.error(`end: ${error.message}`)); }
  /** Ends every program still running (the app went away mid-build). */
  async endAll(): Promise<void> { await Promise.all([...this.running.keys()].map((pid) => this.end(pid))); }
}

/**
 * A time limit that counts only the time `held()` is false, checked every `stepMs`. `onExpire` runs once. Returns the
 * function that cancels it.
 */
export function activeDeadline(limitMs: number, held: () => boolean, onExpire: () => void, stepMs = 1_000, now = Date.now): () => void {
  let spent = 0, last = now();
  const timer = setInterval(() => {
    const at = now();
    if (!held()) spent += at - last;
    last = at;
    if (spent >= limitMs) { clearInterval(timer); onExpire(); }
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
 * Windows: a small helper, compiled once per build, that does what Node cannot: sets a process's I/O and memory
 * priority and turns on EcoQoS (Task Manager's "efficiency mode"), and suspends, resumes or ends a process with
 * everything it started. It reads one command per line and answers one line. The script is fixed here and takes only numbers.
 */
export const windowsHelperScript = String.raw`$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class BranchQuiet {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("ntdll.dll")] static extern int NtSetInformationProcess(IntPtr h, int cls, ref int info, int len);
  [DllImport("ntdll.dll")] static extern int NtSuspendProcess(IntPtr h);
  [DllImport("ntdll.dll")] static extern int NtResumeProcess(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool SetProcessInformation(IntPtr h, int cls, int[] info, int len);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, int pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref Entry e);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref Entry e);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Entry { public int size; public int usage; public int pid; public IntPtr heap; public int module; public int threads; public int parent; public int prio; public int flags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string exe; }
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr h, uint code);
  // Held by handle, not by number: a process that is held cannot hand its number on to another one.
  static readonly Dictionary<int, IntPtr> held = new Dictionary<int, IntPtr>();
  static long Created(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);
    if (h == IntPtr.Zero) return 0;
    long created, exited, kernel, user;
    bool ok = GetProcessTimes(h, out created, out exited, out kernel, out user);
    CloseHandle(h);
    return ok ? created : 0;
  }
  // The root and everything it started. A process whose parent's number was handed on to the root (or to one of its
  // children) after the parent ended is not the root's: a child is never older than its parent.
  static List<int> Tree(int root) {
    var children = new Dictionary<int, List<int>>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);
    var e = new Entry(); e.size = Marshal.SizeOf(typeof(Entry));
    for (bool ok = Process32FirstW(snap, ref e); ok; ok = Process32NextW(snap, ref e)) {
      if (e.pid == e.parent) continue;
      if (!children.ContainsKey(e.parent)) children[e.parent] = new List<int>();
      children[e.parent].Add(e.pid);
    }
    CloseHandle(snap);
    var found = new List<int>(); found.Add(root);
    var born = new Dictionary<int, long>(); born[root] = Created(root);
    for (int i = 0; i < found.Count; i++) {
      List<int> kids;
      if (!children.TryGetValue(found[i], out kids)) continue;
      foreach (int k in kids) {
        if (found.Contains(k)) continue;
        long at = Created(k);
        if (at == 0 || born[found[i]] == 0 || at < born[found[i]]) continue;
        found.Add(k); born[k] = at;
      }
    }
    return found;
  }
  public static string Lower(int pid) {
    IntPtr h = OpenProcess(0x0200, false, pid);
    if (h == IntPtr.Zero) return "gone";
    int low = 1;
    int io = NtSetInformationProcess(h, 33, ref low, 4);
    bool memory = SetProcessInformation(h, 0, new int[] { 2 }, 4);
    bool eco = SetProcessInformation(h, 4, new int[] { 1, 1, 1 }, 12);
    CloseHandle(h);
    return "io=" + io + " memory=" + memory + " eco=" + eco;
  }
  public static int Pause(int root) {
    for (int round = 0; round < 20; round++) {
      int added = 0;
      foreach (int pid in Tree(root)) {
        if (held.ContainsKey(pid)) continue;
        IntPtr h = OpenProcess(0x0800 | 0x100000, false, pid);
        if (h == IntPtr.Zero) continue;
        if (NtSuspendProcess(h) == 0) { held[pid] = h; added++; } else CloseHandle(h);
      }
      if (added == 0) break;
    }
    return held.Count;
  }
  public static int Resume() {
    int count = 0;
    foreach (IntPtr h in held.Values) { if (NtResumeProcess(h) == 0) count++; CloseHandle(h); }
    held.Clear();
    return count;
  }
  public static int End(int root) {
    int count = 0;
    foreach (int pid in Tree(root)) {
      IntPtr h = OpenProcess(0x0001, false, pid);
      if (h == IntPtr.Zero) continue;
      if (TerminateProcess(h, 1)) count++;
      CloseHandle(h);
    }
    return count;
  }
}
'@
[Console]::Out.WriteLine('ready')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $words = $line.Split(' ')
  try {
    $pid2 = [int]$words[1]
    switch ($words[0]) {
      'lower' { [Console]::Out.WriteLine([BranchQuiet]::Lower($pid2)) }
      'pause' { [Console]::Out.WriteLine([BranchQuiet]::Pause($pid2)) }
      'resume' { [Console]::Out.WriteLine([BranchQuiet]::Resume()) }
      'end' { [Console]::Out.WriteLine([BranchQuiet]::End($pid2)) }
      default { [Console]::Out.WriteLine('unknown') }
    }
  } catch { [Console]::Out.WriteLine('failed ' + $_.Exception.Message) }
}
`;

/**
 * Lowers the process it runs in, before it starts anything, so everything it starts inherits the low priority; on
 * Windows the helper then lowers its I/O and memory priority too (inherited as well). Answers the gate the build's
 * programs run through, the helper (null when it could not run: the priority class alone still holds), and in words
 * what was lowered, for the build's log.
 */
export async function lowerBuildProcess(platform: NodeJS.Platform = process.platform): Promise<{ gate: BuildGate; quiet: WindowsQuiet | null; lowered: string }> {
  os.setPriority(0, quietPriority);
  if (platform !== "win32") return { gate: new BuildGate(posixHold), quiet: null, lowered: `nice ${os.getPriority(0)}` };
  const quiet = await WindowsQuiet.start();
  const lowered = quiet ? await quiet.lower(process.pid).catch((error: Error) => `failed ${error.message}`) : "helper unavailable";
  return { gate: new BuildGate(quiet), quiet, lowered: `priority ${os.getPriority(0)}, ${lowered}` };
}

/** Windows' own PowerShell, by its full path: never one found on PATH. */
export const windowsPowerShell = (): string =>
  join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

/** The Windows helper, running. Its commands are answered in order, one at a time. */
export class WindowsQuiet implements TreeHold {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(private readonly child: ChildProcess, private readonly lines: AsyncIterator<string>) {}
  /** Starts the helper; null when it cannot run here (PowerShell missing, or a policy refuses compiled code). */
  static async start(timeoutMs = 60_000): Promise<WindowsQuiet | null> {
    // The script goes in encoded (fixed words, nothing filled in), which leaves standard input for the commands.
    const encoded = Buffer.from(windowsHelperScript, "utf16le").toString("base64");
    const child = spawn(windowsPowerShell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    child.on("error", () => undefined);
    child.stdin?.on("error", () => undefined);
    const lines = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    const ready = await Promise.race([lines.next().then((line) => line.value === "ready"),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs).unref())]);
    if (ready) return new WindowsQuiet(child, lines);
    child.kill();
    return null;
  }
  private ask(command: string): Promise<string> {
    const answer = this.queue.then(async () => {
      this.child.stdin!.write(`${command}\r\n`);
      const line = await this.lines.next();
      if (line.done) throw new Error("the helper that keeps the build quiet stopped");
      return line.value;
    });
    this.queue = answer.catch(() => undefined);
    return answer;
  }
  /** Low I/O priority, low memory priority and EcoQoS for one process; its children inherit the first two. */
  lower(pid: number): Promise<string> { return this.ask(`lower ${Math.trunc(pid)}`); }
  async pause(pid: number): Promise<void> { await this.ask(`pause ${Math.trunc(pid)}`); }
  async resume(_pid: number): Promise<void> { await this.ask("resume 0"); }
  async end(pid: number): Promise<void> { await this.ask(`end ${Math.trunc(pid)}`); }
  close(): void { this.child.stdin?.end(); this.child.kill(); }
}
