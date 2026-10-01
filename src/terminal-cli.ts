import { createRequire } from "node:module";
import type { createBranch } from "./index.js";
import { inferToolGroup } from "./catalog.js";
import { statusSnapshot } from "./cli-run.js";
import { healthReport } from "./health.js";
import { lockdownState, setLockdown } from "./lockdown.js";
import { noModelWords } from "./no-model.js";
import { policyPresets } from "./policy.js";
import { pricingSettings } from "./pricing.js";
import { limitLines } from "./usage-limits.js"; // mac7/usage-bar
import { usageLimits } from "./usage-limits-api.js"; // mac7/usage-bar
import { analyticsLines, usageAnalytics } from "./accounts/usage-analytics.js";
import { choosePreset, historyLines, presetLines, presetWords } from "./terminal-commands.js";
import { PLACE_ROWS, connectionRows, skillRows, type Row } from "./terminal-place-data.js";
import { TERMINAL_CLI_COMMANDS } from "./terminal-parity.js";
import { MODEL_TABS, SETTINGS_PAGES, allHomes, homeOf, parseRoute, placeById, type Route } from "./terminal-places.js";
import { knowCopysCommit, settingsRows } from "./terminal-settings.js";
import {
  LOOK_LANGUAGES, loadThemeCatalogue, lookLanguage, readLook, saveLook, saveLookMode, terminalSwitches, type Look, type LookLanguage, type LookMode,
} from "./terminal-theme.js";
import { startTui } from "./terminal-tui.js";
import { loadWords, type Words } from "./terminal-words.js";

/**
 * The `branch` commands the terminal brings: every place and Settings page by name, and the
 * everyday commands people know from Hermes Agent and OpenClaw. In a terminal the place commands
 * open the designed view there; piped or in a script they print the same rows, one per line, or
 * JSON with --json.
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
interface Io { interactive: boolean; env: NodeJS.ProcessEnv; json: boolean; write(line: string): void }

const PLACE_COMMANDS = new Set(["inbox", "automations", "library", "customize", "team", "overview", "household", "settings"]);
export const terminalCommandNames = new Set(TERMINAL_CLI_COMMANDS.map((entry) => entry.name));

/**
 * mac7/smoke-fixes (B4): the terminal commands that only look. These are the ones a second terminal
 * may run against the Branch already open, over `GET /api/terminal`, so the window being open no
 * longer makes the terminal useless. Everything left out either writes (`theme`, `model use`,
 * `lockdown`, `permissions <preset>`) or wants a terminal of its own (`resume`, `setup`). This door
 * passes its words straight through, so a command that writes is never added here: B5 sends those
 * through their own routes instead (src/cli-engine.ts). `status` only reads, so it is here.
 */
export const readOnlyTerminalCommands = new Set([
  "inbox", "automations", "library", "customize", "team", "overview", "household", "settings", "places", "sessions", "memory",
  "skills", "channels", "mcp", "tools", "projects", "usage", "snapshots", "version", "status",
]);

// The command line as Branch reads it lives beside the aliases it applies, which import nothing, so the `branch`
// entry can read a command line without loading the engine (src/cli.ts).
export { terminalArgv } from "./terminal-parity.js";
export function versionText(): string {
  return `Branch Agent ${String(createRequire(import.meta.url)("../package.json").version)}`;
}

export const wordsFor = (app: Branch, env: NodeJS.ProcessEnv): Words => loadWords(lookLanguage(readLook(app.store, app.runtime.owner), env));
/**
 * B5 (CL-05): a place is headed by its name as the window says it ("Inbox › History"), never its
 * internal id. Rows also carry the terminal view's own slash commands; a plain shell cannot run
 * those, so they are left off the printed line (they stay in --json for the view and for scripts).
 */
function printRows(io: Io, rows: Row[], words: Words, heading = ""): void {
  if (io.json) return io.write(JSON.stringify({ rows }, null, 2));
  if (heading) io.write(heading);
  if (!rows.length) io.write(words.t("terminal.empty.default", "Nothing here yet."));
  for (const row of rows) {
    const command = row.command && !row.command.startsWith("/") ? `\t${row.command}` : "";
    io.write(`${row.title}${row.detail ? `\t${row.detail}` : ""}${command}`);
  }
}
/** Light, dark or following the computer, from the saved preferences the window also writes. */
export type ShownMode = "follow" | "light" | "dark";
export const modeOf = (saved: Record<string, unknown>): ShownMode =>
  saved.followSystem === true ? "follow" : saved.appearance === "daylight" ? "light" : "dark";
