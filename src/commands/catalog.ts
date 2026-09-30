/**
 * Every slash command Branch understands, on every surface, as one table (wave mac3, commands).
 *
 * This file is data and nothing else: no runtime, no store, no screen. The app window's message box,
 * the phone (which shows the same window through the paired address), the `branch` terminal view,
 * the chat apps and the browser dashboard all read their list from here, so a command added here
 * shows up everywhere it claims at once, and no surface keeps a list of its own.
 *
 * Each command says:
 * - `surfaces`: where it can be typed;
 * - `legacy`: where it already worked before this table existed. Those keep working whatever the
 *   owner's switch says; everywhere else the command follows the switch in `settings.ts`, which
 *   ships off, so a fresh install behaves exactly as it did;
 * - `level`: what the key (or chat sender) must be allowed: look, start tasks, or be the owner.
 *   `bareLooks` marks a command that only reads when typed on its own (`/lockdown` says whether
 *   Lockdown is on; `/lockdown on` changes it);
 * - `route`: the existing API route the command stands for, when there is one, so the short-lived
 *   key limits of that route can be checked against the command's level;
 * - `whileWorking`: one of the few that matter while a task is working (the chat apps' "when
 *   needed" setting reads only those).
 *
 * The idea of one registry with a scope per surface follows OpenClaw's
 * `src/auto-reply/commands-registry.shared.ts` (MIT); the table itself is written for Branch.
 */
export const surfaces = ["window", "phone", "terminal", "chat", "dashboard"] as const;
export type Surface = (typeof surfaces)[number];
export type Level = "look" | "run" | "owner";

export interface CatalogCommand {
  name: string;
  aliases: readonly string[];
  /** The language key for `english` in public/locales. */
  key: string;
  english: string;
  args: string;
  surfaces: readonly Surface[];
  legacy: readonly Surface[];
  level: Level;
  bareLooks?: boolean;
  route?: { method: "GET" | "POST"; path: string };
  whileWorking?: boolean;
  /** What the command asks of the key once something follows it (`/help <question>` asks the model). */
  withArgument?: Level;
  /**
   * Other names this table added to a command a surface already had, per surface (the terminal had
   * `/clear` and `/?` long before the chat apps did); on that surface they follow the switch.
   */
  newAliases?: Partial<Record<Surface, readonly string[]>>;
}

const W: Surface[] = ["window", "phone"];
/** The same added names on each of the given surfaces. */
const added = (names: string[], ...where: Surface[]): Partial<Record<Surface, readonly string[]>> =>
  Object.fromEntries(where.map((surface) => [surface, names]));
const ALL: Surface[] = ["window", "phone", "terminal", "chat", "dashboard"];
type Extra = Partial<Pick<CatalogCommand, "bareLooks" | "route" | "whileWorking" | "legacy" | "newAliases" | "withArgument">>;
const entry = (name: string, aliases: string[], args: string, english: string, where: Surface[], level: Level, extra: Extra = {}): CatalogCommand =>
  ({ name, aliases, args, english, key: `commands.${name}`, surfaces: where, level, legacy: [], ...extra });
/** Worked in the terminal (and the window, when named) before this table. */
const was = (...where: Surface[]): Extra => ({ legacy: where });

/**
 * The order is the order of the terminal's help list and palette, which came first; the commands
 * this table added follow.
 */
