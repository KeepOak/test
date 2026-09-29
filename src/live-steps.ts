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
  find: "🔎",
  page: "📄",
  read: "📖",
  write: "✍️",
  edit: "🔧",
  files: "🗂️",
  command: "💻",
  process: "⚙️",
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
  retry: "🔁",
  switch: "🔀",
  paused: "⏸️",
  resumed: "▶️",
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
  // Hermes Agent's 🔎 "Searching files for …": a search inside files, told apart from a web search (🔍).
  [/^(files\.(grep|find|glob|search)|code\.search)$/, "find"],
  [/^(files\.|workspace\.|code\.map)/, "files"],
  // Hermes Agent's ⚙️ process_manage: a program Branch keeps running in the background, told apart from a command.
  [/^process\./, "process"],
  [/^(shell\.|remote\.run|device\.run|terminal\.)/, "command"],
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

/* ---------- the owner's language ---------- */
/** A length of time, for the window to say in the chosen language (Intl's own unit names). */
export interface Span { amount: number; unit: "second" | "minute" }
/**
 * A line's words as a key in public/locales and the parts filled into it, so the window says them in the language
 * chosen (fr, es, de). The English stays where it was (`label`, `result`, `sentence`) for the terminal, the phone and
 * the record. A number `count` picks the key's plural form (`<key>.one`, `<key>.other`); a Span is a length of time.
 * tests/live-step-words.test.mjs holds en.json's words, filled in, to exactly the English here.
 */
export interface Said { key: string; values?: Record<string, string | number | Span> }
/** Words with their English and their key. */
export interface Worded { english: string; said: Said }
export const worded = (key: string, english: string, values?: Said["values"]): Worded => ({ english, said: values ? { key, values } : { key } });
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
/** A wait in whole minutes from a minute up, else whole seconds (at least one). */
export const span = (ms: number): Span => (ms >= 60_000 ? { amount: Math.round(ms / 60_000), unit: "minute" } : { amount: Math.max(1, Math.round(ms / 1000)), unit: "second" });
const spanWords = (time: Span) => plural(time.amount, time.unit);
const inTime = (key: string, ms: number, english: (time: string) => string, more: Said["values"] = {}): Worded => {
  const time = span(ms);
  return worded(key, english(spanWords(time)), { ...more, time });
};

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
/** A count in words, with the key whose plural forms say it. */
const count = (key: string, n: number, one: string, many: string, english: (said: string) => string = (said) => said): Worded =>
  worded(key, english(plural(n, one, many)), { count: n });
const words = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);
const SEARCHES = /^(web\.search|files\.(search|grep|glob|find)|sessions\.search|history\.search|memory\.search)$/;
/**
 * The short result of a finished call, only where the tool's answer has a known shape (web.search: its results;
 * web.fetch: the page's text; files.read: the file's lines; files.list: its entries; files.write/edit: saved). Any
 * other answer gets no words, never a guess.
 */