async function rowsOf(app: Branch, words: Words, route: Route): Promise<Row[]> {
  if ("settings" in route) {
    const look = readLook(app.store, app.runtime.owner);
    const table = await loadThemeCatalogue();
    await knowCopysCommit();
    const mode = modeOf(app.store.get("settings", app.runtime.owner, "preferences")?.data ?? {});
    const themeName = table.THEMES.find((theme) => theme[0] === look.theme)?.[1] ?? look.theme;
    return settingsRows(app, words, route.settings, route.sub, { look, mode, themeName, switches: terminalSwitches(app.store, app.runtime.owner) });
  }
  if (route.place === "chat") return [];
  return PLACE_ROWS[homeOf(route)]!(app, words);
}
/** A home's name in the window's words: "Inbox › History", "Settings › Models › Defaults". */
function homeName(home: string, words: Words): string {
  const route = parseRoute(home)!;
  if ("settings" in route) {
    const page = SETTINGS_PAGES.find((entry) => entry.id === route.settings)!;
    const sub = MODEL_TABS.find((entry) => entry.id === route.sub);
    return [words.t("settings.title", "Settings"), words.t(page.key, page.english), ...(route.settings === "models" && sub ? [words.t(sub.key, sub.english)] : [])].join(" › ");
  }
  const place = placeById(route.place)!;
  const tab = place.tabs.find((entry) => entry.id === route.tab);
  return [words.t(place.key, place.english), ...(tab ? [words.t(tab.key, tab.english)] : [])].join(" › ");
}

/** A place or Settings page: the view opened there, or its rows printed. */
async function placeCommand(app: Branch, command: string, args: string[], io: Io): Promise<void> {
  const words = wordsFor(app, io.env);
  const route = parseRoute([command, ...args].join(" "), words);
  if (!route) throw new Error(`There is no ${command} page called "${args.join(" ")}". \`branch places\` lists them all.`);
  if (io.interactive) return startTui(app.runtime, { app, route: homeOf(route) });
  printRows(io, await rowsOf(app, words, route), words, homeName(homeOf(route), words));
}
function placesCommand(io: Io, words: Words): void {
  const homes = allHomes().map((home) => ({ home, name: homeName(home, words), command: `branch ${home.replace(/:/g, " ").replace(/^chat$/, "chat")}` }));
  if (io.json) return io.write(JSON.stringify({ homes }, null, 2));
  for (const entry of homes) io.write(`${entry.name.padEnd(40)} ${entry.command}`);
}

/** The theme's one line, the same whether this terminal saved it or the running Branch did. */
export function themeLine(look: Look, themeName: string, mode: ShownMode, words: Words): string {
  const shown = mode === "follow" ? words.t("terminal.cli.mode.follow", "follow this computer")
    : mode === "light" ? words.t("terminal.cli.mode.light", "light") : words.t("terminal.cli.mode.dark", "dark");
  return words.t("terminal.cli.theme.line", "Theme: {name} · {mode} · contrast {contrast} · language {language}. The window follows this too.",
    { name: themeName, mode: shown, contrast: look.contrast, language: look.language });
}
/** Every theme, one per line, the one in use marked. */
export const themeListLines = (themes: readonly (readonly unknown[])[], current: string): string[] =>
  themes.map((theme) => `${theme[0] === current ? "*" : " "} ${String(theme[0]).padEnd(16)} ${theme[1]}`);
/** A typed language, checked before it is saved, so a wrong one is named in words rather than a validation dump. */
export function checkedLanguage(word: string | undefined, words: Words): "auto" | LookLanguage {
  const value = word ?? "auto";
  if (value === "auto" || (LOOK_LANGUAGES as readonly string[]).includes(value)) return value as "auto" | LookLanguage;
  throw new Error(words.t("terminal.cli.language.choose", "Choose a language: {list}.", { list: ["auto", ...LOOK_LANGUAGES].join(", ") }));
}
/** Contrast is standard or more; with no word it swaps. */
export function checkedContrast(word: string | undefined, current: string): "standard" | "more" {
  if (word === undefined) return current === "more" ? "standard" : "more";
  if (word === "standard" || word === "more") return word;
  throw new Error("Usage: branch theme contrast [standard|more]");
}

