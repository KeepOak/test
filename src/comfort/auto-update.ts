import type { Store } from "../store.js";
import { readComfort } from "./settings.js";
import { lockdownActive } from "../lockdown.js";
import { diagnose } from "../diagnostic-log.js";

/**
 * R17-S17: whether the window should look for an update now, and whether it may install one.
 *
 * Installing always goes through the app's own Update button path (src/desktop/updater.ts): the
 * download is checked against its published checksum, the new version is tried on a copy of the
 * owner's work first (never-break's canary), and a safety copy is written before anything is
 * swapped. Nothing here downloads or installs; it only says what is due.
 */
export type UpdateStep = "nothing" | "check" | "install";
export interface UpdatePlan {
  mode: "off" | "check" | "install"; step: UpdateStep; reason: string; lastCheckedAt: string | null;
  /** While a ready update is held: what has to happen first, in words that finish "it installs when …". */
  until?: string;
}

const lastKey = "comfort-update-last";
export const checkEveryMs = 24 * 60 * 60 * 1000;
/**
 * Beta looks once a minute: a look is one small git request (no rate-limited API), and GitHub has built the change in
 * about two minutes (src/desktop/build-output.ts), so a merged change reaches the app in minutes, not the average of
 * two and a half spent waiting for a five-minute look.
 */
export const betaCheckEveryMs = 60 * 1000;

export function lastUpdateCheck(store: Pick<Store, "get">, owner: string): string | null {
  const at = store.get("settings", owner, lastKey)?.data?.at;
  return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : null;
}
export function noteUpdateCheck(store: Store, owner: string, now = new Date()): void {
  store.save("settings", owner, lastKey, { at: now.toISOString() });
}

/**
 * Dogfood F1 review: the release (a Dev change's `dev-<commit>`, or a version's tag) whose install last failed. The
 * automatic path does not try it again, so a change that will not build is not rebuilt every few minutes for good; it
 * tries the next one that lands. The Update button does not ask the plan, so it can always try again by hand.
 */
const failedKey = "comfort-update-failed";
export function failedInstall(store: Pick<Store, "get">, owner: string): string | null {
  const tag = store.get("settings", owner, failedKey)?.data?.tag;
  return typeof tag === "string" && tag ? tag : null;
}
/** Records a failed install; true only the first time for that release, so the owner is told once. */
export function noteFailedInstall(store: Store, owner: string, tag: string, now = new Date()): boolean {
  if (failedInstall(store, owner) === tag) return false;
  store.save("settings", owner, failedKey, { tag, at: now.toISOString() });
  return true;
}

/**
 * Dogfood F4: how long a question holds an update. The Updates card said "5 tasks are working" for five old
 * conversations waiting hours for an answer; the owner's rule is that a question left for hours does not hold one.
 * Ten minutes: a question the owner has not answered by then is kept across the update (never-break), not lost.
 */
export const questionHoldsUpdateMs = 10 * 60 * 1000;
/**
 * A task marked working that has recorded nothing for this long is not working: the engine itself calls a task that
 * silent stale (activity.ts staleAfterMs, from the owner's own limits). This is the floor used when the engine's own
 * figure is not given.
 */
export const staleTaskMs = 15 * 60 * 1000;
/**
 * The longest an update waits for busy tasks. After that it goes ahead: work is handed over to the new engine or
 * carried on after it (never-break), so a task that never ends cannot hold every fix back for good.
 */
export const maxBusyHoldMs = 3 * 60 * 60 * 1000;
export interface BusyTasks {
  /** Tasks working now (each recorded something within the stale window). */
  working: number;
  /** Tasks stopped on a question asked within the last ten minutes: they wait too. */
  asking: number;
  /** Tasks still marked working that have recorded nothing for longer than the stale window: they hold nothing. */
  stale: string[];
}
/**
 * Integration review: every task still at work in this house, whoever started it, counted in full, not from a recent
 * list. Dogfood F4: a task stopped on its question counts only while the question is fresh. A task marked working that
 * has gone silent past `staleMs` is reported as stale instead of counted.
 */
