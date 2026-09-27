import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { commitOfCopy } from "./desktop/build-identity.js";
import { comfortRows } from "./comfort/terminal.js"; // R17-S21
import { lockdownState } from "./lockdown.js";
import { neverBreakModeSync } from "./never-break/gateway-config.js";
import { chatAppRows, peopleRows, permissionRows, type PlaceApp, type Row } from "./terminal-place-data.js";
import { FIRST_MODEL_TAB, SETTINGS_PAGES } from "./terminal-places.js";
import type { Look, LookMode, TerminalSwitches } from "./terminal-theme.js";
import type { Words } from "./terminal-words.js";

/**
 * What each Settings page shows in the terminal, page for page as the window's Settings has them. The
 * pages the terminal can change (Appearance, Models › Defaults, Permissions) carry a command on each
 * row, run when the row is chosen in the view; the others say plainly what is on the page and name the
 * `branch` command or the window that changes it. Printed in a plain shell (`where` is "plain"), the
 * rows keep only what a shell can use: no view command and no word about the view's keys.
 */
export interface SettingsState { look: Look; mode: LookMode | "follow"; themeName: string; switches: TerminalSwitches }
export type RowsFor = "view" | "plain";

const inWindow = (words: Words, page: string): Row => ({
  title: words.t("terminal.settings.inWindow", "The rest of this page is in the window"),
  detail: words.t("terminal.settings.inWindowDetail", "Open Branch and choose Settings › {page}.", { page }), tone: "muted",
});
const switchWord = (words: Words, value: string): string =>
  value === "on" ? words.t("terminal.state.on", "on") : value === "off" ? words.t("terminal.state.off", "off") : words.t("terminal.state.whenNeeded", "when needed");

/** A language named in its own words (English, Français, Deutsch), as the window names it. */
function ownName(code: string): string {
  const name = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
  return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
}

function appearance(words: Words, state: SettingsState): Row[] {
  const mode = { dark: words.t("look.mode.dark", "Dark"), light: words.t("look.mode.light", "Light"), follow: words.t("look.mode.follow", "Follow this computer") }[state.mode];
  const language = state.look.language === "auto" ? words.t("terminal.settings.languageAuto", "Same as this computer") : ownName(state.look.language);
  const s = state.switches;
  return [
    { title: `${words.t("look.theme", "Theme")}: ${state.themeName}`, detail: words.t("terminal.settings.themeDetail", "All 44 themes, shared with the window."), command: "/theme list" },
    { title: `${words.t("look.mode", "Light and dark")}: ${mode}`, command: "/theme mode" },
    { title: `${words.t("look.contrast", "More contrast between text and background")}: ${switchWord(words, state.look.contrast === "more" ? "on" : "off")}`, command: "/theme contrast" },
    { title: `${words.t("terminal.settings.language", "Language")}: ${language}`, command: "/theme language" },
    { title: `${words.t("terminal.switch.mouse", "Clicks and the wheel")}: ${switchWord(words, s.mouse)}`, detail: words.t("terminal.switch.mouseDetail", "Off keeps your terminal's own text selection."), command: "/switch mouse" },
    { title: `${words.t("terminal.switch.sidePane", "Side pane opens by itself")}: ${switchWord(words, s.sidePane)}`, detail: words.t("terminal.switch.sidePaneDetail", "When needed, it opens while a task works."), command: "/switch sidePane" },
    { title: `${words.t("terminal.switch.oak", "The oak on a new conversation")}: ${switchWord(words, s.oak)}`, detail: words.t("terminal.switch.oakDetail", "When needed, only when the terminal is tall enough."), command: "/switch oak" },
  ];
}
/** The models of one Models tab; `local` is also the whole of Settings › On this computer. */
function modelRows(app: PlaceApp, words: Words, sub: string): Row[] {
  const summary = app.runtime.models.summary(app.runtime.owner);
  const active = summary.activePreset ?? summary.defaultPreset;
  const presets = summary.presets.filter((preset) => sub !== "local" || app.runtime.models.runsLocally(preset.id));
  const rows: Row[] = presets.map((preset) => ({
    title: `${preset.id === active ? "● " : ""}${preset.name}`, detail: `${preset.model}${preset.coolingDownUntil ? " · resting" : ""}`,
    tone: preset.id === active ? "ok" as const : undefined,
    ...(sub === "defaults" ? { command: `/default ${preset.id}` } : {}),
  }));
  if (sub === FIRST_MODEL_TAB) rows.push({ title: words.t("terminal.settings.signIn", "Sign in to a ChatGPT account"), detail: "branch login", tone: "muted" });
  if (sub === "defaults") rows.push({ title: words.t("terminal.settings.fallbacks", "Tried next when one fails"), detail: summary.fallbackOrder.join(", ") || "—", tone: "muted" });
  return rows;
}
function models(app: PlaceApp, words: Words, sub: string): Row[] {
  const tab = sub === "connection" ? FIRST_MODEL_TAB : sub || FIRST_MODEL_TAB;
  const rows = [FIRST_MODEL_TAB, "local", "defaults"].includes(tab) ? modelRows(app, words, tab) : [];
  return rows.length ? rows : [inWindow(words, words.t("settings.page.models", "Models"))];
}
/** Settings › Gateway: on or off, as the window says it, from the gateway's own settings file. */
function gateway(app: PlaceApp, words: Words): Row[] {
  const on = neverBreakModeSync(app.store.folder) !== "off";
  return [{
    title: on ? words.t("window.settings.gateway.the-gateway-is-on", "The gateway is on") : words.t("window.settings.gateway.the-gateway-is-off", "The gateway is off"),
    detail: on ? words.t("window.settings.gateway.on-telegram-your-phone-and-automations", "On. Telegram, your phone and automations keep working when the window is closed, and it restarts the engine if it stops.")
      : words.t("window.settings.gateway.off-when-you-close-branch-your", "Off. When you close Branch, your Trunks stop, and Telegram and automations go quiet until you open it again."),
    tone: on ? "ok" : "muted",
  }];
}

