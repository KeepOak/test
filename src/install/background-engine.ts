import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { clearRunning, readRunning, sessionTokenFileName } from "./running.js";
import { runTool, systemTool, type RunTool } from "./windows.js";
import { quitPath } from "./quit.js";

/**
 * Talking to the engine that is already working with the window closed. When the window joined a
 * background engine, that engine owns the saved work and holds the program files open, so before an
 * update the window asks it for the safety copy and then asks it to close.
 */
export interface BackupDeps { fetch?: typeof fetch; timeoutMs?: number }

/**
 * Asks the background engine to write the safety copy of the person's work. Whatever went wrong
 * there is passed on word for word, so the owner reads the same sentence either way.
 */
export async function requestUpdateBackup(url: string, token: string, deps: BackupDeps = {}): Promise<void> {
  const call = deps.fetch ?? globalThis.fetch;
  const response = await call(`${url}/api/deployment/backup`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(deps.timeoutMs ?? 180000),
  });
  const body = (await response.json().catch(() => null)) as { error?: unknown; path?: unknown; dataCopy?: unknown } | null;
  if (!response.ok)
    throw new Error(typeof body?.error === "string" && body.error
      ? body.error
      : `the background engine did not answer properly (HTTP ${response.status})`);
  if (typeof body?.path !== "string")
    throw new Error("the background engine did not say where it put the copy");
  // The copy of the whole data folder too (src/install/data-copy.ts): an engine that did not make one stops the update.
  if (typeof body.dataCopy !== "string")
    throw new Error("the background engine did not make a copy of the data folder");
}

export interface StopDeps {
  run?: RunTool;
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  systemRoot?: string;
  /** How long to wait for the engine to go, each time it is asked. */
  waitMs?: number;
  /** Which system this is; defaults to this computer's. Only Windows uses `taskkill`. */
  platform?: NodeJS.Platform;
  /** macOS and Linux: sends a signal to a process. Tests hand in a fake. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** macOS and Linux: the call that asks the engine to close over its own local address. */
  fetch?: typeof fetch;
  /** An automatic update waits rather than forcibly ending a background engine. */
  gracefulOnly?: boolean;
}
export interface StopReport {
  /** The engine's process id, so the hand-over script can wait for it too. */
  pid: number | null;
  stopped: boolean;
  forced: boolean;
  message: string;
}

const stillAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === "EPERM"; }
};
const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

async function waitForExit(pid: number, deps: StopDeps): Promise<boolean> {
  const alive = deps.alive ?? stillAlive, sleep = deps.sleep ?? pause;
  const deadline = Date.now() + (deps.waitMs ?? 12000);
  while (alive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
  return true;
}

/**
 * Closes the background engine and waits for it to go, politely first and firmly after. A refusal is
 * not treated as a failure: the hand-over script waits for the same process and ends it if it has to.
 */
export async function stopBackgroundEngine(dataDir: string, deps: StopDeps = {}): Promise<StopReport> {
  const instance = await readRunning(dataDir);
  if (!instance || instance.mode !== "daemon" || instance.pid === process.pid)
    return { pid: null, stopped: false, forced: false, message: "Nothing was working in the background." };
  if ((deps.platform ?? process.platform) !== "win32") return stopPosixEngine(dataDir, instance, deps);
  const run = deps.run ?? runTool, taskkill = systemTool("taskkill.exe", deps.systemRoot);
  const pid = instance.pid;
  // mac7/real-update review: the installer now reaches this too, with whatever note a crash left behind.
  // Windows hands a dead engine's process id to the next program, and taskkill /T /F would end that
  // program and everything it started, so nothing is ended that cannot be shown to be Branch.
  if (!(await windowsStillTheEngine(dataDir, instance, deps))) {
    await clearRunning(dataDir).catch(() => undefined);
    return { pid: null, stopped: false, forced: false, message: "Nothing was working in the background." };
  }
  // Asked first the way `branch quit` asks (src/install/quit.ts): Branch's background engine has no window, so taskkill
  // without /F can never close it ("can only be terminated forcefully"), and an automatic update, which never forces,
  // waited on that for ever while it built, tried and backed up the same version every minute (2026-09-29).
  const quit = await askToQuit(dataDir, instance, deps);
  if (quit === null && (await waitForExit(pid, { ...deps, waitMs: deps.waitMs ?? quitWaitMs }))) return finish(dataDir, pid, false);
  const asked = await run(taskkill, ["/PID", String(pid), "/T"]).then(() => null, (error: unknown) => oneLine(error));
  if (asked === null && (await waitForExit(pid, deps))) return finish(dataDir, pid, false);
  if (deps.gracefulOnly) return waitingForEngine(pid, [quit ?? "it was asked to close but had not closed yet", asked ?? "taskkill asked it to close; it had not closed yet"]);
  await run(taskkill, ["/PID", String(pid), "/T", "/F"]).catch(() => undefined);
  if (await waitForExit(pid, deps)) return finish(dataDir, pid, true);
  return notInTime(pid);
}

/** How long a background engine that agreed to close is given to go: its work is saved first (as `branch quit` waits). */
const quitWaitMs = 20000;
const oneLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 300);

/**
 * Asks the background engine to close over its own loopback address with the data folder's key (`branch quit`'s door).
 * Behind the gateway the engine hands the close to the gateway, which saves the work and ends. Answers null when it
 * agreed to close, or why it did not.
 */
