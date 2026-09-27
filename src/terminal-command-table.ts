import type { Runtime } from "./runtime.js";
import type { ReasoningEffort } from "./models.js";
import type { Conversation } from "./terminal-conversation.js";
import type { Route } from "./terminal-places.js";
import type { Words } from "./terminal-words.js";
import {
  choosePreset, exportConversation, historyLines, presetLines, readAttachment,
} from "./terminal-commands.js";
import type { FeatureMode } from "./feature-switches.js";
import { aliasesOn, levelFor, lookup, type CatalogCommand } from "./commands/catalog.js";
import { available, commandMode, commandsFor } from "./commands/settings.js";
import { executeCommand } from "./commands/execute.js";
import { commandHost } from "./commands/host.js";
import type { CommandHost } from "./commands/handlers.js";
import { savedLine } from "./commands/saved.js";
import { householdCommandRefusal } from "./commands/household.js";
import type { PlaceApp } from "./terminal-place-data.js";
import type { PaletteItem } from "./terminal-screen.js";
import { channelsCommand, findWords, limitsLines } from "./terminal-redesign-commands.js";

/**
 * Every slash command the terminal view understands, as one table: its name, other names, what it
 * does in the owner's words (a language key and its English), what it takes, and what it does.
 * The help list, the palette and the parser all read this table, so a command added here shows up
 * everywhere at once.
 */
export interface CommandContext {
  runtime: Runtime;
  conversation: Conversation;
  words: Words;
  say(kind: "note" | "warn" | "ok" | "bad" | "step", text: string): void;
  open(route: Route | string): void;
  theme(argument: string): Promise<void>;
  togglePane(tab?: string): void;
  lockdown(argument: string): void;
  switchSetting(name: string, value: string): void;
  resume(sessionId: string): void;
  sessions(): void;
  newConversation(): void;
  quit(): void;
  keys(): void;
  /** R17-S21: opens a model picker and says true, where the view can draw one. */
  pickModel?(): boolean;
  /** What the shared commands can reach; the runtime alone when the view was opened without the app. */
  host?: CommandHost;
  /** What the places read from, for the commands that read what the window reads (/channels, /usage). */
  app?: PlaceApp;
  /** Shows a list to choose from in the drawn view and says true; false where the view cannot draw one. */
  pick?(title: string, items: PaletteItem[]): boolean;
}
export interface TerminalCommand {
  name: string;
  aliases: string[];
  key: string;
  english: string;
  args: string;
  run(context: CommandContext, argument: string): void | Promise<void>;
}

const onOff = (argument: string, current: boolean): boolean => (argument ? argument === "on" : !current);

function listModels(context: CommandContext): void {
  const { runtime, conversation } = context;
  const summary = runtime.models.summary(runtime.owner), active = conversation.model ?? summary.activePreset ?? summary.defaultPreset;
  for (const preset of summary.presets) context.say("note", `${preset.id === active ? "*" : " "} ${preset.id} — ${preset.name} · ${preset.model}`);
}
function chooseModel(context: CommandContext, argument: string): void {
  const { runtime, conversation } = context, models = runtime.models;
  if (!argument) return context.pickModel?.() ? undefined : listModels(context); // R17-S21: a picker in the full view
  if (!models.presets.has(argument)) return context.say("warn", `No model called ${argument}. Use /model to list them.`);
  conversation.model = argument;
  if (conversation.sessionId) models.configureSession(runtime.owner, conversation.sessionId, { preset: argument });
  context.say("note", `[model set to ${models.presets.get(argument)!.name} for this conversation]`);
}
function think(context: CommandContext, argument: string): void {
  const { runtime, conversation } = context;
  const choice = argument === "default" ? null : argument;
  if (choice !== null && !["low", "medium", "high"].includes(choice)) return context.say("warn", "Use /think low, medium, high or default.");
  conversation.reasoning = choice as ReasoningEffort | null;
  if (conversation.sessionId) runtime.models.configureSession(runtime.owner, conversation.sessionId, { reasoning: conversation.reasoning });
  context.say("note", `[thinking set to ${choice ?? "the model's default"} for this conversation]`);
}
function skills(context: CommandContext): void {
  const list = context.runtime.store.skills.list(context.runtime.owner);
  if (!list.length) context.say("note", "No skills installed. Add a skill under Customize › Skills.");
  for (const skill of list) context.say("note", `${skill.activeVersion ? "*" : " "} ${skill.name} — ${skill.description}`);
}
function memory(context: CommandContext, argument: string): void {
  // Q259: the facts of whoever the window is switched to, as the Library place shows them (terminal-place-data.ts).
  const { store } = context.runtime, owner = store.profiles.scope();
  const facts = argument ? store.searchMemory(owner, argument) : store.list("memory", owner).slice(0, 20);
  if (!facts.length) context.say("note", argument ? "No saved facts match that." : "Nothing saved to memory yet.");
  for (const fact of facts) context.say("note", `- ${String(fact.data.text)} (${String(fact.data.source)})`);
}
async function attach(context: CommandContext, argument: string): Promise<void> {
  if (!argument) throw new Error("Name a file: /attach report.pdf");
  const attachment = await readAttachment(argument);
  context.conversation.attachments.push(attachment);
  context.say("note", `[${attachment.name} goes with your next message]`);
}
function toggle(name: "plan" | "verify" | "dryRun" | "temporary"): TerminalCommand["run"] {
  return (context, argument) => {
    const conversation = context.conversation, on = onOff(argument, conversation[name]);
    conversation[name] = on;
    if (name === "temporary" && context.conversation.sessionId)
      return context.say("warn", "[a conversation becomes temporary when it starts; /new, then /temporary]");
    const said = name === "temporary" ? `temporary: ${on ? "on, nothing from this conversation is remembered" : "off"}`
      : name === "plan" ? `a short plan first: ${on ? "on" : "off"}`
      : name === "verify" ? `a reviewer checks the answer: ${on ? "on" : "off"}` : `dry run: ${on ? "on, it shows what it would do without doing it" : "off"}`;
    context.say("note", `[${said}]`);
  };
}

