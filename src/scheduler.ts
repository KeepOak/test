import { randomBytes, randomUUID } from "node:crypto";
import { lateNote } from "./never-break/resume.js"; // mac3/never-break
import { neverBreakModeSync } from "./never-break/gateway-config.js"; // mac3/never-break
import { z } from "zod";
import { startedFromChat } from "./key-context.js"; // mac7/chat-source
import type { ToolContext, Run } from "./contracts.js";
import type { Store, SavedRecord } from "./store.js";
import type { Runtime } from "./runtime.js";
import type { ToolRegistry } from "./registry.js";
import type { SuiteRunner } from "./evaluation-runner.js";
import { GateScriptSchema, afterGateFailure, checkGateProgram, gateFingerprint, gatePrompt, runGate, type GateRunner, type GateScript } from "./job-gate.js";
import { Heartbeat, automationHealth, quietSwitches, quietWord, saveQuietSwitches, registerHeartbeat, type Health, type QuietMode } from "./heartbeat.js";
import { nextCronOccurrence, nextWallOccurrence, validCron } from "./recurrence.js";

const timezone = z.string().min(1).max(64).refine((zone) => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return true; } catch { return false; }
}, "Unknown timezone");
const sendingToChats = "Sending messages to your chats";
const trunkMayNotSend = "The Trunk that made this schedule may no longer send to chats, so its result was kept here.";
export const ScheduleSchema = z
  .object({
    prompt: z.string().min(1).max(8000),
    dueAt: z.iso.datetime(),
    /** reminder: a note in Activity; task: run the assistant; check: run it and hand it the previous result; evaluation: run a test suite. */
    kind: z.enum(["reminder", "task", "check", "evaluation"]),
    /** Which evaluation suite to run, for an `evaluation` schedule. */
    suite: z.string().min(1).max(64).optional(),
    /** The model choice the evaluation should use; the one in use otherwise. */
    preset: z.string().min(1).max(64).optional(),
    intervalMs: z.number().int().min(60000).max(31536000000).optional(),
    /** Repeat every day at this local time in `timezone` (HH:MM, 24-hour). */
    dailyAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
    /** With `dailyAt`, run only on these local weekdays (0 Sunday through 6 Saturday). */
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7)
      .refine((days) => new Set(days).size === days.length, "A weekday can appear only once").optional(),
    /** With `dailyAt`, run on this day of each month; months without it are skipped. */
    monthDay: z.number().int().min(1).max(31).optional(),
    /** Numeric five-field cron: minute hour day-of-month month weekday. */
    cron: z.string().trim().max(100).refine(validCron, "Invalid five-field cron expression").optional(),
    timezone: timezone.optional(),
    /** Send the finished result to a connected channel chat. */
    deliverTo: z.object({ channel: z.string().min(1).max(64), chatId: z.string().min(1).max(64) }).strict().optional(),
    /** Allow an authenticated webhook to trigger this schedule with a payload. */
    webhook: z.boolean().optional(),
    /** Wave 6: what to do when the due moment lands on a holiday, a weekend or a day off. */
    daysOff: z.enum(["run", "skip", "shift"]).default("run"),
    // Ships-on sweep (2026-09-26): an accepted automation whose blueprint names no permissions takes all the owner
    // holds, narrowed (src/autonomy/index.ts), and with the ships-on parts listed that is past 50; the list is still
    // only ever names from the tool catalogue.
    permissions: z.array(z.string().max(100)).max(200).optional(),
    /** A short program, approved by the owner, that runs first and says whether to wake the assistant. */
    gate: GateScriptSchema.optional(),
    /** always: send every result; changes: only when something changed or needs the owner. Checks default to changes. */
    notify: z.enum(["always", "changes"]).optional(),
  })
  .strict()
  .refine((value) => [value.intervalMs, value.dailyAt, value.cron].filter((entry) => entry !== undefined).length <= 1,
    "Choose one recurrence: interval, wall-clock time, or cron")
  .refine((value) => !value.dailyAt || value.timezone, "A daily time needs a timezone")
  .refine((value) => !value.cron || value.timezone, "A cron recurrence needs a timezone")
  .refine((value) => !value.weekdays || value.dailyAt, "A weekday recurrence needs a daily time")
  .refine((value) => !value.monthDay || value.dailyAt, "A monthly recurrence needs a daily time")
  .refine((value) => !(value.weekdays && value.monthDay), "Choose either weekdays or a day of the month")
  .refine((value) => value.kind !== "evaluation" || !!value.suite, "An evaluation schedule needs the name of a suite")
  .refine((value) => !value.gate || value.kind === "task" || value.kind === "check", "Only a task or a check can have a check script");
