/**
 * Watch Branch think and work, live: one task's steps as short lines while it runs, for the window's reply area.
 *
 *   GET /api/runs/:id/live   (server-sent events; src/streams.ts streamLiveSteps)
 *
 * Each line is one thing the task is doing or did: a thought (the reasoning summary the provider streamed, held in
 * memory only and never written to the record), a tool call from the moment it starts ("Searching the web for …") to
 * what it came to ("Found 8 results") and how long it took, a question waiting on the owner, and each helper the task
 * started with that helper's own lines nested under it. The route scrubs the whole answer (`hideSecrets`) before it
 * leaves, as /api/runs/:id/steps does.
 *
 * The icon of each kind of step comes from one table (`stepIcon`), used here, by /api/runs/:id/steps and by the
 * helpers list, so a step looks the same live, folded and in a helper.
 */
import type { PendingApproval } from "./approvals.js";
import type { Event, Run } from "./contracts.js";
import { argumentsById } from "./inspect.js";
import type { Store } from "./store.js";

/* ---------- one emoji per kind of step ---------- */
/**
 * The one table: a kind of step, its emoji. Chosen after Hermes Agent's tool-progress emojis and OpenClaw's tool
 * display map (sources in the pull request that added it): one picture per kind of work, the same wherever it shows.
 */
export const STEP_ICONS = {
  thinking: "💭",
  search: "🔍",
  page: "📄",
  read: "📖",
  write: "✍️",
  edit: "📝",
  files: "🗂️",
  command: "💻",
  code: "🐍",
  memory: "🧠",
  browser: "🌐",
  helper: "🤖",
  message: "✉️",
  plan: "📋",
  question: "❓",
  approval: "🔒",
  settings: "⚙️",
  git: "🔀",
  schedule: "⏰",
  waiting: "⏳",
  done: "✅",
  failed: "❌",
  tool: "⚡",
} as const;
export type StepCategory = keyof typeof STEP_ICONS;

/** Tool names by what they do; the first matching prefix wins, anything else is a plain tool. */
const CATEGORY_OF: [RegExp, StepCategory][] = [
  [/^(web\.search|search\.)/, "search"],
  [/^web\.(fetch|read|extract)|^research\./, "page"],
  [/^files\.(read|validate)$/, "read"],
  [/^files\.write$/, "write"],
  [/^(files\.(edit|patch)|code\.(patch|change_set))$/, "edit"],
  [/^(files\.|workspace\.|code\.map)/, "files"],
  [/^(shell\.|process\.|remote\.run|device\.run|terminal\.)/, "command"],
  [/^code\./, "code"],
  [/^(memory\.|remember|sessions\.search|history\.search)/, "memory"],
  [/^(browser\.|computer\.|desktop\.|screen\.)/, "browser"],
  [/^(delegate\.|specialists\.|agents\.|trunk\.|team\.)/, "helper"],
  [/^(channels\.|email\.|mail\.|messages?\.)/, "message"],
  [/^(checklist\.|todos\.|plans?\.)/, "plan"],
  [/^user\.ask$/, "question"],
  [/^(schedules?\.|cron\.|automations?\.)/, "schedule"],
  [/^settings\./, "settings"],
  [/^git\./, "git"],
];
export function stepCategory(toolName: string): StepCategory {
  return CATEGORY_OF.find(([pattern]) => pattern.test(toolName))?.[1] ?? "tool";
}
/** The emoji for a tool by its name, or for a kind of step that is not a tool. */
export function stepIcon(kind: "tool" | "model" | "ask" | "helper" | "you" | "think", toolName = ""): string {
  if (kind === "tool") return STEP_ICONS[stepCategory(toolName)];
  if (kind === "ask") return STEP_ICONS.approval;
  if (kind === "helper") return STEP_ICONS.helper;
  if (kind === "think" || kind === "model") return STEP_ICONS.thinking;
  return STEP_ICONS.plan;
}

/* ---------- what a finished tool call came to, in words ---------- */
const CLIP = 800;
type Scrub = (text: string) => string;
const asIs: Scrub = (text) => text;
/** Clipped for the line, after the scrub has seen the whole text (a cut secret would no longer be recognised). */
const clip = (value: unknown, scrub: Scrub = asIs): string | null => {
  if (value === undefined || value === null) return null;
  const text = scrub(typeof value === "string" ? value : JSON.stringify(value));
  return text.length > CLIP ? `${text.slice(0, CLIP)}…` : text;
};
const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const words = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);
const SEARCHES = /^(web\.search|files\.(search|grep|glob|find)|sessions\.search|history\.search|memory\.search)$/;
/**
 * The short result of a finished call, only where the tool's answer has a known shape (web.search: its results;
 * web.fetch: the page's text; files.read: the file's lines; files.list: its entries; files.write/edit: saved). Any
 * other answer gets no words, never a guess.
 */