/**
 * What each terminal command does here. The names, other names, words and arguments come from the
 * one table every surface reads (src/commands/catalog.ts); a command the terminal has no code of its
 * own for is carried out by the shared code, exactly as the window and the chat apps carry it out.
 */
const RUNNERS: Record<string, TerminalCommand["run"]> = {
  help: (context, argument) => (argument && modeOf(context) !== "off" ? shared("help")(context, argument) : context.keys()),
  model: chooseModel,
  think,
  preset: (context, argument) => {
    if (!argument) presetLines(context.runtime, context.words).forEach((line) => context.say("note", line));
    else context.say("note", choosePreset(context.runtime, argument, undefined, context.words));
  },
  memory,
  skills,
  plan: toggle("plan"),
  verify: toggle("verify"),
  "dry-run": toggle("dryRun"),
  temporary: toggle("temporary"),
  attach,
  history: (context) => historyLines(context.runtime, context.conversation.sessionId).forEach((line) => context.say("note", line)),
  export: async (context, argument) =>
    context.say("note", `[saved to ${await exportConversation(context.runtime, context.conversation.sessionId, argument || undefined)}]`),
  new: (context) => context.newConversation(),
  sessions: (context, argument) => (argument ? context.resume(argument) : context.sessions()),
  go: (context, argument) => context.open(argument),
  inbox: (context, argument) => context.open(`inbox ${argument}`),
  automations: (context, argument) => context.open(`automations ${argument}`),
  library: (context, argument) => context.open(`library ${argument}`),
  customize: (context, argument) => context.open(`customize ${argument}`),
  team: (context, argument) => context.open(`team ${argument}`),
  find: findWords,
  channels: channelsCommand,
  usage: async (context, argument) => {
    await shared("usage")(context, argument);
    for (const line of await limitsLines(context)) context.say("note", line);
  },
  settings: (context, argument) => context.open(`settings ${argument}`),
  theme: (context, argument) => context.theme(argument),
  default: (context, argument) => {
    const { runtime } = context;
    if (!runtime.models.presets.has(argument)) return context.say("warn", `No model called ${argument}. Use /model to list them.`);
    runtime.models.configure(runtime.owner, { activePreset: argument });
    context.say("note", `[new conversations start with ${runtime.models.presets.get(argument)!.name}]`);
  },
  switch: (context, argument) => {
    const [name = "", value = ""] = argument.split(/\s+/);
    context.switchSetting(name, value);
  },
  pane: (context, argument) => context.togglePane(argument),
  lockdown: (context, argument) => context.lockdown(argument),
  keys: (context) => context.keys(),
  exit: (context) => context.quit(),
};
const modeOf = (context: CommandContext): FeatureMode => commandMode(context.runtime.store, context.runtime.owner, "terminal");
/** A command carried out by the shared code, its answer printed line by line. */
function shared(name: string): TerminalCommand["run"] {
  return async (context, argument) => {
    const host = context.host ?? commandHost(context.runtime);
    const outcome = await executeCommand(host, {
      surface: "terminal", line: `/${name} ${argument}`.trim(), sessionId: context.conversation.sessionId, access: "full",
    });
    if (!outcome) return context.say("warn", `I do not know /${name}. Type /help for the list.`);
    for (const line of outcome.text.split("\n")) context.say(outcome.refused ? "warn" : "note", line);
  };
}
const fromCatalog = (entry: CatalogCommand, mode: FeatureMode = "on"): TerminalCommand => ({
  name: entry.name, aliases: [...aliasesOn(entry, "terminal", mode === "off")], key: entry.key, english: entry.english, args: entry.args,
  run: RUNNERS[entry.name] ?? shared(entry.name),
});
/** Every command the terminal can take with the switch where it is; `all` adds what "when needed" keeps out of lists. */
export function terminalCommands(mode: FeatureMode, all = false): TerminalCommand[] {
  return commandsFor("terminal", mode, all).map((entry) => fromCatalog(entry, mode));
}
/** The terminal's list with the switch off, which is the list it has always had. */
export const TERMINAL_COMMANDS: TerminalCommand[] = terminalCommands("off");