export function busyTasks(store: Pick<Store, "sqlite">, now = Date.now(), staleMs = staleTaskMs): BusyTasks {
  const since = new Date(now - staleMs).toISOString();
  const running = store.sqlite.prepare(`SELECT t.id AS id, MAX(t.updated_at, COALESCE((SELECT MAX(e.created_at) FROM events e WHERE e.run_id = t.id), '')) AS last
    FROM tasks t WHERE t.status='running'`).all() as { id: string; last: string }[];
  const asking = Number(store.sqlite.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status='needs_input' AND updated_at >= ?")
    .get(new Date(now - questionHoldsUpdateMs).toISOString())?.n ?? 0);
  return { working: running.filter((row) => row.last >= since).length, asking, stale: running.filter((row) => row.last < since).map((row) => row.id) };
}

/**
 * Busy tasks as they hold an update, at most `maxBusyHoldMs`: the time the hold began is kept, and once it is over the
 * busy tasks are reported as `overdue` instead of holding it. Stale tasks are written to the activity log once each.
 */
const holdKey = "comfort-update-held";
export function updateHold(store: Store, owner: string, busy: BusyTasks, now = Date.now()): BusyTasks & { overdue: number; heldSince: string | null } {
  const saved = store.get("settings", owner, holdKey)?.data as { since?: unknown; staleTold?: unknown } | undefined;
  const told = new Set(Array.isArray(saved?.staleTold) ? saved.staleTold.filter((id): id is string => typeof id === "string") : []);
  const fresh = busy.stale.filter((id) => !told.has(id));
  if (fresh.length) diagnose("updater", "warn", `${fresh.length} task(s) marked working have recorded nothing for a long while, so they no longer hold an update`, { fields: { tasks: fresh.slice(0, 10).join(", ") } });
  const held = busy.working + busy.asking;
  const since = held > 0 ? (typeof saved?.since === "string" ? saved.since : new Date(now).toISOString()) : null;
  const staleTold = busy.stale.slice(0, 50);
  if (since !== (typeof saved?.since === "string" ? saved.since : null) || fresh.length || staleTold.length !== told.size)
    store.save("settings", owner, holdKey, { since, staleTold });
  if (since && now - Date.parse(since) >= maxBusyHoldMs) return { working: 0, asking: 0, stale: busy.stale, overdue: held, heldSince: since };
  return { ...busy, overdue: 0, heldSince: since };
}
/** One task holding an update: the owner's own are named by id, so the window can open its conversation. */
export interface HoldingTask { id: string; sessionId: string; state: "working" | "asking" }
/**
 * The owner's own tasks that hold an update, newest first (at most ten). Other people's are only counted in
 * `busyTasks`: their conversations are not the owner's to open.
 */
export function holdingTasks(store: Pick<Store, "sqlite">, owner: string, now = Date.now(), staleMs = staleTaskMs): HoldingTask[] {
  const rows = store.sqlite.prepare(`SELECT t.id AS id, t.session_id AS sessionId, t.status AS status FROM tasks t WHERE t.owner = ? AND
    ((t.status='running' AND MAX(t.updated_at, COALESCE((SELECT MAX(e.created_at) FROM events e WHERE e.run_id = t.id), '')) >= ?)
      OR (t.status='needs_input' AND t.updated_at >= ?)) ORDER BY t.updated_at DESC LIMIT 10`)
    .all(owner, new Date(now - staleMs).toISOString(), new Date(now - questionHoldsUpdateMs).toISOString()) as { id: string; sessionId: string; status: string }[];
  return rows.map((row) => ({ id: row.id, sessionId: row.sessionId, state: row.status === "running" ? "working" : "asking" }));
}

/** What an update held by the plan is waiting on, for its line in the activity log. */
export interface UpdateWaitFacts {
  channel: string; version: string | null; busyTasks: number; workingTasks: number; askingTasks: number;
  holding: HoldingTask[]; heldSince: string | null; overdueTasks: number;
}
/** The last wait written, per owner: the window asks every 30 s to 5 min, and the same wait is written once. */
const lastWait = new Map<string, string>();
/**
 * Writes why the plan tells update by itself to wait with a ready update (a plan with `until`), only when that wait is
 * new: another reason, another version or channel. At warn, so it is kept at the log's shipped "when needed" mode; a wait
 * is never an error, so it never becomes an automatic problem report. Answers whether a line was written.
 */
