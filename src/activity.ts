import type { Event, Run } from "./contracts.js";
import type { Store } from "./store.js";
import { localFirstReplyMs, toolLimits } from "./knobs/apply.js";
import { localFirstReplyGraceMs } from "./reliability.js";

/** Q58: minimal shape of a queued follow-up message (matches Runtime's FollowUp interface). */
interface QueuedMessage { id: string; prompt: string; createdAt: string }

/**
 * Q51: how long a working task may record nothing before it reads "no update": the longest silence the owner's own
 * limits allow, with their settings applied: a model's stall window, one tool's run, or a model on this computer
 * starting its reply (with the grace the runtime gives it).
 */
export function staleAfterMs(store: Parameters<typeof toolLimits>[0], owner: string,
  limits: { modelStallMs: number; toolTimeoutMs: number; toolResultChars: number; localFirstReplyMs: number }): number {
  const firstMs = localFirstReplyMs(store, owner, limits);
  return Math.max(limits.modelStallMs, toolLimits(store, owner, limits).toolTimeoutMs, firstMs + localFirstReplyGraceMs(firstMs));
}

/**
 * Plain-language activity for a task in progress: what the assistant is doing right now and how
 * each earlier step ended, built from the durable event log so any client can show it.
 */
export interface ActivityStep { id: string; label: string; status: "working" | "done" | "failed" | "stopped"; at: string }
/** The plan a task is working through, where it has got to, and what a reviewer said. */
export interface ActivityPlan { steps: string[]; step: number; awaitingApproval: boolean; finished: boolean }
export interface RunActivity {
  runId: string; sessionId: string; prompt: string; status: Run["status"]; startedAt: string;
  current: string | null; steps: ActivityStep[]; working?: string;
  plan?: ActivityPlan; milestone?: string; verdict?: string;
  /** Q51: what the task is really doing, from its events. */
  task?: TaskState;
}

/**
 * Q51: what a task that has not finished is really doing, told from its own event log and nothing else. The
 * latest event that says so decides: it is working, waiting for the owner, waiting for a service (a rate pause, a
 * retry, a model loading, a fallback, a summary being written) or blocked (a refusal nothing has moved on from
 * yet). `why` is that event's kind, so the window can name it in the owner's language; `reason` is the event's
 * own words (the question asked, the message, the reason given), never made up; `until` is when a wait ends, when
 * the event says. There is no percentage: nothing records how much is left.
 * Q58: "queued" means the task is waiting for a busy conversation to become free. Position and waitingBehind are set for queued tasks.
 */
export type TaskStateName = "working" | "waiting-owner" | "waiting-service" | "blocked" | "finished" | "queued";
export interface TaskState {
  state: TaskStateName; why: string; reason: string;
  /** When the task last recorded anything. */
  lastUpdate: string;
  /** Working or waiting for a service, and nothing recorded for longer than a model or a tool may take. */
  stale: boolean;
  until?: string;
  /** Q58: position in queue (1-based), set for queued tasks. */
  position?: number;
  /** Q58: description of what this task is waiting behind, for queued tasks. */
  waitingBehind?: string;
}

const OWNER = new Set(["policy.ask", "attention.needed", "plan.awaiting_approval", "folder.trust_needed", "web.challenge", "run.can_continue"]);
const SERVICE = new Set(["rate.paused", "model.retry_scheduled", "model.loading", "model.fallback", "model.stalled", "context.compacting"]);
const BLOCKED = new Set(["policy.denied", "hook.blocked", "provider.refused", "reconciliation.required", "rounds.exhausted"]);
const WORKING = new Set(["run.started", "run.resumed", "model.started", "model.completed", "tool.started", "tool.completed", "tool.failed",
  "tool.stalled", "plan.approved", "plan.step.started", "run.milestone", "verify.verdict", "rate.resumed"]);
const FINISHED = new Set<Run["status"]>(["completed", "failed", "cancelled", "budget_exceeded"]);