export function resultWords(name: string, result: unknown): string | null {
  const value = result && typeof result === "object" && "result" in (result as object) && Object.keys(result as object).length <= 3
    ? (result as { result: unknown }).result : result;
  if (Array.isArray(value)) {
    if (SEARCHES.test(name)) return `Found ${count(value.length, "result", "results")}`;
    if (name === "files.list") return count(value.length, "item", "items");
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (name === "web.fetch" && typeof v.text === "string") return `Read ${count(words(v.text), "word", "words")}`;
  if (name === "files.read" && typeof v.content === "string") return `Read ${count(v.content.split("\n").length, "line", "lines")}`;
  if (SEARCHES.test(name) && Array.isArray(v.matches)) return `Found ${count(v.matches.length, "match", "matches")}`;
  if (name === "files.list" && Array.isArray(v.entries)) return count(v.entries.length, "item", "items");
  if ((name === "files.write" || name === "files.edit") && v.ok !== false) return "Saved";
  return null;
}

/* ---------- the lines ---------- */
export type LiveState = "running" | "done" | "failed" | "waiting";
export interface LiveStep {
  /** Stable while the task runs: the call's id, the question's fingerprint, the helper's task, or the thought's place. */
  id: string;
  kind: "think" | "tool" | "ask" | "helper";
  icon: string;
  /** The plain words: "Searching the web for “tides”", "Reading example.com", or the thought itself. */
  label: string;
  /** What it came to ("Found 8 results"), or the first line of what went wrong; null while running or unknown. */
  result: string | null;
  state: LiveState;
  at: string;
  seconds: number | null;
  /** 0 for the task's own steps, 1 for a helper's. `seconds` is null while a step runs: the window counts from `at`, so
     the list changes only when a step does. */
  depth: number;
  /** What the step was given and what came back, clipped (the route scrubs both). */
  input: string | null;
  output: string | null;
}
export interface LiveDeps {
  /** The thoughts the task's model streamed, oldest first (in memory only; runtime.thoughtsOf). */
  thoughtsOf: (runId: string) => { at: string; text: string; live: boolean }[];
  /** Every question waiting anywhere (the approval gate's list). */
  waiting: PendingApproval[];
  helperName: (agent: string) => string | null;
  /** Hides saved secrets in a text before any of it is cut short (the runtime's hideSecrets); the route scrubs the whole
     answer again after. */
  scrub?: Scrub;
}
/** How many lines one answer carries at most: the newest are kept. */
export const MAX_LINES = 120;

const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value));
const secondsBetween = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 100) / 10);
const firstLine = (text: string) => text.split("\n")[0]!.trim().slice(0, 160);

/** A command's own words for its line: "Running npm test" rather than "Running a command". */
function commandWords(args: string | undefined, scrub: Scrub): string | null {
  if (!args) return null;
  try {
    const a = JSON.parse(args) as Record<string, unknown>;
    const line = scrub([a.executable ?? a.command ?? a.cmd, ...(Array.isArray(a.args) ? a.args : [])].filter((x) => typeof x === "string" && x).join(" "));
    return line ? `Running ${line.length > 80 ? `${line.slice(0, 80)}…` : line}` : null;
  } catch { return null; } // cut short or not JSON: the tool's own label stays
}

function toolLines(store: Store, run: Run, events: Event[], depth: number, scrub: Scrub): LiveStep[] {
  const given = argumentsById(store, run.sessionId);
  const lines = new Map<string, LiveStep>();
  for (const event of events) {
    const data = event.data, id = str(data.id) || `e${event.id}`, name = str(data.name);
    // A program working on its own (Claude Code) said this step; its words and input came with it, scrubbed.
    if (event.kind === "program.step.started") {
      lines.set(id, { id, kind: "tool", icon: stepIcon("tool", name), label: str(data.label) || name, result: null, state: "running",
        at: event.createdAt, seconds: null, depth, input: str(data.input) || null, output: null });
      continue;
    }
    if (event.kind === "tool.started") {
      const args = given.get(id);
      const label = (/^shell\.(execute|session\.run)$/.test(name) ? commandWords(args, scrub) : null) ?? (str(data.label) || name);
      lines.set(id, { id, kind: "tool", icon: stepIcon("tool", name), label, result: null, state: "running", at: event.createdAt,
        seconds: null, depth, input: args ?? null, output: null });
      continue;
    }
    const line = lines.get(id);
    if (!line) continue;
    if (event.kind === "program.step.finished") Object.assign(line, data.error ? { state: "failed", result: firstLine(scrub(str(data.error))) } : { state: "done" });
    else if (event.kind === "tool.completed") Object.assign(line, { state: "done", result: resultWords(name, data.result), output: clip(data.result, scrub) });
    else if (event.kind === "tool.failed" || event.kind === "tool.stalled")
      Object.assign(line, { state: "failed", result: firstLine(scrub(str(data.error))) || null, output: clip(data.error, scrub) });
    else continue;
    line.seconds = secondsBetween(line.at, event.createdAt);
  }
  return [...lines.values()];
}