async function themeCommand(app: Branch, args: string[], io: Io): Promise<void> {
  const { store } = app, owner = app.runtime.owner, word = args[0] ?? "list", words = wordsFor(app, io.env);
  if (["light", "dark", "follow"].includes(word)) saveLookMode(store, owner, word as LookMode | "follow");
  else if (word === "contrast") await saveLook(store, owner, { contrast: checkedContrast(args[1], readLook(store, owner).contrast) });
  else if (word === "language") await saveLook(store, owner, { language: checkedLanguage(args[1], words) });
  else if (word !== "list") await saveLook(store, owner, { theme: word });
  const look = readLook(store, owner), table = await loadThemeCatalogue();
  if (io.json) return io.write(JSON.stringify(look, null, 2));
  if (word === "list") themeListLines(table.THEMES, look.theme).forEach((line) => io.write(line));
  const name = table.THEMES.find((theme) => theme[0] === look.theme)?.[1] ?? look.theme;
  // The language just chosen is the one this line is said in.
  io.write(themeLine(look, name, modeOf(store.get("settings", owner, "preferences")?.data ?? {}), wordsFor(app, io.env)));
}
function sessionsCommand(app: Branch, args: string[], io: Io): void {
  if (args[0] === "show") {
    const id = args[1] ?? "";
    const found = app.store.recentSessions(app.runtime.owner, 100).sessions.find((entry) => entry.sessionId.startsWith(id));
    if (!id || !found) throw new Error("Name a conversation: branch sessions show <id>");
    return historyLines(app.runtime, found.sessionId, 200).forEach((line) => io.write(line));
  }
  const { sessions } = app.store.recentSessions(app.runtime.owner, 30);
  if (io.json) return io.write(JSON.stringify({ sessions }, null, 2));
  if (!sessions.length) io.write("No conversations yet.");
  for (const entry of sessions) io.write(`${entry.sessionId}\t${entry.createdAt.slice(0, 16).replace("T", " ")}\t${entry.messageCount}\t${entry.opening.replace(/\s+/g, " ").slice(0, 70)}`);
}
async function resumeCommand(app: Branch, args: string[], io: Io): Promise<void> {
  const { sessions } = app.store.recentSessions(app.runtime.owner, 100);
  const wanted = args[0] ?? "latest";
  const found = wanted === "latest" ? sessions[0] : sessions.find((entry) => entry.sessionId.startsWith(wanted));
  if (!found) throw new Error(wanted === "latest" ? "There is no conversation to carry on yet." : `There is no conversation ${wanted}.`);
  if (io.interactive) return startTui(app.runtime, { app, sessionId: found.sessionId });
  historyLines(app.runtime, found.sessionId, 200).forEach((line) => io.write(line));
}
/** The models, one per line with the one in use marked, or the plain words when there is none yet. */
export function modelLines(summary: { presets: { id: string; name: string; model: string }[]; activePreset?: string | null; defaultPreset: string },
  configured: boolean, words: Words): string[] {
  if (!configured || !summary.presets.length) return [words.t("terminal.cli.noModel", noModelWords)];
  const active = summary.activePreset ?? summary.defaultPreset;
  return summary.presets.map((preset) => `${preset.id === active ? "*" : " "} ${preset.id}\t${preset.name}\t${preset.model}`);
}
/** The line after `branch model use`, the same here and over the running Branch. */
export const modelUsedLine = (name: string, words: Words): string =>
  words.t("terminal.cli.model.use", "New conversations start with {name}.", { name });