export function noteUpdateWait(owner: string, plan: UpdatePlan, facts: UpdateWaitFacts): boolean {
  if (!plan.until) { lastWait.delete(owner); return false; }
  const key = JSON.stringify([plan.reason, plan.until, facts.version, facts.channel]);
  if (lastWait.get(owner) === key) return false;
  lastWait.set(owner, key);
  diagnose("updater", "warn", `Update by itself waits: ${plan.reason}`, { fields: {
    until: plan.until, version: facts.version, channel: facts.channel, busyTasks: facts.busyTasks, workingTasks: facts.workingTasks,
    askingTasks: facts.askingTasks, tasks: facts.holding.map((task) => `${task.id} (${task.state})`).join(", "),
    heldSince: facts.heldSince, overdueTasks: facts.overdueTasks,
  } });
  return true;
}

/**
 * The last thing that went wrong while Branch updated itself (a look, a build, an install, or asking the engine), in
 * the updater's or engine's own words. It is kept until a look goes through cleanly, so Settings › Updates can say it.
 */
const problemKey = "comfort-update-problem";
export interface UpdateProblem { message: string; at: string }
export function updateProblem(store: Pick<Store, "get">, owner: string): UpdateProblem | null {
  const data = store.get("settings", owner, problemKey)?.data;
  return typeof data?.message === "string" && data.message && typeof data.at === "string" ? { message: data.message, at: data.at } : null;
}
/** Records a failure; true when it is new (another message than the one kept), so the owner is told once. */
export function noteUpdateProblem(store: Store, owner: string, message: string, now = new Date()): boolean {
  const before = updateProblem(store, owner);
  store.save("settings", owner, problemKey, { message, at: now.toISOString() });
  return before?.message !== message;
}
export function clearUpdateProblem(store: Store, owner: string): void {
  if (updateProblem(store, owner)) store.save("settings", owner, problemKey, { message: "", at: new Date().toISOString() });
}

/** The tasks that hold an update: those working, and those whose question is still fresh. */
export function busyTaskCount(store: Pick<Store, "sqlite">, now = Date.now()): number {
  // The count alone, as it stands (no hold limit): the plan and readiness apply `updateHold`.
  const busy = busyTasks(store, now);
  return busy.working + busy.asking;
}

export interface PlanFacts {
  /** Tasks still working, or waiting on a question asked within the hour (dogfood F4); an install never starts while one is. */
  busyTasks: number;
  /** Of those, the ones working now and the ones waiting on a fresh question, so the wait is said the right way. */
  workingTasks?: number;
  askingTasks?: number;
  /** What the updater last said: "available" means a newer version is known. */
  updaterPhase?: string | undefined;
  /** Which release the updater is talking about (its tag), so one whose install failed is not tried again by itself. */
  updaterTag?: string | undefined;
  /** Tasks still busy after the update waited `maxBusyHoldMs` for them (updateHold): it goes ahead, and says so. */
  overdueTasks?: number;
  now?: Date;
}