export function resultWords(name: string, result: unknown): Worded | null {
  const value = result && typeof result === "object" && "result" in (result as object) && Object.keys(result as object).length <= 3
    ? (result as { result: unknown }).result : result;
  if (Array.isArray(value)) {
    if (SEARCHES.test(name)) return count("window.chat.live.found-results", value.length, "result", "results", (n) => `Found ${n}`);
    if (name === "files.list") return count("window.chat.live.items", value.length, "item", "items");
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (name === "web.fetch" && typeof v.text === "string") return count("window.chat.live.read-words", words(v.text), "word", "words", (n) => `Read ${n}`);
  if (name === "files.read" && typeof v.content === "string")
    return count("window.chat.live.read-lines", v.content.split("\n").length, "line", "lines", (n) => `Read ${n}`);
  if (SEARCHES.test(name) && Array.isArray(v.matches)) return count("window.chat.live.found-matches", v.matches.length, "match", "matches", (n) => `Found ${n}`);
  if (name === "files.list" && Array.isArray(v.entries)) return count("window.chat.live.items", v.entries.length, "item", "items");
  if ((name === "files.write" || name === "files.edit") && v.ok !== false) return worded("window.chat.live.saved", "Saved");
  return null;
}

/* ---------- the lines ---------- */
export type LiveState = "running" | "done" | "failed" | "waiting";
export interface LiveStep {
  /** Stable while the task runs: the call's id, the question's fingerprint, the helper's task, or the thought's place. */
  id: string;
  /** long-work: "state" is what happened to the task itself — a limit, a dropped connection, a restart, a pause. */
  kind: "think" | "tool" | "ask" | "helper" | "state";
  /** long-work: when a wait ends (ISO), for the window to show in the owner's own clock. */
  until?: string | undefined;
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
  /** The label's and the result's words by their language keys, where the engine has them (see `Said`). */
  say?: { label?: Said | undefined; result?: Said | undefined } | undefined;
  /** A tool line's tool, so a chat app can leave out Branch finding its way (`tools.*`) and show a command as code. */
  tool?: string | undefined;
  /** The workspace file a tool line is about, scrubbed, so a chat app can show it as code. */
  path?: string | undefined;
}
export interface LiveDeps {
  /** The thoughts the task's model streamed, oldest first (in memory only; runtime.thoughtsOf). */
  thoughtsOf: (runId: string) => { at: string; text: string; live: boolean }[];
  /** Every question waiting anywhere (the approval gate's list). */
  waiting: PendingApproval[];
  /** A helper's name from the specialist or mode it works as (`agent`), else the name recorded when it started. */
  helperName: (agent: string, recorded?: string) => string | null;
  /** Hides saved secrets in a text before any of it is cut short (the runtime's hideSecrets); the route scrubs the whole
     answer again after. */
  scrub?: Scrub;
}
/** How many lines one answer carries at most: the newest are kept. */
export const MAX_LINES = 120;

const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value));
/** A saved specialist's name, or null when there is none (it was never saved, or it was deleted). */
export function specialistName(store: Store, owner: string, id: string): string | null {
  const saved = store.get("specialists", owner, id)?.data as { definition?: { name?: unknown }; name?: unknown } | undefined;
  const name = saved?.definition?.name ?? saved?.name;
  return typeof name === "string" && name.trim() ? name : null;
}
const secondsBetween = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 100) / 10);
const firstLine = (text: string) => text.split("\n")[0]!.trim().slice(0, 160);

/** A command's own words for its line: "Running npm test" rather than "Running a command". */
function commandWords(args: string | undefined, scrub: Scrub): Worded | null {
  if (!args) return null;
  try {
    const a = JSON.parse(args) as Record<string, unknown>;
    const line = scrub([a.executable ?? a.command ?? a.cmd, ...(Array.isArray(a.args) ? a.args : [])].filter((x) => typeof x === "string" && x).join(" "));
    const command = line.length > 80 ? `${line.slice(0, 80)}…` : line;
    return line ? worded("window.chat.live.running", `Running ${command}`, { command }) : null;
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
        at: event.createdAt, seconds: null, depth, input: str(data.input) || null, output: null, tool: name });
      continue;
    }
    if (event.kind === "tool.started") {
      const args = given.get(id);
      const running = /^shell\.(execute|session\.run)$/.test(name) ? commandWords(args, scrub) : null;
      const path = str(data.path) ? scrub(str(data.path)) : "";
      lines.set(id, { id, kind: "tool", icon: stepIcon("tool", name), label: running?.english ?? (str(data.label) || name), result: null,
        state: "running", at: event.createdAt, seconds: null, depth, input: args ?? null, output: null, ...(running ? { say: { label: running.said } } : {}),
        tool: name, ...(path ? { path } : {}) });
      continue;
    }
    const line = lines.get(id);
    if (!line) continue;
    if (event.kind === "program.step.finished")
      Object.assign(line, data.error ? { state: "failed", result: firstLine(scrub(str(data.error))) } : { state: "done" }, { output: clip(data.output, scrub) });
    else if (event.kind === "tool.completed") {
      const came = resultWords(name, data.result);
      Object.assign(line, { state: "done", result: came?.english ?? null, output: clip(data.result, scrub) });
      if (came) line.say = { ...line.say, result: came.said };
    }
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