/** `model`, `model list` and `model use <id>`; anything else is named rather than quietly listed. */
export function modelAction(args: string[]): { use: string } | null {
  if (args[0] === "use") return { use: args[1] ?? "" };
  if (args[0] === undefined || args[0] === "list") return null;
  throw new Error("Usage: branch model [list | use <id>]");
}
function modelCommand(app: Branch, args: string[], io: Io): void {
  const models = app.runtime.models, owner = app.runtime.owner, words = wordsFor(app, io.env), action = modelAction(args);
  if (action) {
    if (!models.presets.has(action.use)) throw new Error(`There is no model called ${action.use}. \`branch model\` lists them.`);
    models.configure(owner, { activePreset: action.use });
    return io.write(modelUsedLine(models.presets.get(action.use)!.name, words));
  }
  const summary = models.summary(owner);
  if (io.json) return io.write(JSON.stringify(summary, null, 2));
  modelLines(summary, models.configured, words).forEach((line) => io.write(line));
}
function toolsCommand(app: Branch, io: Io): void {
  const tools = app.registry.descriptions(new Set(app.registry.permissions()), { diet: true });
  const groups = new Map<string, string[]>();
  for (const tool of tools) groups.set(inferToolGroup(tool.name), [...(groups.get(inferToolGroup(tool.name)) ?? []), tool.name]);
  if (io.json) return io.write(JSON.stringify({ toolboxes: Object.fromEntries(groups) }, null, 2));
  for (const [group, names] of [...groups].sort()) io.write(`${group} (${names.length}): ${names.sort().join(", ")}`);
}
/** Lockdown's state in lines, the same whether this terminal read it or the running Branch sent it. */
export function lockdownLines(state: { on: boolean; since?: string | null; effects?: readonly string[] }, words: Words): string[] {
  if (!state.on) return [words.t("terminal.cli.lockdown.off", "Lockdown is off.")];
  const head = state.since
    ? words.t("terminal.cli.lockdown.onSince", "Lockdown is on, since {since}.", { since: state.since.slice(0, 16).replace("T", " ") })
    : words.t("terminal.cli.lockdown.on", "Lockdown is on.");
  return [head, ...(state.effects ?? []).map((effect) => `- ${effect}`)];
}
/** `lockdown`, `lockdown on` or `lockdown off`: the switch asked for, or null to only read it. */
export function lockdownSwitch(args: string[]): boolean | null {
  if (args[0] === "on" || args[0] === "off") return args[0] === "on";
  if (args[0] === undefined) return null;
  throw new Error("Usage: branch lockdown [on|off]");
}
function lockdownCommand(app: Branch, args: string[], io: Io): void {
  const { store } = app, owner = app.runtime.owner, on = lockdownSwitch(args);
  // As the route does: turning it on also ends the yeses already given (mac7/lockdown-fix integration review).
  if (on !== null && setLockdown(store, owner, { on }, "owner-by-command").on) app.runtime.approvals.forgetAll();
  const state = lockdownState(store, owner);
  if (io.json) return io.write(JSON.stringify(state, null, 2));
  lockdownLines(state, wordsFor(app, io.env)).forEach((line) => io.write(line));
}
/** The usage figure's line in the window's words: tokens, not "words of context". */
export function usageLine(stats: { monthStart: string; currentMonthlyTokens: number; estimatedCost: number }, words: Words): string {
  return words.t("terminal.cli.usage.line", "Since {date}: {tokens} tokens used, about {cost}.",
    { date: stats.monthStart.slice(0, 10), tokens: stats.currentMonthlyTokens, cost: `$${stats.estimatedCost.toFixed(2)}` });
}
async function usageCommand(app: Branch, io: Io): Promise<void> {
  const { overrides } = pricingSettings(app.store, app.runtime.owner);
  const stats = app.store.usageStore().getMonthlyStats(undefined, overrides);
  // mac7/usage-bar: the same rows the Usage screen draws, in the same words, as plain lines.
  // It is the owner's figure, so a household profile is refused and simply gets nothing here.
  const limits = await usageLimits(app).catch(() => null);
  const analytics = usageAnalytics(app.store, app.runtime.owner, stats.monthStart.slice(0, 7));
  if (io.json) return io.write(JSON.stringify({ ...stats, ...(limits ? { limits } : {}), analytics }, null, 2));
  const words = wordsFor(app, io.env);
  io.write(usageLine(stats, words));
  if (stats.unpricedRuns) io.write(words.t("dashboard.spend.unpriced", "Tasks on a model with no price on file, not in this figure: {count}", { count: stats.unpricedRuns }));
  for (const line of analyticsLines(analytics)) io.write(line);
  if (!limits) return;
  io.write("");
  io.write(`${words.t("glance.title", "What each connection has left")}:`);
  for (const line of limitLines(limits, Date.now())) io.write(line);
}
/** The health summary in lines: one heading, then each check. `branch status` and `branch doctor` share it. */
export function healthLines(health: { ok: boolean; items: { ok: boolean; name: string; summary: string }[] }, words: Words): string[] {
  return [health.ok ? words.t("terminal.cli.health.ok", "Everything checks out.") : words.t("terminal.cli.health.attention", "Some checks need attention:"),
    ...health.items.map((check) => `  ${check.ok ? "ok" : "x "} ${check.name}: ${check.summary}`)];
}

