import type { Runtime } from "../runtime.js";
import type { RunSource } from "../policy.js";
import { compactionSplit } from "../runtime.js";
import { parseSessionSummary, summaryText } from "../session-summary.js";
import { usageLine } from "../terminal-tui.js";
import type { FeatureMode } from "../feature-switches.js";
import { aliasesOn, lookup, parseLine, type CatalogCommand } from "../commands/catalog.js";
import { available, commandMode, commandsFor } from "../commands/settings.js";
import { executeCommand } from "../commands/execute.js";
import { commandHost } from "../commands/host.js";
import { improveCommand } from "../self-development-requests.js";

/**
 * Commands a person can type in a chat app while Branch works: stop the task, ask where it is,
 * start afresh, fold the conversation, add a tokens-and-cost line to replies, and ask a quick
 * question on the side. Only messages that already passed the sender check get here, so a
 * stranger's "/stop" is answered like any other stranger's message.
 *
 * The list follows OpenClaw's chat commands (MIT); the code is written for Branch.
 */
export type ChatCommandName = string;
export interface ChatCommand { name: ChatCommandName; argument: string }
/**
 * One chat command, as data: what it is called, other names it answers to, what it does in plain
 * words, what may follow it, whether it is one of the few that matter while a task works (the
 * "when needed" setting reads only those), and what it does. The names, words and arguments come
 * from the one table every surface reads (src/commands/catalog.ts, wave mac3).
 */
export interface ChatCommandSpec {
  name: ChatCommandName;
  aliases: readonly string[];
  description: string;
  args: string;
  whileWorking: boolean;
  run: (argument: string, context: CommandContext) => string | Promise<string>;
}
/**
 * The chat apps' own code for the commands they had first, and for /improve, which needs the chat
 * message itself (who sent it, and where); the rest is the shared code.
 */
const RUNNERS: Record<string, ChatCommandSpec["run"]> = {
  stop: (_, c) => stop(c),
  status: (_, c) => status(c),
  new: (_, c) => fresh(c),
  compact: (_, c) => compact(c),
  usage: (a, c) => usage(a, c),
  btw: (a, c) => aside(a, c),
  help: (a, c) => (a && modeHere(c) !== "off" ? shared("help")(a, c) : chatCommandHelp(modeHere(c))),
  improve: (a, c) => improveCommand(a, c),
};
const modeHere = (context: CommandContext): FeatureMode => commandMode(context.runtime.store, context.runtime.owner);
/** A command carried out by the shared code, for this chat, with what this chat's sender may do. */
function shared(name: string): ChatCommandSpec["run"] {
  return async (argument, context) => {
    const outcome = await executeCommand(commandHost(context.runtime), {
      surface: "chat", line: `/${name} ${argument}`.trim(), sessionId: context.sessionId, access: "run",
      permissions: context.permissions,
    });
    return outcome?.text ?? "I do not know that command. Send /help for the list.";
  };
}
const toSpec = (entry: CatalogCommand): ChatCommandSpec => ({
  name: entry.name, aliases: entry.aliases, description: entry.english, args: entry.args,
  whileWorking: entry.whileWorking === true, run: RUNNERS[entry.name] ?? shared(entry.name),
});
/** The chat commands with the shared switch where it is (off: the ones chat apps always had). */
export function chatCommandsFor(mode: FeatureMode, all = false): ChatCommandSpec[] {
  return commandsFor("chat", mode, all).map(toSpec);
}
export const chatCommands: readonly ChatCommandSpec[] = chatCommandsFor("off");
export const chatCommandNames = chatCommands.map((command) => command.name);
/** The table entry for a parsed command. */
export const chatCommandSpec = (name: ChatCommandName): ChatCommandSpec => {
  const found = lookup(name);
  if (!found || !found.surfaces.includes("chat")) throw new Error(`/${name} is not a chat command`);
  return toSpec(found);
};

/**
 * Reads "/stop", "/Stop", "/stop@BranchBot" (how Telegram addresses a command in a group), an
 * alias such as "/cancel", and so on. Anything else, including an unknown "/word" or one the
 * shared switch keeps out of chats, is an ordinary message and returns null.
 */
export function parseChatCommand(text: string, mode: FeatureMode = "off"): ChatCommand | null {
  if (!/^\/[a-z?]/i.test(text.trim())) return null;
  const parsed = parseLine(text, mode === "off", "chat");
  if (!parsed || !available(parsed.command, "chat", mode)) return null;
  return { name: parsed.command.name, argument: parsed.argument };
}

