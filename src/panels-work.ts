/**
 * Redesign phase 2 (panels): what the side panel's Browser and Terminal tabs show for one conversation.
 *
 * Nothing new runs here. It reads back what the assistant already did in the conversation's last few
 * tasks: the web pages it opened (the browser and web tools) and the commands it ran (the command tools),
 * each with what came back, and the commands it was refused or is waiting on a yes for. The owner's
 * alone: src/short-lived-keys.ts refuses it to every short-lived key, and so to a household person.
 *
 * parity-b2: a command that ran says who let it: "owner" when the owner's yes let it through (it asked first, a
 * `policy.ask` for the same call; a yes already given in the conversation answered it, `policy.answered`; or the owner
 * overruled a refusal, `policy.overruled`), "rules" when it ran without anyone being asked. And the files a task
 * only read (files.read, files.read_many) are listed, so the Files tab can say "Read" beside what it changed.
 *
 *   GET /api/panels/work?session=<id>
 */
import type { Store } from "./store.js";
import type { Event, Run } from "./contracts.js";
import { redactLeaksIn } from "./leak-guard.js";

export const panelsWorkPath = "/api/panels/work";
/** How many of the conversation's latest tasks are read, and how much of any output is kept. */
const TASKS = 8;
const OUTPUT = 1200;
const ENTRIES = 40;

export type WorkState = "running" | "done" | "failed" | "stopped" | "practice" | "refused" | "waiting";
export interface WorkEntry {
  at: string;
  tool: string;
  /** The command line, or the web address or search; the step's plain label when neither is known. */
  what: string;
  output: string | null;
  state: WorkState;
  /** Who let a step that ran go ahead: the owner's yes to its question, or the rules without asking; null otherwise. */
  allowed: "owner" | "rules" | null;
}
export interface PanelsWork {
  running: boolean;
  browser: { entries: WorkEntry[]; picture: string | null };
  terminal: { entries: WorkEntry[] };
  /** Workspace files the tasks read and did not change, oldest first. */
  files: { read: string[] };
}

export const isBrowserTool = (tool: string): boolean => /^(browser|web)\./.test(tool);
/** The same tools src/policy-resources.ts treats as command lines, and the programs kept running. */
export const isTerminalTool = (tool: string): boolean =>
  tool === "shell.execute" || /^(shell|terminal)\./.test(tool) || tool === "process.start" || tool === "remote.run";
const isReadTool = (tool: string): boolean => tool === "files.read" || tool === "files.read_many";

