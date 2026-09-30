import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readRunning, sessionTokenFileName, type RunningInstance } from "./running.js";
import { stopBackgroundEngine, type StopReport } from "./background-engine.js";

/**
 * `branch quit`: asks the Branch that is running on this computer, window or background engine, to
 * close the way it does when the owner quits it (open work is saved, and the app gives it a few
 * seconds at most), and returns once that process has really gone. A script restarts Branch with
 * `branch quit` followed by starting it again.
 */
export const quitPath = "/api/deployment/quit";

const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

async function savedToken(dataDir: string): Promise<string | null> {
  const token = (await readFile(join(dataDir, sessionTokenFileName), "utf8").catch(() => "")).trim();
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

/** True only for the master key of this data folder, never a short-lived key. */
async function carriesMasterKey(request: IncomingMessage, dataDir: string): Promise<boolean> {
  const supplied = /^Bearer (\S+)$/.exec(String(request.headers.authorization ?? ""))?.[1] ?? "";
  const saved = await savedToken(dataDir);
  return Boolean(saved) && supplied.length === saved!.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(saved!));
}

/**
 * The engine's side. Only this computer, holding the master key, may ask; the answer is sent before
 * the process starts closing. `quit` is what quitting means for this launch (the window's own Quit,
 * or the same stop as Ctrl+C for `branch start`); a launch that did not supply one refuses.
 */
export async function quitRequest(
  request: IncomingMessage, input: { dataDir: string; quit?: (() => void) | undefined; viaRemote?: boolean },
): Promise<{ closing: true; pid: number; message: string }> {
  if (request.method !== "POST") throw new Error("Ask with POST.");
  // Both ends of the connection are this computer, it did not come through the phone door, and it
  // carries the data folder's own key (a web page can neither read that key nor send it cross-site).
  const local = loopback.has(request.socket?.localAddress ?? "") && loopback.has(request.socket?.remoteAddress ?? "");
  if (input.viaRemote || !local || !(await carriesMasterKey(request, input.dataDir)))
    throw new Error("Only a program on this computer holding Branch's own key can close it.");
  const quit = input.quit;
  if (!quit) throw new Error("This copy of Branch cannot be closed from outside.");
  setTimeout(quit, 200);
  return { closing: true, pid: process.pid, message: "Branch Agent is closing." };
}

export interface QuitDeps {
  fetch?: typeof fetch;
  alive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** How long to wait for the process to go once it has been asked (20 seconds). */
  waitMs?: number;
  /** The background engine's own stop, used when the polite request is not answered. */
  stopEngine?: (dataDir: string) => Promise<StopReport>;
}
export interface QuitReport {
  /** True when nothing of Branch is running any more. */
  stopped: boolean;
  wasRunning: boolean;
  /** The process that was closed, so an update can wait for it too. */
  pid: number | null;
  message: string;
}

export const processAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as { code?: string }).code === "EPERM"; }
};
const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** The running note, but only while the process it names still exists. */
export async function runningNow(dataDir: string, alive: (pid: number) => boolean = processAlive): Promise<RunningInstance | null> {
  const note = await readRunning(dataDir);
  return note && alive(note.pid) ? note : null;
}

export async function waitForExit(pid: number, deps: QuitDeps): Promise<boolean> {
  const alive = deps.alive ?? processAlive, sleep = deps.sleep ?? pause;
  const deadline = Date.now() + (deps.waitMs ?? 20000);
  while (alive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(250);
  }
  return true;
}

async function ask(dataDir: string, note: RunningInstance, deps: QuitDeps): Promise<boolean> {
  try {
    if (new URL(note.url).hostname !== "127.0.0.1") return false;
    const token = await savedToken(dataDir);
    if (!token) return false;
    const response = await (deps.fetch ?? globalThis.fetch)(`${note.url}${quitPath}`, {
      method: "POST", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch { return false; }
}

/** Closes the running Branch and waits for it; "not running" counts as done. */
export async function quitRunning(dataDir: string, deps: QuitDeps = {}): Promise<QuitReport> {
  const note = await runningNow(dataDir, deps.alive ?? processAlive);
  if (!note) return { stopped: true, wasRunning: false, pid: null, message: "Branch Agent is not running." };
  const pid = note.pid;
  if ((await ask(dataDir, note, deps)) && (await waitForExit(pid, deps)))
    return { stopped: true, wasRunning: true, pid, message: "Branch Agent has closed." };
  if (note.mode === "daemon") {
    const report = await (deps.stopEngine ?? stopBackgroundEngine)(dataDir);
    if (report.stopped) return { stopped: true, wasRunning: true, pid, message: "Branch Agent has closed." };
  }
  return { stopped: false, wasRunning: true, pid,
    message: "Branch Agent did not close. Quit it from its window or menu, then try again." };
}
