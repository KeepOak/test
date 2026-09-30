import { startedForHere } from "./household-approvals.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { lockdownActive, lockdownBlocksAny } from "./lockdown.js";
import type { Store } from "./store.js";

/**
 * DESIGN-DIRECTION PR 1: steering or stopping one helper (a task another task started) from the helpers frame, by
 * `POST /api/runs/<helper>/steer` and `/cancel`. Stopping one helper stops it and the helpers it started (Runtime.cancel
 * walks src/helper-tree.ts); its siblings and the task that started it carry on. Who may act on a helper is decided here:
 * - the owner, or the household person the task was started for (src/household-approvals.ts startedForHere);
 * - a short-lived key never steers a helper: a steer note is read as the owner's own word (src/steer.ts). Stopping
 *   stays under the key rule every task has (src/key-context.ts keyStopRefusal);
 * - under Lockdown, a helper that may reach a tool Lockdown refuses outright is not steered: the note could only point
 *   it at what Lockdown shut.
 */
export const helperNotFound = "Run not found";
export const helperKeySteerRefusal = "A short-lived key cannot steer a helper. Steer it in the app window.";
export const helperLockdownSteerRefusal =
  "Lockdown is on, and this helper can reach tools Lockdown refuses, so it cannot be steered. Stop it, or turn Lockdown off in Settings.";

/** The task that started this one, when it is a helper of a task still on record (a learning pass names no task). */
export function helperParent(store: Store, runId: string): string | null {
  const parent = store.events(runId).find((event) => event.kind === "run.started")?.data.parentRunId;
  return typeof parent === "string" && store.run(parent) ? parent : null;
}

/** Why the person at the window may not act on this helper, or null. Not theirs reads as not found. */
function notTheirs(store: Store, runId: string): { status: number; message: string } | null {
  return startedForHere(store, runId) ? null : { status: 404, message: helperNotFound };
}

/** Why this helper may not be stopped here, or null (also null for a task that is not a helper). */
export function helperStopRefusal(store: Store, runId: string): { status: number; message: string } | null {
  if (!helperParent(store, runId)) return null;
  return notTheirs(store, runId);
}

/** Why this helper may not be steered here, or null (also null for a task that is not a helper). */
export function helperSteerRefusal(store: Store, owner: string, runId: string): { status: number; message: string } | null {
  if (!helperParent(store, runId)) return null;
  const theirs = notTheirs(store, runId);
  if (theirs) return theirs;
  if (startedWithShortLivedKey()) return { status: 403, message: helperKeySteerRefusal };
  const permissions = store.events(runId).find((event) => event.kind === "run.started")?.data.permissions;
  const reach = Array.isArray(permissions) ? permissions.map(String) : null;
  // Nothing recorded about what it may reach reads as reaching everything.
  if (lockdownActive(store, owner) && (reach === null || lockdownBlocksAny(reach)))
    return { status: 403, message: helperLockdownSteerRefusal };
  return null;
}
