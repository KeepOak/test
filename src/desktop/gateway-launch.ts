import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Attachment } from "../install/running.js";

export const desktopGatewayFlag = "--branch-gateway";
interface LaunchChild {
  unref(): void;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "exit", listener: () => void): unknown;
}
export interface GatewayLaunchOptions {
  executable: string;
  appRoot: string;
  packaged: boolean;
  base: string;
  dataDir: string;
  workspace: string;
  join(): Promise<Attachment | null>;
  spawn?: (file: string, args: string[], env: NodeJS.ProcessEnv) => LaunchChild;
  /** Whether a broker process named in the private authority note is still alive (tests hand in a fixture). */
  brokerAlive?: (dataDir: string) => Promise<boolean>;
  waitMs?: number;
}

/**
 * The broker did not become ready. `brokerMayRun` is false only when its launch is proved over: the launched process
 * failed or ended and no other broker is named alive, so a foreground engine cannot become a second database writer.
 */
export class GatewayLaunchError extends Error {
  override name = "GatewayLaunchError";
  constructor(message: string, readonly brokerMayRun: boolean) { super(message); }
}

/** A broker writes its pid into desktop-control/authority.json once it runs; an unreadable note names none. */
export async function brokerNamedAlive(dataDir: string): Promise<boolean> {
  let pid: unknown;
  try { pid = (JSON.parse(await readFile(join(dataDir, "desktop-control", "authority.json"), "utf8")) as { pid?: unknown }).pid; }
  catch { return false; }
  return Number.isInteger(pid) && (pid as number) > 0 && pidAlive(pid as number);
}

/** Launch only the existing runtime and program files; the detached broker has its own single-instance lock. */
export async function launchDesktopGateway(options: GatewayLaunchOptions): Promise<Attachment> {
  const joined = await options.join();
  if (joined) return joined;
  const env: NodeJS.ProcessEnv = { ...process.env, BRANCH_DESKTOP_HOME: options.base, BRANCH_DATA_DIR: options.dataDir, BRANCH_WORKSPACE: options.workspace };
  delete env.ELECTRON_RUN_AS_NODE;
  // A shell's debugger/automation preload belongs to that shell, never to the detached owner.
  delete env.NODE_OPTIONS;
  const launch = options.spawn ?? ((file, args, launchEnv) => spawn(file, args,
    { env: launchEnv, detached: true, windowsHide: true, stdio: "ignore" }));
  const alive = options.brokerAlive ?? brokerNamedAlive;
  let failure: Error | null = null, ended = false;
  let child: LaunchChild;
  try { child = launch(options.executable, [...(options.packaged ? [] : [options.appRoot]), desktopGatewayFlag], env); }
  catch (error) { throw new GatewayLaunchError((error as Error).message, await alive(options.dataDir)); }
  child.once("error", (error) => { failure = error; });
  child.once("exit", () => { ended = true; });
  child.unref();
  const until = Date.now() + (options.waitMs ?? 120000);
  while (Date.now() < until) {
    const running = await options.join();
    if (running) return running;
    // An ended launch (another broker held the lock, or it failed) waits on only while some broker is still named alive.
    if (failure || ended) {
      if (!(await alive(options.dataDir))) {
        const last = await options.join();
        if (last) return last;
        throw new GatewayLaunchError((failure as Error | null)?.message ?? "Branch's background engine stopped before it was ready.", false);
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new GatewayLaunchError("Branch's background engine did not become ready. Your work has been left in place.",
    !ended || await alive(options.dataDir));
}

/**
 * A joined window whose engine stopped proving itself: `gone` when nothing is named running any more (the owner turned
 * the gateway off, or its broker ended), so the app starts again and opens its own engine or a new broker; `moved` when
 * the running note names another address to prove; otherwise `wait` (a restart or a resume from sleep in progress).
 */
export function joinedEngineVerdict(note: { pid: number; url: string } | null, url: string,
  alive: (pid: number) => boolean = pidAlive): "wait" | "moved" | "gone" {
  if (!note || !alive(note.pid)) return "gone";
  return note.url === url ? "wait" : "moved";
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
