import { readFileSync } from "node:fs";

/** A signal-zero probe includes unreaped Linux zombies, which have already finished their work. */
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); }
  catch (error) { return (error as { code?: string }).code === "EPERM"; }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm is parenthesized and may itself contain spaces, newlines or ')'. All later fields are
    // scalars, so the final ')' ends comm. Only a positively identified exited state is ignored.
    const end = stat.lastIndexOf(")");
    if (!stat.startsWith(`${pid} (`) || end < 0) return true;
    return !/^ [ZX] \d+(?:\s|$)/.test(stat.slice(end + 1));
  } catch {
    // procfs may be absent/restricted, or the process may have changed since the probe. Let the
    // next signal-zero probe establish that it is gone; an unreadable state is not proof of exit.
    return true;
  }
}
