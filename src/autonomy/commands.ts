import type { Call, Reply } from "../commands/handlers.js";
import { handOff } from "../interop/handoff.js";
import { autonomyFor, type Autonomy } from "./index.js";
import type { LoopKind } from "./loops.js";
import { offSentence, quoteLine, type AutonomyPart } from "./settings.js";
import { addSubgoal, saveSubgoals, subgoalsOf } from "./subgoals.js";
import { catalogue } from "./blueprints.js";
import { conversationModeSettings, readConversationMode, type ConversationMode } from "../conversation-mode.js";

/**
 * R17-B: what `/loop`, `/heartbeat`, `/subgoal`, `/bg`, `/handoff`, `/suggestions` and `/blueprint`
 * do (the table entries are in src/commands/catalog.ts). Each follows the typed-commands switch like
 * every other new command, and its own part's switch as well: with the part off it says so in one
 * sentence and does nothing.
 */
type Handler = (call: Call) => Reply | Promise<Reply>;
const say = (text: string): Reply => ({ text });
const needSession = "Start a conversation first; this command works on the conversation you are in.";

function reach(call: Call, part: AutonomyPart): Autonomy | string {
  const autonomy = autonomyFor(call.host.runtime);
  if (!autonomy) return "This part of Branch is not in this copy.";
  return autonomy.mode(part) === "off" ? offSentence(part) : autonomy;
}

const gap = (ms: number): string => (ms % 3_600_000 === 0 ? `${ms / 3_600_000} h` : `${Math.round(ms / 60_000)} min`);

function repeating(kind: LoopKind): Handler {
  return (call) => {
    const autonomy = reach(call, "loops");
    if (typeof autonomy === "string") return say(autonomy);
    if (!call.sessionId) return say(needSession);
    const word = call.argument.trim().toLowerCase();
    if (!word || word === "status") {
      const state = autonomy.loops.get(kind, call.sessionId);
      if (!state) return say(`There is no /${kind} here. Start one: /${kind} every 10m <what to ${kind === "loop" ? "do" : "watch"}>`);
      return say(`/${kind} (${state.status}, ${state.fired} of ${state.times} turns, every ${gap(state.everyMs)}): ${state.prompt}${state.note ? `\n${state.note}` : ""}`);
    }
    if (word === "pause" || word === "resume" || word === "stop" || (kind === "heartbeat" && word === "clear")) {
      const state = autonomy.loops.change(kind, call.sessionId, word === "clear" ? "stop" : word);
      return say(`/${kind} is ${state.status === "done" ? "stopped" : state.status}.`);
    }
    const state = autonomy.loops.start(kind, call.sessionId, call.argument, call.permissions);
    return say(`/${kind} set: every ${gap(state.everyMs)}, at most ${state.times} turns. /${kind} stop ends it.`);
  };
}

const subgoal: Handler = async (call) => {
  const autonomy = reach(call, "session-commands");
  if (typeof autonomy === "string") return say(autonomy);
  call.host.requireOwner("/subgoal"); // a household person never adds to the owner's goal
  if (!call.sessionId) return say(needSession);
  const goal = call.host.goals?.status(call.sessionId);
  if (!goal || (goal.status !== "working" && goal.status !== "paused")) return say("There is no goal working here. Start one with /goal first.");
  const { store, owner } = call.host.runtime, text = call.argument.trim();
  const items = subgoalsOf(store, owner, call.sessionId);
  const lines = (list: string[]): string => (list.length ? list.map((item, i) => `${i + 1}. ${item}`).join("\n") : "No sub-goals.");
  if (!text) return say(lines(items));
  if (text.toLowerCase() === "clear") { saveSubgoals(store, owner, call.sessionId, []); return say("Sub-goals cleared."); }
  const remove = /^remove\s+(\d+)$/i.exec(text);
  if (remove) {
    const at = Number(remove[1]) - 1;
    if (!items[at]) return say("There is no sub-goal with that number.");
    return say(lines(saveSubgoals(store, owner, call.sessionId, items.filter((_, i) => i !== at))));
  }
  return say(`Added. The goal is done only when these are true too:\n${lines(addSubgoal(store, owner, call.sessionId, text))}`);
};

/** Background tasks started with /bg that are still working, so at most three run at once. */
const background = new WeakMap<object, Set<string>>();
const maxBackground = 3;

/**
 * Redesign security review: how much a /bg task may do. Started from a conversation, it is held to that conversation
 * exactly as the conversation's own tasks are: a Trunk's side of a room follows the room's conversation, and a
 * conversation with no mode of its own follows the owner's rules (so does the task). Only with no conversation at all
 * does a task started from the window take the owner's choice for a new one, as a message sent there does.
 */
function backgroundMode(call: Call): ConversationMode | null {
  const runtime = call.host.runtime;
  if (call.sessionId)
    return readConversationMode(runtime.store, runtime.owner, runtime.modeFollows(call.sessionId) ?? call.sessionId)?.mode ?? null;
  if (call.surface !== "window") return null;
  const chosen = conversationModeSettings(runtime.store, runtime.owner).newConversation;
  return chosen === "follow" ? null : chosen;
}

