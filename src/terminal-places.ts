import type { Words } from "./terminal-words.js";

/**
 * The map of Branch, as the terminal shows it: the window's places in the window's order with the
 * window's names (public/app/shell/shell.js PLACES, with the conversation first and Team last on the
 * tab row, as the prototype's terminal draws it), their tabs, the Settings pages in the window's
 * order (public/app/settings/settings.js NAV), the five Models tabs (settings/pages/models.js TABS)
 * and the four side-pane tabs. Every key is one the window itself shows for that name, so both
 * surfaces say the same words, and `tests/terminal-view.test.mjs` checks this list against
 * `docs/places.md` and the window's own lists.
 */
export type PlaceId = "chat" | "inbox" | "automations" | "library" | "customize" | "team" | "overview";
export interface Named { id: string; key: string; english: string }
export interface Place extends Named { intro: [string, string]; tabs: Named[] }
export interface SettingsPage extends Named { intro: [string, string] }

const tab = (id: string, key: string, english: string): Named => ({ id, key, english });
export const PLACES: Place[] = [
  { id: "chat", key: "nav.chat", english: "Conversation",
    intro: ["terminal.place.chat.intro", "The work happening now, and what this conversation is using."], tabs: [] },
  { id: "inbox", key: "place.inbox", english: "Inbox",
    intro: ["window.places.inbox.everything-a-trunk-is-waiting-on", "Everything a Trunk is waiting on you for, what finished, and a record of what ran."],
    tabs: [tab("needs", "place.inbox.needs", "Needs you"), tab("finished", "place.inbox.finished", "Finished"), tab("history", "place.inbox.history", "History")] },
  { id: "automations", key: "place.automations", english: "Automations",
    intro: ["window.places.automations.work-your-trunks-do-on-their", "Work your Trunks do on their own."],
    tabs: [tab("scheduled", "place.automations.scheduled", "Scheduled"), tab("procedures", "place.automations.procedures", "Procedures"),
      tab("triggers", "place.automations.triggers", "Triggers")] },
  { id: "library", key: "place.library", english: "Library",
    intro: ["window.places.library.what-your-trunks-remember-the-documents", "What your Trunks remember, the documents they read, and everything they made."],
    tabs: [tab("memory", "place.library.memory", "Memory"), tab("documents", "place.library.documents", "Documents"),
      tab("made", "place.library.made", "Made for you")] },
  { id: "customize", key: "place.customize", english: "Customize",
    intro: ["window.places.customize.who-your-trunks-are-what-they", "Who your Trunks are, what they can do, and where you can reach them."],
    tabs: [tab("trunks", "settingsDirectory.trunks", "Trunks"), tab("tools", "dashboard.filter.tools", "Tools"),
      tab("specialists", "place.customize.specialists", "Specialists"), tab("channels", "place.customize.channels", "Channels"),
      tab("everywhere", "window.places.customize.everywhere", "Everywhere")] },
  { id: "team", key: "window.shell.shell.team", english: "Team",
    intro: ["window.places.team.everyone-who-uses-branch-and-what", "Everyone who uses Branch, and what their Trunks are doing right now."],
    tabs: [tab("live", "window.places.team.live-now", "Live now"), tab("people", "people.admin.people", "People")] },
];
/** The window's Overview, reached from the Trunks strip rather than the tab row. */
export const STRIP_PLACES: Place[] = [
  { id: "overview", key: "place.overview", english: "Overview",
    intro: ["window.places.overview.whats-happening-across-your-trunks-at", "What's happening across your Trunks, at a glance."],
    tabs: [tab("here", "place.overview.here", "Overview")] },
];
/** Every place the terminal can open, including the one shown in the window's strip. */
export const ALL_PLACES = [...PLACES, ...STRIP_PLACES];
/** A name the terminal used before the redesign, still understood when typed: People is Team › People now. */
const OLD_PLACES: Record<string, { place: PlaceId; tab: string }> = { household: { place: "team", tab: "people" } };

