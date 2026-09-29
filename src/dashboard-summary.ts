import { statfs, stat } from "node:fs/promises";
import { freemem, totalmem } from "node:os";
import { join } from "node:path";
import type { createBranch } from "./index.js";
import type { Run } from "./contracts.js";
import { costByProject } from "./project-ledger.js";
import { pricingSettings } from "./pricing.js";
import { lockdownState } from "./lockdown.js";
import { readRunning, type RunningInstance } from "./install/running.js";
import { listUpdateBackups, readFirstStart } from "./install/update-backup.js";
import { launchdLabel } from "./install/launchd.js";

/**
 * The owner's control dashboard (wave mac3), the reading half: everything on the page is worked out
 * here from records Branch already keeps — tasks, events, schedules, channels, the usage ledger and
 * the notes an update leaves — so the page needs one call and nothing new is written down to fill it.
 * The layout of the answer follows the page: Now, Health, Spend and Activity.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;

/** What the summary needs from the computer, so tests can hand in a fake one. */
export interface SummaryDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  pid?: number;
  now?: () => Date;
  running?: (dataDir: string) => Promise<RunningInstance | null>;
  disk?: (path: string) => Promise<{ free: number; total: number } | null>;
  /** selfdev: this engine runs under the desktop app's own engine host, which starts it again whenever it stops. */
  hosted?: boolean;
}

const ACTIVITY_KINDS = new Set(["run.started", "run.finished", "model.started", "model.completed", "tool.started",
  "tool.completed", "tool.failed", "policy.ask", "schedule.fired", "delivery.failed"]);
/**
 * A short one-line version of a recorded text. Saved keys and key-shaped values are taken out before
 * it is cut, because a key cut in half is no longer recognised by the scrubber the summary goes through.
 */
const clip = (app: Branch, text: unknown, length = 160) =>
  app.runtime.hideSecrets(String(text ?? "")).replace(/\s+/g, " ").trim().slice(0, length);
const sinceDays = (days: number, now: Date) => new Date(now.getTime() - days * 86_400_000).toISOString();

/* ---------- Now ---------- */

function workingNow(app: Branch): Array<{ runId: string; sessionId: string; prompt: string; startedAt: string }> {
  return app.store.runs(app.store.profiles.scope())
    .filter((run: Run) => run.status === "running")
    .slice(0, 20)
    .map((run: Run) => ({ runId: run.id, sessionId: run.sessionId, prompt: clip(app, run.prompt), startedAt: run.createdAt }));
}

/** Questions a task stopped to ask, approvals waiting for a yes, and suggested memory changes. */
function needsYou(app: Branch) {
  const owner = app.runtime.owner, seen = new Set<string>();
  const questions: Array<{ runId: string; sessionId: string; text: string; at: string }> = [];
  for (const run of app.store.runs(owner)) {
    if (seen.has(run.sessionId)) continue;
    seen.add(run.sessionId);
    if (run.status === "needs_input") questions.push({ runId: run.id, sessionId: run.sessionId, text: clip(app, run.output), at: run.createdAt });
  }
  const approvals = app.runtime.approvals.waiting()
    .map((item) => ({ runId: item.runId, sessionId: item.sessionId, text: clip(app, item.label || item.question) }));
  const memory = app.store.review.proposals(owner).length;
  return { total: questions.length + approvals.length + memory, questions, approvals, memory };
}

export async function nowSection(app: Branch, dataDir: string, deps: SummaryDeps = {}) {
  const owner = app.runtime.owner;
  const choice = app.runtime.models.plan(owner, "").choice;
  const running = await (deps.running ?? readRunning)(dataDir);
  const pid = deps.pid ?? process.pid;
  const uptime = Math.round(process.uptime());
  return {
    version: app.version,
    startedAt: new Date((deps.now?.() ?? new Date()).getTime() - uptime * 1000).toISOString(),
    uptimeSeconds: uptime,
    /** "background" when this copy is the engine that keeps working with the window closed. */
    where: running?.pid === pid && running.mode === "daemon" ? "background" : "window",
    model: { name: choice.presetName, model: choice.model, connection: choice.provider, local: choice.local },
    lockdown: lockdownState(app.store, owner).on,
    working: workingNow(app),
    needsYou: needsYou(app),
  };
}

