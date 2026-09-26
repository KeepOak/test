import type { Runtime } from "../runtime.js";
import type { RunSource } from "../policy.js";
import type { FeatureMode } from "../feature-switches.js";
import type { Surface } from "./catalog.js";
import { conversationMarkdown } from "../memory-export.js";
import { listModels, switchModel } from "../model-switch.js";
import { lockdownState, setLockdown } from "../lockdown.js";
import { presetLines, choosePreset, sessionTotals, activeModel, historyLines } from "../terminal-commands.js";
import { homeOf, parseRoute } from "../terminal-places.js";
import { askAside, compactConversation } from "../channels/chat-commands.js";
import { answerFromHandbook } from "./docs-answer.js";
import { tokenLines, tokenReport } from "./tokens.js";
import { runningLines, statusLines, whoamiLines } from "./status.js";
import { helpText } from "./help-text.js";
import { promptsCommand } from "./saved.js";
import { trunkCommand } from "./trunk.js"; // R17-A
import { accountCommand } from "./account.js"; // mac6/accounts
import { BOARD_HANDLERS } from "../flows-boards/commands.js"; // r17-h
import { AUTONOMY_HANDLERS } from "../autonomy/commands.js"; // r17-b
import { initCommand } from "../coding/commands.js"; // mac7/r17-d
import { REACH_HANDLERS } from "../reach/commands.js"; // r17-i
import { learnCommand } from "../learn/commands.js"; // mac7/learn
import { adaptCommand } from "../adapt/commands.js"; // mac7/adapt
import { householdHere, mayUseConversation, runsHere } from "./household.js"; // Q259
import { conversationHolder } from "../household-approvals.js"; // Q261

/**
 * What each command does when it is carried out for a surface that has no code of its own for it:
 * the app window and the phone (through `POST /api/commands/run`), the dashboard, and the new
 * commands in the terminal and the chat apps. Every handler answers in words; a handler that needs
 * the page to do something (open a place, tick a box) also says what, and the page does it.
 */
export type Access = "full" | "run" | "read";
export type ClientAction =
  | { do: "go"; home: string }
  | { do: "toggle"; what: "plan" | "temporary" | "pane"; on: boolean | null; tab?: string }
  | { do: "new" } | { do: "attach" } | { do: "refresh-model" } | { do: "help" }
  | { do: "download"; name: string; text: string }
  | { do: "open-session"; id: string }
  | { do: "theme"; name: string }
  // bucket 12: send the finished text as the next message, or only put it in the message box
  | { do: "send"; text: string } | { do: "fill"; text: string }
  // r17-h: focus view on, off, or switched (public/flows-boards.js)
  | { do: "focus"; on: boolean | null };
export interface Reply { text: string; client?: ClientAction }

interface GoalView { status: string; round: number; maxRounds: number; objective: string; reason?: string; sessionId: string }
/** The goal feature (mac2/goal-undo), when this copy has it. */
export interface GoalHost {
  start(input: { objective: string; maxRounds?: number; sessionId?: string }): Promise<GoalView>;
  status(sessionId: string): GoalView | null;
  pause(sessionId: string): GoalView;
  resume(sessionId: string): Promise<GoalView>;
  stop(sessionId: string): GoalView;
}
export interface CommandHost {
  runtime: Runtime;
  version?: string;
  health?: () => Promise<{ ok: boolean; items: { name: string; ok: boolean; summary: string }[] }>;
  goals?: GoalHost;
  /** The owner's own profile check; throws while someone else's profile is in use. */
  requireOwner: (what: string) => void;
}
export interface Call {
  host: CommandHost;
  surface: Surface;
  argument: string;
  sessionId: string | undefined;
  access: Access;
  mode: FeatureMode;
  /** What a task from this chat may use, for `/whoami` in a chat app. */
  permissions?: string[];
}
type Handler = (call: Call) => Reply | Promise<Reply>;
const say = (text: string, client?: ClientAction): Reply => (client ? { text, client } : { text });
const needSession = "Start a conversation first; this command works on the conversation you are in.";
const onOff = (argument: string): boolean | null => (argument === "on" ? true : argument === "off" ? false : null);

