import type { DatabaseSync } from "node:sqlite";
import { isSignInConnection } from "../accounts/trunk-guard.js";
import { presetRunsLocally, type ModelPreset } from "../models.js";
import { learningTaskPrefix } from "../skill-authoring.js";
import type { SeasonsSettings } from "./settings.js";

/**
 * The two gates every overnight step passes before it may ask a model: which model (never one that spends money
 * unless the owner allowed it) and whether now is a quiet moment (never while the owner works).
 */
export type ModelKind = "local" | "sign-in" | "billed";
const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Where a connection answers and how it is paid for: on this computer, a subscription sign-in, or billed per call. */
export function modelKind(preset: ModelPreset): ModelKind {
  if (presetRunsLocally(preset)) return "local";
  try { if (preset.endpoint && localHosts.has(new URL(preset.endpoint).hostname.toLowerCase())) return "local"; } catch { /* not an address */ }
  return isSignInConnection(preset) ? "sign-in" : "billed";
}

export type OvernightModel = { preset: ModelPreset; kind: ModelKind } | { preset: null; reason: "no-free-model" };
/**
 * The connection the night uses. A model on this computer first, then the owner's subscription sign-in, and a
 * connection billed per call only when the owner turned `paidModels` on (ship-on rule (a)). The owner's default
 * connection wins within each kind. A household person's night never uses the owner's sign-in: a sign-in answers
 * only work the owner is behind (trunks-use-subscriptions).
 */
export function overnightModel(presets: readonly ModelPreset[], defaultId: string, paidModels: boolean, forOwner: boolean): OvernightModel {
  const ordered = [...presets].sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId));
  const allowed: ModelKind[] = ["local", ...(forOwner ? ["sign-in" as const] : []), ...(paidModels ? ["billed" as const] : [])];
  for (const kind of allowed) {
    const preset = ordered.find((entry) => modelKind(entry) === kind);
    if (preset) return { preset, kind };
  }
  return { preset: null, reason: "no-free-model" };
}

export type QuietReason = "off" | "outside-night" | "task-running" | "owner-active";
/** Whether this local hour is inside the night window, which may wrap past midnight. */
export function inNight(settings: Pick<SeasonsSettings, "nightFrom" | "nightTo">, now: Date): boolean {
  const hour = now.getHours(), { nightFrom: from, nightTo: to } = settings;
  if (from === to) return true;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * The owner's own tasks, leaving out the learning passes' own rows and every helper a task started (a helper is
 * never the owner at the keyboard). A night's own model calls therefore never count as the owner being active.
 */
const ownWork = `owner=? AND prompt NOT LIKE '${learningTaskPrefix}%' AND NOT EXISTS (SELECT 1 FROM events e WHERE e.run_id=tasks.id
  AND e.kind='run.started' AND json_extract(e.data,'$.parentRunId') IS NOT NULL)`;

/** Whether the night may do a step now: switched on, inside the window, nothing running and nobody at work. */
export function quietNow(db: DatabaseSync, owner: string, settings: SeasonsSettings, now: Date): { quiet: true } | { quiet: false; reason: QuietReason } {
  if (settings.rings === "off") return { quiet: false, reason: "off" };
  if (!inNight(settings, now)) return { quiet: false, reason: "outside-night" };
  const running = Number(db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE ${ownWork} AND status='running'`).get(owner)!.n);
  if (running) return { quiet: false, reason: "task-running" };
  const last = db.prepare(`SELECT MAX(updated_at) AS at FROM tasks WHERE ${ownWork}`).get(owner)!.at;
  if (typeof last === "string" && now.getTime() - Date.parse(last) < settings.idleMinutes * 60_000) return { quiet: false, reason: "owner-active" };
  return { quiet: true };
}

/** The local calendar date a night belongs to: a night that starts after midnight belongs to the evening before. */
export function nightOf(now: Date, settings: Pick<SeasonsSettings, "nightFrom" | "nightTo">): string {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (settings.nightFrom > settings.nightTo && now.getHours() < settings.nightTo) day.setDate(day.getDate() - 1);
  if (settings.nightFrom <= settings.nightTo) day.setDate(day.getDate() - 1);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}