async function askToQuit(dataDir: string, instance: { url: string }, deps: StopDeps): Promise<string | null> {
  const answer = await engineCall(dataDir, instance.url, "POST", quitPath, deps);
  if (!answer) return "it did not answer on its own address";
  if (answer.ok) return null;
  const body = (await answer.json().catch(() => null)) as { error?: unknown } | null;
  return `it refused to close (HTTP ${answer.status}${typeof body?.error === "string" ? `: ${body.error.slice(0, 200)}` : ""})`;
}

const notInTime = (pid: number): StopReport => ({
  pid, stopped: false, forced: true,
  message: "The background engine did not close in time; the update will close it before swapping the files.",
});
const waitingForEngine = (pid: number, why: string[] = []): StopReport => ({
  pid, stopped: false, forced: false,
  message: `Branch could not close its background engine without forcing it${why.length ? ` (${why.join("; ")})` : ""}, so the update is waiting rather than ending it by force. Nothing was changed.`,
});

/** macOS and Linux wait a few seconds at each step rather than Windows' twelve. */
const posixWaitMs = 3000;

/**
 * macOS and Linux: the engine is asked over its own local address first, then sent the ordinary
 * "please stop" signal, and only then ended outright. Each step waits a few seconds at most. No
 * signal is ever sent to a process id that cannot be shown to still be this engine: a note left
 * behind by a crash may name an id the system has since given to an unrelated program.
 */
async function stopPosixEngine(
  dataDir: string, instance: { pid: number; url: string }, deps: StopDeps,
): Promise<StopReport> {
  const pid = instance.pid, bounded = { ...deps, waitMs: deps.waitMs ?? posixWaitMs };
  const kill = deps.kill ?? ((target: number, signal: NodeJS.Signals) => { process.kill(target, signal); });
  const send = (signal: NodeJS.Signals): boolean => {
    try { kill(pid, signal); return true; } catch { return false; }
  };
  const closing = await engineCall(dataDir, instance.url, "POST", "/api/deployment/close", deps);
  if (closing?.ok && (await waitForExit(pid, bounded))) return finish(dataDir, pid, false);
  // Behind the gateway, the close door is the engine's and the note names the gateway, so the engine refuses it; the
  // gateway closes through `branch quit`'s door instead.
  const quit = closing && !closing.ok ? await askToQuit(dataDir, instance, deps) : undefined;
  if (quit === null && (await waitForExit(pid, { ...deps, waitMs: deps.waitMs ?? quitWaitMs }))) return finish(dataDir, pid, false);
  if (!closing?.ok && !(await stillTheEngine(dataDir, instance, deps))) {
    await clearRunning(dataDir).catch(() => undefined);
    return { pid: null, stopped: false, forced: false, message: "Nothing was working in the background." };
  }
  if (deps.gracefulOnly) return waitingForEngine(pid, [quit ?? (closing ? "it was asked to close but had not closed yet" : "it did not answer on its own address")]);
  if (send("SIGTERM") && (await waitForExit(pid, bounded))) return finish(dataDir, pid, false);
  send("SIGKILL");
  if (await waitForExit(pid, bounded)) return finish(dataDir, pid, true);
  return notInTime(pid);
}

/**
 * True when the noted process is still Branch's engine: its address answers as Branch with the saved
 * key, or the system says that process id is running Branch's engine script.
 */
async function stillTheEngine(dataDir: string, instance: { pid: number; url: string }, deps: StopDeps): Promise<boolean> {
  const state = await engineCall(dataDir, instance.url, "GET", "/api/state", deps);
  const body = state?.ok ? ((await state.json().catch(() => null)) as { version?: unknown } | null) : null;
  if (typeof body?.version === "string") return true;
  const run = deps.run ?? runTool;
  const command = await run("/bin/ps", ["-p", String(instance.pid), "-o", "command="]).catch(() => "");
  return /[\\/]dist[\\/]cli\.js\b/.test(command);
}

/** The program the background engine runs as on Windows (the app's own runtime, see daemon.ts). */
export const windowsEngineImage = "Branch Agent.exe";

/**
 * Windows: true when the noted process is still Branch's engine: its address answers as Branch with
 * the saved key, or Windows says that process id is running Branch's own program.
 */
async function windowsStillTheEngine(dataDir: string, instance: { pid: number; url: string }, deps: StopDeps): Promise<boolean> {
  const state = await engineCall(dataDir, instance.url, "GET", "/api/state", deps);
  const body = state?.ok ? ((await state.json().catch(() => null)) as { version?: unknown } | null) : null;
  if (typeof body?.version === "string") return true;
  const run = deps.run ?? runTool;
  const listing = await run(systemTool("tasklist.exe", deps.systemRoot), ["/FI", `PID eq ${instance.pid}`, "/FO", "CSV", "/NH"]).catch(() => "");
  const row = /^"([^"]*)","(\d+)"/m.exec(listing);
  return Boolean(row) && Number(row![2]) === instance.pid && row![1]!.toLowerCase() === windowsEngineImage.toLowerCase();
}

/** One call to the engine's own loopback address with the saved key; null when it could not be made. */
async function engineCall(
  dataDir: string, url: string, method: "GET" | "POST", path: string, deps: StopDeps,
): Promise<Response | null> {
  try {
    if (new URL(url).hostname !== "127.0.0.1") return null;
    const token = (await readFile(join(dataDir, sessionTokenFileName), "utf8")).trim();
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const call = deps.fetch ?? globalThis.fetch;
    return await call(`${url}${path}`, {
      method, headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(posixWaitMs),
    });
  } catch { return null; }
}

async function finish(dataDir: string, pid: number, forced: boolean): Promise<StopReport> {
  await clearRunning(dataDir).catch(() => undefined);
  return {
    pid, stopped: true, forced,
    message: "Branch stopped working in the background so the new version can replace the files.",
  };
}