function model(call: Call): Reply {
  const { runtime } = call.host, owner = runtime.owner;
  if (!call.argument || call.argument === "?") {
    const { active, choices } = listModels(runtime.models, owner, call.sessionId ?? "");
    return say(["Type /model followed by a name:", ...choices.map((c) => `${c.id === active ? "→ " : "  "}${c.name} (${c.model})`)].join("\n"));
  }
  if (!call.sessionId) return say("Start a conversation first, then /model changes the model for it.");
  // Q261: a household person at the window is not told the owner's connection names when a name is wrong, and their
  // own conversation is filed under their profile (POST /api/commands/run has checked it is theirs).
  const household = householdHere(runtime.store, call.surface);
  const holder = household ? conversationHolder(runtime.store, owner, call.sessionId) : owner;
  return say(switchModel(runtime.models, owner, call.sessionId, call.argument, { names: !household, holder }).message, { do: "refresh-model" });
}
function think(call: Call): Reply {
  const choice = call.argument === "default" ? null : call.argument;
  if (choice !== null && !["low", "medium", "high"].includes(choice)) return say("Use /think low, medium, high or default.");
  if (!call.sessionId) return say(needSession);
  call.host.runtime.models.configureSession(call.host.runtime.owner, call.sessionId, { reasoning: choice });
  return say(`Thinking is set to ${choice ?? "the model's default"} for this conversation.`);
}
function preset(call: Call): Reply {
  if (!call.argument) return say(presetLines(call.host.runtime).join("\n"));
  return say(choosePreset(call.host.runtime, call.argument));
}
function memory(call: Call): Reply {
  const { store } = call.host.runtime;
  // Q259: a household person at the window reads what is remembered for them (their profile's), never the owner's.
  const owner = householdHere(store, call.surface) ? store.profiles.scope() : call.host.runtime.owner;
  const facts = call.argument ? store.searchMemory(owner, call.argument) : store.list("memory", owner).slice(0, 20);
  if (!facts.length) return say(call.argument ? "No saved facts match that." : "Nothing saved to memory yet.");
  return say(facts.map((fact) => `- ${String(fact.data.text)}`).join("\n"));
}
function skills(call: Call): Reply {
  const list = call.host.runtime.store.skills.list(call.host.runtime.owner);
  if (!list.length) return say("No skills installed. Add a skill under Customize › Skills.", { do: "go", home: "customize:skills" });
  return say(list.map((skill) => `${skill.activeVersion ? "*" : " "} ${skill.name} — ${skill.description}`).join("\n"));
}
function exportConversation(call: Call): Reply {
  if (!call.sessionId) return say("There is nothing to save yet; send a message first.");
  const text = conversationMarkdown({ sessionId: call.sessionId }, call.host.runtime.store.messages(call.sessionId));
  return say("Saving this conversation as a Markdown file.", { do: "download", name: `conversation-${call.sessionId.slice(0, 8)}.md`, text });
}
/** `/go inbox finished`, `/settings appearance`, `/inbox`: the home it names, for the page to open. */
function go(prefix: string): Handler {
  return (call) => {
    const words = `${prefix} ${call.argument}`.trim();
    const route = words ? parseRoute(words) : null;
    if (!route) return say(`There is no place called "${words}". Try /go inbox, /go library memory or /settings appearance.`);
    const home = homeOf(route).replace(/^settings:models:.*$/, "settings:models");
    return say(`Opening ${home}.`, { do: "go", home });
  };
}
function theme(call: Call): Reply {
  if (!call.argument || call.argument === "list") return say("The themes are in Settings › Appearance.", { do: "go", home: "settings:appearance" });
  return say(`Choosing the theme ${call.argument}.`, { do: "theme", name: call.argument });
}
function defaultModel(call: Call): Reply {
  const { runtime } = call.host;
  if (!runtime.models.presets.has(call.argument)) return say(`No model called ${call.argument}. Use /model to list them.`);
  runtime.models.configure(runtime.owner, { activePreset: call.argument });
  return say(`New conversations start with ${runtime.models.presets.get(call.argument)!.name}.`);
}
function lockdown(call: Call): Reply {
  const { store, owner } = call.host.runtime, wanted = onOff(call.argument);
  if (!call.argument) return say(lockdownState(store, owner).on ? "Lockdown is on. Commands are refused; all else asks you." : "Lockdown is off.");
  if (wanted === null) return say("Send /lockdown on or /lockdown off.");
  const state = setLockdown(store, owner, { on: wanted }, "owner-by-command");
  // As the route does: turning it on also ends the yeses already given.
  if (state.on) call.host.runtime.approvals.forgetAll();
  return say(state.on ? "Lockdown is on. Commands are refused; all else asks you." : "Lockdown is off.");
}
function toggle(what: "plan" | "temporary"): Handler {
  return (call) => say(`Changing ${what === "plan" ? "plan first" : "temporary"}.`, { do: "toggle", what, on: onOff(call.argument) });
}

