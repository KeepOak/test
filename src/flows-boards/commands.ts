import type { Call, Reply } from "../commands/handlers.js";
import type { FlowsBoards } from "./index.js";
import { flowsBoardsFor } from "./instance.js";
import type { InstallRequest } from "./install-requests.js";
import { offSentence, type BoardPart } from "./settings.js";
import { busyModes, type BusyMode, type Direction } from "./waiting-line.js";

/**
 * R17-H: what `/queue`, `/busy`, `/focus` and `/installs` do (the table entries are in
 * src/commands/catalog.ts). Each follows the typed-commands switch like every other new command, and
 * its own part's switch as well: with the part off it says so in one sentence and does nothing.
 *
 * `/installs` can be typed in a chat app, but there it can only ask: approving is refused on the chat
 * surface whoever is writing, and anywhere else it needs the owner's full access.
 */
type Handler = (call: Call) => Reply | Promise<Reply>;
const say = (text: string, client?: Reply["client"]): Reply => (client ? { text, client } : { text });
const needSession = "Start a conversation first; this command works on the conversation you are in.";

function reach(call: Call, part: BoardPart): FlowsBoards | string {
  const boards = flowsBoardsFor(call.host.runtime);
  if (!boards) return "This part of Branch is not in this copy.";
  return boards.mode(part) === "off" ? offSentence(part) : boards;
}

const lines = (items: { prompt: string }[]): string =>
  items.length ? items.map((item, i) => `${i + 1}. ${item.prompt.slice(0, 120)}`).join("\n") : "Nothing is waiting in this conversation.";

const queue: Handler = (call) => {
  const boards = reach(call, "waiting-line");
  if (typeof boards === "string") return say(boards);
  if (!call.sessionId) return say(needSession);
  const sessionId = call.sessionId, items = boards.waiting.followUps(sessionId);
  const text = call.argument.trim();
  if (!text) return say(lines(items));
  const match = /^(edit|move|remove)\s+(\d+)\s*(.*)$/is.exec(text);
  const item = match ? items[Number(match[2]) - 1] : undefined;
  if (!match || !item) return say("Use /queue, /queue edit <n> <new words>, /queue move <n> up|down|first|last, or /queue remove <n>.");
  const verb = match[1]!.toLowerCase(), rest = match[3]!.trim();
  if (verb === "remove") return say(lines(boards.waiting.removeFollowUp(sessionId, item.id)));
  if (verb === "edit") return say(rest ? lines(boards.waiting.editFollowUp(sessionId, item.id, { prompt: rest })) : "Say the new words after the number.");
  if (!["up", "down", "first", "last"].includes(rest)) return say("Move it up, down, first or last.");
  return say(lines(boards.waiting.moveFollowUp(sessionId, item.id, { direction: rest as Direction })));
};

const busyWords: Record<BusyMode, string> = {
  queue: "what you type waits until the task finishes",
  steer: "what you type is handed to the working task before its next step",
  interrupt: "what you type stops the working task and goes next",
};
const busy: Handler = (call) => {
  const boards = reach(call, "waiting-line");
  if (typeof boards === "string") return say(boards);
  const choice = call.argument.trim().toLowerCase();
  if (!choice) return say(`While a task works, ${busyWords[boards.waiting.busyMode()]}. Change it with /busy queue, steer or interrupt.`);
  if (!(busyModes as readonly string[]).includes(choice)) return say("Use /busy queue, /busy steer or /busy interrupt.");
  call.host.requireOwner("/busy");
  return say(`From now on, ${busyWords[boards.waiting.saveBusyMode({ mode: choice })]}.`);
};

const focus: Handler = (call) => {
  const boards = reach(call, "focus");
  if (typeof boards === "string") return say(boards);
  const word = call.argument.trim().toLowerCase();
  const on = word === "on" ? true : word === "off" ? false : null;
  if (word && on === null) return say("Use /focus, /focus on or /focus off.");
  const text = on === false ? "Focus view is off: every step shows again." : on ? "Focus view is on: only what you asked and the final answers show." : "Focus view switched.";
  return say(text, { do: "focus", on });
};

const status = (item: InstallRequest): string => ({ waiting: "waiting for your answer", approved: "approved", declined: "declined", refused: "refused" })[item.status];
const described = (item: InstallRequest, n: number): string => {
  const what = item.ask.kind === "package" ? `${item.ask.ecosystem} package ${item.ask.name}${item.ask.version ? ` ${item.ask.version}` : ""}` : `tool server ${item.ask.name}`;
  return `${n}. ${what} — ${status(item)}; asked by ${item.from}: ${item.ask.why}. Malware list: ${item.check.note}.${item.nextStep ? `\n   Next: ${item.nextStep}` : ""}`;
};

const installs: Handler = async (call) => {
  const boards = reach(call, "install-requests");
  if (typeof boards === "string") return say(boards);
  // Integration review: on a chat, only the requests chats made are listed (and so can be numbered).
  const items = boards.installs.list().filter((item) => call.surface !== "chat" || item.by === "chat").slice(-20);
  const text = call.argument.trim();
  if (!text) return say(items.length ? items.map((item, i) => described(item, i + 1)).join("\n") : "No requests for packages or tool servers.");
  const request = /^request\s+(npm|pypi)\s+(\S+)(?:\s+(.+))?$/i.exec(text);
  if (request) {
    const npm = request[1]!.toLowerCase() === "npm";
    const spec = npm ? /^(@?[^@\s]+)(?:@(\S+))?$/.exec(request[2]!) : /^([^=\s]+)(?:==(\S+))?$/.exec(request[2]!);
    if (!spec) return say("Name the package, with its version if you like: npm left-pad@1.3.0, or pypi requests==2.32.3.");
    const [by, from] = call.surface === "chat" ? ["chat", "a chat app"] as const
      : call.access === "full" ? ["owner", "the owner"] as const : ["other", "a short-lived key"] as const;
    const made = await boards.installs.request({ kind: "package", ecosystem: npm ? "npm" : "PyPI", name: spec[1]!,
      ...(spec[2] ? { version: spec[2] } : {}), why: request[3] ?? "asked for with /installs" }, by, from);
    const shown = boards.installs.list().filter((item) => call.surface !== "chat" || item.by === "chat").slice(-20);
    return say(`Asked. ${described(made, shown.findIndex((entry) => entry.id === made.id) + 1)}`);
  }
  const answer = /^(approve|decline)\s+(\d+)(\s+anyway)?$/i.exec(text);
  if (!answer) return say("Use /installs, /installs request npm|pypi <name[@version]> [why], or /installs approve|decline <n>.");
  if (call.surface === "chat" || call.access !== "full") return say("Only the owner can answer a request, in the Branch app or the owner's terminal. From here you can only ask.");
  call.host.requireOwner("Answering a request for a package or tool server");
  const item = items[Number(answer[2]) - 1];
  if (!item) return say("There is no request with that number; /installs lists them.");
  const done = await boards.installs.answer(item.id, answer[1]!.toLowerCase() === "approve", { despiteUnchecked: Boolean(answer[3]) });
  return say(described(done, Number(answer[2])));
};

export const BOARD_HANDLERS: Record<string, Handler> = { queue, busy, focus, installs };