export const COMMANDS: readonly CatalogCommand[] = [
  entry("help", ["?"], "[question]", "the commands you can use here; with a question, an answer from Branch's handbook", ALL, "look", { ...was("window", "phone", "terminal", "chat"), whileWorking: true, newAliases: added(["?"], "window", "phone", "chat"), withArgument: "run" }),
  entry("model", ["models"], "[id]", "which model answers; /model on its own lists them", ["window", "phone", "terminal", "chat"], "run", { ...was("window", "phone", "terminal"), bareLooks: true, route: { method: "POST", path: "/api/models/switch" }, newAliases: added(["models"], "window", "phone") }),
  entry("think", ["reasoning"], "<low|medium|high|default>", "how hard the model thinks in this conversation", ["window", "phone", "terminal", "chat"], "run", was("terminal")),
  entry("preset", ["permissions", "approvals"], "[name]", "when Branch checks with you before doing something", [...W, "terminal"], "owner", { ...was("terminal"), bareLooks: true, route: { method: "POST", path: "/api/policy" }, newAliases: added(["approvals"], "terminal") }),
  entry("memory", [], "[words]", "facts it has saved", [...W, "terminal"], "look", was("terminal")),
  entry("skills", [], "", "skills installed here", [...W, "terminal"], "look", was("terminal")),
  // CHAT-205: pin one skill to this conversation (src/commands/steer-skill.ts); /skill off unpins it.
  entry("skill", [], "[name|off]", "pin a skill to this conversation so it applies to every turn; on its own, which one is pinned", ["window", "phone", "terminal", "chat"], "run", { bareLooks: true }),
  entry("plan", [], "[on|off]", "turn a short plan first on or off", [...W, "terminal"], "look", was("terminal")),
  entry("verify", [], "[on|off]", "turn a reviewer's check of the answer on or off", ["terminal"], "look", was("terminal")),
  entry("dry-run", [], "[on|off]", "a dry run: it shows what it would do without doing it", ["terminal"], "look", was("terminal")),
  entry("temporary", ["incognito"], "[on|off]", "a conversation that is not remembered; set it before the first message", [...W, "terminal"], "look", was("terminal")),
  entry("attach", ["image"], "<file>", "send a file or picture with your next message", [...W, "terminal"], "look", was("terminal")),
  entry("history", [], "", "this conversation so far", ["terminal", "chat"], "look", was("terminal")),
  entry("export", ["save"], "[file]", "save this conversation as a Markdown file", [...W, "terminal"], "look", was("terminal")),
  entry("new", ["clear", "reset"], "", "start a fresh conversation", ["window", "phone", "terminal", "chat"], "look", { ...was("terminal", "chat"), newAliases: added(["clear"], "chat") }),
  entry("branch", ["fork"], "[--here] [name]", "copy this chat's conversation and follow the copy here; the original is kept", ["chat"], "run"),
  entry("sessions", ["resume"], "[id]", "earlier conversations; with a number, carry one on", [...W, "terminal"], "look", was("terminal")),
  entry("go", ["open"], "<place>", "open a place or a Settings page by name: /go inbox finished", [...W, "terminal", "dashboard"], "look", was("terminal")),
  entry("inbox", [], "[tab]", "what needs you, what finished, and the history", [...W, "terminal", "dashboard"], "look", was("terminal")),
  entry("automations", ["cron"], "[tab]", "schedules, procedures and triggers", [...W, "terminal", "dashboard"], "look", was("terminal")),
  entry("library", [], "[tab]", "memory, documents and what it made", [...W, "terminal", "dashboard"], "look", was("terminal")),
  entry("customize", ["tools"], "[tab]", "Trunks, tools, specialists, channels and everywhere", [...W, "terminal", "dashboard"], "look", was("terminal")),
  entry("settings", ["config"], "[page]", "the Settings pages, by name", [...W, "terminal", "dashboard"], "look", was("terminal")),
  entry("theme", ["skin"], "[name|light|dark|follow|list]", "the theme, shared with the window", [...W, "terminal"], "look", was("terminal")),
  entry("default", [], "<id>", "the model every new conversation starts with", [...W, "terminal"], "owner", { ...was("terminal"), route: { method: "POST", path: "/api/models" } }),
  entry("switch", [], "<mouse|sidePane|oak> [on|off|when-needed]", "the terminal's own switches", ["terminal"], "owner", was("terminal")),
  entry("pane", ["details"], "[activity|plan|files|memory]", "show or hide the side pane", [...W, "terminal"], "look", was("terminal")),
  entry("lockdown", ["pause"], "[on|off]", "the one switch that refuses commands and makes everything else wait for your yes", [...W, "terminal", "dashboard"], "owner", { ...was("terminal"), bareLooks: true, route: { method: "POST", path: "/api/lockdown" } }),
  entry("keys", ["shortcuts"], "", "every key the view answers to", ["terminal"], "look", { ...was("terminal"), newAliases: added(["shortcuts"], "terminal") }),
  entry("exit", ["quit"], "", "leave", ["terminal"], "look", was("terminal")),
  // ---- the redesign's terminal (design/redesign/prototype.html termRun): Team, finding and the chat apps ----
  // CHAT-187: also in the window's "/" menu (the window opens Team, the sidebar's search, and Customize › Channels).
  entry("team", [], "[tab]", "who uses Branch, and what their Trunks are doing now", [...W, "terminal"], "look"),
  entry("find", ["search"], "<words>", "search every conversation and message", [...W, "terminal"], "owner"),
  entry("channels", [], "", "the chat apps and which ones reach Branch", [...W, "terminal"], "owner"),
  // ---- added with this table ----
  // CHAT-192: a note for the working task, as the Steer box and "type while it works" do (src/commands/steer-skill.ts).
  entry("steer", [], "<note>", "a note for the task working now; it reads it before its next step", ["window", "phone", "terminal", "chat"], "run", { whileWorking: true }),
  entry("stop", ["cancel"], "[task]", "stop what is working now", ["window", "phone", "terminal", "chat", "dashboard"], "run", { ...was("chat"), whileWorking: true }),
  entry("status", [], "", "what is working right now, and with which model", ALL, "look", { ...was("chat"), whileWorking: true }),
  entry("compact", ["compress", "fold"], "", "fold the earlier part of this conversation into a summary", ["window", "phone", "terminal", "chat"], "run", { ...was("chat"), newAliases: added(["compress", "fold"], "chat") }),
  entry("usage", ["cost"], "[on|off]", "tokens and cost so far; in a chat app, on or off adds a line to each reply", ALL, "look", { ...was("chat"), newAliases: added(["cost"], "chat") }),
  entry("btw", ["side"], "<question>", "a quick question on the side; it does not join the task", ["window", "phone", "terminal", "chat"], "run", { ...was("chat"), whileWorking: true, newAliases: added(["side"], "chat") }),
  entry("tokens", ["context"], "", "what fills the next request: instructions, tools, the conversation, and what it costs", ["window", "phone", "terminal", "chat"], "look"),
  entry("goal", [], "<what should be true> [--max rounds]", "keep working until a goal is met, paused or out of rounds", [...W, "terminal"], "run", { ...was("window", "phone"), route: { method: "POST", path: "/api/goals" } }),
  entry("whoami", ["id"], "", "what you may do from here", ALL, "look"),
  entry("version", ["about"], "", "which Branch this is", ALL, "look"),
  entry("health", ["doctor"], "", "a quick check of the database, models, chat apps and schedules", [...W, "terminal", "dashboard"], "look"),
  // bucket 12: the owner's saved prompts and procedures; their own commands are laid over this table in saved.ts
  entry("prompts", ["procedures", "workflows"], "[name]", "your saved prompts and procedures; with a name, one of them in the message box", ALL, "look"),
  // R17-A: the owner's Trunks; talking to one starts a task, so a bare /trunk only looks
  entry("trunk", ["trunks"], "[name] [message]", "your Trunks; with a name and a message, talk to one", [...W, "terminal", "chat"], "run", { bareLooks: true }),
  // mac6/accounts: which account the model answers through; switching is the owner's, so not in chat apps
  entry("account", ["accounts"], "[name|default name]", "which account the model uses; with a name, switch this conversation to it", [...W, "terminal", "dashboard"], "owner", { bareLooks: true, route: { method: "POST", path: "/api/accounts/switch" } }),
  // ---- r17-b: repeating in a conversation, sub-goals, background tasks, handing on, suggested automations (src/autonomy/commands.ts) ----
  entry("loop", ["proactive"], "[every] <10m> <what to do> [--times n] [--until when]", "ask the same thing again in this conversation every so often; status, pause, resume or stop", [...W, "terminal"], "owner", { bareLooks: true }),
  entry("heartbeat", ["hb"], "every <30m> <what to watch>", "a quiet check on this conversation that speaks up only with news; status, pause, resume or stop", [...W, "terminal"], "owner", { bareLooks: true }),
  entry("subgoal", [], "[text | remove n | clear]", "more that must be true before this conversation's goal is done", [...W, "terminal"], "run", { bareLooks: true }),
  entry("bg", ["background"], "<what to do>", "do something in a separate conversation, so this one stays free", [...W, "terminal"], "run"),
  entry("handoff", [], "<chat app | terminal | assistant name>", "carry this conversation on in a chat app, a terminal or another assistant", [...W, "terminal"], "owner"),
  entry("suggestions", ["suggest"], "[catalog | accept n | dismiss n]", "automations Branch suggests; a no is never offered again", [...W, "terminal"], "owner", { bareLooks: true }),
  entry("blueprint", ["bp"], "[name] [blank=value ...]", "the automation catalogue; with a name and its blanks, make one", [...W, "terminal"], "owner", { bareLooks: true }),
  // ---- end r17-b ----
  // mac7/r17-d: the project's instruction file, written by the model (src/coding/init.ts); follows that part's switch
  entry("init", [], "", "look around this project and write its instruction file (AGENTS.md)", W, "run"),
  // r17-i: pausing a chat app; from a chat app it is taken only from the owner's own account (src/reach/platform.ts)
  entry("platform", [], "[status | pause <chat app> | resume <chat app>]", "pause a chat app so its messages are let go, or turn it back on", [...W, "terminal"], "owner", { bareLooks: true }),
  // ---- r17-h: the waiting line, typing while it works, focus view, asking for packages (src/flows-boards/commands.ts) ----
  entry("queue", ["waiting"], "[edit n <words> | move n up|down|first|last | remove n]", "the messages waiting in this conversation; reword, move or take one out", [...W, "terminal"], "owner", { bareLooks: true, whileWorking: true }), // integration review: rewording is the owner's
  entry("busy", [], "[queue|steer|interrupt]", "what happens when you type while a task works: wait, pass it on, or stop and go next", [...W, "terminal"], "owner", { bareLooks: true }),
  entry("focus", [], "[on|off]", "show only what you asked and the final answers", W, "look"),
  entry("installs", ["install"], "[request npm|pypi <name> [why] | approve n | decline n]", "requests for new packages and tool servers; only the owner answers, and nothing installs itself", ALL, "look", { withArgument: "run" }),
  // ---- end r17-h ----
  // A change to Branch itself, asked for from a chat app (src/self-development-requests.ts). It only files
  // a request; the owner's yes or no is given in the Branch app, never with a command.
  entry("improve", [], "<what to change in Branch>", "ask the owner for a change to Branch itself; only the owner answers, in the Branch app", ["chat"], "run"),
  // mac7/learn: a map of a folder of code or a knowledge base, and a guided walk through it. Building
  // a map reads a whole folder and a tour may ask a model, and every /api/learn route is the owner's,
  // so the command asks the same; /learn on its own only says what the feature is.
  entry("learn", ["understand", "map"], "[code|documents] [folder or knowledge base]", "a map of something and a guided walk through it, in plain words", [...W, "terminal", "dashboard"], "owner", { bareLooks: true, route: { method: "POST", path: "/api/learn/map" } }),
  // mac7/adapt: what a stopped task is missing, and — on the owner's yes — getting it and carrying
  // on. It installs and spends the owner's disk, so it is theirs alone and only where the owner is
  // at this computer with its own key: never from a chat app, a phone or the browser dashboard,
  // each of which reaches Branch as another computer does.
  entry("adapt", ["unblock"], "[what it said | yes <line>]", "what a stopped task is missing, what would fix it and what that costs; with yes and the offer's line, get it and carry on", ["window", "terminal"], "owner", { bareLooks: true, route: { method: "POST", path: "/api/adapt/go" } }),
];