/* ---------- long-work: what happened to the task itself, in plain words, each with the one next step ---------- */
/** Events that end a wait: the model answered again, or the task stopped. */
const BACK = new Set(["model.completed", "model.reconnected", "model.limit_resumed", "model.account"]);
/** A result in the engine's own words (a model service's reason) has no key: it is shown as it came. */
function stateLine(event: Event, depth: number, icon: string, label: Worded, result: Worded | string | null): LiveStep {
  const came = result === null || typeof result === "string" ? null : result;
  return { id: `state:${event.id}`, kind: "state", icon, label: label.english, result: came ? came.english : result as string | null,
    state: "done", at: event.createdAt, seconds: null, depth, input: null, output: null, say: came ? { label: label.said, result: came.said } : { label: label.said } };
}
/** A line's result, changed after it was drawn: its English and its key together. */
const resultOf = (line: LiveStep, result: Worded | null): LiveStep =>
  Object.assign(line, { result: result?.english ?? null, say: result ? { label: line.say?.label, result: result.said } : { label: line.say?.label } });
/**
 * Account pools (src/accounts/pool-provider.ts sayMoved): the one line said the moment the work moves to another account,
 * "Moved to “Work” — “Home” hit its limit, resets 15:00": where it went, which account it left, why, and when that one
 * is back when the service or the plan meter said. `reason` is the pool's failure kind; `until` an ISO time.
 */
export function accountMoved(to: string, from: string, reason = "limit", until = "", known = false, model = ""): Worded {
  const values = { to, from };
  if (reason === "billing") return worded("window.chat.live.moved-credit", `Moved to “${to}” — “${from}” is out of credit`, values);
  if (reason === "auth" || reason === "refused") return worded("window.chat.live.moved-refused", `Moved to “${to}” — “${from}” was refused by the service`, values);
  if (reason === "model") return worded("window.chat.live.moved-model", `Moved to “${to}” — “${from}” can't use ${model}`, { ...values, model });
  const at = until && known ? new Date(until) : null;
  if (at && Number.isFinite(at.getTime())) {
    const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return worded("window.chat.live.moved-limit-at", `Moved to “${to}” — “${from}” hit its limit, resets ${time}`, { ...values, time });
  }
  return worded("window.chat.live.moved-limit", `Moved to “${to}” — “${from}” hit its limit`, values);
}
/**
 * Lines for what happened to the task rather than a step it took: a plan or rate limit and the account it moved to or
 * the wait for its reset, a dropped connection and each attempt after it, a model that went quiet or was swapped, the
 * owner's Pause, being picked up after a restart or a Resume, and the earlier conversation being summarised. A wait
 * stays "running" until the model answers again; one line per outage, however many attempts it took.
 */