export type DeliveryHandler = (channel: string, chatId: string, text: string, key: string) => Promise<{ messageId?: string | undefined; queued?: number }>;
export interface HistoryEntry { runId: string | null; status: string; startedAt: string; finishedAt?: string; trigger: string }
const historyLimit = 50;
/** How many turns in a row a repeating job may miss before it is paused and the owner told why. */
export const failuresBeforePausing = 3;
/** Whether a schedule comes round again, rather than happening once. */
const repeating = (data: Record<string, unknown>): boolean =>
  typeof data.intervalMs === "number" || typeof data.dailyAt === "string" || typeof data.cron === "string";
/** The moment a repeating schedule is next due after `now`. */
export const nextTurn = (data: Record<string, unknown>, now: Date): string => {
  const zone = String(data.timezone);
  if (typeof data.cron === "string") return nextCronOccurrence(now, data.cron, zone).toISOString();
  if (typeof data.dailyAt === "string") {
    const weekdays = Array.isArray(data.weekdays) ? data.weekdays.map(Number) : null;
    if (weekdays) return nextWallOccurrence(now, data.dailyAt, zone, (day) => weekdays.includes(day.weekday)).toISOString();
    if (typeof data.monthDay === "number") return nextWallOccurrence(now, data.dailyAt, zone, (day) => day.day === data.monthDay).toISOString();
    return nextDailyOccurrence(now, data.dailyAt, zone).toISOString();
  }
  return new Date(now.getTime() + Number(data.intervalMs ?? 0)).toISOString();
};

/** What a check says when it has nothing to report; exactly this, after trimming, sends nothing. */
export const nothingNew = quietWord;
const awaitingApproval = "This job runs a check script first, and waits until you approve the script in Schedules.";
const scriptsOff = "Check scripts are switched off, so this job is waiting. Turn them on in Schedules to let it run.";
const unreadableGate = "The check script saved with this job cannot be read, so the job has been paused. Remove it and add it again.";
const saidNothingNew = (output: string): boolean => output.trim() === nothingNew;
/** The job's saved check script, or null when what is stored is not a valid one (it is never run then). */
function storedGate(data: Record<string, unknown>): GateScript | null {
  const parsed = GateScriptSchema.safeParse(data.gate);
  return parsed.success ? parsed.data : null;
}
/** Whether the owner's yes covers exactly the script that is saved now. */
function gateIsApproved(data: Record<string, unknown>): boolean {
  const script = storedGate(data);
  return script !== null && typeof data.gateApproved === "string" && data.gateApproved === gateFingerprint(script);
}
const dayMs = 86_400_000;
/**
 * Whether only news is sent. Off: every result, as before. A schedule's own `notify` wins otherwise;
 * without one, checks are gated ("when needed": only checks that come round more than once a day).
 */
function onlyChanges(data: Record<string, unknown>, mode: QuietMode): boolean {
  if (mode === "off" || data.notify === "always") return false;
  if (data.notify === "changes") return true;
  if (data.kind !== "check") return false;
  return mode === "on" || (typeof data.intervalMs === "number" && data.intervalMs < dayMs);
}
/**
 * Why a result is not worth sending, or null when it is. The first failure and the first success
 * after failures always go out; only repeats are held back.
 */
function heldBack(data: Record<string, unknown>, run: Run, mode: QuietMode): string | null {
  if (!onlyChanges(data, mode)) return null;
  const failedBefore = Number(data.consecutiveFailures ?? 0) > 0;
  if (run.status !== "completed")
    return failedBefore ? "It did not finish again; you were told the first time, so nothing was sent." : null;
  if (failedBefore) return null;
  if (saidNothingNew(run.output)) return "Nothing changed, so nothing was sent.";
  const last = typeof data.lastResult === "string" ? data.lastResult.trim() : null;
  if (last !== null && last === run.output.slice(0, 4000).trim()) return "The result is the same as last time, so nothing was sent.";
  return null;
}
/** What is sent: the result, or plain words for a failure or for working again. */
function messageFor(data: Record<string, unknown>, run: Run): string {
  if (run.status !== "completed") return `The scheduled task did not finish (${run.status}).`;
  if (Number(data.consecutiveFailures ?? 0) > 0 && saidNothingNew(run.output)) return "The check is working again. Nothing new to report.";
  return run.output;
}
/** Healthy, failing, held or never run, for one saved schedule. */
export function scheduleHealth(data: Record<string, unknown>): Health {
  const history = Array.isArray(data.history) ? data.history as HistoryEntry[] : [];
  const waiting = data.status === "paused" && data.pausedBecause === awaitingApproval;
  const held = typeof data.heldBecause === "string" ? data.heldBecause : waiting ? awaitingApproval : undefined;
  const failing = Number(data.consecutiveFailures ?? 0) > 0 || Number(data.gateFailures ?? 0) > 0 ||
    (data.status === "paused" && typeof data.pausedBecause === "string" && !waiting);
  return automationHealth(history, { runCount: Number(data.runCount ?? 0), ...(failing ? { failing: true } : {}), ...(held ? { held } : {}) });
}

