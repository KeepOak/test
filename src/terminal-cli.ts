import { createRequire } from "node:module";
import type { createBranch } from "./index.js";
import { inferToolGroup } from "./catalog.js";
import { statusSnapshot } from "./cli-run.js";
import { healthReport } from "./health.js";
import { lockdownState, setLockdown } from "./lockdown.js";
import { pricingSettings } from "./pricing.js";
import { limitLines } from "./usage-limits.js"; // mac7/usage-bar
import { usageLimits } from "./usage-limits-api.js"; // mac7/usage-bar
import { choosePreset, historyLines, presetLines } from "./terminal-commands.js";
import { PLACE_ROWS, type Row } from "./terminal-place-data.js";
import { TERMINAL_ALIASES, TERMINAL_CLI_COMMANDS } from "./terminal-parity.js";
import { MODEL_TABS, SETTINGS_PAGES, allHomes, homeOf, parseRoute, placeById, type Route } from "./terminal-places.js";
import { settingsRows } from "./terminal-settings.js";
import {
  loadThemeCatalogue, lookLanguage, readLook, saveLook, saveLookMode, terminalSwitches, type LookLanguage, type LookMode,
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

const PLACE_COMMANDS = new Set(["inbox", "automations", "library", "customize", "overview", "household", "settings"]);
export const terminalCommandNames = new Set(TERMINAL_CLI_COMMANDS.map((entry) => entry.name));

/**
 * mac7/smoke-fixes (B4): the terminal commands that only look. These are the ones a second terminal
 * may run against the Branch already open, over `GET /api/terminal`, so the window being open no
 * longer makes the terminal useless. Everything left out either writes (`theme`, `model use`,
 * `lockdown`, `permissions <preset>`) or wants a terminal of its own (`resume`, `setup`), and still
 * refuses while another Branch holds the saved work. `status` only reads too, so it is here.
 */
export const readOnlyTerminalCommands = new Set([
  "inbox", "automations", "library", "customize", "overview", "household", "settings", "places", "sessions", "memory",
  "skills", "channels", "mcp", "tools", "projects", "usage", "snapshots", "version", "status",
]);

/**
 * The command line as Branch reads it: nothing at all opens the view in a terminal (and starts the
 * web app anywhere else, as it always has), and a name brought from Hermes or OpenClaw becomes the
 * Branch command it means.
 */
export function terminalArgv(args: string[], interactive: boolean): string[] {
  if (!args.length) return [interactive ? "chat" : "start"];
  const [first = "", ...rest] = args;
  if (first === "mcp" && rest[0] === "serve") return ["mcp-serve", ...rest.slice(1)];
  const alias = TERMINAL_ALIASES[first];
  return alias ? [...alias, ...rest] : args;
}
export function versionText(): string {
  return `Branch Agent ${String(createRequire(import.meta.url)("../package.json").version)}`;
}

const wordsFor = (app: Branch, env: NodeJS.ProcessEnv): Words => loadWords(lookLanguage(readLook(app.store, app.runtime.owner), env));
function printRows(io: Io, rows: Row[], heading = ""): void {
  if (io.json) return io.write(JSON.stringify({ rows }, null, 2));
  if (heading) io.write(heading);
  if (!rows.length) io.write("Nothing here yet.");
  for (const row of rows) io.write(`${row.title}${row.detail ? `\t${row.detail}` : ""}${row.command ? `\t${row.command}` : ""}`);
}
async function rowsOf(app: Branch, words: Words, route: Route): Promise<Row[]> {
  if ("settings" in route) {
    const look = readLook(app.store, app.runtime.owner);
    const table = await loadThemeCatalogue();
    const saved = app.store.get("settings", app.runtime.owner, "preferences")?.data ?? {};
    const mode = saved.followSystem === true ? "follow" : saved.appearance === "daylight" ? "light" : "dark";
    const themeName = table.THEMES.find((theme) => theme[0] === look.theme)?.[1] ?? look.theme;
    return settingsRows(app, words, route.settings, route.sub, { look, mode, themeName, switches: terminalSwitches(app.store, app.runtime.owner) });
  }
  if (route.place === "chat") return [];
  return PLACE_ROWS[homeOf(route)]!(app, words);
}

/** A place or Settings page: the view opened there, or its rows printed. */
async function placeCommand(app: Branch, command: string, args: string[], io: Io): Promise<void> {
  const words = wordsFor(app, io.env);
  const route = parseRoute([command, ...args].join(" "), words);
  if (!route) throw new Error(`There is no ${command} page called "${args.join(" ")}". \`branch places\` lists them all.`);
  if (io.interactive) return startTui(app.runtime, { app, route: homeOf(route) });
  printRows(io, await rowsOf(app, words, route), `# ${homeOf(route)}`);
}
function placesCommand(io: Io, words: Words): void {
  const named = (home: string): string => {
    const route = parseRoute(home)!;
    if ("settings" in route) {
      const page = SETTINGS_PAGES.find((entry) => entry.id === route.settings)!;
      const sub = MODEL_TABS.find((entry) => entry.id === route.sub);
      return [words.t("settings.title", "Settings"), words.t(page.key, page.english), ...(route.settings === "models" && sub ? [words.t(sub.key, sub.english)] : [])].join(" › ");
    }
    const place = placeById(route.place)!;
    const tab = place.tabs.find((entry) => entry.id === route.tab);
    return [words.t(place.key, place.english), ...(tab ? [words.t(tab.key, tab.english)] : [])].join(" › ");
  };
  const homes = allHomes().map((home) => ({ home, name: named(home), command: `branch ${home.replace(/:/g, " ").replace(/^chat$/, "chat")}` }));
  if (io.json) return io.write(JSON.stringify({ homes }, null, 2));
  for (const entry of homes) io.write(`${entry.home.padEnd(28)} ${entry.name.padEnd(40)} ${entry.command}`);
}

async function themeCommand(app: Branch, args: string[], io: Io): Promise<void> {
  const { store } = app, owner = app.runtime.owner, word = args[0] ?? "list";
  if (["light", "dark", "follow"].includes(word)) saveLookMode(store, owner, word as LookMode | "follow");
  else if (word === "contrast") await saveLook(store, owner, { contrast: args[1] === "standard" || (!args[1] && readLook(store, owner).contrast === "more") ? "standard" : "more" });
  else if (word === "language") await saveLook(store, owner, { language: (args[1] ?? "auto") as "auto" | LookLanguage });
  else if (word !== "list") await saveLook(store, owner, { theme: word });
  const look = readLook(store, owner), table = await loadThemeCatalogue();
  const saved = store.get("settings", owner, "preferences")?.data ?? {};
  const mode = saved.followSystem === true ? "follow this computer" : saved.appearance === "daylight" ? "light" : "dark";
  if (word === "list") for (const theme of table.THEMES) io.write(`${theme[0] === look.theme ? "*" : " "} ${theme[0].padEnd(16)} ${theme[1]}`);
  io.write(`Theme: ${table.THEMES.find((theme) => theme[0] === look.theme)?.[1] ?? look.theme} · ${mode} · contrast ${look.contrast} · language ${look.language}. The window follows this too.`);
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
function modelCommand(app: Branch, args: string[], io: Io): void {
  const models = app.runtime.models, owner = app.runtime.owner;
  if (args[0] === "use") {
    const id = args[1] ?? "";
    if (!models.presets.has(id)) throw new Error(`There is no model called ${id}. \`branch model\` lists them.`);
    models.configure(owner, { activePreset: id });
    return io.write(`New conversations start with ${models.presets.get(id)!.name}.`);
  }
  const summary = models.summary(owner), active = summary.activePreset ?? summary.defaultPreset;
  if (io.json) return io.write(JSON.stringify(summary, null, 2));
  for (const preset of summary.presets) io.write(`${preset.id === active ? "*" : " "} ${preset.id}\t${preset.name}\t${preset.model}`);
}
function toolsCommand(app: Branch, io: Io): void {
  const tools = app.registry.descriptions(new Set(app.registry.permissions()), { diet: true });
  const groups = new Map<string, string[]>();
  for (const tool of tools) groups.set(inferToolGroup(tool.name), [...(groups.get(inferToolGroup(tool.name)) ?? []), tool.name]);
  if (io.json) return io.write(JSON.stringify({ toolboxes: Object.fromEntries(groups) }, null, 2));
  for (const [group, names] of [...groups].sort()) io.write(`${group} (${names.length}): ${names.sort().join(", ")}`);
}
function lockdownCommand(app: Branch, args: string[], io: Io): void {
  const { store } = app, owner = app.runtime.owner;
  if (args[0] === "on" || args[0] === "off") {
    // As the route does: turning it on also ends the yeses already given (mac7/lockdown-fix integration review).
    if (setLockdown(store, owner, { on: args[0] === "on" }, "owner-by-command").on) app.runtime.approvals.forgetAll();
  }
  const state = lockdownState(store, owner);
  io.write(state.on ? `Lockdown is on${state.since ? ` since ${state.since}` : ""}.` : "Lockdown is off.");
  if (state.on) for (const effect of state.effects) io.write(`- ${effect}`);
}
async function usageCommand(app: Branch, io: Io): Promise<void> {
  const { overrides } = pricingSettings(app.store, app.runtime.owner);
  const stats = app.store.usageStore().getMonthlyStats(undefined, overrides);
  // mac7/usage-bar: the same rows the Usage screen draws, in the same words, as plain lines.
  // It is the owner's figure, so a household profile is refused and simply gets nothing here.
  const limits = await usageLimits(app).catch(() => null);
  if (io.json) return io.write(JSON.stringify({ ...stats, ...(limits ? { limits } : {}) }, null, 2));
  io.write(`Since ${stats.monthStart.slice(0, 10)}: ${stats.currentMonthlyTokens} words of context used, about $${stats.estimatedCost.toFixed(2)}.`);
  if (stats.unpricedRuns) io.write(`${stats.unpricedRuns} task(s) used a model with no price on file, so they are not in that figure.`);
  if (!limits) return;
  io.write("");
  io.write("What each connection has left:");
  for (const line of limitLines(limits, Date.now())) io.write(line);
}

/**
 * `branch status`: the tasks working now, the questions waiting for an answer, and the health
 * summary. The health summary only looks; it never asks the model anything. The one place these
 * lines are written, whether this terminal opened the saved work itself or asked the Branch that
 * is already open for them over `GET /api/terminal`, so the two can never say different things.
 */
export async function statusCommand(app: Branch, io: Pick<Io, "json" | "write">): Promise<void> {
  const snapshot = statusSnapshot(app.runtime);
  const health = await healthReport(app, { probeProvider: false });
  if (io.json) return io.write(JSON.stringify({ ...snapshot, health }, null, 2));
  io.write(`When to check with me: ${snapshot.approvalPreset}`);
  io.write(snapshot.running.length ? "Working now:" : "Nothing is working right now.");
  for (const run of snapshot.running) io.write(`  ${run.id} — ${run.prompt}`);
  for (const waiting of snapshot.waitingForYou) io.write(`  waiting for you: ${waiting.id} — ${waiting.question}`);
  io.write(health.ok ? "Everything checks out." : "Some checks need attention:");
  for (const check of health.items) io.write(`  ${check.ok ? "ok" : "x "} ${check.name}: ${check.summary}`);
}

/** Runs one of the terminal's commands. */
export async function runTerminalCommand(app: Branch, command: string, args: string[], io: Io): Promise<void> {
  const words = wordsFor(app, io.env), owner = app.runtime.owner;
  if (PLACE_COMMANDS.has(command)) return placeCommand(app, command, args, io);
  if (command === "setup") return io.interactive ? startTui(app.runtime, { app, route: "settings:models:connection" }) : printRows(io, await rowsOf(app, words, { settings: "models", sub: "connection" }), "Connect a model here, or run `branch doctor` to check everything.");
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
  if (command === "memory") return printRows(io, (await PLACE_ROWS["library:memory"]!(app, words)).filter((row) => !args.length || `${row.title} ${row.detail}`.toLowerCase().includes(args.join(" ").toLowerCase())));
  if (command === "skills") return printRows(io, await PLACE_ROWS["customize:skills"]!(app, words));
  if (command === "channels") return printRows(io, await PLACE_ROWS["customize:channels"]!(app, words));
  if (command === "mcp") return printRows(io, await PLACE_ROWS["customize:connections"]!(app, words));
  if (command === "tools") return toolsCommand(app, io);
  if (command === "projects") return printRows(io, app.store.projects.list(owner).map((project) => ({ title: `${project.id === app.store.projects.active(owner).id ? "* " : "  "}${project.name}`, detail: project.id })));
  if (command === "lockdown") return lockdownCommand(app, args, io);
  if (command === "permissions") return args[0] ? io.write(choosePreset(app.runtime, args.join(" "), (name) => `Run branch permissions ${name} confirm to go ahead.`)) : presetLines(app.runtime).forEach((line) => io.write(line));
  if (command === "usage") return usageCommand(app, io);
  if (command === "snapshots") return printRows(io, app.store.workspaceHistory.snapshots().map((snap) => ({ title: snap.label, detail: `${snap.id} · ${snap.files} files · ${snap.createdAt.slice(0, 16).replace("T", " ")}` })));
  throw new Error(`I do not know the command "${command}".`);
}
