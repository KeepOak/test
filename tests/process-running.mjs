import { processAlive } from "../dist/install/process-alive.js";

/** Positive PIDs only: an exited leader says nothing about its process group. */
export function processRunning(pid, probe = () => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new RangeError("Expected a positive process PID");
  if (!probe()) return false;
  // Preserve the caller's signal-error policy before the conservative Linux state probe.
  return process.platform !== "linux" || processAlive(pid);
}