/* ---------- Health ---------- */

function connectionsHealth(app: Branch) {
  const summary = app.runtime.models.summary(app.runtime.owner);
  return summary.presets.map((preset) => {
    const failing = Boolean(preset.coolingDownUntil) || Boolean(preset.health.lastErrorAt
      && (!preset.health.lastOkAt || preset.health.lastErrorAt > preset.health.lastOkAt));
    return {
      id: preset.id, name: preset.name, model: preset.model, local: preset.local,
      state: failing ? "failing" : preset.health.lastOkAt ? "connected" : "unused",
      lastOkAt: preset.health.lastOkAt, reason: failing ? clip(app, preset.health.lastError ?? "Resting after a failure") : null,
    };
  });
}

function channelsHealth(app: Branch) {
  const summary = app.channels.summary(), waiting = app.channels.outstanding();
  return summary.channels.map((channel) => {
    const mine = waiting.filter((delivery) => delivery.channel === channel.id);
    const last = summary.chats.filter((chat) => chat.channel === channel.id)
      .map((chat) => String(chat.updatedAt ?? "")).sort().at(-1) ?? null;
    const gaveUp = mine.filter((delivery) => delivery.status === "dead").length;
    const state = channel.health.state === "connected" && gaveUp === 0 ? "connected" : "failing";
    return {
      id: channel.id, kind: channel.kind, name: clip(app, channel.botName ?? channel.id, 60), state,
      reason: clip(app, channel.health.reason ?? (gaveUp ? mine.find((d) => d.status === "dead")?.lastError : "") ?? ""),
      lastMessageAt: last, waiting: mine.length - gaveUp, gaveUp,
    };
  });
}

/** One schedule's standing: healthy, failing, never run, paused or running. */
export function scheduleStanding(data: Record<string, unknown>): "healthy" | "failing" | "never" | "paused" | "running" {
  const status = String(data.status ?? "");
  if (status === "running") return "running";
  if (status === "paused") return "paused";
  const history = Array.isArray(data.history) ? data.history as Array<{ status?: string }> : [];
  const last = history.filter((entry) => entry.status !== "running").at(-1);
  if (!last && !data.lastRunAt) return "never";
  if (status === "failed" || status === "interrupted" || Number(data.consecutiveFailures ?? 0) > 0) return "failing";
  return last && last.status !== "completed" ? "failing" : "healthy";
}

function automationsHealth(app: Branch) {
  const owner = app.runtime.owner;
  const schedules = app.store.list("schedules", owner).map((record) => ({
    id: record.id, name: clip(app, record.data.prompt, 80), kind: String(record.data.kind ?? "task"),
    standing: scheduleStanding(record.data),
    lastRunAt: typeof record.data.lastRunAt === "string" ? record.data.lastRunAt : null,
    nextAt: record.data.status === "pending" && typeof record.data.dueAt === "string" ? record.data.dueAt : null,
    reason: clip(app, record.data.pausedBecause ?? record.data.error ?? ""),
  }));
  // A trigger's own record carries its secret, so only its name and switch leave this function.
  const triggers = app.triggers.list(owner).map((trigger) => ({ id: trigger.id, name: clip(app, trigger.name, 80), on: trigger.enabled }));
  const workflows = app.workflows.list(owner).map((flow) => ({
    id: flow.id, name: clip(app, flow.name, 80),
    standing: flow.status === "failed" || flow.status === "interrupted" ? "failing"
      : flow.status === "completed" ? "healthy" : flow.status === "idle" ? "never" : flow.status === "paused" ? "paused" : "running",
  }));
  return { schedules, triggers, workflows };
}