const text = (value: unknown): string => (typeof value === "string" ? value : "");
function parsed(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  try { const value: unknown = JSON.parse(text(raw)); return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
  catch { return {}; }
}
const joined = (program: unknown, rest: unknown): string =>
  [program, ...(Array.isArray(rest) ? rest : [])].map((v) => String(v ?? "")).join(" ").trim();

/** What a call was about, in the words a person would recognise: the command, or the address. */
export function describe(tool: string, args: Record<string, unknown>): string {
  if (tool === "shell.execute") return joined(args.executable, args.args);
  if (tool === "shell.session.run") return text(args.input);
  if (tool === "shell.session.open" || tool === "remote.run" || tool === "process.start") return joined(args.program ?? args.command, args.args);
  if (tool === "web.search") return text(args.query);
  return text(args.url) || text(args.address) || text(args.query);
}
function clipped(value: string): string {
  return value.length > OUTPUT ? value.slice(0, OUTPUT) + "…" : value;
}
/** What came back, as text: a command's printout, or the page's title and address (not again when `what` already says it). */
export function outputOf(tool: string, result: unknown, what = ""): string | null {
  if (result === undefined || result === null) return null;
  if (typeof result === "string") return clipped(result);
  const r = result as Record<string, unknown>;
  if (isTerminalTool(tool)) {
    const printed = [text(r.stdout), text(r.stderr), text(r.output)].filter(Boolean).join("\n").trim();
    const exit = typeof r.exitCode === "number" && r.exitCode !== 0 ? `(finished with code ${r.exitCode})` : "";
    return clipped([printed, exit].filter(Boolean).join("\n")) || null;
  }
  const page = [text(r.title), text(r.url) === what ? "" : text(r.url)].filter(Boolean).join(" · ");
  return page ? clipped(page) : null;
}

/** The arguments of the calls these tasks made, read back off the assistant messages by call id. */
function argumentsById(store: Store, sessionId: string, wanted: Set<string>): Map<string, Record<string, unknown>> {
  const found = new Map<string, Record<string, unknown>>();
  if (!wanted.size) return found;
  for (const message of store.messages(sessionId))
    for (const call of message.toolCalls ?? []) if (wanted.has(call.id)) found.set(call.id, parsed(call.arguments));
  return found;
}
/** The call ids of the browser and command steps in these events, so only their arguments are parsed. */
function callIds(events: Event[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    const tool = text(event.data.name), id = text(event.data.id);
    if (id && (isBrowserTool(tool) || isTerminalTool(tool) || isReadTool(tool))) ids.add(id);
  }
  return ids;
}
/**
 * integrate/p2-panels: a command line or a printout can carry a key the assistant typed or a program
 * printed. The event log is already scrubbed of saved secrets, but the command lines come off the
 * messages, and neither catches a key-shaped value the locker never saw: both are cleaned here, as
 * a chat app's copy is (src/index.ts, channels.hideLeaks).
 */
function cleaned(store: Store, entries: WorkEntry[]): WorkEntry[] {
  return entries.map((entry) => {
    const [what, output] = redactLeaksIn(store.secrets.scrubber.deep([entry.what, entry.output])).value;
    return { ...entry, what: what ?? "", output: output ?? null };
  });
}
const ENDED: Record<string, WorkState> = {
  "tool.completed": "done", "tool.failed": "failed", "tool.stalled": "stopped", "tool.simulated": "practice",
  "policy.denied": "refused", "policy.ask": "waiting",
};
/** A step that really ran was let through: by the owner's yes when it asked first, else by the rules. */
const RAN = new Set<WorkState>(["running", "done", "failed", "stopped"]);
/** The events that say the owner's yes let a call through. */
const OWNER_YES = new Set(["policy.ask", "policy.answered", "policy.overruled"]);
/** One task's browser and command steps, in the order they happened. */
function entriesOf(events: Event[], given: Map<string, Record<string, unknown>>, running: boolean): WorkEntry[] {
  const open = new Map<string, WorkEntry>();
  const asked = new Set<string>();
  const out: WorkEntry[] = [];
  for (const event of events) {
    const data = event.data;
    const tool = text(data.name);
    if (!isBrowserTool(tool) && !isTerminalTool(tool)) continue;
    const id = text(data.id) || `event-${event.id}`; // a step with no call id stands alone
    if (OWNER_YES.has(event.kind)) asked.add(id);
    const state = event.kind === "tool.started" ? "running" : ENDED[event.kind];
    if (!state) continue;
    const said = describe(tool, given.get(id) ?? {});
    const entry = open.get(id) ?? { at: event.createdAt, tool, what: said || text(data.target) || text(data.label), output: null, state, allowed: null };
    if (!open.has(id)) { open.set(id, entry); out.push(entry); }
    entry.state = state;
    entry.allowed = RAN.has(state) ? (asked.has(id) ? "owner" : "rules") : null;
    if (event.kind === "tool.started") continue;
    // A browser step whose arguments named no page (a picture, a click) says which page it was on.
    const page = isBrowserTool(tool) && !said ? text(parsed(data.result).url) : "";
    if (page) entry.what = page;
    entry.output = (page ? text(parsed(data.result).title) || null : outputOf(tool, data.result ?? data.error ?? data.reason, entry.what)) ?? entry.output;
  }
  // A step left "running" in a task that is over never finished; a question left open still waits.
  if (!running) for (const entry of out) if (entry.state === "running") entry.state = "stopped";
  return out;
}
/** A path as the tasks wrote it, compared the same way whichever slashes or "./" it came with. */
const samePath = (path: string): string => path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
/** The files these tasks read (a read that finished), leaving out any they also changed. */
function filesRead(events: Event[], given: Map<string, Record<string, unknown>>): string[] {
  const changed = new Set(events.filter((e) => e.kind === "file.changed").map((e) => samePath(text(e.data.path))));
  const read: string[] = [];
  for (const event of events) {
    const tool = text(event.data.name);
    if (event.kind !== "tool.completed" || !isReadTool(tool)) continue;
    const args = given.get(text(event.data.id)) ?? {};
    const paths = tool === "files.read" ? [args.path] : Array.isArray(args.paths) ? args.paths : [];
    for (const path of paths.map(text).map(samePath)) if (path && !changed.has(path) && !read.includes(path)) read.push(path);
  }
  return read.slice(-ENTRIES);
}
/** The last picture the browser took in these tasks, as the path the artifacts route serves. */
function lastPicture(events: Event[]): string | null {
  let found: string | null = null;
  for (const event of events) {
    if (event.kind !== "tool.completed" || event.data.name !== "browser.screenshot") continue;
    const path = text(parsed(event.data.result).path);
    if (path) found = path;
  }
  return found;
}

/** Everything the two tabs show for this conversation; empty lists when it is not the owner's. */
export function panelsWork(store: Store, owner: string, sessionId: string): PanelsWork {
  const empty: PanelsWork = { running: false, browser: { entries: [], picture: null }, terminal: { entries: [] }, files: { read: [] } };
  if (!sessionId || !store.ownsSession(owner, sessionId)) return empty;
  const runs: Run[] = store.runs(owner).filter((run) => run.sessionId === sessionId).slice(0, TASKS).reverse();
  const eventsOf = runs.map((run) => store.events(run.id));
  const given = argumentsById(store, sessionId, callIds(eventsOf.flat()));
  const all: WorkEntry[] = [];
  let picture: string | null = null;
  runs.forEach((run, i) => {
    all.push(...entriesOf(eventsOf[i] ?? [], given, run.status === "running"));
    picture = lastPicture(eventsOf[i] ?? []) ?? picture;
  });
  // parity-b2: a question the owner said yes to is carried on by the conversation's next task, which runs the same
  // command again; the first task's copy of the question then waits on nothing and is left out.
  const answered = (entry: WorkEntry, i: number): boolean => entry.state === "waiting"
    && all.slice(i + 1).some((later) => later.tool === entry.tool && later.what === entry.what && RAN.has(later.state));
  const shown = all.filter((entry, i) => !answered(entry, i));
  return {
    running: runs.some((run) => run.status === "running"),
    browser: { entries: cleaned(store, shown.filter((entry) => isBrowserTool(entry.tool)).slice(-ENTRIES)), picture },
    terminal: { entries: cleaned(store, shown.filter((entry) => isTerminalTool(entry.tool)).slice(-ENTRIES)) },
    files: { read: filesRead(eventsOf.flat(), given) },
  };
}
