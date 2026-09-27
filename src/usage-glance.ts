import { z } from "zod";
import { optionalFields } from "./feature-switches.js"; // Q65
import type { Store } from "./store.js";
import type { LimitRow, LimitsView, LimitWindow } from "./usage-limits.js";

/**
 * Redesign phase 1: the small ring under the message box, and the prompt at 95%.
 *
 * The ring shows how much the tightest connection has left, drawn from the same rows as Settings ›
 * Data & usage › "What each connection has left" and held to the same rule: a share is only ever
 * worked out where a service gave both a limit and a remainder, and never for money, which has no
 * denominator a provider gave us. Where nothing was reported the ring says so and draws no share.
 *
 * The prompt at 95% only asks. Pressing "Save progress" sends each of the owner's running tasks a
 * note through the ordinary steering channel, asking it to write down where it is and what is left.
 * Nothing is paused, stopped or switched: Branch has no pause, and this does not invent one.
 */

export const glanceRingChoices = ["shown", "hidden"] as const;
export const saveProgressChoices = ["off", "ask"] as const;
export const UsageGlanceSettingsSchema = z.object({
  /** The ring under the message box. Shown, because the owner asked to see it; one switch hides it. */
  ring: z.enum(glanceRingChoices).default("shown"),
  /** At 95% used, offer to ask running tasks to save their progress. "ask" only ever asks. */
  saveProgress: z.enum(saveProgressChoices).default("ask"),
}).strict();
export type UsageGlanceSettings = z.infer<typeof UsageGlanceSettingsSchema>;
const settingsKey = "usage-glance";

export function usageGlanceSettings(store: Pick<Store, "get">, owner: string): UsageGlanceSettings {
  const saved = UsageGlanceSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? saved.data : UsageGlanceSettingsSchema.parse({});
}
export function saveUsageGlanceSettings(store: Pick<Store, "get" | "save">, owner: string, input: unknown): UsageGlanceSettings {
  // Q65: only the choice that was sent; `.partial()` put the other back to its default.
  const wanted = optionalFields(UsageGlanceSettingsSchema).parse(input ?? {});
  const next = UsageGlanceSettingsSchema.parse({ ...usageGlanceSettings(store, owner), ...wanted });
  store.save("settings", owner, settingsKey, next);
  return next;
}

/** When a window is this used up (or more), the prompt may ask. */
export const saveProgressAt = 95;

/**
 * The share of a window that is left, 0 to 100, or null when no share may be said: money, a window
 * with no limit, or one whose remainder nobody gave. The same guard the Usage screen draws its bars by.
 */
export function shareLeft(window: LimitWindow): number | null {
  if (window.kind === "money" || window.limit === null || window.limit <= 0 || window.remaining === null) return null;
  return Math.max(0, Math.min(100, (window.remaining / window.limit) * 100));
}

export interface GlanceTightest {
  connection: string;
  connectionName: string;
  accountLabel: string | null;
  windowTitle: string;
  /** Whole percent left, rounded down so 4.6% left never reads as 5%. */
  percentLeft: number;
  estimated: boolean;
  resetAt: string | null;
}
/** A window at or past 95% used that a service measured; the prompt asks once per key. */
export interface GlanceCrossing {
  key: string;
  connectionName: string;
  accountLabel: string | null;
  percentUsed: number;
}

const rowName = (row: LimitRow): string => (row.accountLabel ? `${row.connectionName} — ${row.accountLabel}` : row.connectionName);

/** The connection with the least left, among windows that can honestly be drawn as a share. */
export function tightestOf(rows: LimitRow[]): GlanceTightest | null {
  let best: GlanceTightest | null = null;
  for (const row of rows) for (const window of row.windows) {
    const share = shareLeft(window);
    if (share === null || (best && best.percentLeft <= Math.floor(share))) continue;
    best = { connection: row.connection, connectionName: row.connectionName, accountLabel: row.accountLabel,
      windowTitle: window.title, percentLeft: Math.floor(share), estimated: window.state === "estimated", resetAt: window.resetAt };
  }
  return best;
}

/**
 * Every measured window at or past 95% used. The key names the connection, the account, the window
 * and when it refills, so the prompt asks at most once per window; a window that never said when
 * it refills is keyed by the day instead.
 */
export function crossingsOf(rows: LimitRow[], now: number): GlanceCrossing[] {
  const out: GlanceCrossing[] = [];
  for (const row of rows) for (const window of row.windows) {
    const share = shareLeft(window);
    if (share === null || window.state !== "measured" || 100 - share < saveProgressAt) continue;
    const refill = window.resetAt ?? new Date(now).toISOString().slice(0, 10);
    out.push({ key: [row.connection, row.account ?? "", window.id, refill].join("|"),
      connectionName: rowName(row), accountLabel: row.accountLabel, percentUsed: Math.round(100 - share) });
  }
  return out;
}

/** This month's estimated spend: tasks with a price are summed, tasks without one are only counted. */
export interface GlanceMonth { cost: number; pricedRuns: number; unpricedRuns: number }

export type UsageGlance =
  | { available: false }
  | { available: true; settings: UsageGlanceSettings; tightest: GlanceTightest | null; crossings: GlanceCrossing[];
    running: number; rows: LimitRow[]; summary: string; empty: boolean; month?: GlanceMonth };

/** What the ring and its popover show, built from rows already read. */
/**
 * Dogfood C3 (CodexBar-style): the ring is about what the next message spends, so with the connection in use known it
 * reads only that connection's account in use, and says nothing rather than borrow another account's number. The
 * popover still lists every account.
 */
export function nextRows(rows: LimitRow[], active: string | null | undefined): LimitRow[] {
  if (!active) return rows;
  const mine = rows.filter((row) => row.connection === active);
  if (!mine.length) return rows;
  return mine.filter((row) => row.account === null || row.inUse);
}
export function glanceFrom(view: LimitsView, settings: UsageGlanceSettings, running: number, now: number, month?: GlanceMonth, active?: string | null): UsageGlance {
  return { available: true, settings, tightest: tightestOf(nextRows(view.rows, active)), crossings: crossingsOf(view.rows, now),
    running, rows: view.rows, summary: view.summary, empty: view.empty, ...(month ? { month } : {}) };
}

/** The note each running task is sent when the owner presses "Save progress". */
export const saveProgressNote =
  "One of your connections is nearly out of its allowance. Before you go on, write a short checkpoint note in this "
  + "conversation: what you have done so far, where you are now, and what is left to do, so the work can be picked up "
  + "again if the allowance runs out. Then carry on.";
