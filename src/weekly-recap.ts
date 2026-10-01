import { z } from "zod";
import type { Run } from "./contracts.js";
import type { Store } from "./store.js";

export const RecapSettingsSchema = z.object({
  manualMinutesPerTask: z.number().min(0).max(1440).nullable().default(null),
}).strict();
export interface RecapGroup { trunkId: string | null; name: string; completed: number }
const cap = 5000;
const day = 86_400_000;

export function recapSettings(store: Store, owner: string) {
  const parsed = RecapSettingsSchema.safeParse(store.get("settings", owner, "weekly_recap")?.data ?? {});
  return parsed.success ? parsed.data : RecapSettingsSchema.parse({});
}

/** Adapted from Hermes insights.py _compute_overview at 16b214e1a1f0544218b1cf8c21b923b4e1c62768 (MIT).
 * A task's recorded elapsed time is activity, never a measurement of its owner's time saved. */
function recordedMinutes(runs: readonly Run[]): number {
  const durations = runs.map((run) => Date.parse(run.updatedAt) - Date.parse(run.createdAt));
  return Math.round(durations.filter((duration) => Number.isFinite(duration) && duration > 0)
    .reduce((total, duration) => total + duration, 0) / 60_000);
}

export function weeklyRecap(store: Store, owner: string, trunkName: (id: string) => string | null, now = new Date()) {
  const until = now.toISOString(), since = new Date(now.getTime() - 7 * day).toISOString();
  const candidates = store.completedRunsBetween(owner, since, until, cap + 1);
  const capped = candidates.length > cap, scanned = candidates.slice(0, cap);
  const aside = store.engineOwnRuns(scanned.map((run) => run.id));
  const runs = scanned.filter((run) => !aside.has(run.id));
  const trunks = store.runTrunkIds(runs.map((run) => run.id));
  const groups = new Map<string, RecapGroup>();
  for (const run of runs) {
    const trunkId = trunks.get(run.id) ?? null;
    const key = trunkId ?? "";
    const group = groups.get(key) ?? { trunkId, name: trunkId ? trunkName(trunkId) ?? "Removed Trunk" : "Other tasks", completed: 0 };
    group.completed += 1;
    groups.set(key, group);
  }
  const settings = recapSettings(store, owner);
  const trunkTasks = [...groups.values()].filter((group) => group.trunkId !== null).reduce((total, group) => total + group.completed, 0);
  return { since, until, completed: runs.length, trunkTasks, capped, scanned: scanned.length,
    groups: [...groups.values()].sort((a, b) => b.completed - a.completed),
    recordedMinutes: recordedMinutes(runs), settings,
    estimatedMinutesSaved: settings.manualMinutesPerTask === null ? null : Math.round(trunkTasks * settings.manualMinutesPerTask),
    estimateBasis: "Owner's usual manual minutes per completed Trunk task; excludes other tasks, helpers and engine activity. Not a measured saving.",
    countBasis: "Completed retained tasks in the last seven days, by recorded finish time and original trunk.turn marker; engine/helper/temporary/deleted tasks excluded." };
}
