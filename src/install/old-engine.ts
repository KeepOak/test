import { processAlive as stillAlive } from "./process-alive.js";
import { spawn } from "node:child_process";
import { readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { daemonCommandLine, hiddenRunner } from "./daemon.js";
import { join } from "node:path";
import { quitPath } from "./quit.js";
import { clearRunning, readRunning, sessionTokenFileName, type RunningInstance } from "./running.js";
import { runTool, systemTool, type RunTool } from "./windows.js";

/**
 * Moving to this version when a background engine from before it is still running. Such an engine cannot answer the
 * proof the window now asks for (src/engine-proof.ts), so it would never be joined. It is closed and started again as
 * this version, with no question to the owner.
 *
 * The window's key is never sent to a port that has not proved itself as the engine. The old engine has no proof to
 * give, so this computer is asked instead: the process holding the port must be the very process the engine's own
 * note names (running.json in the owner's data folder). Only then is the old engine asked to close the way `branch
 * quit` asks it, with its key, which it checks against its own copy on disk. If it does not close in time, that same
 * process, checked again, is ended.
 */
export interface OldEngineDeps {
  platform?: NodeJS.Platform;
  run?: RunTool;
  fetch?: typeof fetch;
  alive?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Which process is listening at 127.0.0.1:`port`, as this computer says; tests hand in a stand-in. */
  listener?: (port: number) => Promise<number | null>;
  sleep?: (ms: number) => Promise<void>;
  /** How long the engine has to close after it was asked, and again after it was ended. */
  waitMs?: number;
}

export type CloseOutcome =
  | { closed: true; instance: RunningInstance; forced: boolean }
  | { closed: false; why: string };

const pause = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Windows: the process listening at 127.0.0.1:`port` (or every address), from the system's own table. */
export function listenerFromNetstat(table: string, port: number): number | null {
  for (const line of table.split(/\r?\n/)) {
    const [proto, local, , state, pid] = line.trim().split(/\s+/);
    if (proto !== "TCP" || state !== "LISTENING" || !local || !pid) continue;
    if (local === `127.0.0.1:${port}` || local === `0.0.0.0:${port}`) return Number(pid);
  }
  return null;
}

/** Linux: the socket numbers listening at 127.0.0.1:`port` or every address, from /proc/net/tcp. */
export function listeningInodes(table: string, port: number): Set<string> {
  const found = new Set<string>();
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  for (const line of table.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const [local, , state] = [fields[1], fields[2], fields[3]];
    if (state === "0A" && (local === `0100007F:${hexPort}` || local === `00000000:${hexPort}`)) found.add(fields[9]!);
  }
  return found;
}

async function linuxHolds(pid: number, port: number): Promise<boolean> {
  const inodes = listeningInodes(await readFile("/proc/net/tcp", "utf8"), port);
  if (!inodes.size) return false;
  const fds = await readdir(`/proc/${pid}/fd`).catch(() => [] as string[]);
  for (const fd of fds) {
    const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
    const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
    if (inode && inodes.has(inode)) return true;
  }
  return false;
}

/** Whether process `pid` is the one listening at 127.0.0.1:`port`, as this computer says. */
async function holdsPort(pid: number, port: number, deps: OldEngineDeps): Promise<boolean> {
  try {
    if (deps.listener) return (await deps.listener(port)) === pid;
    const platform = deps.platform ?? process.platform, run = deps.run ?? runTool;
    if (platform === "win32") return listenerFromNetstat(await run(systemTool("netstat.exe"), ["-ano", "-p", "TCP"]), port) === pid;
    if (platform === "linux") return await linuxHolds(pid, port);
    const listed = await run("/usr/sbin/lsof", ["-nP", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN", "-Fp"]);
    return listed.split("\n").some((line) => line === `p${pid}`);
  } catch { return false; }
}

async function gone(pid: number, deps: OldEngineDeps): Promise<boolean> {
  const alive = deps.alive ?? stillAlive, sleep = deps.sleep ?? pause;
  for (const end = Date.now() + (deps.waitMs ?? 20000); alive(pid);) {
    if (Date.now() >= end) return false;
    await sleep(100);
  }
  return true;
}

/** Asks the checked engine to close, the way `branch quit` does, then the way an update does (a gateway's own close). */
async function askToClose(note: RunningInstance, key: string, deps: OldEngineDeps): Promise<boolean> {
  const call = deps.fetch ?? globalThis.fetch;
  for (const path of [quitPath, "/api/deployment/close"]) {
    if (!(await holdsPort(note.pid, note.port, deps))) return false;
    const answer = await call(`http://127.0.0.1:${note.port}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000),
    }).catch(() => null);
    await answer?.body?.cancel().catch(() => undefined);
    if (answer?.ok) return true;
  }
  return false;
}

/** Ends the checked engine's process (and on Windows what it started), when it did not close when asked. */
async function end(note: RunningInstance, deps: OldEngineDeps): Promise<void> {
  if (!(await holdsPort(note.pid, note.port, deps))) return;
  if ((deps.platform ?? process.platform) === "win32") {
    await (deps.run ?? runTool)(systemTool("taskkill.exe"), ["/PID", String(note.pid), "/T", "/F"]).catch(() => undefined);
    return;
  }
  const kill = deps.kill ?? ((pid: number, signal: NodeJS.Signals) => { process.kill(pid, signal); });
  try { kill(note.pid, "SIGTERM"); } catch { return; }
  if (await gone(note.pid, { ...deps, waitMs: 3000 })) return;
  try { kill(note.pid, "SIGKILL"); } catch { /* it went meanwhile */ }
}

/** Closes the background engine the note names, once this computer confirms it holds the note's port. */
export async function closeOldEngine(dataDir: string, deps: OldEngineDeps = {}): Promise<CloseOutcome> {
  const note = await readRunning(dataDir);
  if (!note || note.mode !== "daemon") return { closed: false, why: "no background engine is noted" };
  if (!(deps.alive ?? stillAlive)(note.pid)) return { closed: false, why: "the noted engine is not running" };
  if (note.url !== `http://127.0.0.1:${note.port}`) return { closed: false, why: "the note names another address" };
  const key = (await readFile(join(dataDir, sessionTokenFileName), "utf8").catch(() => "")).trim();
  if (!/^[a-f0-9]{64}$/.test(key)) return { closed: false, why: "no window key is saved" };
  if (!(await holdsPort(note.pid, note.port, deps))) return { closed: false, why: "its port is not held by the noted engine" };
  if ((await askToClose(note, key, deps)) && (await gone(note.pid, deps))) return { closed: true, instance: note, forced: false };
  await end(note, deps);
  if (!(await gone(note.pid, deps))) return { closed: false, why: "the noted engine did not close" };
  const now = await readRunning(dataDir);
  if (now?.pid === note.pid) await clearRunning(dataDir).catch(() => undefined);
  return { closed: true, instance: note, forced: true };
}

export interface FreshEngine {
  /** This version's engine start script (dist/cli.js). */
  script: string;
  /** The runtime that runs it: Node, or the app itself as Node (ELECTRON_RUN_AS_NODE). */
  executable: string;
  dataDir: string;
  workspace: string;
  port: number;
  env?: NodeJS.ProcessEnv;
}

/** The script that starts the fresh engine on Windows, beside the scheduled task's own (src/install/daemon.ts). */
export const freshLauncherName = "branch-engine-start.vbs";

/**
 * Starts this version's engine in the background, as `branch start` does, at the port the old one had. On Windows it
 * is started the way the sign-in task starts it (src/install/daemon.ts): through the script host, so it has no window
 * and holds nothing of the app's own (a program started straight from the app would keep the app's output open).
 */
export async function startFreshEngine(options: FreshEngine, deps: { platform?: NodeJS.Platform; start?: typeof spawn; write?: (path: string, text: string) => Promise<void> } = {}): Promise<void> {
  const start = deps.start ?? spawn;
  if ((deps.platform ?? process.platform) === "win32") {
    const launcher = join(options.dataDir, freshLauncherName);
    await (deps.write ?? ((path, text) => writeFile(path, text, "utf8")))(launcher, hiddenRunner(daemonCommandLine({ ...options, launcherPath: launcher })));
    const host = start(systemTool("wscript.exe"), ["//B", "//Nologo", launcher], { env: options.env ?? process.env, stdio: "ignore", windowsHide: true });
    host.on("error", () => undefined);
    host.unref();
    return;
  }
  const child = start(options.executable, [options.script, "start"], {
    env: { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: "1", BRANCH_DATA_DIR: options.dataDir,
      BRANCH_WORKSPACE: options.workspace, BRANCH_PORT: String(options.port) },
    detached: true, stdio: "ignore",
  });
  child.on("error", () => undefined);
  child.unref();
}

export interface MoveInput<Joined> {
  dataDir: string;
  fresh: Omit<FreshEngine, "port" | "dataDir">;
  /** Whether the engine at `url` proves itself under `key` (src/engine-proof.ts). */
  proves: (url: string, key: string) => Promise<boolean>;
  /** Joins the background engine now running, when it proves itself; null otherwise. */
  join: () => Promise<Joined | null>;
  log: (line: string) => void;
  close?: typeof closeOldEngine;
  start?: typeof startFreshEngine;
  /** How long the fresh engine has to start and prove itself. */
  waitMs?: number;
}

/**
 * The whole move: a background engine that is noted and running but cannot prove itself is closed (closeOldEngine)
 * and this version's engine started in its place; resolves with the fresh engine joined, or null when there was
 * nothing to move or it could not be done, and the app then starts its own engine as it would with none running.
 */
export async function moveOldEngine<Joined>(input: MoveInput<Joined>): Promise<Joined | null> {
  const note = await readRunning(input.dataDir);
  if (note?.mode !== "daemon") return null;
  // One that proves itself is this version already (joining it failed for another reason): it is never closed here.
  const key = (await readFile(join(input.dataDir, sessionTokenFileName), "utf8").catch(() => "")).trim();
  if (!/^[a-f0-9]{64}$/.test(key) || (await input.proves(note.url, key))) return null;
  input.log("Branch is moving its background engine to this version.");
  const closed = await (input.close ?? closeOldEngine)(input.dataDir);
  if (!closed.closed) { input.log(`Branch left the background engine as it was (${closed.why}) and starts its own.`); return null; }
  await (input.start ?? startFreshEngine)({ ...input.fresh, dataDir: input.dataDir, port: closed.instance.port });
  for (const end = Date.now() + (input.waitMs ?? 60000); Date.now() < end; await pause(250)) {
    const now = await readRunning(input.dataDir);
    if (!now || now.pid === closed.instance.pid) continue;
    const joined = await input.join();
    if (joined) { input.log("Branch's background engine now runs this version."); return joined; }
  }
  input.log("Branch's background engine did not start again in time; Branch starts its own.");
  return null;
}
