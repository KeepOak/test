import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeAtomic } from "./gateway-config.js";

/**
 * What the gateway remembers between its own starts: whether it last stopped cleanly, and how the
 * worker has been crashing. Two ideas from Hermes (MIT, reimplemented): a "running" mark left behind
 * means the previous exit was not clean (`gateway/lifecycle_ledger.py`), and crashes are chained by
 * the gap between them rather than counted in a fixed window, so a slow crash loop is caught as
 * surely as a fast one (`gateway/restart_loop_guard.py`). Any trouble reading or writing this file
 * is ignored: it must never be the reason the gateway does not start.
 */
export const stateFile = "gateway-state.json";
const keepCrashes = 50;

const StateSchema = z.object({
  phase: z.enum(["running", "exited"]),
  pid: z.number().int(),
  changedAt: z.iso.datetime(),
  crashes: z.array(z.number()).max(keepCrashes),
}).strict();
export type GatewayState = z.infer<typeof StateSchema>;

export async function readState(dataDir: string): Promise<GatewayState | null> {
  try { return StateSchema.parse(JSON.parse(await readFile(join(dataDir, stateFile), "utf8"))); }
  catch { return null; }
}
async function writeState(dataDir: string, state: GatewayState): Promise<void> {
  await writeAtomic(join(dataDir, stateFile), JSON.stringify(state)).catch(() => undefined);
}

/** Marks the gateway running; answers whether the one before it stopped without saying so. */
export async function markRunning(dataDir: string, pid = process.pid): Promise<{ uncleanBefore: boolean; crashes: number[] }> {
  const before = await readState(dataDir);
  await writeState(dataDir, { phase: "running", pid, changedAt: new Date().toISOString(), crashes: before?.crashes ?? [] });
  return { uncleanBefore: before?.phase === "running", crashes: before?.crashes ?? [] };
}
export async function markExited(dataDir: string): Promise<void> {
  const before = await readState(dataDir);
  await writeState(dataDir, { phase: "exited", pid: process.pid, changedAt: new Date().toISOString(), crashes: before?.crashes ?? [] });
}

export interface CrashVerdict {
  /** How many crashes follow one another with no quiet gap longer than the limit. */
  chained: number;
  /** True once the chain is long enough that the gateway must slow down and stop carrying on work by itself. */
  tripped: boolean;
  /** How long to wait before the next worker. */
  delayMs: number;
}

/** Pure: the verdict for a list of crash times (milliseconds), newest last. */
export function crashVerdict(crashes: number[], limits: { maxQuickCrashes: number; gapSeconds: number }): CrashVerdict {
  let chained = crashes.length ? 1 : 0;
  for (let index = crashes.length - 1; index > 0; index--) {
    if (crashes[index]! - crashes[index - 1]! > limits.gapSeconds * 1000) break;
    chained++;
  }
  const tripped = chained >= limits.maxQuickCrashes;
  const delayMs = tripped ? 5 * 60_000 : chained === 0 ? 0 : Math.min(30_000, 500 * 2 ** (chained - 1));
  return { chained, tripped, delayMs };
}

/** Writes a crash down and answers what to do about it. */
export async function recordCrash(dataDir: string, limits: { maxQuickCrashes: number; gapSeconds: number }, at = Date.now()): Promise<CrashVerdict> {
  const before = await readState(dataDir);
  const crashes = [...(before?.crashes ?? []), at].slice(-keepCrashes);
  await writeState(dataDir, { phase: before?.phase ?? "running", pid: process.pid, changedAt: new Date(at).toISOString(), crashes });
  return crashVerdict(crashes, limits);
}
/** A worker that has stayed up long enough clears the chain. */
export async function clearCrashes(dataDir: string): Promise<void> {
  const before = await readState(dataDir);
  if (!before?.crashes.length) return;
  await writeState(dataDir, { ...before, crashes: [] });
}

/**
 * UP-PLATFORM-002, the restart storm: every start after an unclean stop is written down (in a file of its own, so an
 * older version reading `gateway-state.json` after a rollback is not confused). Three within ten minutes means
 * whatever starts Branch (the scheduled task, systemd, launchd) keeps starting a gateway that keeps dying; that is
 * said once per ten minutes. After OpenClaw's `src/daemon/restart-storm.ts` (https://github.com/openclaw/openclaw, MIT):
 * the same threshold, window and once-per-window warning.
 */
export const restartsFile = "gateway-restarts.json";
export const restartStorm = { threshold: 3, windowMs: 10 * 60_000 };
const RestartsSchema = z.object({ restarts: z.array(z.number()).max(20), warnedAt: z.number().nullable() }).strict();

/** Writes this unclean start down; answers the warning to show, or null. Never throws. */
export async function recordUncleanStart(dataDir: string, at = Date.now()): Promise<string | null> {
  const file = join(dataDir, restartsFile);
  let saved: z.infer<typeof RestartsSchema> = { restarts: [], warnedAt: null };
  try { saved = RestartsSchema.parse(JSON.parse(await readFile(file, "utf8"))); } catch { /* none yet, or unreadable */ }
  const inWindow = (time: number) => time <= at && at - time < restartStorm.windowMs;
  const restarts = [...saved.restarts.filter(inWindow), at].slice(-20);
  const warned = saved.warnedAt !== null && inWindow(saved.warnedAt);
  const storm = restarts.length >= restartStorm.threshold && !warned;
  await writeAtomic(file, JSON.stringify({ restarts, warnedAt: storm ? at : saved.warnedAt })).catch(() => undefined);
  if (!storm) return null;
  return `Branch's background engine stopped unexpectedly and was started again ${restarts.length} times in the last ten minutes. `
    + "Something keeps making it stop, so Branch may be unavailable for a minute at a time until that is fixed.";
}