/** Which of the four an event says, or null for one that says nothing about it (a note, a count). */
function stateOf(event: Event): Exclude<TaskStateName, "finished"> | null {
  const { kind, data } = event;
  if (kind === "run.stuck") return data.action === "ask" ? "waiting-owner" : "waiting-service";
  if (kind === "model.stall_recovery") return data.action === "fail" ? null : "waiting-service";
  if (OWNER.has(kind)) return "waiting-owner";
  if (SERVICE.has(kind)) return "waiting-service";
  if (BLOCKED.has(kind)) return "blocked";
  return WORKING.has(kind) ? "working" : null;
}
/** The event's own words for why, if it has any. */
function reasonOf(event: Event): string {
  const d = event.data;
  const words = d.question ?? d.message ?? d.note ?? d.reason ?? d.label ?? d.error ?? d.site ?? d.folder ?? d.provider ?? d.name ?? "";
  return short(words, 160);
}
/** When the wait an event describes ends, when it says. A fallback's `cooldownUntil` is when the first model may be
    tried again, not when the task stops waiting (it has already moved on), so it is not read here. */
function untilOf(event: Event): string | undefined {
  const d = event.data, at = Date.parse(event.createdAt);
  const wait = Number(d.waitMs ?? d.delayMs ?? (d.waitSeconds !== undefined ? Number(d.waitSeconds) * 1000 : NaN));
  return Number.isFinite(wait) && wait > 0 && Number.isFinite(at) ? new Date(at + wait).toISOString() : undefined;
}

export function taskState(run: Run, events: Event[], options: { now?: number; staleMs?: number } = {}): TaskState {
  const lastUpdate = events.at(-1)?.createdAt ?? run.updatedAt ?? run.createdAt;
  if (FINISHED.has(run.status)) return { state: "finished", why: run.status, reason: "", lastUpdate, stale: false };
  let decided: { state: Exclude<TaskStateName, "finished">; event: Event } | null = null;
  for (let at = events.length - 1; at >= 0 && !decided; at--) {
    const state = stateOf(events[at]!);
    if (state) decided = { state, event: events[at]! };
  }
  /* A task that stopped to ask, or that Branch closed on, waits for the owner whatever came last. */
  const waitsForOwner = run.status === "needs_input" || run.status === "interrupted";
  if (waitsForOwner && decided?.state !== "waiting-owner") {
    const asked = [...events].reverse().find((event) => stateOf(event) === "waiting-owner");
    decided = asked ? { state: "waiting-owner", event: asked } : null;
    if (!decided) return { state: "waiting-owner", why: run.status, reason: "", lastUpdate, stale: false };
  }
  if (!decided) return { state: "working", why: "run.started", reason: "", lastUpdate, stale: false };
  const { state, event } = decided;
  const quiet = (options.now ?? Date.now()) - Date.parse(lastUpdate);
  const stale = (state === "working" || state === "waiting-service") && quiet > (options.staleMs ?? 90_000);
  const until = state === "waiting-service" ? untilOf(event) : undefined;
  return { state, why: event.kind, reason: state === "working" ? "" : reasonOf(event), lastUpdate, stale, ...(until ? { until } : {}) };
}

const short = (value: unknown, max = 60): string => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
};
const host = (value: unknown): string => { try { return new URL(String(value)).host; } catch { return short(value); } };

/** Tools whose first argument is a workspace file, so a call on one counts as touching that file. */
const fileTools = new Set([
  "files.read", "files.write", "files.edit", "files.validate", "files.verify",
  "code.check", "document.open", "documents.add",
]);
/**
 * The workspace file a call is about, or "" when it is about none. It is written beside the call in
 * the task's own record so that "which files do you keep coming back to?" can be answered later
 * from what actually happened. Only the path is kept, never what was in the file.
 */
export function filePathOf(name: string, args: unknown): string {
  if (!fileTools.has(name)) return "";
  const path = (args && typeof args === "object" ? (args as Record<string, unknown>).path : undefined);
  return typeof path === "string" && path && path !== "." ? path.slice(0, 200) : "";
}

