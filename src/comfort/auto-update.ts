import type { Store } from "../store.js";
import { readComfort } from "./settings.js";

/**
 * R17-S17: whether the window should look for an update now, and whether it may install one.
 *
 * Installing always goes through the app's own Update button path (src/desktop/updater.ts): the
 * download is checked against its published checksum, the new version is tried on a copy of the
 * owner's work first (never-break's canary), and a safety copy is written before anything is
 * swapped. Nothing here downloads or installs; it only says what is due.
 */
export type UpdateStep = "nothing" | "check" | "install";
export interface UpdatePlan { mode: "off" | "check" | "install"; step: UpdateStep; reason: string; lastCheckedAt: string | null }

const lastKey = "comfort-update-last";
export const checkEveryMs = 24 * 60 * 60 * 1000;
export const betaCheckEveryMs = 5 * 60 * 1000;

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
 */
export const questionHoldsUpdateMs = 60 * 60 * 1000;
export interface BusyTasks {
  /** Tasks working now. */
  working: number;
  /** Tasks stopped on a question asked within the last hour: swapping the program would lose it, so they wait too. */
  asking: number;
}
/**
 * Integration review: every task still at work in this house, whoever started it, counted in full, not from a recent
 * list. Dogfood F4: a task stopped on its question counts only while the question is newer than an hour.
 */
export function busyTasks(store: Pick<Store, "sqlite">, now = Date.now()): BusyTasks {
  const count = (sql: string, ...args: string[]): number => Number(store.sqlite.prepare(sql).get(...args)?.n ?? 0);
  return {
    working: count("SELECT COUNT(*) AS n FROM tasks WHERE status='running'"),
    asking: count("SELECT COUNT(*) AS n FROM tasks WHERE status='needs_input' AND updated_at >= ?", new Date(now - questionHoldsUpdateMs).toISOString()),
  };
}
/** The tasks that hold an update: those working, and those whose question is still fresh. */
export function busyTaskCount(store: Pick<Store, "sqlite">, now = Date.now()): number {
  const busy = busyTasks(store, now);
  return busy.working + busy.asking;
}

export interface PlanFacts {
  /** Tasks still working, or waiting on a question asked within the hour (dogfood F4); an install never starts while one is. */
  busyTasks: number;
  /** What the updater last said: "available" means a newer version is known. */
  updaterPhase?: string | undefined;
  /** Which release the updater is talking about (its tag), so one whose install failed is not tried again by itself. */
  updaterTag?: string | undefined;
  now?: Date;
}

/** What is due, in plain words. */
export function updatePlan(store: Pick<Store, "get">, owner: string, facts: PlanFacts): UpdatePlan {
  const settings = readComfort(store, owner, "notify");
  const mode = settings.autoUpdate;
  const lastCheckedAt = lastUpdateCheck(store, owner);
  const plan = (step: UpdateStep, reason: string): UpdatePlan => ({ mode, step, reason, lastCheckedAt });
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
        : plan("nothing", "The newest version did not install here last time, so it is not tried again by itself. The next one is, as soon as it lands; Update tries this one now.");
    if (facts.busyTasks > 0) return plan("nothing", "A newer version is ready; it installs once no task is working.");
    return plan("install", "A newer version is ready and nothing is working, so it is installed now, safely.");
  }
  // An available update is remembered by GitHub, not by this process. After a restart the updater
  // starts idle, so look again even if yesterday's check timestamp is still fresh.
  if (install && facts.updaterPhase === "idle")
    return plan("check", "Checking for an update that may have waited through the last restart.");
  if (!due) return plan("nothing", settings.releaseChannel === "beta"
    ? "Beta updates were looked for less than five minutes ago."
    : "Updates were looked for less than a day ago.");
  return plan("check", install ? "Looking for a newer version to install." : "Looking for a newer version to tell you about.");
}