/** The list a person gets for /help, written from the table. */
export function chatCommandHelp(mode: FeatureMode = "off"): string {
  const lines = chatCommandsFor(mode).map((command) => {
    const shown = aliasesOn(lookup(command.name)!, "chat", mode === "off");
    const also = shown.length ? ` (or ${shown.map((alias) => `/${alias}`).join(", ")})` : "";
    return `/${command.name}${command.args ? ` ${command.args}` : ""}${also} - ${command.description}`;
  });
  const more = mode === "when-needed" ? ["Send /help all for every command, or /help <question> to ask about Branch."] : [];
  return ["Things you can send while I work:", ...lines, ...more, "Any other message while I work is passed to the task as a note."].join("\n");
}

/** The task a chat has going, as the router keeps it. */
export interface ChatTurn {
  runId: string | null;
  startedAt: number;
  /** Notes from the person already handed to the task. */
  passed: number;
}
export interface CommandContext {
  runtime: Runtime;
  channel: string;
  chatId: string;
  /** The conversation this chat carries on, when it has one. */
  sessionId: string | undefined;
  turn: ChatTurn | undefined;
  /** What a task from this chat may use; a side question gets none of it. */
  permissions: string[];
  /** The message the command came in: who sent it, so a request to change Branch says so. */
  from?: { senderId: string; senderName: string; messageId: string };
  /** Drops a message that is still waiting to start. True when there was one. */
  dropWaiting(): boolean;
  /** Points the chat at no conversation, so the next message starts a new one. */
  forget(): void;
  now?: () => number;
}

const usageKey = (channel: string, chatId: string) => `channel-usage:${channel}:${chatId}`;
/** Whether replies in this chat end with a tokens-and-cost line. */
export function usageShown(runtime: Runtime, channel: string, chatId: string): boolean {
  const saved = runtime.store.get("settings", runtime.owner, usageKey(channel, chatId))?.data as { on?: boolean } | undefined;
  return saved?.on === true;
}
/** The tokens-and-cost line for one finished task, or null when nothing was counted. */
export function usageFooter(runtime: Runtime, runId: string): string | null {
  const run = runtime.store.run(runId);
  return run ? usageLine(runtime.store, run) : null;
}

/** Carries out one command and returns the words to send back. */
export async function runChatCommand(command: ChatCommand, context: CommandContext): Promise<string> {
  if (command.name === "help" && command.argument.toLowerCase() === "all") return chatCommandHelp(modeHere(context) === "off" ? "off" : "on");
  return chatCommandSpec(command.name).run(command.argument, context);
}

function stop(context: CommandContext): string {
  const { turn, runtime } = context;
  if (turn?.runId && runtime.cancel(turn.runId)) return "Stopping. Anything already changed stays changed; the app shows what was done.";
  if (context.dropWaiting()) return "Dropped that. Nothing was started.";
  return "Nothing is working right now.";
}

function status(context: CommandContext): string {
  const { turn, runtime } = context;
  const usageNote = usageShown(runtime, context.channel, context.chatId) ? " Replies here end with a tokens-and-cost line." : "";
  if (!turn) return `Nothing is working right now.${usageNote}`;
  if (!turn.runId) return "Your message is about to start.";
  const seconds = Math.max(0, Math.round(((context.now ?? Date.now)() - turn.startedAt) / 1000));
  const events = runtime.store.events(turn.runId);
  const started = events.filter((e) => e.kind === "tool.started" && !String(e.data.name ?? "").startsWith("tools."));
  const finished = events.filter((e) => ["tool.completed", "tool.failed", "tool.stalled"].includes(e.kind)
    && !String(e.data.name ?? "").startsWith("tools.")).length;
  const last = started.at(-1);
  const label = last ? String(last.data.label ?? last.data.name ?? "").replace(/\s+/g, " ").slice(0, 80) : "";
  const lines = [
    `Working for ${seconds} s, ${started.length} ${started.length === 1 ? "step" : "steps"} so far (${Math.min(finished, started.length)} done).`,
    ...(label ? [`Latest step: ${label}`] : ["Thinking about it."]),
    ...(turn.passed ? [`${turn.passed} ${turn.passed === 1 ? "note" : "notes"} from you passed to the task.`] : []),
  ];
  return lines.join("\n") + usageNote;
}

function fresh(context: CommandContext): string {
  if (context.turn) return "I am still working on something. Send /stop first, then /new.";
  if (!context.sessionId) return "This chat has no conversation yet; your next message starts one.";
  context.forget();
  return "Your next message starts a new conversation. The earlier one is kept in the app.";
}

function usage(argument: string, context: CommandContext): string {
  const { runtime, channel, chatId } = context;
  const word = argument.toLowerCase();
  if (word && word !== "on" && word !== "off") return "Send /usage on or /usage off.";
  const on = word ? word === "on" : !usageShown(runtime, channel, chatId);
  runtime.store.save("settings", runtime.owner, usageKey(channel, chatId), { on, channel, chatId, updatedAt: new Date().toISOString() });
  return on ? "From now on my replies here end with a tokens-and-cost line." : "My replies here no longer end with a tokens-and-cost line.";
}