function stop(call: Call): Reply {
  const { runtime } = call.host;
  // Q259: at the window a household person finds and stops only their own tasks; the owner's read as no such id.
  const working = runsHere(runtime.store, runtime.owner, call.surface).filter((run) => run.status === "running");
  if (call.argument) {
    const wanted = call.argument.toLowerCase();
    const run = wanted.length >= 6 ? working.find((entry) => entry.id.startsWith(wanted)) : undefined;
    if (!run) return say("No working task has that id. Send /status to see what is working.");
    return say(runtime.cancel(run.id) ? "Stopping. Anything already changed stays changed." : "That task has already finished.");
  }
  const here = call.sessionId ? working.filter((run) => run.sessionId === call.sessionId) : [];
  if (!here.length) {
    if (call.surface === "dashboard" && working.length) return say([...runningLines(working), "Send /stop <task> to stop one."].join("\n"));
    return say(call.sessionId ? "Nothing is working in this conversation." : "Nothing is working right now.");
  }
  for (const run of here) runtime.cancel(run.id);
  return say("Stopping. Anything already changed stays changed; the record shows what was done.");
}
function usage(call: Call): Reply {
  const { runtime } = call.host, lines: string[] = [];
  if (call.sessionId) {
    const model = activeModel(runtime, runtime.models.session(runtime.owner, call.sessionId).preset ?? undefined);
    const totals = sessionTotals(runtime, call.sessionId, model);
    lines.push(`This conversation: ${totals.input} tokens in, ${totals.output} out · ${totals.cost}`);
  }
  // Q259: the month's tokens and spending are the owner's; a household person at the window sees their conversation's.
  if (householdHere(runtime.store, call.surface)) return say(lines.length ? lines.join("\n") : needSession);
  const month = runtime.store.usageStore().getMonthlyStats();
  lines.push(`This month (since ${month.monthStart}): ${month.currentMonthlyTokens} tokens · about $${month.estimatedCost.toFixed(2)}`
    + (month.unpricedRuns ? ` (${month.unpricedRuns} tasks had no price on file)` : "")
    + (month.stillBeingMade > 0 ? `, including about $${month.stillBeingMade.toFixed(2)} for something still being made` : "")); // hardening-3
  return say(lines.join("\n"));
}
async function compact(call: Call): Promise<Reply> {
  const { runtime } = call.host;
  if (!call.sessionId) return say("There is nothing to fold yet.");
  if (runtime.store.runs(runtime.owner).some((run) => run.sessionId === call.sessionId && run.status === "running"))
    return say("It is still working on something. Try /compact once it has answered.");
  const folded = await compactConversation(runtime, call.sessionId, sourceOf(call));
  return say(folded ? `Folded ${folded} earlier messages into a summary. The most recent ones stay as they are.`
    : "This conversation is still short; there is nothing to fold yet.");
}
const aside: Handler = async (call) => say(await askAside(call.host.runtime, call.sessionId, call.argument, sourceOf(call)));
/** A command typed in a chat app starts its side task as the chat's, never as the owner's own. */
const sourceOf = (call: Call): RunSource | undefined => (call.surface === "chat" ? "channel" : undefined);
const tokens: Handler = (call) => (call.sessionId ? say(tokenLines(tokenReport(call.host.runtime, call.sessionId)).join("\n")) : say(needSession));

const goalLine = (goal: GoalView): string =>
  `Goal (${goal.status}, round ${goal.round} of ${goal.maxRounds}): ${goal.objective}${goal.reason ? `\n${goal.reason}` : ""}`;