function askLines(run: Run, events: Event[], deps: LiveDeps, depth: number): LiveStep[] {
  return events.filter((e) => e.kind === "policy.ask").map((event) => {
    const fingerprint = str(event.data.fingerprint);
    const waiting = deps.waiting.some((q) => q.runId === run.id && (q.fingerprint ?? "") === fingerprint);
    return { id: `ask:${run.id}:${fingerprint || event.id}`, kind: "ask" as const, icon: STEP_ICONS.approval,
      label: str(event.data.question) || str(event.data.label) || str(event.data.name), result: null,
      state: waiting ? "waiting" as const : "done" as const, at: event.createdAt, seconds: null, depth,
      input: str(event.data.bytes) || null, output: null };
  });
}

function thoughtLines(runId: string, deps: LiveDeps, depth: number): LiveStep[] {
  return deps.thoughtsOf(runId).map((thought, i) => ({
    id: `think:${runId}:${i}`, kind: "think" as const, icon: STEP_ICONS.thinking, label: thought.text, result: null,
    state: thought.live ? "running" as const : "done" as const, at: thought.at, seconds: null, depth, input: null, output: null,
  }));
}

const RUNNING: ReadonlySet<Run["status"]> = new Set(["running"]);
/** The tasks this one started (their run.started names it as the parent), oldest first; the same owner only. */
function childrenOf(store: Store, run: Run): { child: Run; events: Event[] }[] {
  return store.runs(run.owner).filter((child) => child.id !== run.id && child.owner === run.owner && child.createdAt >= run.createdAt)
    .map((child) => ({ child, events: store.events(child.id) }))
    .filter(({ events }) => str(events.find((e) => e.kind === "run.started")?.data.parentRunId) === run.id)
    .reverse();
}

function linesOf(store: Store, run: Run, events: Event[], deps: LiveDeps, depth: number): LiveStep[] {
  const scrub = deps.scrub ?? asIs;
  const own = [...thoughtLines(run.id, deps, depth), ...toolLines(store, run, events, depth, scrub), ...askLines(run, events, deps, depth)]
    .sort((a, b) => a.at.localeCompare(b.at));
  if (depth >= 1) return own;
  const helpers = childrenOf(store, run).map(({ child, events: childEvents }) => {
    const started = childEvents.find((e) => e.kind === "run.started")!;
    const name = started.data.agent ? deps.helperName(str(started.data.agent)) : null;
    const state: LiveState = RUNNING.has(child.status) ? "running" : child.status === "needs_input" ? "waiting"
      : child.status === "completed" ? "done" : "failed";
    const head: LiveStep = { id: `helper:${child.id}`, kind: "helper", icon: STEP_ICONS.helper, label: name ?? firstLine(scrub(child.prompt)),
      result: null, state, at: child.createdAt, seconds: RUNNING.has(child.status) ? null : secondsBetween(child.createdAt, child.updatedAt),
      depth, input: clip(child.prompt, scrub), output: null };
    return [head, ...linesOf(store, child, childEvents, deps, depth + 1)];
  });
  // A helper's lines stay together, under it, where it started.
  const out: LiveStep[] = [];
  const queue = [...helpers];
  for (const line of own) {
    while (queue.length && queue[0]![0]!.at <= line.at) out.push(...queue.shift()!);
    out.push(line);
  }
  for (const rest of queue) out.push(...rest);
  return out;
}

/** One task's live lines, newest last, with how long it has worked. */
export function liveSteps(store: Store, runId: string, deps: LiveDeps) {
  const run = store.run(runId);
  if (!run) throw new Error("Run not found");
  const steps = linesOf(store, run, store.events(run.id), deps, 0);
  const done = !RUNNING.has(run.status);
  return {
    runId: run.id, sessionId: run.sessionId, status: run.status, startedAt: run.createdAt,
    seconds: done ? secondsBetween(run.createdAt, run.updatedAt) : null,
    total: steps.length, steps: steps.slice(-MAX_LINES),
  };
}