const page = (id: string, key: string, english: string, intro: [string, string]): SettingsPage => ({ id, key, english, intro });
/** In the window's order (public/app/settings/settings.js NAV), which tests/terminal-view.test.mjs holds it to. */
export const SETTINGS_PAGES: SettingsPage[] = [
  page("general", "settings.page.general", "General", ["window.settings.general.how-branch-starts-and-behaves-on", "How Branch starts and behaves on this computer."]),
  page("people", "people.admin.people", "People", ["window.settings.people.everyone-who-uses-branch-on-this", "Everyone who uses Branch: on this computer, on their own devices, and your keepoak.com team. The same list as Team › People."]),
  page("appearance", "settings.page.appearance", "Appearance", ["window.settings.appearance.how-branch-looks-on-this-computer", "How Branch looks on this computer. Changes show as you pick."]),
  page("notifications", "settings.page.notifications", "Notifications", ["window.settings.notifications.when-branch-may-interrupt-you", "When Branch may interrupt you."]),
  page("achievements", "delight.ach.title", "Achievements", ["window.settings.achievements.private-to-you-never-nagging", "Private to you, never nagging."]),
  page("instructions", "settings.page.instructions", "Instructions & personality", ["window.settings.instructions.plain-files-every-trunk-reads-before", "Plain files every Trunk reads before it works. They work the same as in other agents, so a file written for one of them works here."]),
  page("models", "settings.page.models", "Models", ["window.settings.models.which-models-answer-and-where-they", "Which models answer, and where they run."]),
  page("accounts", "settings.page.accounts", "Accounts", ["window.settings.accounts.your-model-accounts-the-order-branch", "Your model accounts, the order Branch uses them in, which Trunks use each, and your keepoak.com account."]),
  page("local", "settings.models.local", "On this computer", ["window.settings.local.models-that-run-here-free-and", "Models that run here, free and private. Branch looks at this computer first and only offers what fits."]),
  page("voice", "settings.page.voice", "Voice", ["window.settings.voice.talking-to-branch-voice-stays-on", "Talking to Branch. Voice stays on this computer."]),
  page("chatapps", "dashboard.links.chats", "Chat apps", ["window.p17d.chat-apps-lede", "Where you can message your Trunks, and how each chat app behaves."]),
  page("gateway", "window.settings.gateway.gateway", "Gateway", ["window.settings.gateway.a-small-helper-that-keeps-branch", "A small helper that keeps Branch running in the background, starts it again if it stops, and carries interrupted work on."]),
  page("permissions", "settings.page.permissions", "Permissions", ["window.settings.permissions.what-trunks-may-do-without-asking", "What Trunks may do without asking you first."]),
  page("computer", "settings.page.computer", "Computer & browser", ["window.settings.computer.the-computers-your-trunks-may-use", "The computers your Trunks may use, and the browser they work in. Which Branch you talk to is the switcher at the top of the list."]),
  page("secrets", "window.settings.secrets.saved-sign-ins", "Saved sign-ins", ["window.settings.secrets.sign-ins-branch-may-fill-for", "Sign-ins Branch may fill for you. It never sees or stores the passwords."]),
  page("usage", "settings.page.data", "Data & usage", ["window.settings.usage.what-each-connection-has-left-what", "What each connection has left, what Branch spent, what it keeps."]),
  page("data", "window.settings.data.title", "Your data", ["window.settings.data.lede", "What Branch keeps for you, what leaves this computer, and how to take it all with you or delete it."]),
  page("self", "dashboard.computer.engine", "Branch itself", ["window.settings.self.what-branch-may-change-about-itself-2", "What Branch may change about itself, how it stays running, and every change it made, each one reversible."]),
  page("updates", "settings.page.about", "Updates & about", ["terminal.settings.about.intro", "Your version, and updates."]),
];
export const MODEL_TABS: Named[] = [
  tab("connections", "settings.page.connections", "Connections"), tab("defaults", "settings.models.defaults", "Defaults"),
  tab("local", "settings.models.local", "On this computer"), tab("second", "settings.models.second", "Second opinion"),
  tab("media", "window.settings.models.media", "Media"),
];
/** The Models tab the page opens on. */
export const FIRST_MODEL_TAB = "connections";
/** A Models tab's name from before the redesign, still understood when typed. */
const OLD_MODEL_TABS: Record<string, string> = { connection: "connections" };
export const PANE_TABS: Named[] = [
  tab("activity", "pane.activity", "Activity"), tab("plan", "pane.plan", "Plan"), tab("files", "pane.files", "Files"), tab("memory", "pane.memory", "Memory"),
];

/** Where the view is: a place and its tab, or a Settings page (and a Models tab). */
export type Route = { place: PlaceId; tab: string } | { settings: string; sub: string };
/** A Settings page's route, opening Models on its first tab. */
export const settingsPage = (id: string): Route => ({ settings: id, sub: id === "models" ? FIRST_MODEL_TAB : "" });