/** What a tool call is doing, for people; arguments are summarised and never echoed in full. */
export function describeToolCall(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  switch (name) {
    case "files.read": return `Reading ${short(a.path)}`;
    case "files.write": return `Writing ${short(a.path)}`;
    case "files.list": return `Looking through ${short(a.path ?? "the workspace")}`;
    case "files.search": case "files.grep": return `Searching files for “${short(a.query ?? a.pattern)}”`;
    case "files.glob": return `Listing files like ${short((a.patterns as string[] | undefined)?.[0])}`;
    case "files.find": return `Looking for a file called “${short(a.query)}”`;
    case "files.patch": return "Applying a set of file changes";
    case "code.patch": return a.dryRun ? "Working out what a set of file changes would do" : "Applying a set of file changes";
    case "code.change_set": return `Changing ${(a.edits as unknown[] | undefined)?.length ?? 0} files`;
    case "code.check": return "Running this project's check";
    case "code.run": return `Running a small ${a.language === "python" ? "Python" : "JavaScript"} script`;
    case "process.start": return `Starting ${short(a.name ?? a.executable)} and leaving it running`;
    case "process.list": return "Listing what is still running";
    case "process.read": return "Reading what a running program has said";
    case "process.stop": return "Stopping a running program";
    case "files.edit": return `Changing some text in ${short(a.path)}`;
    case "files.validate": return `Checking ${short(a.path)} still reads correctly`;
    case "workspace.map": case "code.map": return "Mapping the workspace";
    case "web.search": return `Searching the web for “${short(a.query)}”`;
    case "web.fetch": return `Reading ${host(a.url)}`;
    case "shell.execute": return "Running a command";
    case "shell.session.open": return "Opening a command line to keep";
    case "shell.session.run": return "Running a command on the open command line";
    case "shell.session.list": return "Listing the command lines being kept open";
    case "shell.session.close": return "Closing a kept-open command line";
    case "remote.run": return `Running a program on ${String(a.computer ?? "another computer")}`;
    case "git.status": return "Checking what changed";
    case "git.diff": return "Looking at the changed lines";
    case "git.log": return "Looking back through saved versions";
    case "git.branch": return "Working with lines of work";
    case "git.commit": return "Saving a version";
    case "git.worktree_add": case "git.worktree_remove": case "plans.try": return "Setting up a parallel copy";
    case "git.push": return "Sending work to the server";
    case "git.pull": return "Bringing down work from the server";
    case "user.ask": return "Asking you a question";
    // Dogfood E2: the owner read "Using device.run" and "Using settings.change" in questions; each now says what it does.
    case "device.run": return `Running ${short(a.executable ?? "a program")} on ${a.device ? short(a.device) : "your paired device"}`;
    case "settings.change": return "Changing Branch's own settings";
    case "settings.loosen": return "Making Branch less careful in its own settings";
    case "settings.undo": return "Undoing a change to Branch's own settings";
    case "settings.list": case "settings.find": case "settings.why": return "Looking through Branch's own settings";
    case "tools.search": case "tools.describe": case "tools.open": return "Looking for the right tool";
    case "checklist.write": return "Updating its checklist";
    case "agents.ask": return `Asking ${short(a.agent)}, an assistant elsewhere`;
    case "agents.remote": return a.action === "list" ? "Listing assistants elsewhere" : "Changing the list of assistants elsewhere";
    case "specialists.delegate": return `Asking the ${short(a.id)} specialist`;
    case "specialists.fanout": return "Running several specialists";
    case "sessions.search": case "history.search": return "Looking back through earlier conversations";
    case "history.attach": return "Reading another conversation for context";
    default:
      if (name.startsWith("memory.")) return name.endsWith("put") || name.endsWith("write") ? "Saving a note to memory" : "Checking memory";
      if (name.startsWith("schedules.")) return "Updating a schedule";
      if (name.startsWith("skills.")) return "Reading a skill";
      if (name.startsWith("browser.")) return "Using the browser";
      if (name.startsWith("github.")) return "Using GitHub";
      return `Using ${name}`;
  }
}