const compactionAsk = "Summarize the conversation below for a handoff to yourself. Reply with JSON only: "
  + "{\"goals\":[],\"decisions\":[],\"openQuestions\":[],\"filesTouched\":[]}. Keep identifiers and paths exactly, "
  + "at most eight short entries per list. Do not use any tools.";

/** A task's opening message may be at most this long (RunInputSchema). */
const promptLimit = 15500;
/** Text cut to `room` characters by keeping its beginning and its end, which a summary needs most. */
export function keepEnds(text: string, room: number): string {
  if (text.length <= room) return text;
  const marker = "\n[... middle left out ...]\n";
  const half = Math.max(0, Math.floor((room - marker.length) / 2));
  return text.slice(0, half) + marker + text.slice(text.length - half);
}

/**
 * Folds the earlier part of the conversation into a summary now, the same way a long task does on
 * its own: the most recent messages and anything pinned stay as they are. The summary is written
 * by a short side task with no tools, so nothing in the conversation can make it act.
 */
export async function compactConversation(runtime: Runtime, sessionId: string, source?: RunSource): Promise<number> {
  const { summary: earlier, rows } = runtime.store.workingMessages(sessionId);
  const messages = rows.map((row) => row.message), ids = rows.map((row) => row.id);
  const split = compactionSplit(messages, ids);
  if (!split) return 0;
  const head = `${compactionAsk}\n\n${earlier ? `Earlier summary:\n${earlier.slice(0, 6000)}\n\n` : ""}`;
  const transcript = messages.slice(split.from, split.to).map((m) => `${m.role}: ${m.content}`).join("\n");
  const run = await runtime.run({
    prompt: head + keepEnds(transcript, promptLimit - head.length),
    temporary: true, permissions: [], onTextDelta: () => undefined, ...(source ? { source } : {}),
  });
  if (run.status !== "completed" || !run.output.trim()) throw new Error("the summary could not be written");
  const reply = run.output.trim().slice(0, 6000);
  const structured = parseSessionSummary(reply);
  const text = structured ? summaryText(structured) : reply;
  runtime.store.saveSessionSummary(runtime.owner, sessionId, structured, text);
  runtime.store.saveCompaction(sessionId, ids[split.to - 1]!, text);
  return split.to - split.from;
}

async function compact(context: CommandContext): Promise<string> {
  if (context.turn) return "I am still working on something. Try /compact once I have answered.";
  if (!context.sessionId) return "There is nothing to fold yet.";
  try {
    const folded = await compactConversation(context.runtime, context.sessionId, "channel");
    return folded
      ? `Folded ${folded} earlier messages into a summary. The most recent ones stay as they are.`
      : "This conversation is still short; there is nothing to fold yet.";
  } catch (error) {
    return `I could not fold the conversation: ${error instanceof Error ? error.message : String(error)}.`;
  }
}

/**
 * A quick question answered on the side. It sees the last few messages so "btw, what was that
 * file called?" makes sense, but it runs in a throwaway conversation with no tools, so it never
 * joins the task, never changes anything, and is gone when the app next starts.
 */
async function aside(question: string, context: CommandContext): Promise<string> {
  return askAside(context.runtime, context.sessionId, question, "channel");
}
/** The side question itself, shared with the other surfaces through src/commands (wave mac3). */
export async function askAside(runtime: Runtime, sessionId: string | undefined, question: string, source?: RunSource): Promise<string> {
  if (!question) return "Ask it like this: /btw what time is it in Lagos?";
  const recent = sessionId ? runtime.store.workingMessages(sessionId).rows.slice(-6)
    .filter((row) => (row.message.role === "user" || row.message.role === "assistant") && row.message.from !== "branch")
    .map((row) => `${row.message.role}: ${String(row.message.content).slice(0, 1500)}`).join("\n") : "";
  const prompt = [
    "Answer this side question briefly. It is separate from any task in progress; do not use tools.",
    ...(recent ? [`For context, the latest messages of the conversation:\n${recent}`] : []),
    `Question: ${question.slice(0, 4000)}`,
  ].join("\n\n");
  try {
    const run = await runtime.run({ prompt, temporary: true, permissions: [], onTextDelta: () => undefined, ...(source ? { source } : {}) });
    return run.status === "completed" && run.output.trim() ? `(on the side) ${run.output.trim()}` : "I could not answer that on the side.";
  } catch (error) {
    return `I could not answer that on the side: ${error instanceof Error ? error.message : String(error)}.`;
  }
}