/** Why a restart can or cannot happen; the page says the same through its language files. */
export const restartWords = {
  "restart.ready": "Branch works in the background and starts by itself, so it can be restarted from here.",
  "restart.windows": "On Windows, close Branch from its icon by the clock and open it again.",
  "restart.window": "Branch is running in its window here. Close the window and open Branch again to restart it.",
  "restart.by-hand": "This copy of Branch was started by hand, so nothing would start it again. Stop it and start it yourself.",
} as const;
export type RestartReason = keyof typeof restartWords;

/** Whether something outside Branch would start this engine again after it stops on purpose. */
export function restartPlan(input: { platform: NodeJS.Platform; env: NodeJS.ProcessEnv; pid: number; running: RunningInstance | null; hosted?: boolean | undefined }):
  { possible: boolean; reason: RestartReason } {
  // selfdev: under the desktop app's engine host or the gateway, whatever stops the engine is followed by a new start,
  // on every system (Windows included), so a restart there is always possible.
  if (input.hosted || input.env.BRANCH_GATEWAY_CHILD === "1") return { possible: true, reason: "restart.ready" };
  if (input.platform === "win32")
    return { possible: false, reason: "restart.windows" };
  if (input.running?.mode !== "daemon" || input.running.pid !== input.pid)
    return { possible: false, reason: "restart.window" };
  const supervised = input.platform === "darwin" ? input.env.XPC_SERVICE_NAME === launchdLabel
    : input.platform === "linux" ? Boolean(input.env.INVOCATION_ID) : false;
  return supervised ? { possible: true, reason: "restart.ready" } : { possible: false, reason: "restart.by-hand" };
}

async function engineHealth(app: Branch, dataDir: string, deps: SummaryDeps) {
  const running = await (deps.running ?? readRunning)(dataDir);
  const plan = restartPlan({ platform: deps.platform ?? process.platform, env: deps.env ?? process.env, pid: deps.pid ?? process.pid, running, hosted: deps.hosted });
  const firstStart = await readFirstStart(dataDir);
  const copies = await listUpdateBackups(dataDir);
  return {
    mode: running?.mode ?? null, startsBySelf: plan.possible, restart: plan,
    update: {
      version: app.version,
      /** How this version's first start went: true, false, or null when nobody wrote it down. */
      firstStartHealthy: firstStart?.version === app.version ? firstStart.healthy : null,
      safetyCopies: copies.length,
      newestCopyAt: copies[0]?.savedAt ?? null,
    },
  };
}

async function diskOf(path: string): Promise<{ free: number; total: number } | null> {
  try {
    const found = await statfs(path);
    return { free: found.bavail * found.bsize, total: found.blocks * found.bsize };
  } catch { return null; }
}

async function resources(dataDir: string, deps: SummaryDeps) {
  const disk = await (deps.disk ?? diskOf)(dataDir);
  const database = await stat(join(dataDir, "branch.sqlite")).then((found) => found.size, () => null);
  return {
    engineMemory: process.memoryUsage().rss,
    computerMemory: { free: freemem(), total: totalmem() },
    disk, databaseBytes: database,
  };
}

/** The last few things that went wrong, newest first, each in the words it was recorded in. */
function recentErrors(app: Branch, now: Date) {
  const owner = app.runtime.owner, since = sinceDays(7, now);
  const failedTasks = app.store.runs(owner)
    .filter((run) => run.status === "failed" && run.updatedAt >= since)
    .map((run) => ({ at: run.updatedAt, what: "task", text: clip(app, run.output || run.prompt), runId: run.id }));
  const failedTools = app.store.recentEvents(owner, 400)
    .filter((event) => event.kind === "tool.failed" && event.createdAt >= since)
    .map((event) => ({ at: event.createdAt, what: "tool", text: clip(app, event.data.error ?? event.data.name), runId: event.runId }));
  const crashes = app.store.spans.recent(owner, 200)
    .filter((span) => span.kind === "error" && span.startedAt >= since)
    .map((span) => ({ at: span.startedAt, what: "engine", text: clip(app, span.message), runId: null as string | null }));
  return [...failedTasks, ...failedTools, ...crashes]
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 8);
}