/** What is due, in plain words. */
export function updatePlan(store: Pick<Store, "get">, owner: string, facts: PlanFacts): UpdatePlan {
  const settings = readComfort(store, owner, "notify");
  const mode = settings.autoUpdate;
  const lastCheckedAt = lastUpdateCheck(store, owner);
  const plan = (step: UpdateStep, reason: string, until?: string): UpdatePlan => ({ mode, step, reason, lastCheckedAt, ...(until ? { until } : {}) });
  if (mode === "off") return plan("nothing", "Updates are only looked for when you press Check.");
  const now = (facts.now ?? new Date()).getTime();
  const interval = settings.releaseChannel === "stable" ? checkEveryMs : betaCheckEveryMs;
  const due = lastCheckedAt === null || now - Date.parse(lastCheckedAt) >= interval;
  /* Beta builds Branch on this computer from every merged change (dogfood F1, the owner's decision): with "update by
     itself" on it is built and installed like any other update, once no task is working, so each fix is seen live. */
  const install = mode === "install";
  if (install && facts.updaterPhase === "available") {
    // NAS a870cea: a failed release is not tried again, but looking goes on as usual, or the next one would never be found.
    if (facts.updaterTag && failedInstall(store, owner) === facts.updaterTag)
      return due ? plan("check", "Looking past the version that did not install here for a newer one.")
        : plan("nothing", "The newest version did not install here last time, so it is not tried again by itself. The next one is, as soon as it lands; Update tries this one now.", "a newer version lands");
    // Lockdown: nothing starts by itself, and swapping in new code is the most far-reaching of all. It waits; the owner's
    // own Update button (which never asks this plan) still installs it.
    if (lockdownActive(store, owner))
      return plan("nothing", "A newer version is ready; while Lockdown is on it does not install by itself. Update installs it now.", "Lockdown is off");
    if (facts.busyTasks > 0) {
      const asking = facts.askingTasks ?? 0, working = facts.workingTasks ?? facts.busyTasks - asking;
      return working > 0 || asking === 0
        ? plan("nothing", "A newer version is ready; it installs once no task is working.", "no task is working")
        : plan("nothing", "A newer version is ready; it installs once the questions asked in the last hour are answered.", "the questions asked in the last hour are answered");
    }
    if (facts.overdueTasks) return plan("install", `A newer version has waited three hours for ${facts.overdueTasks} task(s), so it is installed now; the work carries on after it.`);
    return plan("install", "A newer version is ready and nothing is working, so it is installed now, safely.");
  }
  // An available update is remembered by GitHub, not by this process. After a restart the updater
  // starts idle, so look again even if yesterday's check timestamp is still fresh.
  if (install && facts.updaterPhase === "idle")
    return plan("check", "Checking for an update that may have waited through the last restart.");
  if (!due) return plan("nothing", settings.releaseChannel === "beta"
    ? "Beta updates were looked for less than a minute ago."
    : "Updates were looked for less than a day ago.");
  return plan("check", install ? "Looking for a newer version to install." : "Looking for a newer version to tell you about.");
}

/**
 * The last time anything looked at the update plan (the app's own update loop asks it every 30 s to 5 min, whatever it
 * then does). A loop that stopped is a problem said in Settings › Updates and in the activity log, never silence.
 */
const lookedKey = "comfort-update-looked";
export function noteUpdateLook(store: Store, owner: string, now = new Date()): void {
  store.save("settings", owner, lookedKey, { at: now.toISOString() });
}
export const stalledWords = "Branch has not looked for an update since";
/** How long without a look before the loop counts as stopped: three of its slowest looks, or three hours on Stable's check-only. */
export function stalledLookMs(settings: { autoUpdate: string; releaseChannel: string }): number {
  return settings.autoUpdate === "check" && settings.releaseChannel === "stable" ? 3 * 60 * 60 * 1000 : 15 * 60 * 1000;
}
/**
 * Whether updating by itself has stopped looking: on, and no look for `stalledLookMs` since the later of the last look
 * and `since` (when this engine started). Said as a problem the first time; answers the words, or null.
 */
export function noteStalledLooks(store: Store, owner: string, since: number, now = Date.now()): string | null {
  const settings = readComfort(store, owner, "notify");
  if (settings.autoUpdate === "off") return null;
  const saved = store.get("settings", owner, lookedKey)?.data?.at;
  const last = Math.max(since, typeof saved === "string" ? Date.parse(saved) || 0 : 0);
  if (now - last < stalledLookMs(settings)) return null;
  const words = `${stalledWords} ${new Date(last).toISOString().slice(0, 16).replace("T", " ")} UTC: updating by itself has stopped. Restarting Branch starts it again.`;
  if (noteUpdateProblem(store, owner, words, new Date(now))) diagnose("updater", "error", words);
  return words;
}
