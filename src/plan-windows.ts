import type { Store } from "./store.js";
import type { PlanWindowSaid } from "./rate-limit-headers.js";
import type { LimitWindow } from "./usage-limits.js";

/**
 * What each subscription sign-in has left, kept per ACCOUNT (not per model) with the moment it was
 * measured, and kept across restarts.
 *
 * Two sources, both the ones the services' own clients use, and nothing else:
 *
 * - ChatGPT: the `x-codex-{primary,secondary}-*` headers on each answer (see `codexPlanWindows`).
 * - Claude Code: Branch only runs Anthropic's `claude` program, so it reads what that program prints
 *   with `--output-format stream-json --verbose`: `rate_limit_event` lines, whose `rate_limit_info`
 *   carries `rateLimitType` ("five_hour" / "seven_day"), `utilization` (a fraction, 0 to 1) and
 *   `resetsAt` (Unix seconds). The type is published in @anthropic-ai/claude-agent-sdk (`SDKRateLimitInfo`);
 *   the program fills it from the `anthropic-ratelimit-unified-{5h,7d}-*` headers it receives.
 */

const settingsKey = "plan-windows";
const keyOf = (source: string, account: string): string => `${source}|${account}`;

type Saved = Record<string, PlanWindowSaid[]>;

export class PlanWindowStore {
  constructor(private readonly store: Pick<Store, "get" | "save">, private readonly owner: string) {}
  private all(): Saved {
    const data = this.store.get("settings", this.owner, settingsKey)?.data;
    return data && typeof data === "object" && !Array.isArray(data) ? data as Saved : {};
  }
  /** The windows last said for this account, newest reading of each window. */
  get(source: string, account: string): PlanWindowSaid[] {
    const found = this.all()[keyOf(source, account)];
    return Array.isArray(found) ? found : [];
  }
  /** A new reading replaces the same window and keeps the others (Claude reports one window at a time). */
  record(source: string, account: string, said: PlanWindowSaid[]): void {
    if (!said.length) return;
    const all = this.all(), key = keyOf(source, account);
    const kept = (all[key] ?? []).filter((old) => !said.some((fresh) => fresh.id === old.id));
    this.store.save("settings", this.owner, settingsKey, { ...all, [key]: [...said, ...kept].sort(byLength) });
  }
}

const order = ["primary", "five_hour", "secondary", "seven_day"];
const byLength = (a: PlanWindowSaid, b: PlanWindowSaid): number =>
  (a.minutes ?? Infinity) - (b.minutes ?? Infinity) || order.indexOf(a.id) - order.indexOf(b.id);

const claudeWindows: Record<string, { id: string; minutes: number }> = {
  five_hour: { id: "five_hour", minutes: 300 }, seven_day: { id: "seven_day", minutes: 10080 },
};

/** One Claude `rate_limit_info` window, as a plan window, or null when it carried no share. */
function claudeWindow(type: string, utilization: unknown, resetsAt: unknown, now: number): PlanWindowSaid | null {
  const known = claudeWindows[type];
  if (!known || typeof utilization !== "number" || !Number.isFinite(utilization)) return null;
  const reset = typeof resetsAt === "number" && resetsAt > 0 ? new Date(resetsAt * 1000).toISOString() : null;
  return { id: known.id, usedPercent: Math.max(0, Math.min(100, utilization * 100)), minutes: known.minutes,
    resetAt: reset, measuredAt: new Date(now).toISOString() };
}

/**
 * Every plan window the `claude` program reported in one run's stream-json output. A line that is
 * not a `rate_limit_event`, or an event with no utilization, adds nothing: no share is ever guessed.
 */
export function claudePlanWindows(stdout: string, now: number): PlanWindowSaid[] {
  const found = new Map<string, PlanWindowSaid>();
  for (const line of stdout.split("\n")) {
    if (!line.includes("rate_limit_event")) continue;
    let event: { type?: unknown; rate_limit_info?: Record<string, unknown> };
    try { event = JSON.parse(line); } catch { continue; }
    const info = event.type === "rate_limit_event" ? event.rate_limit_info : undefined;
    if (!info || typeof info !== "object") continue;
    const one = claudeWindow(String(info.rateLimitType ?? ""), info.utilization, info.resetsAt, now);
    if (one) found.set(one.id, one);
    const each = info.unifiedWindows as Record<string, { utilization?: unknown; resetsAt?: unknown }> | undefined;
    for (const [type, value] of Object.entries(each && typeof each === "object" ? each : {})) {
      const window = claudeWindow(type, value?.utilization, value?.resetsAt, now);
      if (window) found.set(window.id, window);
    }
  }
  return [...found.values()];
}

/** "This 5-hour window", "This week": the window's length as the service said it. */
export function planWindowTitle(window: Pick<PlanWindowSaid, "id" | "minutes">): string {
  const minutes = window.minutes;
  if (minutes === 10080) return "This week";
  if (minutes && minutes % 1440 === 0) return `This ${minutes / 1440}-day window`;
  if (minutes && minutes % 60 === 0) return `This ${minutes / 60}-hour window`;
  if (minutes) return `This ${minutes}-minute window`;
  return window.id === "secondary" ? "The longer plan window" : "The plan window";
}

/** A plan window as a row's window: a share of 100, measured, and saying where it came from. */
export function planLimitWindow(window: PlanWindowSaid, from: string): LimitWindow {
  return { id: window.id, title: planWindowTitle(window), kind: "plan", limit: 100,
    remaining: Math.round((100 - window.usedPercent) * 10) / 10, resetAt: window.resetAt,
    measuredAt: window.measuredAt, state: "measured", from };
}
