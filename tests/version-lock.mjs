/* A real lock for the versioned-folder tests: a PowerShell process opens a file with FileShare None (as a scanner or
   an indexer can), which Node's own handles never do. Released by ending that one process, by its exact id. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";

export const locksWork = process.platform === "win32";

export async function holdOpen(path) {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const quoted = path.replace(/'/g, "''");
  const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    `$f = [System.IO.File]::Open('${quoted}', 'Open', 'ReadWrite', 'None'); [Console]::Out.WriteLine('held'); Start-Sleep -Seconds 120; $f.Close()`],
  { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  let seen = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the lock was not taken in time")), 30_000);
    child.stdout.on("data", (chunk) => { seen += chunk; if (seen.includes("held")) { clearTimeout(timer); resolve(); } });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("the locking process ended early")); });
  });
  return {
    pid: child.pid,
    // Ended by its own id (the lock goes with it); never waited on for longer than a few seconds.
    release: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const gone = once(child, "exit");
      child.kill();
      await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
    },
  };
}
