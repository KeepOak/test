import type { Run } from "../contracts.js";
import type { RunOptions } from "../runtime.js";
import { lockedDown } from "../lockdown.js";
import type { Store } from "../store.js";
import { autonomyLimits } from "./settings.js";

/**
 * R17-B: the one way anything in this folder starts a task by itself.
 *
 * - It is a task like any other (`Runtime.run`), marked as started by a schedule, so the owner's
 *   approval rules are capped exactly as for a timed job and an "ask first" rule stops it to wait.
 * - Its steps and tokens are bounded (Settings › Automations, "Limits"), and every part together may
 *   start only so many turns a day; each item has its own daily count and its own gap as well.
 * - Its permissions are never wider than what the owner holds now: `narrowed` keeps only those, and
 *   never the ones that make or change schedules or settings, install anything, or propose more
 *   automations. Every turn is narrowed here, whoever asked for it.
 * - Nothing starts while Lockdown is on, and `cancel` stops the turns that are working (a part
 *   switched off, or Lockdown turned on).
 */
export interface RunnerHost {
  readonly owner: string;
  run(options: RunOptions): Promise<Run>;
  cancel(runId: string): boolean;
}

export interface TurnRequest {
  /** What the count is kept under: `loop:<session>`, `order:<id>`, `procedure:<id>`. */
  key: string;
  prompt: string;
  sessionId?: string;
  temporary?: boolean;
  permissions?: string[];
  /** How many turns this one item may take in a day. */
  perDay: number;
  /** The least time between two of its turns. */
  gapMs: number;
  signal?: AbortSignal;
}

export type TurnOutcome = { ran: true; run: Run } | { ran: false; reason: string };

interface Counts { day: string; total: number; items: Record<string, { count: number; last: number; prev?: number }> }
const countsKey = "autonomy-counts";

/** Permissions no automatic turn ever holds: schedules, settings, installing, and proposing more. */
const never = new Set(["skills.write", "secrets.write", "settings.write", "models.switch"]);
const neverHeld = (p: string): boolean =>
  never.has(p) || p.startsWith("schedules.") || p.startsWith("addons.") || p.endsWith(".manage") || p.endsWith(".propose");

/** Only the permissions the owner holds now, and none of those above. */
export function narrowed(wanted: readonly string[] | undefined, held: readonly string[]): string[] {
  const allowed = new Set(held.filter((p) => !neverHeld(p)));
  return [...new Set((wanted ?? [...allowed]).filter((p) => allowed.has(p)))];
}

export class Runner {
  /** Runs this runner started, so a "task finished" trigger never fires on its own work. */
  readonly started = new Set<string>();
  /** Turns working now, by run id, with the key they count under. */
  private readonly working = new Map<string, string>();
  constructor(private readonly store: Store, private readonly host: RunnerHost,
    /** The permissions the owner holds right now. */
    private readonly holds: () => string[], private readonly now: () => Date = () => new Date()) {}

  /** Cancels the working turns whose key matches; returns how many. */
  cancel(match: (key: string) => boolean = () => true): number {
    let count = 0;
    for (const [runId, key] of this.working) if (match(key) && this.host.cancel(runId)) count++;
    return count;
  }

  private counts(): Counts {
    const day = this.now().toISOString().slice(0, 10);
    const saved = this.store.get("settings", this.host.owner, countsKey)?.data as Counts | undefined;
    return saved && saved.day === day ? saved : { day, total: 0, items: saved?.items ?? {} };
  }

  /** Why this item may not start a turn now, or null. */
  held(key: string, perDay: number, gapMs: number): string | null {
    if (lockedDown(this.store, this.host.owner)) return "Lockdown is on, so nothing starts by itself.";
    const counts = this.counts(), limits = autonomyLimits(this.store, this.host.owner);
    const item = counts.items[key];
    const today = item && new Date(item.last).toISOString().slice(0, 10) === counts.day ? item.count : 0;
    if (counts.total >= limits.runsPerDay) return `All automatic work together has reached today's limit of ${limits.runsPerDay} turns.`;
    if (today >= perDay) return `This has already run ${perDay} times today, its limit.`;
    if (item && this.now().getTime() - item.last < gapMs) return "It ran a moment ago; it waits before running again.";
    return null;
  }

  private count(key: string, step: 1 | -1): void {
    const counts = this.counts();
    const item = counts.items[key];
    const sameDay = item && new Date(item.last).toISOString().slice(0, 10) === counts.day;
    const count = Math.max(0, (sameDay ? item.count : 0) + step);
    // Taking a turn back also gives back its moment, so the retry is not held by the gap.
    counts.items[key] = step > 0
      ? { count, last: this.now().getTime(), prev: item?.last ?? 0 }
      : { count, last: item?.prev ?? 0, prev: item?.prev ?? 0 };
    counts.total = Math.max(0, counts.total + step);
    // Items not seen for a week are let go of, so the record does not grow for ever.
    const week = this.now().getTime() - 7 * 86_400_000;
    for (const [name, value] of Object.entries(counts.items)) if (value.last < week) delete counts.items[name];
    this.store.save("settings", this.host.owner, countsKey, { ...counts });
  }

  /**
   * eng-trunk-controls: why nothing may start in this conversation now (the Trunk it belongs to is paused),
   * in words, or null. `createBranch` connects it; on its own nothing is held.
   */
  sessionHeld: (sessionId: string) => string | null = () => null;

  /** Starts one bounded turn, or says why not. The turn is counted before it starts. */
  async turn(request: TurnRequest): Promise<TurnOutcome> {
    const reason = (request.sessionId ? this.sessionHeld(request.sessionId) : null) ?? this.held(request.key, request.perDay, request.gapMs);
    if (reason) return { ran: false, reason };
    this.count(request.key, 1);
    const limits = autonomyLimits(this.store, this.host.owner);
    let run: Run, startedId = "";
    try {
      run = await this.startRun(request, limits, (id) => { startedId = id; });
    } catch (error) {
      this.working.delete(startedId);
      // The conversation is still answering something else: this turn waits, and is not counted.
      if (!busy.test(String((error as Error)?.message))) throw error;
      this.count(request.key, -1);
      return { ran: false, reason: "The conversation is busy; it tries again on the next beat." };
    }
    this.working.delete(run.id);
    this.started.add(run.id);
    if (this.started.size > 500) this.started.delete(this.started.values().next().value!);
    return { ran: true, run };
  }

  private startRun(request: TurnRequest, limits: ReturnType<typeof autonomyLimits>, onId: (id: string) => void): Promise<Run> {
    return this.host.run({
      prompt: request.prompt, source: "schedule", onTextDelta: () => undefined,
      budget: { maxSteps: limits.stepsPerTurn, maxTokens: limits.tokensPerTurn },
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      ...(request.temporary ? { temporary: true } : {}),
      permissions: narrowed(request.permissions, this.holds()),
      ...(request.signal ? { signal: request.signal } : {}),
      onStarted: (started) => { onId(started.id); this.started.add(started.id); this.working.set(started.id, request.key); },
    });
  }
}
const busy = /already has an active run/;