const bg: Handler = async (call) => {
  const autonomy = reach(call, "session-commands");
  if (typeof autonomy === "string") return say(autonomy);
  // The task below is started in the owner's name, so it is the owner's alone.
  call.host.requireOwner("/bg");
  const prompt = call.argument.trim();
  if (!prompt) return say("Say what to do in the background: /bg <what to do>");
  const runtime = call.host.runtime;
  const working = background.get(runtime) ?? new Set<string>();
  background.set(runtime, working);
  if (working.size >= maxBackground) return say(`${maxBackground} background tasks are already working; wait for one to finish.`);
  let sessionId = "", runId = "";
  const mode = backgroundMode(call);
  // A separate conversation, not awaited: this one stays free. It is a task like any the owner starts.
  await new Promise<void>((resolve) => {
    void runtime.run({ prompt, source: "owner", onTextDelta: () => undefined, ...(call.permissions ? { permissions: call.permissions } : {}),
      ...(mode ? { conversationMode: mode } : {}),
      onStarted: (run) => { sessionId = run.sessionId; runId = run.id; working.add(run.id); resolve(); } })
      .catch(() => undefined).finally(() => { working.delete(runId); resolve(); });
  });
  return say(sessionId ? `Working on it in a separate conversation (${sessionId.slice(0, 8)}). It will be in Inbox, Finished.` : "The background task could not start.");
};

async function handoffToChat(autonomy: Autonomy, call: Call, target: string): Promise<Reply> {
  const { chats } = autonomy.deps, owner = autonomy.owner;
  const wanted = target.toLowerCase();
  const ids = new Set(chats.summary().channels.filter((c) => c.id.toLowerCase() === wanted || c.kind.toLowerCase() === wanted).map((c) => c.id));
  const chat = chats.chats(owner).filter((c) => ids.has(c.channel)).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).pop();
  if (!chat) return say(`No chat on ${quoteLine(target, 40)} has talked to Branch yet. Send the bot a message there first.`);
  chats.link(owner, { channel: chat.channel, chatId: chat.chatId, sessionId: call.sessionId });
  const last = autonomy.store.messages(call.sessionId!).filter((m) => m.role === "assistant").pop();
  const note = `This conversation carries on here.${last ? ` Last reply: ${call.host.runtime.hideSecrets(String(last.content)).slice(0, 500)}` : ""}`;
  await chats.deliver(chat.channel, chat.chatId, note).catch(() => undefined);
  return say(`Handed to ${quoteLine(chat.title, 60)} on ${chat.channel}. Messages there now carry on this conversation.`);
}

const handoff: Handler = async (call) => {
  const autonomy = reach(call, "session-commands");
  if (typeof autonomy === "string") return say(autonomy);
  if (!call.sessionId) return say(needSession);
  const [where = "", ...rest] = call.argument.trim().split(/\s+/);
  if (!where) return say("Say where to: /handoff telegram (or another chat app), /handoff terminal, or /handoff assistant <name>.");
  if (where === "terminal" || where === "assistant") {
    const parts = autonomy.deps.handoff;
    if (!parts) return say("Handing on to a terminal or another assistant is not in this copy.");
    const done = await handOff(parts, { sessionId: call.sessionId, to: where, ...(rest.length ? { agent: rest.join(" ") } : {}) }, "");
    return say("command" in done ? `Run this in a terminal: ${done.command}` : `Handed to ${String((done as { agent?: string }).agent)}.`);
  }
  return handoffToChat(autonomy, call, where);
};

const suggestions: Handler = (call) => {
  const autonomy = reach(call, "suggestions");
  if (typeof autonomy === "string") return say(autonomy);
  const [word = "", number = ""] = call.argument.trim().toLowerCase().split(/\s+/);
  const offered = autonomy.suggestions(word === "catalog" || word === "catalogue" || word === "accept" || word === "dismiss");
  if (word === "accept" || word === "dismiss") {
    const chosen = offered[Number(number) - 1];
    if (!chosen) return say("There is no suggestion with that number. /suggestions lists them.");
    autonomy.answerSuggestion(chosen.fingerprint, word === "accept");
    return say(word === "accept" ? `Made: ${chosen.title}. It is in Automations, Scheduled.` : "Won't suggest that again.");
  }
  if (!offered.length) return say("Nothing to suggest right now. /suggestions catalog shows starting ideas.");
  return say(offered.map((s, i) => `${i + 1}. ${s.title}: ${s.why}`).join("\n") + "\n/suggestions accept <n> or /suggestions dismiss <n>");
};

const blueprintCommand: Handler = (call) => {
  const autonomy = reach(call, "suggestions");
  if (typeof autonomy === "string") return say(autonomy);
  const [name = "", ...pairs] = call.argument.trim().match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  if (!name) return say(catalogue().map((b) => `${b.id}: ${b.title}. Blanks: ${b.slots.map((s) => s.name).join(", ")}`).join("\n"));
  const values = Object.fromEntries(pairs.map((pair) => {
    const at = pair.indexOf("=");
    if (at < 1) throw new Error(`Write each blank as name=value; "${quoteLine(pair, 40)}" is not.`);
    return [pair.slice(0, at), pair.slice(at + 1).replace(/^"|"$/g, "")];
  }));
  autonomy.fromBlueprint({ blueprint: name.toLowerCase(), values });
  return say("Made. It is in Automations, Scheduled.");
};

/** The handlers src/commands/handlers.ts lays into its table. */
export const AUTONOMY_HANDLERS: Record<string, Handler> = {
  loop: repeating("loop"), heartbeat: repeating("heartbeat"), subgoal, bg, handoff, suggestions, blueprint: blueprintCommand,
};