export async function healthSection(app: Branch, dataDir: string, deps: SummaryDeps = {}) {
  const now = deps.now?.() ?? new Date();
  return {
    connections: connectionsHealth(app),
    channels: channelsHealth(app),
    automations: automationsHealth(app),
    engine: await engineHealth(app, dataDir, deps),
    resources: await resources(dataDir, deps),
    errors: recentErrors(app, now),
  };
}

/* ---------- Spend ---------- */

interface Day { date: string; estimatedCost: number; pricedRuns: number; unpricedRuns: number; presets: Array<{ id: string; model: string; runs: number; cost: number | null }> }

/** The same money added up by connection, with tasks that have no price counted apart. */
function byConnection(days: Day[], names: Map<string, string>) {
  const totals = new Map<string, { id: string; name: string; runs: number; cost: number; unpriced: number }>();
  for (const day of days) for (const preset of day.presets) {
    const key = preset.id || preset.model || "unknown";
    const entry = totals.get(key) ?? { id: key, name: names.get(preset.id) ?? (preset.model || key), runs: 0, cost: 0, unpriced: 0 };
    entry.runs += preset.runs;
    if (preset.cost === null) entry.unpriced += preset.runs;
    else entry.cost += preset.cost;
    totals.set(key, entry);
  }
  return [...totals.values()].sort((a, b) => b.cost - a.cost || b.runs - a.runs);
}

/**
 * What the month will come to at today's pace. The same sum as `forecastMonth` in public/usage.js,
 * worked out here so a phone gets it in the one call; a month with no priced task says null.
 */
export function forecast(days: Day[], today: Date): { cost: number; priced: number; projected: number | null } {
  const cost = days.reduce((total, day) => total + (day.pricedRuns ? day.estimatedCost : 0), 0);
  const priced = days.reduce((total, day) => total + day.pricedRuns, 0);
  const daysInMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
  return { cost, priced, projected: priced ? (cost / today.getUTCDate()) * daysInMonth : null };
}

/** The usage ledger files each task under its UTC day (src/usage.ts), so days are matched the same way. */
const ledgerDay = (when: Date) => when.toISOString().slice(0, 10);

export function spendSection(app: Branch, deps: SummaryDeps = {}) {
  const owner = app.runtime.owner, now = deps.now?.() ?? new Date();
  const { overrides } = pricingSettings(app.store, owner);
  const days = app.store.usageStore().aggregateUsage("90d", "day", overrides) as Day[];
  const month = days.filter((day) => day.date.startsWith(ledgerDay(now).slice(0, 8)));
  const today = days.filter((day) => day.date === ledgerDay(now));
  const names = new Map(app.runtime.models.summary(owner).presets.map((preset) => [preset.id, preset.name]));
  const sum = (list: Day[]) => ({
    cost: list.reduce((total, day) => total + day.estimatedCost, 0),
    pricedRuns: list.reduce((total, day) => total + day.pricedRuns, 0),
    unpricedRuns: list.reduce((total, day) => total + day.unpricedRuns, 0),
    byConnection: byConnection(list, names),
  });
  // The project ledger counts back in days from this moment, so a part-day reaches exactly midnight UTC.
  const back = (from: Date) => Math.max(1 / 1440, (now.getTime() - from.getTime()) / 86_400_000);
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return {
    currency: "USD",
    today: { ...sum(today), byProject: costByProject(app.store, owner, back(midnight)) },
    month: { ...sum(month), forecast: forecast(month, now).projected, byProject: costByProject(app.store, owner, back(firstOfMonth)) },
  };
}

/* ---------- Activity ---------- */

export function activitySection(app: Branch, limit = 40) {
  const events = app.store.recentEvents(app.store.profiles.scope(), 400);
  return {
    /** The live updates start after this, so nothing is shown twice. */
    lastEventId: events[0]?.id ?? 0,
    events: events.filter((event) => ACTIVITY_KINDS.has(event.kind)).slice(0, limit).map((event) => ({
      id: event.id, runId: event.runId, kind: event.kind, createdAt: event.createdAt,
      about: clip(app, event.data.name ?? event.data.label ?? event.data.model ?? event.data.question ?? event.data.error ?? "", 80),
    })),
  };
}