let asked: Promise<string | null> | null = null;
let knownCommit: string | null = null;
/**
 * The commit this terminal's own copy was built from, asked of git once per process and without waiting on it (never a
 * synchronous child process). The terminal awaits this before it draws Settings, so the first draw already names it.
 */
export function knowCopysCommit(): Promise<string | null> {
  asked ??= commitOfCopy(dirname(dirname(fileURLToPath(import.meta.url))))
    .catch(() => null)
    .then((commit) => (knownCommit = commit));
  return asked;
}

/** Q55: Updates & about names the installed build, as the window's page does: version, then the commit it was built from. */
export function aboutRows(words: Words, version: string, commit: string | null): Row[] {
  const line = (shown: string): string => words.t("terminal.settings.builtFrom", "Built from commit: {commit}", { commit: shown });
  const built: Row = commit
    ? { title: line(commit.slice(0, 12)), detail: commit }
    : { title: line(words.t("updates.build.not-recorded", "not recorded")), tone: "muted" };
  return [{ title: `Branch Agent ${version}`, detail: "branch update" }, built];
}

/** The comfort settings (src/comfort/terminal.ts) still name two pages by their names from before the redesign. */
const COMFORT_PAGE: Record<string, string> = { updates: "about", self: "advanced" };

/** The rows of one Settings page (and Models tab). */
export function settingsRows(app: PlaceApp, words: Words, page: string, sub: string, state: SettingsState, where: RowsFor = "view"): Row[] {
  // R17-S21: the comfort settings on each page are real controls (src/comfort/terminal.ts), put
  // after the page's own rows and before its last row, the pointer to the window.
  const comfort = comfortRows(app.store, app.runtime.owner, words, COMFORT_PAGE[page] ?? page);
  const own = pageRows(app, words, page, sub, state);
  const rows = comfort.length ? [...own.slice(0, -1), ...comfort, ...own.slice(-1)] : own;
  if (where === "view") return rows;
  // A comfort control's line under it only names the view's keys, so a shell gets its title alone.
  const controls = new Set<Row>(comfort);
  return rows.map((row) => {
    const { command: _viewOnly, ...plain } = row;
    if (controls.has(row)) delete plain.detail;
    return plain;
  });
}
function pageRows(app: PlaceApp, words: Words, page: string, sub: string, state: SettingsState): Row[] {
  const name = SETTINGS_PAGES.find((entry) => entry.id === page);
  const here = inWindow(words, name ? words.t(name.key, name.english) : page);
  const owner = app.runtime.owner;
  switch (page) {
    case "appearance": return appearance(words, state);
    case "models": return models(app, words, sub);
    case "local": return [...modelRows(app, words, "local"), here];
    case "people": return [...peopleRows(app, words), here];
    case "chatapps": return [...chatAppRows(app), here];
    case "gateway": return [...gateway(app, words), here];
    case "permissions": {
      const lock = lockdownState(app.store, owner).on;
      const detail = lock
        ? words.t("lockdown.on", "Lockdown is on. Commands are refused; all else asks you.")
        : words.t("lockdown.off", "Lockdown is off. Commands follow the permission rules above.");
      return [...permissionRows(app, words), { title: `${words.t("lockdown.label", "Lockdown")}: ${switchWord(words, lock ? "on" : "off")}`, detail, command: `/lockdown ${lock ? "off" : "on"}`, tone: lock ? "bad" : undefined }];
    }
    case "general": return [
      ...app.store.projects.list(owner).map((project) => ({ title: project.name, ...(project.id === app.store.projects.chosen(owner).id ? { detail: words.t("terminal.settings.activeProject", "the project in use") } : {}) })),
      here];
    case "usage": return [{ title: words.t("terminal.settings.tasks", "{count} tasks on record", { count: app.store.runs(owner).length }), detail: "branch backup <file>" }, here];
    case "self": return [{ title: words.t("terminal.settings.doctor", "Check that everything works"), detail: "branch doctor" }, here];
    case "updates": return [...aboutRows(words, app.version, knownCommit), here];
    default: return [here];
  }
}
