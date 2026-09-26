import { historyKeywordLimit, historyKeywords } from "./history.js";
import { recipeBook } from "./channel-setup/recipes.js";
import { limitLines } from "./usage-limits.js";
import { usageLimits } from "./usage-limits-api.js";
import type { PlaceApp } from "./terminal-place-data.js";
import type { PaletteItem } from "./terminal-screen.js";
import type { Runtime } from "./runtime.js";
import type { Words } from "./terminal-words.js";

/**
 * The commands the redesign's terminal added (design/redesign/prototype.html termRun): /find, /channels
 * and the half of /usage that says what each account has left. Each reads what the window reads, for the person
 * using Branch here: /find searches only their own conversations, and the chat apps and the account limits are the
 * owner's alone, as they are in the window.
 */
export interface Said { say(kind: "note" | "warn" | "ok" | "bad" | "step", text: string): void }
export interface RedesignContext extends Said {
  runtime: Runtime;
  words: Words;
  app?: PlaceApp | undefined;
  /** Shows a list to choose from in the drawn view and says true; false where the view cannot draw one. */
  pick?(title: string, items: PaletteItem[]): boolean;
}

const flat = (text: string, size: number): string => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > size ? `${line.slice(0, size - 1)}…` : line;
};

/** `/find <words>`: every conversation and message of the person here that holds all the words. */
export function findWords(context: RedesignContext, argument: string): void {
  const { words } = context, store = context.runtime.store;
  const keywords = historyKeywords(argument).slice(0, historyKeywordLimit);
  if (!keywords.length) return context.say("warn", words.t("terminal.find.say", "Say what to find: /find <words>"));
  const scope = store.profiles.scope();
  const openings = new Map(store.recentSessions(scope, 200).sessions.map((entry) => [entry.sessionId, entry.opening]));
  const lower = keywords.map((word) => word.toLowerCase());
  const named = [...openings].filter(([, opening]) => lower.every((word) => opening.toLowerCase().includes(word)));
  const hits = store.searchHistory(scope, { query: keywords.join(" "), limit: 20 });
  const items: PaletteItem[] = [
    ...named.map(([sessionId, opening]) => ({ label: flat(opening, 80), section: words.t("rail.conversations", "Conversations"), run: `/sessions ${sessionId}` })),
    ...hits.map((hit) => ({ label: flat(hit.excerpt, 80), section: flat(openings.get(hit.sessionId) ?? "", 60), run: `/sessions ${hit.sessionId}` })),
  ];
  if (!items.length) return context.say("note", words.t("terminal.find.none", "Nothing matches."));
  if (context.pick?.(words.t("terminal.find.title", "Found"), items)) return;
  for (const item of items) context.say("note", item.section ? `${item.section}: ${item.label}` : item.label);
}

/** `/channels`: every chat app Branch can set up, the ones that reach Branch now first, four to a line. */
export function channelsCommand(context: RedesignContext): void {
  const { words, app } = context;
  if (!app) return context.say("warn", words.t("terminal.noApp", "Open Branch to see this."));
  const connected = new Set(app.channels.summary().channels.flatMap((channel) => [channel.kind, channel.id]));
  const recipes = [...recipeBook().recipes].sort((a, b) => Number(connected.has(b.id)) - Number(connected.has(a.id)));
  const on = recipes.filter((recipe) => connected.has(recipe.id)).length;
  context.say("note", words.t("terminal.channels.head", "{on} of {count} reach Branch · ● connected · set one up in the window or on the phone",
    { on, count: recipes.length }));
  for (let index = 0; index < recipes.length; index += 4)
    context.say("note", recipes.slice(index, index + 4).map((recipe) => `${connected.has(recipe.id) ? "●" : "○"} ${recipe.name.slice(0, 16).padEnd(17)}`).join("").trimEnd());
}

/** The half of `/usage` the window's Data & usage page leads with: what each connection has left. The owner's alone. */
export async function limitsLines(context: RedesignContext): Promise<string[]> {
  if (!context.app || !context.runtime.store.profiles.isOwner()) return [];
  const view = await usageLimits(context.app as unknown as Parameters<typeof usageLimits>[0]);
  return [context.words.t("terminal.usage.limits", "What each connection has left:"), ...limitLines(view, Date.now())];
}
