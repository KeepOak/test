import { z } from "zod";
import type { Store } from "../store.js";
import { unsetRecord } from "../ship-on.js";
import { orchardTools } from "../orchard/model.js";

/**
 * Bucket R17-H: flows and boards. Each part has the owner's three-way switch — off, when needed, on —
 * kept in a settings record of its own. What each ships as is `boardShipsOn` below; a saved record that
 * cannot be read is off.
 *
 *   off          the part refuses in one plain sentence, and its tools are not in the catalog at all
 *   when-needed  it works, and its tools are a line in the index until the work calls for them
 *   on           it works, and its tools are loaded from the first round
 *
 * The mode schema is written out here, as src/asks/settings.ts does, because feature-switches.ts
 * reads these same records and the two must not import each other.
 */
export const boardParts = [
  "time-travel", "recipe-checks", "kanban", "widgets", "waiting-line", "focus", "install-requests",
] as const;
export type BoardPart = (typeof boardParts)[number];
export const BoardPartSchema = z.enum(boardParts);

export const BoardModeSchema = z.enum(["off", "when-needed", "on"]);
export type BoardMode = z.infer<typeof BoardModeSchema>;
const RecordSchema = z.object({ mode: BoardModeSchema.default("off") }).strict();

export const boardKey = (part: BoardPart): string => `flowboards-${part}`;

/**
 * What each part is while nothing has been saved for it. The owner's rule (ships on, 2026-09-26): each of these only
 * rearranges, checks or shows the owner's own work on this computer, and anything that would run asks first under its
 * own rules; none of (a)–(f). Install requests too (2026-09-27): nothing installs itself and only the owner answers; the
 * one lookup sends a public package name to the public malware list. A saved record that is damaged still reads as off.
 */
export const boardShipsOn: Partial<Record<BoardPart, BoardMode>> = {
  ...Object.fromEntries(boardParts.map((part) => [part, "when-needed"])),
  // Orchard (src/orchard, the owner's rule, 2026-09-27: ships on). The reason it was kept off is met: every Orchard tool
  // declares what it touches (reach "local", target "orchard:<board or card>"). It pulls only cards the owner posted or
  // said yes to, never while Lockdown is on or its Trunk is paused, and each runs under the owner's approval rules exactly
  // as they are; none of (a)–(f). "When needed" like the rest: it works, and its tools wait in the index until a task
  // calls for them, so no task carries them from its first round.
  kanban: "when-needed",
};

/** What each part is, in the owner's words, for the cards and for a refusal. */
export const boardLabels: Record<BoardPart, string> = {
  "time-travel": "Going back to an earlier step of a flow",
  "recipe-checks": "Checks, clean-up and retries for saved procedures",
  kanban: "Orchard, the task board your Trunks work from",
  widgets: "Live widgets the assistant builds",
  "waiting-line": "Changing the waiting line, and what happens when you type while it works",
  focus: "Focus view",
  "install-requests": "Requests for new packages and tool servers",
};

/** The tools each part owns, so the catalog can leave them out while the part is off. */
export const boardTools: Record<BoardPart, readonly string[]> = {
  "time-travel": ["flow.steps"],
  "recipe-checks": ["procedures.replay_checked"],
  kanban: orchardTools,
  widgets: ["widgets.list", "widgets.propose"],
  "waiting-line": [],
  focus: [],
  "install-requests": ["install.request", "install.requests"],
};

/** For src/feature-switches.ts: each part with tools — its settings record, why it is loaded, and its tools. */
export const boardToolFeatures: readonly (readonly [string, string, readonly string[], BoardMode])[] = boardParts
  .filter((part) => boardTools[part].length > 0)
  .map((part) => [boardKey(part), `${boardLabels[part].charAt(0).toLowerCase()}${boardLabels[part].slice(1)} is switched on`, boardTools[part], boardShipsOn[part] ?? "off"] as const);

export function boardMode(store: Pick<Store, "get">, owner: string, part: BoardPart): BoardMode {
  const found = store.get("settings", owner, boardKey(part));
  if (unsetRecord(found?.data)) return boardShipsOn[part] ?? "off";
  const saved = RecordSchema.safeParse(found?.data ?? {});
  return saved.success ? saved.data.mode : "off";
}

export function saveBoardMode(store: Store, owner: string, part: BoardPart, input: unknown): BoardMode {
  const { mode } = RecordSchema.parse(input);
  store.save("settings", owner, boardKey(part), { mode });
  return mode;
}

/**
 * Integration review: a switch changed from a settings file (src/settings-kit/catalogue.ts) goes through
 * the running copy's `setMode`, so the part's tools come and go with it. Without a running copy (a
 * store opened on its own) the record is written as it is.
 */
const switchers = new WeakMap<object, (part: BoardPart, input: unknown) => BoardMode>();
export function followBoardSwitches(store: object, setMode: (part: BoardPart, input: unknown) => BoardMode): void {
  switchers.set(store, setMode);
}
export function writeBoardSwitch(store: Store, owner: string, part: BoardPart, patch: Record<string, unknown>): void {
  const next = { mode: boardMode(store, owner, part), ...patch };
  const setMode = switchers.get(store);
  if (setMode) setMode(part, next); else saveBoardMode(store, owner, part, next);
}

export class BoardOffError extends Error {
  override name = "BoardOffError";
}

export const offSentence = (part: BoardPart): string =>
  `${boardLabels[part]} is switched off. The owner can switch it on in Branch.`;

/** Throws the one plain sentence a switched-off part answers with. */
export function requirePart(store: Pick<Store, "get">, owner: string, part: BoardPart): void {
  if (boardMode(store, owner, part) === "off") throw new BoardOffError(offSentence(part));
}

/** A part's own settings record (not its switch), read through a schema with defaults. */
export function partRecord<T>(store: Pick<Store, "get">, owner: string, key: string, schema: z.ZodType<T>): T {
  const saved = schema.safeParse(store.get("settings", owner, key)?.data ?? {});
  return saved.success ? saved.data : schema.parse({});
}

/** One line of somebody else's text made safe to show or to put in a prompt: no line breaks, capped. */
export function oneLine(text: string, max = 300): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