/** `<objective> [--max n]`, with n from 1 to 20. */
export function parseGoal(text: string): { objective: string; maxRounds?: number } {
  const limit = /(?:^|\s)--max(?:=|\s+)(\d+)\s*$/.exec(text);
  const objective = (limit ? text.slice(0, limit.index) : text).trim();
  if (!objective) throw new Error("Say what the goal is: /goal <what should be true when it is done> [--max rounds]");
  const rounds = limit ? Number(limit[1]) : undefined;
  if (rounds !== undefined && (rounds < 1 || rounds > 20)) throw new Error("A goal may have from 1 to 20 rounds.");
  return rounds === undefined ? { objective } : { objective, maxRounds: rounds };
}
async function goal(call: Call): Promise<Reply> {
  const goals = call.host.goals;
  if (!goals) return say("Standing goals are not part of this copy of Branch yet.");
  const word = call.argument.toLowerCase();
  if (!word || word === "status") {
    if (!call.sessionId) return say("There is no goal here. Start one: /goal <what should be true> [--max rounds]");
    const state = goals.status(call.sessionId);
    return say(state ? goalLine(state) : "There is no goal in this conversation. Start one: /goal <what should be true> [--max rounds]");
  }
  if (word === "pause" || word === "resume" || word === "stop") {
    if (!call.sessionId) return say(needSession);
    return say(goalLine(await goals[word](call.sessionId)));
  }
  const state = await goals.start({ ...parseGoal(call.argument), ...(call.sessionId ? { sessionId: call.sessionId } : {}) });
  return say(goalLine(state), state.sessionId && state.sessionId !== call.sessionId ? { do: "open-session", id: state.sessionId } : undefined);
}
async function health(call: Call): Promise<Reply> {
  if (!call.host.health) return say("The health check is not available here; run `branch doctor`.");
  const report = await call.host.health();
  const lines = report.items.map((item) => `${item.ok ? "ok        " : "needs a look"} ${item.name} — ${item.summary}`);
  return say([report.ok ? "Everything checked is working." : "Something needs a look:", ...lines].join("\n"));
}
async function help(call: Call): Promise<Reply> {
  const { runtime } = call.host;
  const question = call.argument.trim();
  if (!question || question === "all" || call.mode === "off") return say(helpText(call.surface, call.mode, question === "all"), { do: "help" });
  return say(await answerFromHandbook(question, async (prompt) => {
    const source = sourceOf(call);
    const run = await runtime.run({ prompt, temporary: true, permissions: [], onTextDelta: () => undefined, ...(source ? { source } : {}) });
    return run.status === "completed" ? run.output : "";
  }));
}
function sessions(call: Call): Reply {
  if (!call.argument) return say("Your earlier conversations are in Inbox › History.", { do: "go", home: "inbox:history" });
  const id = call.argument.toLowerCase();
  const { store, owner } = call.host.runtime;
  // Q259: a household person at the window opens only their own conversations; the owner's read as no such id.
  const found = id.length >= 6 ? runsHere(store, owner, call.surface).map((run) => run.sessionId).find((sessionId) => sessionId.startsWith(id)) : undefined;
  return found && mayUseConversation(store, owner, call.surface, found) ? say("Opening that conversation.", { do: "open-session", id: found }) : say("No conversation has that id.");
}
function pane(call: Call): Reply {
  const tab = ["activity", "plan", "files", "memory"].includes(call.argument) ? call.argument : undefined;
  return say("Showing or hiding the side pane.", { do: "toggle", what: "pane", on: tab ? true : null, ...(tab ? { tab } : {}) });
}

/** Every command a surface may hand to this file, by name. */
export const HANDLERS: Record<string, Handler> = {
  help, model, think, preset, memory, skills,
  plan: toggle("plan"), temporary: toggle("temporary"),
  attach: () => say("Choose a file to send with your next message.", { do: "attach" }),
  export: exportConversation,
  history: (call) => say(historyLines(call.host.runtime, call.sessionId).join("\n")),
  new: () => say("Starting a fresh conversation.", { do: "new" }),
  sessions,
  go: go(""), inbox: go("inbox"), automations: go("automations"), library: go("library"),
  customize: go("customize"), settings: go("settings"),
  theme, default: defaultModel, pane, lockdown,
  stop, status: (call) => say(statusLines(call).join("\n")), compact, usage, btw: aside, tokens, goal,
  whoami: (call) => say(whoamiLines(call).join("\n")),
  version: (call) => say(`Branch Agent ${call.host.version ?? "(version unknown)"}`),
  health,
  prompts: promptsCommand, // bucket 12
  trunk: trunkCommand, // R17-A
  account: accountCommand, // mac6/accounts
  ...AUTONOMY_HANDLERS, // r17-b: /loop, /heartbeat, /subgoal, /bg, /handoff, /suggestions, /blueprint
  init: initCommand, // mac7/r17-d
  adapt: adaptCommand, // mac7/adapt: get what a stopped task is missing, then carry it on
  ...REACH_HANDLERS, // r17-i: /platform
  ...BOARD_HANDLERS, // r17-h: /queue, /busy, /focus, /installs
  learn: learnCommand, // mac7/learn
};