export function stateLines(store: Store, run: Run, events: Event[], depth: number): LiveStep[] {
  const lines: LiveStep[] = [];
  let open: LiveStep | null = null, limitedLabel = "";
  const close = (result: Worded | null) => { if (open) { resultOf(Object.assign(open, { state: "done" as const, until: undefined }), result); open = null; } };
  for (const event of events) {
    const d = event.data;
    const waiting: LiveStep | null = open;
    if (BACK.has(event.kind) && waiting) {
      close(waiting.id.startsWith("net:") ? worded("window.chat.live.connected-again", "Connected again, so it carried on by itself")
        : worded("window.chat.live.limit-reset", "The limit reset, so it carried on by itself"));
      if (event.kind !== "model.account") continue;
    }
    switch (event.kind) {
      case "model.account": {
        const label = str(d.label) || str(d.account);
        if (limitedLabel && label !== limitedLabel)
          lines.push(stateLine(event, depth, STEP_ICONS.switch, accountMoved(label, limitedLabel), null));
        limitedLabel = "";
        break;
      }
      case "model.account_moved": {
        // Said the moment the work moves on; the "model.account" that follows once it answers adds nothing.
        const from = str(d.from) || limitedLabel;
        lines.push(stateLine(event, depth, STEP_ICONS.switch,
          accountMoved(str(d.label) || str(d.account), from, str(d.reason) || "limit", str(d.until), d.known === true, str(d.model)), null));
        limitedLabel = "";
        break;
      }
      case "model.account_limit": limitedLabel = str(d.label) || str(d.account); break;
      case "model.limit_wait": {
        const who = limitedLabel ? worded("window.chat.live.plan-limit", `“${limitedLabel}” reached its plan limit`, { from: limitedLabel })
          : worded("window.chat.live.service-limit", "Reached the model service's limit");
        const line: LiveStep = { ...stateLine(event, depth, STEP_ICONS.waiting, who,
          worded("window.chat.live.limit-wait", "Waiting for it to reset, then it carries on by itself; nothing to do")),
          state: "running", until: str(d.until) || undefined };
        open = line;
        lines.push(line);
        break;
      }
      case "model.network_retry": {
        const tries = { attempt: Number(d.attempt) || 1, of: Number(d.of) || 1 };
        const attempt = inTime("window.chat.live.trying-again", Number(d.delayMs) || 0, (time) => `Trying again in ${time} (${tries.attempt} of ${tries.of}); nothing to do`, tries);
        const current: LiveStep | null = open;
        if (current?.id.startsWith("net:")) { resultOf(current, attempt); break; }
        const line: LiveStep = { ...stateLine(event, depth, STEP_ICONS.retry, worded("window.chat.live.lost-connection", "Lost the connection to the model service"), attempt),
          id: `net:${event.id}`, state: "running" };
        open = line;
        lines.push(line);
        break;
      }
      case "model.retry_scheduled":
        lines.push(stateLine(event, depth, STEP_ICONS.retry, worded("window.chat.live.asked-wait", "The model service asked Branch to wait a moment"),
          inTime("window.chat.live.tried-after", Number(d.delayMs) || 0, (time) => `Tried again after ${time}`)));
        break;
      case "model.stall_recovery":
        if (d.action === "retry" || d.action === "fallback")
          lines.push(stateLine(event, depth, STEP_ICONS.retry, inTime("window.chat.live.no-answer", Number(d.afterMs) || 0, (time) => `The model gave no answer for ${time}`),
            d.action === "retry" ? worded("window.chat.live.asked-again", "Asked it again") : worded("window.chat.live.asked-next", "Asked the next model instead")));
        break;
      case "model.fallback":
        lines.push(stateLine(event, depth, STEP_ICONS.switch, worded("window.chat.live.moved-to", `Moved to ${str(d.model) || str(d.to)}`, { model: str(d.model) || str(d.to) }),
          firstLine(str(d.reason)) || null));
        break;
      case "run.pause_asked":
        lines.push({ ...stateLine(event, depth, STEP_ICONS.paused, worded("window.chat.live.paused", "Paused after this step. Nothing is lost."), null),
          state: run.status === "running" ? "running" : "done" });
        break;
      case "run.resumed": {
        const restarted = store.sqlite.prepare("SELECT 1 FROM events WHERE run_id=? AND kind='run.auto_resumed' LIMIT 1").get(str(d.from));
        lines.push(stateLine(event, depth, STEP_ICONS.resumed, restarted
          ? worded("window.chat.live.restarted", "Branch restarted, so it picked the task up from its last step")
          : worded("window.chat.live.carried-on", "Carried on from its last step"),
        Number(d.unknownToolOutcomes) > 0 ? worded("window.chat.live.checked-first", "A step that may already have happened is checked before it is done again")
          : worded("window.chat.live.nothing-again", "Nothing done before is done again")));
        break;
      }
      case "context.compacted":
        lines.push(stateLine(event, depth, STEP_ICONS.memory, worded("window.chat.live.summarised", "Summarised the earlier conversation"),
          worded("window.chat.live.kept", "Kept the decisions, the to-do list, the files touched, the pinned messages and your instructions")));
        break;
      default: break;
    }
  }
  if (open && run.status !== "running") close(null);
  return lines;
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
  const own = [...thoughtLines(run.id, deps, depth), ...toolLines(store, run, events, depth, scrub), ...askLines(run, events, deps, depth),
    ...stateLines(store, run, events, depth)]
    .sort((a, b) => a.at.localeCompare(b.at));
  if (depth >= 1) return own;
  const helpers = childrenOf(store, run).map(({ child, events: childEvents }) => {
    const started = childEvents.find((e) => e.kind === "run.started")!;
    const name = started.data.agent ? deps.helperName(str(started.data.agent), str(started.data.agentName)) : null;
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