const bare = (name: string): string => name.replace(/^\//, "").replace(/@[\w.-]+$/, "").toLowerCase();
/**
 * The other names a command answers to on a surface: with `oldNamesOnly`, only those it had there
 * before. With no surface named, a name this table added anywhere is left out.
 */
export function aliasesOn(command: CatalogCommand, surface: Surface | undefined, oldNamesOnly: boolean): readonly string[] {
  if (!oldNamesOnly) return command.aliases;
  const fresh = surface ? command.newAliases?.[surface] ?? [] : Object.values(command.newAliases ?? {}).flat();
  return command.aliases.filter((alias) => !fresh.includes(alias));
}
/**
 * The command a typed name stands for (`/model`, `model`, `/cancel`, `/stop@BranchBot`). With
 * `oldNamesOnly` (the switch is off), the other names this table added on `surface` are not read.
 */
export function lookup(name: string, oldNamesOnly = false, surface?: Surface): CatalogCommand | undefined {
  const wanted = bare(name);
  return COMMANDS.find((command) => command.name === wanted
    || aliasesOn(command, surface, oldNamesOnly).includes(wanted));
}
/** Splits a typed line into the command and what follows it; null when it is not a known command. */
export function parseLine(text: string, oldNamesOnly = false, surface?: Surface): { command: CatalogCommand; argument: string } | null {
  const match = /^\/([a-z?][\w?-]*)(?:@[\w.-]+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;
  const command = lookup(match[1]!, oldNamesOnly, surface);
  return command ? { command, argument: (match[2] ?? "").trim() } : null;
}
/** What a command asks of the key once its argument is known. */
export function levelFor(command: CatalogCommand, argument: string): Level {
  const given = argument.trim();
  if (command.withArgument && given && given !== "all") return command.withArgument;
  return command.bareLooks && !given ? "look" : command.level;
}