/** Every home the terminal can open, written as `docs/places.md` writes them. */
export function allHomes(): string[] {
  const homes = ["chat"];
  for (const place of ALL_PLACES) for (const entry of place.tabs) homes.push(`${place.id}:${entry.id}`);
  for (const entry of SETTINGS_PAGES) {
    if (entry.id === "models") for (const sub of MODEL_TABS) homes.push(`settings:models:${sub.id}`);
    else homes.push(`settings:${entry.id}`);
  }
  return homes;
}
export const placeById = (id: string): Place | undefined => ALL_PLACES.find((place) => place.id === id);
export const firstTab = (id: PlaceId): string => placeById(id)?.tabs[0]?.id ?? "";

const squash = (text: string): string => text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
/** True when the typed words name this entry by id, English or the chosen language. */
const names = (entry: Named, words: Words | undefined, typed: string): boolean =>
  [entry.id, entry.english, words?.t(entry.key, entry.english) ?? ""].some((name) => name && squash(name) === typed);

/**
 * A route from what a person types: `inbox`, `inbox:finished`, `Made for you`, `settings models
 * defaults`, `Paramètres Modèles`, a Settings page's name on its own, and so on. A place followed by
 * words that name none of its tabs is no route at all, rather than quietly its first tab.
 */
export function parseRoute(text: string, words?: Words): Route | null {
  const parts = text.split(/[:›>/]/).map(squash).filter(Boolean);
  if (!parts.length) return null;
  const [head, ...rest] = parts.length === 1 ? splitWords(parts[0]!, words) : parts;
  const settingsWord = [squash("settings"), squash(words?.t("settings.title", "Settings") ?? "settings")];
  if (settingsWord.includes(head!)) return settingsRoute(rest, words);
  const wanted = rest.join(" ");
  const old = OLD_PLACES[head!];
  if (old) return !wanted || wanted === old.tab ? { ...old } : null;
  const place = ALL_PLACES.find((entry) => names(entry, words, head!));
  if (place) {
    const chosen = place.tabs.find((entry) => names(entry, words, wanted));
    if (!wanted || chosen) return { place: place.id as PlaceId, tab: chosen?.id ?? place.tabs[0]?.id ?? "" };
  }
  for (const entry of ALL_PLACES) {
    const chosen = entry.tabs.find((candidate) => names(candidate, words, parts.join(" ")));
    if (chosen) return { place: entry.id as PlaceId, tab: chosen.id };
  }
  return settingsRoute(parts, words);
}
/** "settings models defaults" typed as one run of words becomes its three parts. */
function splitWords(typed: string, words?: Words): string[] {
  const settings = squash(words?.t("settings.title", "Settings") ?? "settings");
  for (const lead of new Set(["settings", settings]))
    if (typed.startsWith(lead + " ")) return [lead, typed.slice(lead.length + 1)];
  const leads: [string, string][] = [...ALL_PLACES.flatMap((entry): [string, string][] => [[entry.id, entry.id], [squash(entry.english), entry.id]]),
    ...Object.keys(OLD_PLACES).map((name): [string, string] => [name, name])];
  const found = leads.find(([name]) => typed.startsWith(name + " "));
  return found ? [found[1], typed.slice(found[0].length + 1)] : [typed];
}
function settingsRoute(parts: string[], words?: Words): Route | null {
  const typed = parts.join(" ");
  if (!typed) return settingsPage("general");
  const direct = SETTINGS_PAGES.find((entry) => names(entry, words, typed));
  if (direct) return settingsPage(direct.id);
  const models = SETTINGS_PAGES.find((entry) => entry.id === "models")!;
  const [lead, ...tail] = parts.length > 1 ? parts : typed.split(" ");
  const asked = names(models, words, lead ?? "") ? tail.join(" ") : typed;
  const sub = MODEL_TABS.find((entry) => names(entry, words, OLD_MODEL_TABS[asked] ?? asked));
  return sub ? { settings: "models", sub: sub.id } : null;
}
/** The home a route stands for, as `docs/places.md` writes it. */
export function homeOf(route: Route): string {
  if ("place" in route) return route.place === "chat" ? "chat" : `${route.place}:${route.tab}`;
  return route.settings === "models" ? `settings:models:${OLD_MODEL_TABS[route.sub] ?? (route.sub || FIRST_MODEL_TAB)}` : `settings:${route.settings}`;
}
