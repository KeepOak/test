import type { Store } from "../store.js";
import { AutonomyModeSchema, autonomyShipsOn, quoteLine } from "./settings.js";

/**
 * R17-018: `/subgoal` — more that must be true before a conversation's goal (goal mode, src/goal-mode.ts)
 * counts as done. Each one is shown to the next round word for word, and the judge is asked about
 * the goal and every sub-goal together.
 *
 *   /subgoal <text>      adds one (at most 8, each at most 300 characters)
 *   /subgoal             lists them
 *   /subgoal remove <n>  takes one away
 *   /subgoal clear       takes them all away
 *
 * They are kept beside the goal rather than inside it, so a round finishing never writes over one
 * added while it was working. The command follows Hermes Agent's `/subgoal` (MIT); the code is Branch's.
 */
export const maxSubgoals = 8;
const keyOf = (sessionId: string): string => `autonomy-subgoals:${sessionId}`;

export function subgoalsOf(store: Pick<Store, "get">, owner: string, sessionId: string): string[] {
  const saved = store.get("settings", owner, keyOf(sessionId))?.data as { items?: unknown } | undefined;
  return Array.isArray(saved?.items) ? saved.items.filter((item): item is string => typeof item === "string").slice(0, maxSubgoals) : [];
}

export function saveSubgoals(store: Store, owner: string, sessionId: string, items: string[]): string[] {
  const kept = items.slice(0, maxSubgoals);
  if (kept.length) store.save("settings", owner, keyOf(sessionId), { items: kept });
  else store.delete("settings", owner, keyOf(sessionId));
  return kept;
}

export function addSubgoal(store: Store, owner: string, sessionId: string, text: string): string[] {
  const item = quoteLine(text, 300);
  if (!item) throw new Error("Say what else must be true: /subgoal <text>");
  const items = subgoalsOf(store, owner, sessionId);
  if (items.length >= maxSubgoals) throw new Error(`A goal may have at most ${maxSubgoals} sub-goals.`);
  return saveSubgoals(store, owner, sessionId, [...items, item]);
}

/**
 * The goal as goal mode shows it to a round and to the judge: the objective, then each sub-goal.
 * Hooked into src/goal-mode.ts; with no sub-goals (or the part switched off) it is the objective alone.
 */
export function goalWithSubgoals(store: Pick<Store, "get">, owner: string, state: { sessionId: string; objective: string }): string {
  if (!state.sessionId) return state.objective;
  const found = store.get("settings", owner, "autonomy-session-commands");
  // The owner's rule (ships on, 2026-09-26): a part never saved reads as it ships (settings.ts); a saved mode that
  // cannot be read is off.
  const saved = found ? AutonomyModeSchema.safeParse((found.data as { mode?: unknown } | undefined)?.mode) : null;
  const mode = saved ? (saved.success ? saved.data : "off") : autonomyShipsOn["session-commands"];
  if (!mode || mode === "off") return state.objective;
  const items = subgoalsOf(store, owner, state.sessionId);
  if (!items.length) return state.objective;
  return `${state.objective}\nIt is done only when every one of these is also true:\n${items.map((item, i) => `${i + 1}. ${item}`).join("\n")}`;
}