/**
 * `branch status`: the tasks working now, the questions waiting for an answer, and the health
 * summary. The health summary only looks; it never asks the model anything. The one place these
 * lines are written, whether this terminal opened the saved work itself or asked the Branch that
 * is already open for them over `GET /api/terminal`, so the two can never say different things.
 */
export async function statusCommand(app: Branch, io: Pick<Io, "json" | "write"> & { env?: NodeJS.ProcessEnv }): Promise<void> {
  const snapshot = statusSnapshot(app.runtime);
  const health = await healthReport(app, { probeProvider: false });
  if (io.json) return io.write(JSON.stringify({ ...snapshot, health }, null, 2));
  const words = wordsFor(app, io.env ?? {});
  // B5 (CL-05b): the preset by the name Settings shows, never its id.
  const found = policyPresets().find((preset) => preset.id === snapshot.approvalPreset);
  const { label } = presetWords(found ?? { id: snapshot.approvalPreset }, words);
  io.write(`${words.t("settings-kit.name.policy", "When to check with me")}: ${label}`);
  const lockdown = lockdownState(app.store, app.runtime.owner);
  if (lockdown.on) io.write(lockdownLines({ on: true, since: lockdown.since }, words)[0]!);
  io.write(snapshot.running.length ? `${words.t("dashboard.working.title", "Working now")}:` : words.t("dashboard.working.emptyTitle", "Nothing is working right now."));
  for (const run of snapshot.running) io.write(`  ${run.id} — ${run.prompt}`);
  for (const waiting of snapshot.waitingForYou) io.write(`  ${words.t("terminal.cli.status.waiting", "waiting for you")}: ${waiting.id} — ${waiting.question}`);
  healthLines(health, words).forEach((line) => io.write(line));
}
/** How a less careful preset is confirmed on the command line. */
export const confirmWords = (words: Words, name: string): string =>
  words.t("terminal.cli.permissions.confirm", "Run branch permissions {name} confirm to go ahead.", { name });

/** Runs one of the terminal's commands. */
export async function runTerminalCommand(app: Branch, command: string, args: string[], io: Io): Promise<void> {
  const words = wordsFor(app, io.env), owner = app.runtime.owner;
  if (PLACE_COMMANDS.has(command)) return placeCommand(app, command, args, io);
  if (command === "setup") return io.interactive ? startTui(app.runtime, { app, route: "settings:models:connection" }) : printRows(io, await rowsOf(app, words, { settings: "models", sub: "connection" }), words, homeName("settings:models:connection", words));
  if (command === "places") return placesCommand(io, words);
  // mac7/smoke-fixes (integration review): `branch version` is answered before anything is opened,
  // so this is only reached over GET /api/terminal — where leaving it out made a command on the
  // read-only list answer "I do not know the command version".
  if (command === "version") return io.write(versionText());
  if (command === "status") return statusCommand(app, io);
  if (command === "theme") return themeCommand(app, args, io);
  if (command === "sessions") return sessionsCommand(app, args, io);
  if (command === "resume") return resumeCommand(app, args, io);
  if (command === "model") return modelCommand(app, args, io);
  if (command === "memory") return printRows(io, (await PLACE_ROWS["library:memory"]!(app, words)).filter((row) => !args.length || `${row.title} ${row.detail}`.toLowerCase().includes(args.join(" ").toLowerCase())), words);
  if (command === "skills") return printRows(io, skillRows(app, words), words);
  if (command === "channels") return printRows(io, await PLACE_ROWS["customize:channels"]!(app, words), words);
  if (command === "mcp") return printRows(io, await connectionRows(app, words), words);
  if (command === "tools") return toolsCommand(app, io);
  if (command === "projects") return printRows(io, app.store.projects.list(owner).map((project) => ({ title: `${project.id === app.store.projects.chosen(owner).id ? "* " : "  "}${project.name}`, detail: project.id })), words);
  if (command === "lockdown") return lockdownCommand(app, args, io);
  if (command === "permissions") return args[0] ? io.write(choosePreset(app.runtime, args.join(" "), (name) => confirmWords(words, name), words)) : presetLines(app.runtime, words).forEach((line) => io.write(line));
  if (command === "usage") return usageCommand(app, io);
  if (command === "snapshots") return printRows(io, app.store.workspaceHistory.snapshots().map((snap) => ({ title: snap.label, detail: `${snap.id} · ${snap.files} files · ${snap.createdAt.slice(0, 16).replace("T", " ")}` })), words);
  throw new Error(`I do not know the command "${command}".`);
}