/** The next moment `HH:MM` occurs in `zone` strictly after `after`. */
export function nextDailyOccurrence(after: Date, hhmm: string, zone: string): Date {
  return nextWallOccurrence(after, hhmm, zone, () => true);
}

/** What the scheduler needs to know about days off; the calendar settings supply it. */
export interface DayOffAdvice {
  decide(owner: string, at: Date, mode: "run" | "skip" | "shift"): { action: "run" | "skip" | "shift"; reason: string | null; moveTo?: string };
}
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Holidays, weekends and the owner's own days off; nothing is held back until this is connected. */
  calendar: DayOffAdvice | undefined;
  private readonly active = new Set<Promise<Run[]>>();
  /** Runs test suites on a schedule; stays null until `createBranch` connects one. */
  evaluations: SuiteRunner | null = null;
  /** Extra work that runs on every beat alongside the saved schedules: watches, the morning brief. */
  readonly onTick = new Set<(now: Date) => Promise<void>>();
  /** The owner's check-in; it does nothing until they switch it on. */
  readonly heartbeat: Heartbeat;
  /** Starts a job's check script; tests hand in a fake. */
  gateRunner: GateRunner | undefined;
  /**
   * R17-A (Trunks): a schedule a Trunk owns runs as that Trunk, and its result is handed back so it
   * lands in the Trunk's own conversation (src/trunks/routines.ts). Nothing is changed until connected.
   */
  routeRun: (scheduleId: string) => { options: { trunkId: string }; finished: (run: Run) => void } | { refuse: string; held?: boolean } | null = () => null;
  /** Why a schedule a Trunk made may not run now (its part switched off), or null; set by src/trunks. */
  trunkHeld: (trunkId: string) => string | null = () => null;
  constructor(
    readonly store: Store,
    readonly runtime: Runtime,
    private readonly deliver?: DeliveryHandler,
  ) {
    this.heartbeat = new Heartbeat(store, runtime, deliver);
  }
  create(context: ToolContext, input: unknown): SavedRecord {
    if (!context.permissions.has("schedules.manage"))
      throw new Error("Permission denied: schedules.manage");
    const definition = ScheduleSchema.parse(input),
      permissions =
        definition.permissions ??
        [...context.permissions].filter(
          (p) => !p.startsWith("schedules.") && !p.endsWith(".manage"),
        );
    if (permissions.some((p) => !context.permissions.has(p)))
      throw new Error("Schedule permission escalation denied");
    // A result sent to a chat goes out as the owner's own bot, so only the owner, and only a caller that
    // may send to chats, puts one on a timer: the same as sending it now (channels.broadcast).
    if (definition.deliverTo) {
      this.store.profiles.requireOwner(sendingToChats);
      if (!context.permissions.has("channels.send")) throw new Error("Permission denied: channels.send");
    }
    if (definition.gate && this.switches().scriptGates === "off") throw new Error(scriptsOff);
    // mac7/chat-source: an evaluation suite runs the owner's own saved tasks, with no way to hold them
    // to what the chat may do, so a chat message's task cannot put one on a timer.
    if (definition.kind === "evaluation" && startedFromChat(context, this.store))
      throw new Error("Running an evaluation suite is for the owner only, and a message from a chat app cannot prove who is typing. Do it in the Branch app.");
    const { webhook, ...rest } = definition;
    const startedBy = context.trunk ?? this.runtime.trunkAtWork();
    // A check script is a program on this computer: it waits for the owner's own yes, whoever asked.
    return this.store.save("schedules", context.owner, randomUUID(), {
      ...rest,
      dueAt: new Date(definition.dueAt).toISOString(),
      permissions,
      // mac7/chat-source: a schedule a chat message's task makes stays the chat's, so its turns are
      // held to the same guards. Without this, a chat could put owner-only work behind a due time.
      ...(startedFromChat(context, this.store) ? { fromChat: true } : {}),
      // Q118: a schedule a Trunk makes stays that Trunk's work, so each turn runs as it, never as the owner.
      ...(startedBy ? { startedBy } : {}),
      status: definition.gate ? "paused" : "pending",
      ...(definition.gate ? { gateApproved: null, pausedBecause: awaitingApproval } : {}),
      history: [],
      ...(webhook ? { hookToken: randomBytes(24).toString("hex") } : {}),
    });
  }
  async tick(now = new Date()): Promise<Run[]> {
    const results: Run[] = [];
    if (this.store.review.dreamDue(this.runtime.owner, now)) await this.store.review.consolidate(this.runtime, this.runtime.owner).catch(() => undefined);
    for (const candidate of this.store.dueSchedules(this.runtime.owner, now.toISOString())) {
      if (this.deferredForDayOff(candidate, now)) continue;
      if (this.heldForScripts(candidate)) continue;
      if (this.heldForTrunks(candidate, now)) continue;
      const claimed = this.store.claimSchedule(this.runtime.owner, candidate.id, now.toISOString());
      if (!claimed) continue;
      const passed = this.gateApplies(claimed.data) ? await this.passGate(claimed, now) : { data: null };
      if (!passed) continue;
      const run = await this.execute(claimed, now, "schedule", undefined, true, passed.data);
      if (run) results.push(run);
    }
    await this.heartbeat.tick(now).catch(() => undefined);
    // Last, so that work the person actually asked for is never left waiting behind a watch
    // that is slow to answer. A beat that overlaps the one before it is normal here.
    for (const listener of this.onTick) await listener(now).catch(() => undefined);
    return results;
  }
  private switches() {
    return quietSwitches(this.store, this.runtime.owner);
  }
  /** A gated job waits while scripts are switched off, and says so on its health badge. */
  private heldForScripts(record: SavedRecord): boolean {
    const off = !!record.data.gate && this.switches().scriptGates === "off";
    if (off !== (record.data.heldBecause === scriptsOff))
      this.store.save("schedules", record.owner, record.id, { ...record.data, heldBecause: off ? scriptsOff : null });
    return off;
  }
  /**
   * A repeating schedule a Trunk made waits while Trunks are switched off, as a gated job does while scripts are, and a
   * repeating routine a Trunk owns waits while routines are (they are off too while Trunks are). The turn is held, not
   * failed: no failure is counted, so the job is never paused for it. It says why on its health badge and moves on to
   * its next turn; once the switch is on again, that turn runs and the badge is cleared. A routine whose Trunk is gone
   * is refused, not held: that turn fails in `execute` and is counted.
   */
  private heldForTrunks(record: SavedRecord, now: Date): boolean {
    const data = record.data;
    if (!repeating(data)) return false;
    const routed = this.routeRun(record.id);
    // The schedule itself, as `execute` sees it: a Trunk's routine is routed there instead.
    const madeBy = typeof data.startedBy === "string" && !routed ? data.startedBy : null;
    const held = routed ? ("refuse" in routed && routed.held ? routed.refuse : null) : madeBy ? this.trunkHeld(madeBy) : null;
    if (held) {
      this.store.save("schedules", record.owner, record.id, { ...data, heldBecause: held, dueAt: nextTurn(data, now) });
      return true;
    }
    // Any routine, its Trunk gone too, so an old note never shows "held" on a turn that runs or fails.
    if ((routed || madeBy) && typeof data.heldBecause === "string" && data.heldBecause !== scriptsOff)
      this.store.save("schedules", record.owner, record.id, { ...data, heldBecause: null });
    return false;
  }
  /** "When needed" runs the script for repeating jobs only; a one-off goes straight ahead. */
  private gateApplies(data: Record<string, unknown>): boolean {
    if (!data.gate) return false;
    return this.switches().scriptGates === "on" || repeating(data);
  }
  /**
   * Holds a schedule back when its moment lands on a day off. "Skip" moves a repeating one on to
   * its next turn and closes a one-off; "shift" moves it to the next working day. Nothing runs.
   */
  private deferredForDayOff(record: SavedRecord, now: Date): boolean {
    const mode = record.data.daysOff;
    if (mode !== "skip" && mode !== "shift") return false;
    const decision = this.calendar?.decide(record.owner, now, mode);
    if (!decision || decision.action === "run") return false;
    const data = record.data;
    const repeats = repeating(data);
    const movedTo = decision.action === "shift" ? decision.moveTo! : repeats ? nextTurn(data, now) : String(data.dueAt);
    this.store.save("schedules", record.owner, record.id, {
      ...data, dueAt: movedTo,
      status: decision.action === "skip" && !repeats ? "skipped" : "pending",
      lastDayOff: { at: now.toISOString(), action: decision.action, reason: decision.reason, movedTo },
    });
    this.runtime.notifyEvent("schedule.day_off", { scheduleId: record.id, action: decision.action, reason: decision.reason, movedTo });
    return true;
  }
  /** Runs a saved schedule now (webhook or local script) without moving its next due time. */
  async trigger(owner: string, id: string, payload: unknown, trigger: "webhook" | "local"): Promise<Run> {
    const record = this.store.get("schedules", owner, id);
    if (!record) throw new Error("Schedule not found");
    if (!["pending", "paused", "completed", "failed"].includes(String(record.data.status)))
      throw new Error("This schedule is running right now");
    const run = await this.execute(record, new Date(), trigger, payload, false);
    if (!run) throw new Error("The schedule did not produce a run");
    return run;
  }
  private async execute(record: SavedRecord, now: Date, trigger: string, payload: unknown, advance: boolean, found: unknown = null): Promise<Run | undefined> {
    const startedAt = now.toISOString(), data = record.data;
    const history = (Array.isArray(data.history) ? data.history as HistoryEntry[] : []).slice(-(historyLimit - 1));
    const entry: HistoryEntry = { runId: null, status: "running", startedAt, trigger };
    // mac3/never-break: a turn missed while Branch was not running runs once, and says so.
    const late = trigger === "schedule" && neverBreakModeSync(this.store.folder) !== "off" ? lateNote(data.dueAt, now) : null;
    if (late) Object.assign(entry, { late });
    this.store.save("schedules", record.owner, record.id, { ...data, status: "running", history: [...history, entry] });
    try {
      const routed = this.routeRun(record.id); // R17-A (Trunks)
      // A Trunk's routine that cannot run as its Trunk does not run at all, never as the owner.
      if (routed && "refuse" in routed) throw new Error(routed.refuse);
      const route = routed;
      const madeBy = !route && typeof data.startedBy === "string" ? data.startedBy : undefined;
      // A Trunk's own schedule, like its routines, does not run while Trunks are switched off: it says why instead.
      const held = madeBy ? this.trunkHeld(madeBy) : null;
      if (held) throw new Error(held);
      const work = async (): Promise<Run> => data.kind === "reminder" ? this.remind(record) : data.kind === "evaluation" ? await this.evaluateSuite(record) : await this.runtime.run({
        prompt: this.promptFor(data, payload) + gatePrompt(found), permissions: data.permissions as string[],
        source: data.fromChat === true ? "channel" : "schedule", ...route?.options,
        // A schedule a Trunk made is built as that Trunk's task, as its routines are: its instructions and
        // memory scope, and its permissions as they are now, never more than the schedule was given.
        ...(madeBy ? { trunkId: madeBy } : {}),
        onStarted: (started) => { entry.runId = started.id; if (late) this.store.event(started.id, "schedule.caught_up", { scheduleId: record.id, note: late }); },
        onTextDelta: () => undefined, // stream so a silent model is noticed
      });
      // Q118: a schedule a Trunk made (not one of its routines, which run as it already) runs as that Trunk,
      // and not at all once the Trunk is gone.
      const run = madeBy ? await this.runtime.asTrunkWork(madeBy, work) : await work();
      Object.assign(entry, { runId: run.id, status: run.status, finishedAt: new Date().toISOString() });
      route?.finished(run); // R17-A (Trunks)
      this.runtime.notifyEvent("schedule.fired", { scheduleId: record.id, runId: run.id, status: run.status, trigger });
      const delivery = await this.deliverResult(data, run, madeBy);
      const kept = run.status === "completed" && !saidNothingNew(run.output);
      this.store.save("schedules", record.owner, record.id, {
        ...data, runId: run.id, runCount: Number(data.runCount ?? 0) + 1, history: [...history, entry],
        lastRunAt: startedAt, lastResult: kept ? run.output.slice(0, 4000) : data.lastResult ?? null,
        ...(delivery ? { delivery } : {}), ...this.afterTurn(data, now, run.status, advance),
      });
      return run;
    } catch (e) {
      Object.assign(entry, { status: "failed", finishedAt: new Date().toISOString() });
      this.store.save("schedules", record.owner, record.id, {
        ...data, history: [...history, entry], lastRunAt: startedAt,
        error: e instanceof Error ? e.message : String(e),
        ...this.afterTurn(data, now, "failed", advance),
      });
      return undefined;
    }
  }
  /**
   * Where a repeating job stands after one turn. A turn that failed used to stop the job for good:
   * its state became "failed" and its due moment was never moved on, so a daily job that failed
   * once never ran again and nothing said so. Now a failed turn moves on to the next one, the
   * failures in a row are counted, and after three the job is paused with the reason written down,
   * so one that is broken rather than unlucky does not fail quietly every day for ever.
   */
  private afterTurn(data: Record<string, unknown>, now: Date, status: string, advance: boolean): Record<string, unknown> {
    if (!advance) return { status: String(data.status) === "running" ? "pending" : data.status };
    if (!repeating(data)) return { status, consecutiveFailures: 0 };
    const failures = status === "completed" ? 0 : Number(data.consecutiveFailures ?? 0) + 1;
    const paused = failures >= failuresBeforePausing;
    return {
      status: paused ? "paused" : "pending", dueAt: nextTurn(data, now), consecutiveFailures: failures,
      ...(paused ? { pausedBecause: `This repeating job did not finish ${failures} turns in a row, so it has been paused. Start it again once whatever it needs is working.` } : {}),
      ...(status === "completed" ? { pausedBecause: null } : {}),
    };
  }
  /**
   * Runs a job's check script before its turn. Returns what the script found when the assistant
   * should be woken; otherwise the turn is written down (quiet, or failed with backoff) and null.
   */
  private async passGate(record: SavedRecord, now: Date): Promise<{ data: unknown } | null> {
    const data = record.data, script = storedGate(data);
    const save = (changes: Record<string, unknown>) => this.store.save("schedules", record.owner, record.id, { ...data, ...changes });
    if (!script) {
      save({ status: "paused", gateApproved: null, pausedBecause: unreadableGate });
      return null;
    }
    if (data.gateApproved !== gateFingerprint(script)) {
      save({ status: "paused", gateApproved: null, pausedBecause: awaitingApproval });
      return null;
    }
    const outcome = await runGate(script, { cwd: this.runtime.workspace, ...(this.gateRunner ? { runner: this.gateRunner } : {}) });
    const lastGate = { at: now.toISOString(), outcome: outcome.outcome, durationMs: outcome.durationMs, reason: outcome.outcome === "error" ? outcome.reason : null };
    if (outcome.outcome === "wake") {
      save({ lastGate, gateFailures: 0 });
      return { data: outcome.data };
    }
    const history = (Array.isArray(data.history) ? data.history as HistoryEntry[] : []).slice(-(historyLimit - 1));
    const entry: HistoryEntry = { runId: null, status: outcome.outcome === "sleep" ? "quiet" : "failed", startedAt: now.toISOString(),
      finishedAt: new Date(now.getTime() + outcome.durationMs).toISOString(), trigger: "schedule" };
    const repeats = repeating(data), next = repeats ? nextTurn(data, now) : null;
    if (outcome.outcome === "sleep") {
      save({ lastGate, gateFailures: 0, history: [...history, entry], dueAt: next ?? data.dueAt, status: repeats ? "pending" : "completed" });
      return null;
    }
    const failures = Number(data.gateFailures ?? 0) + 1;
    const after = afterGateFailure(failures, now, outcome.reason, next);
    // The reason can quote what the script printed, so it stays in the app; the endpoint hears the facts.
    this.runtime.notifyEvent("schedule.script_failed", { scheduleId: record.id, failures, paused: after.paused, retryAt: after.dueAt });
    save({ lastGate, gateFailures: failures, history: [...history, entry], dueAt: after.dueAt,
      status: after.paused ? "paused" : "pending", ...(after.paused ? { pausedBecause: after.pausedBecause } : {}) });
    return null;
  }
  /**
   * The owner's yes (or no) to a job's check script. Only the owner's own app reaches this; the
   * approval is bound to the exact program, arguments and limits, so a changed script asks again.
   */
  async approveGate(owner: string, id: string, approve: boolean): Promise<SavedRecord> {
    const record = this.store.get("schedules", owner, id);
    if (!record?.data.gate) throw new Error("That schedule has no check script");
    if (record.data.status === "running") throw new Error("This schedule is running right now");
    const script = storedGate(record.data);
    if (!script) throw new Error(unreadableGate);
    if (!approve)
      return this.store.save("schedules", owner, id, { ...record.data, gateApproved: null, status: "paused", pausedBecause: awaitingApproval });
    await checkGateProgram(script.executable);
    const waiting = record.data.status === "paused" && record.data.pausedBecause === awaitingApproval;
    return this.store.save("schedules", owner, id, {
      ...record.data, gateApproved: gateFingerprint(script), gateFailures: 0,
      ...(waiting ? { status: "pending", pausedBecause: null } : {}),
    });
  }
  /** Every schedule with its health, and the check-in with its own. */
  overview(owner: string) {
    const schedules = this.store.list("schedules", owner).map((record) => ({
      id: record.id, prompt: String(record.data.prompt).slice(0, 200), kind: record.data.kind, status: record.data.status,
      pausedBecause: record.data.pausedBecause ?? null, health: scheduleHealth(record.data),
      gate: storedGate(record.data) ? { ...storedGate(record.data), approved: gateIsApproved(record.data), last: record.data.lastGate ?? null } : null,
    }));
    return { switches: quietSwitches(this.store, owner), heartbeat: this.heartbeat.overview(owner), schedules };
  }
  /** Runs the test suite a schedule is attached to; anything that has stopped working is announced. */
  private async evaluateSuite(record: SavedRecord): Promise<Run> {
    if (!this.evaluations) throw new Error("Evaluations are not available in this launch");
    const preset = typeof record.data.preset === "string" ? record.data.preset : undefined;
    const { run } = await this.evaluations.runScheduled(String(record.data.suite), preset);
    return run;
  }
  /** Whether the Trunk that made a schedule may send to chats now; false once it is gone. */
  private trunkMaySend(trunkId: string): boolean {
    return this.runtime.trunkShape({ prompt: "", trunkId })?.permissions.includes("channels.send") ?? false;
  }
  private promptFor(data: Record<string, unknown>, payload: unknown): string {
    let prompt = String(data.prompt);
    if (data.kind === "check" && typeof data.lastResult === "string" && data.lastResult)
      prompt += `\n\nYour previous check at ${String(data.lastRunAt ?? "an earlier time")} concluded: ${data.lastResult}\nCompare against it and report what changed.`;
    if (onlyChanges(data, this.switches().notifyGate))
      prompt += `\n\nIf nothing has changed and nothing needs the owner's attention, reply with exactly ${nothingNew} and nothing else.`;
    if (payload !== undefined) prompt += `\n\nTriggering event payload (JSON): ${JSON.stringify(payload).slice(0, 16000)}`;
    return prompt;
  }
  private async deliverResult(data: Record<string, unknown>, run: Run, madeBy?: string): Promise<Record<string, unknown> | undefined> {
    const target = data.deliverTo as { channel: string; chatId: string } | undefined;
    if (!target) return undefined;
    const at = new Date().toISOString();
    if (!this.deliver) return { ...target, at, error: "No channel delivery is available in this launch" };
    // A Trunk's schedule sends only while that Trunk may still send to chats. The sending is the schedule's, not its
    // run's tools, so it is asked of the Trunk as it is now (a reminder's or a suite's run writes no start anyway).
    const held = madeBy && !this.trunkMaySend(madeBy) ? trunkMayNotSend
      : heldBack(data, run, this.switches().notifyGate);
    if (held) {
      this.store.event(run.id, "delivery.held", { ...target, reason: held });
      return { ...target, at, held };
    }
    try {
      const text = messageFor(data, run);
      const { messageId, queued } = await this.deliver(target.channel, target.chatId, text, `schedule:${run.id}`);
      this.store.event(run.id, queued ? "delivery.queued" : "delivery.sent", { ...target, messageId: messageId ?? null, queued: queued ?? 0 });
      return { ...target, at, messageId: messageId ?? null, ...(queued ? { queued } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.event(run.id, "delivery.failed", { ...target, error: message });
      return { ...target, at, error: message };
    }
  }
  /**
   * Batch 20 (wave 8): takes a schedule off the list for good. Without this the only way to be rid
   * of one was to pause it for ever, which is not the same thing and does not read the same way.
   */
  remove(context: ToolContext, id: string): { id: string; removed: boolean } {
    if (!context.permissions.has("schedules.manage"))
      throw new Error("Permission denied: schedules.manage");
    const record = this.store.get("schedules", context.owner, id);
    if (!record || !this.visibleTo(context, record)) return { id, removed: false };
    return { id, removed: this.store.delete("schedules", context.owner, id) };
  }
  /** The schedules the caller may see: all of them for the owner, and only its own for a Trunk. */
  list(context: ToolContext): SavedRecord[] {
    return this.store.list("schedules", context.owner).filter((record) => this.visibleTo(context, record));
  }
  /**
   * The owner sees and changes every schedule; a Trunk only the ones it made, taken the same way
   * `create` records it. Any other schedule gets the same answer as one that does not exist.
   */
  private visibleTo(context: ToolContext, record: SavedRecord): boolean {
    const trunk = context.trunk ?? this.runtime.trunkAtWork();
    return !trunk || record.data.startedBy === trunk;
  }
  setPaused(context: ToolContext, id: string, paused: boolean): SavedRecord {
    if (!context.permissions.has("schedules.manage"))
      throw new Error("Permission denied: schedules.manage");
    const record = this.store.get("schedules", context.owner, id);
    if (!record || !this.visibleTo(context, record) || !["pending", "paused"].includes(String(record.data.status)))
      throw new Error(
        "Only pending or paused schedules may be paused or resumed",
      );
    if (!paused && record.data.gate && !gateIsApproved(record.data))
      throw new Error("Approve this job's check script in Schedules before starting it");
    return this.store.save("schedules", context.owner, id, {
      ...record.data,
      status: paused ? "paused" : "pending",
      // Starting it again clears the count, so a fixed check gets its full number of tries.
      ...(!paused ? { gateFailures: 0 } : {}),
    });
  }
  start(intervalMs = 5000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const pending = this.tick();
      this.active.add(pending);
      void pending.catch(() => {}).finally(() => this.active.delete(pending));
    }, intervalMs);
    this.timer.unref();
  }
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await Promise.allSettled(this.active);
  }
  private remind(record: SavedRecord): Run {
    const run = this.store.createRun(record.owner, String(record.data.prompt));
    const output = `Reminder: ${String(record.data.prompt)}`;
    this.store.message(run.sessionId, { role: "assistant", content: output });
    this.store.event(run.id, "reminder.due", {
      scheduleId: record.id,
      prompt: record.data.prompt,
    });
    return this.store.finish(run.id, "completed", output);
  }
}
export function registerSchedules(
  registry: ToolRegistry,
  scheduler: Scheduler,
): void {
  registerHeartbeat(registry, scheduler.heartbeat);
  registry.register({
    name: "schedules.create",
    description:
      "Persist a reminder, task or monitoring check with an optional interval, wall-clock weekday/monthly recurrence, or five-field cron in a timezone; optional delivery to a channel chat; and optional webhook triggering. Runs when online; missed periods coalesce into one execution. Failed tasks do not auto-retry.",
    permission: "schedules.manage",
    parameters: ScheduleSchema,
    execute: async (a, c) => scheduler.create(c, a),
  });
  registry.register({
    name: "schedules.pause",
    description: "Pause or resume a pending recurring or one-time schedule.",
    permission: "schedules.manage",
    parameters: z
      .object({ id: z.string().uuid(), paused: z.boolean() })
      .strict(),
    execute: async (a, c) => scheduler.setPaused(c, a.id, a.paused),
  });
  registry.register({
    name: "schedules.remove",
    description: "Delete a schedule for good, so it never runs again.",
    permission: "schedules.manage",
    parameters: z.object({ id: z.string().uuid() }).strict(),
    execute: async (a, c) => scheduler.remove(c, a.id),
  });
  registry.register({
    name: "schedules.list",
    description: "List owner schedules and their durable execution status.",
    permission: "schedules.read",
    parameters: z.object({}).strict(),
    execute: async (_a, c) => scheduler.list(c)
      .map((record) => ({ ...record, health: scheduleHealth(record.data) })),
  });
}

/**
 * The owner's own routes for the check-in and for approving check scripts. Returns undefined for a
 * path that is not one of these, so the server carries on looking.
 */
export async function quietJobsApi(scheduler: Scheduler, method: string, path: string, body: () => Promise<unknown>): Promise<unknown> {
  const owner = scheduler.runtime.owner;
  if (path === "/api/heartbeat" && method === "GET") return scheduler.overview(owner);
  if (path === "/api/heartbeat" && method === "POST") return scheduler.heartbeat.configure(owner, await body());
  if (path === "/api/heartbeat/switches" && method === "POST") return saveQuietSwitches(scheduler.store, owner, await body());
  if (path === "/api/heartbeat/check" && method === "POST") return { outcome: await scheduler.heartbeat.checkNow(owner) };
  const gate = /^\/api\/schedules\/([a-f0-9-]{36})\/gate$/.exec(path);
  if (gate && method === "POST") {
    const { approve } = z.object({ approve: z.boolean() }).strict().parse(await body());
    return scheduler.approveGate(owner, gate[1]!, approve);
  }
  return undefined;
}