/** The terminal command a typed name stands for, with the switch where it is (off when not given). */
export function findCommand(name: string, mode: FeatureMode = "off"): TerminalCommand | undefined {
  const found = lookup(name, mode === "off", "terminal");
  return found && available(found, "terminal", mode) ? fromCatalog(found, mode) : undefined;
}
/** The help list: the keys in one line, then one line per command. */
export function helpLines(words: Words, mode: FeatureMode = "off"): string[] {
  const rows = terminalCommands(mode).map((entry) => {
    const usage = `/${entry.name}${entry.args ? " " + entry.args : ""}`;
    return `${usage.padEnd(22)} ${words.t(entry.key, entry.english)}`;
  });
  const more = mode === "when-needed" ? [words.t("commands.helpMore", "Send /help all for every command, or /help <question> to ask about Branch.")] : [];
  // The two key lines the approved sample shows under the message box, then every command.
  const line1 = words.t("terminal.keys.line", "Enter sends · Alt+Enter adds a line · Up recalls · Ctrl+E shows step details · Ctrl+C stops the task · Ctrl+D leaves");
  const line2 = words.t("terminal.keys.line2", "Esc, then 1-6 (or Alt+1 to Alt+6): Conversation, Inbox, Automations, Library, Customize, Team · Ctrl+K or /: find anything");
  return [line1, line2, ...rows, ...more];
}
/** Runs one typed slash command; an unknown one is said so, never sent to the model. */
export async function runCommand(context: CommandContext, text: string): Promise<void> {
  const [name = "", ...rest] = text.trim().split(/\s+/);
  const found = findCommand(name, modeOf(context));
  // ---- bucket 12: one of the owner's saved commands is sent as the message it stands for ----
  // Q259: they are the owner's, so for a household profile such a line is no command at all, as at the window.
  const saved = found || !context.runtime.store.profiles.isOwner() ? null : savedLine(context.runtime.store, context.runtime.owner, text);
  if (saved && "reply" in saved) return saved.reply.split("\n").forEach((line) => context.say("note", line));
  if (saved) return "problem" in saved ? context.say("warn", saved.problem) : context.conversation.send(saved.text);
  // ---- end of the bucket 12 hook ----
  if (!found) return context.say("warn", `I do not know ${name}. Type /help for the list.`);
  try {
    // Wave mac3 (commands): settings and permissions stay with the owner's own profile, as in the window.
    const entry = lookup(found.name)!;
    if (levelFor(entry, rest.join(" ")) === "owner") context.runtime.store.profiles.requireOwner(`/${found.name}`);
    // Q259: a household profile sends only the commands that work on their own things, as at the window.
    const notTheirs = householdCommandRefusal(context.runtime.store, "terminal", found.name, rest.join(" "));
    if (notTheirs) return context.say("warn", notTheirs);
    await found.run(context, rest.join(" "));
  } catch (error) {
    context.say("bad", `[${error instanceof Error ? error.message : String(error)}]`);
  }
}
