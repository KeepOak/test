import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { connectDesktopControl } from "../desktop/gateway-control.js";
import { shellLockName } from "../desktop/shell-lock.js";
import { processAlive, quitRunning, waitForExit, type QuitDeps, type QuitReport } from "./quit.js";

/** A live shell note is metadata, not authority to kill a process. */
export async function runningShell(dataDir: string, alive = processAlive): Promise<number | null> {
  try {
    const note: unknown = JSON.parse(await readFile(join(dataDir, shellLockName), "utf8"));
    if (!note || typeof note !== "object" || !("pid" in note)) return null;
    const pid = note.pid;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
  } catch { return null; }
}

async function closeShell(dataDir: string, pid: number, deps: QuitDeps): Promise<boolean> {
  let client: Awaited<ReturnType<typeof connectDesktopControl>> | null = null;
  try {
    client = await connectDesktopControl(dataDir, {}, "shell");
    if (client.pid !== pid) return false;
    const answer: unknown = await client.link.call("quit", {}, 5000);
    if (!answer || typeof answer !== "object" || !("pid" in answer) || !("closing" in answer)
      || answer.pid !== pid || answer.closing !== true) return false;
    return await waitForExit(pid, deps);
  } catch { return false; }
  finally { client?.close(); }
}

/** Close the proved shell first, then its retained engine. Never force-kill a lock-file PID. */
export async function quitShellAndEngine(dataDir: string, deps: QuitDeps = {}): Promise<QuitReport> {
  const pid = await runningShell(dataDir, deps.alive ?? processAlive);
  if (pid !== null && !(await closeShell(dataDir, pid, deps)))
    return { stopped: false, wasRunning: true, pid,
      message: "The desktop did not close through its private control channel. Quit it from its window or menu, then try again." };
  const engine = await quitRunning(dataDir, deps);
  if (engine.wasRunning || pid === null) return engine;
  return { stopped: true, wasRunning: true, pid, message: "Branch Agent has closed." };
}
