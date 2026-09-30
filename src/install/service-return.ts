import { runTool, systemTool, type RunTool } from "./windows.js";
import { launchctl, launchdDomain, launchdLabel } from "./launchd.js";
import { systemctl, systemdUnitName } from "./systemd.js";
import { daemonTaskName } from "./daemon.js";
import { startGatewayAgain, type StartAgainDeps } from "./gateway-task.js";
import { runningNow } from "./quit.js";
import { attachToRunning, type RunningInstance } from "./running.js";

/**
 * After an update or a rollback, a Branch that was running as a background service is started again
 * through that service's own manager. Closing it for the swap is a polite exit, and neither launchd
 * (`KeepAlive{SuccessfulExit:false}`) nor systemd (a stop on purpose exits 78, `RestartPreventExitStatus=78`) restarts it, so
 * without this the service stayed down until the next sign-in, and the watch that rolls a bad version
 * back never ran.
 */
export function serviceRestartCommand(platform: NodeJS.Platform, uid = process.getuid?.() ?? 501): [string, string[]] {
  if (platform === "darwin") return [launchctl, ["kickstart", "-k", `${launchdDomain(uid)}/${launchdLabel}`]];
  if (platform === "linux") return [systemctl, ["--user", "restart", systemdUnitName]];
  if (platform === "win32") return [systemTool("schtasks.exe"), ["/Run", "/TN", daemonTaskName]];
  throw new Error("Starting the background service again is not available on this kind of computer.");
}

/**
 * Windows: through the gateway's task, or, where only its Startup shortcut looks after it, by starting the installed
 * app's gateway directly (src/install/gateway-task.ts `startGatewayAgain`). `executable` is the app's own program: the
 * running `branch` command's runtime (the app run as Node), or the program BRANCH_EXECUTABLE names.
 */
export async function restartService(platform: NodeJS.Platform = process.platform, run: RunTool = runTool,
  windows: StartAgainDeps & { executable?: string } = {}): Promise<void> {
  if (platform === "win32") {
    await startGatewayAgain(windows.executable ?? process.env.BRANCH_EXECUTABLE ?? process.execPath, { run, ...windows });
    return;
  }
  const [tool, args] = serviceRestartCommand(platform);
  await run(tool, args);
}

export interface ReturnDeps {
  running?: (dataDir: string) => Promise<RunningInstance | null>;
  /** Proves the note is a Branch that really answers, with this computer's own saved key. */
  attach?: (dataDir: string) => Promise<{ instance: RunningInstance; version: string } | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  waitMs?: number;
}

/** What was running before the swap: the process, and when that process started. */
export interface Before { pid: number | null; startedAt: string | null }

/**
 * Waits for the background service to be **back**, and is strict about what that means. A note on disk
 * saying something is running is not enough on its own: the note is written by whatever started, and one
 * left behind by the copy that was just closed looks exactly like a fresh one apart from its time.
 *
 * So four things have to hold, and each of them is a way this went wrong before:
 *
 *   - it is the **background service**, not a window somebody happened to open;
 *   - it is the **version that was meant to be running** — coming back on the old one is not coming back;
 *   - it started **after** the one that was closed. The time is what decides, not the process id: an
 *     operating system is free to hand the same id out again, and a Branch that legitimately gets it is
 *     still a new Branch;
 *   - and it **answers**, on its own port, with this computer's saved key, saying the same version.
 *
 * Answers with the instance that came back, or null when none did in time.
 */
/** What is being waited for: which kind of Branch, on which version. */
export interface Expected { version: string; mode?: "app" | "daemon" }
export async function waitForReturn(
  dataDir: string, before: Before, wanted: Expected, deps: ReturnDeps = {},
): Promise<RunningInstance | null> {
  // A background service unless a caller says otherwise, because that is what every earlier caller
  // meant and a default that changes their meaning would be the worst kind of tidy-up.
  const expect = { version: wanted.version, mode: wanted.mode ?? "daemon" as const };
  const running = deps.running ?? ((dir: string) => runningNow(dir));
  const attach = deps.attach ?? (async (dir: string) => {
    const found = await attachToRunning(dir);
    // `found.version` is what the running Branch said when it was asked, not what the note on disk
    // claims. Taking the note's word would let a Branch still on the old version pass for the new one
    // as long as something had written the new number down.
    return found ? { instance: found.instance, version: found.version } : null;
  });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const now = deps.now ?? Date.now;
  const deadline = now() + (deps.waitMs ?? 60000);
  for (;;) {
    const note = await running(dataDir).catch(() => null);
    if (note && isTheReturn(note, before, expect)) {
      const answered = await attach(dataDir).catch(() => null);
      if (answered && answered.version === expect.version && answered.instance.pid === note.pid) return note;
    }
    if (now() >= deadline) return null;
    await sleep(500);
  }
}

/**
 * Whether the note on disk describes the thing we were waiting for: the right **kind** of Branch, on
 * the right version, started since the one we closed. The kind matters as much as the rest — a
 * background service answering where a window was expected is not the window coming back, and taking
 * it for one hands the owner a computer with no window on it and a line saying there is.
 */
function isTheReturn(note: RunningInstance, before: Before, expect: Expected): boolean {
  if (note.mode !== expect.mode || note.version !== expect.version) return false;
  if (before.startedAt === null) return note.pid !== before.pid;
  return Date.parse(note.startedAt) > Date.parse(before.startedAt);
}