/** Steps and the current activity of one run, from its events. */
export function runActivity(run: Run, events: Event[], options: { now?: number; staleMs?: number } = {}): RunActivity {
  const steps = new Map<string, ActivityStep>();
  for (const event of events) {
    const id = String(event.data.id ?? event.id), name = String(event.data.name ?? "tool");
    if (event.kind === "tool.started")
      steps.set(id, { id, label: String(event.data.label ?? describeToolCall(name, undefined)), status: "working", at: event.createdAt });
    else if (event.kind === "tool.completed" || event.kind === "tool.failed" || event.kind === "tool.stalled") {
      const step = steps.get(id) ?? { id, label: describeToolCall(name, undefined), status: "working" as const, at: event.createdAt };
      steps.set(id, { ...step, status: event.kind === "tool.completed" ? "done" : event.kind === "tool.failed" ? "failed" : "stopped", at: event.createdAt });
    }
  }
  const list = [...steps.values()];
  const working = list.filter((s) => s.status === "working").at(-1);
  // mac7/coding-next: a model on this computer still loading into memory is still the model's turn.
  const thinking = events.at(-1)?.kind === "model.started" || events.at(-1)?.kind === "model.loading";
  const current = run.status !== "running" ? null : working ? working.label : thinking || !list.length ? "Thinking" : "Thinking about the results";
  return {
    runId: run.id, sessionId: run.sessionId, prompt: run.prompt, status: run.status,
    startedAt: run.createdAt, current, steps: list.slice(-30), ...orchestrationState(events),
    task: taskState(run, events, options),
  };
}

/** The plan, the latest "where we are" note and the reviewer's verdict, from the same event log. */
function orchestrationState(events: Event[]): Partial<RunActivity> {
  const last = (kind: string): Event | undefined => events.filter((e) => e.kind === kind).at(-1);
  const created = last("plan.created") ?? last("plan.awaiting_approval");
  const titles = (created?.data.steps as unknown[] | undefined)?.map((s) => String(s)) ?? [];
  const started = last("plan.step.started");
  const plan: ActivityPlan | undefined = titles.length
    ? {
        steps: titles,
        step: Number(started?.data.step ?? 0),
        awaitingApproval: !!last("plan.awaiting_approval") && !last("plan.approved") && !started,
        finished: !!last("plan.completed"),
      }
    : undefined;
  const milestone = last("run.milestone")?.data.text;
  const verdict = last("verify.verdict")?.data.verdict;
  return {
    ...(plan ? { plan } : {}),
    ...(milestone ? { milestone: String(milestone) } : {}),
    ...(verdict ? { verdict: String(verdict) } : {}),
  };
}

/**
 * Activity for every task of the owner that is still running, with what the conversation is doing. With
 * `waiting`, also each conversation's latest task when it stopped to ask the owner (Q51): the one the owner can
 * still answer, never an older one a later task has moved past. The default stays running tasks only, since
 * other screens count these as busy.
 */
export function liveActivity(store: Store, owner: string, options: { waiting?: boolean; staleMs?: number; now?: number } = {}): RunActivity[] {
  const running = store.runs(owner).filter((run) => run.status === "running");
  /* Each conversation's newest task when it waits for the owner, read apart from the recent-history window. */
  const waiting = options.waiting === true ? store.waitingRuns(owner) : [];
  return [...running, ...waiting].map((run) => {
    const working = store.working.describe(run.sessionId);
    return { ...runActivity(run, store.events(run.id), options), ...(working ? { working } : {}) };
  });
}

const HOLDING = new Set<TaskStateName>(["working", "waiting-owner", "waiting-service", "blocked"]);
/**
 * Q58: pseudo-activities for queued messages waiting in a conversation's queue.
 * Each shows position (1-based), what it waits behind (running task or earlier queued message),
 * and when it was queued. Pure function: no side effects, <50 lines.
 */
export function queuedActivity(activity: RunActivity, queued: QueuedMessage[]): RunActivity[] {
  /* A task that works, or waits for the owner or a service, or is blocked, still holds the conversation. */
  const holding = HOLDING.has(activity.task?.state ?? "finished");
  return queued.map((item, i) => {
    const waitingBehind = i > 0 ? queued[i - 1]!.prompt.slice(0, 60) : holding ? activity.prompt.slice(0, 60) : "";
    return {
      runId: item.id, sessionId: activity.sessionId, prompt: item.prompt,
      status: "running" as const, startedAt: item.createdAt, current: null,
      steps: [], task: { state: "queued" as const, why: "run.queued", reason: "", lastUpdate: item.createdAt, stale: false, position: i + 1, waitingBehind },
    };
  });
}
