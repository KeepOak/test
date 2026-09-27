import { z } from "zod";
import type { Store } from "../store.js";
import { lockdownOverrides } from "../lockdown.js"; // mac7/lockdown-fix

/**
 * Bucket R17-B: "it suggests, and runs things on its own". Each part has the owner's three-way
 * switch — off, when needed, on — kept in a settings record of its own. What each ships as is
 * `autonomyShipsOn` below; a saved record that cannot be read is off.
 *
 *   off          the part refuses in one plain sentence; its tools are not in the catalog at all, and
 *                nothing of it runs by itself
 *   when-needed  it works; its tools are a line in the index, and what it adds to a task's
 *                instructions is one line saying where to read the rest
 *   on           it works; its tools are loaded from the first round, and its instructions are given
 *                in full
 *
 * The mode schema is written out here, as src/asks/settings.ts does, because feature-switches.ts
 * reads these same records and the two must not import each other.
 */
export const autonomyParts = [
  "suggestions", "orders", "loops", "session-commands", "procedures", "readiness", "instructions",
] as const;
export type AutonomyPart = (typeof autonomyParts)[number];
export const AutonomyPartSchema = z.enum(autonomyParts);

export const AutonomyModeSchema = z.enum(["off", "when-needed", "on"]);
export type AutonomyMode = z.infer<typeof AutonomyModeSchema>;
const RecordSchema = z.object({ mode: AutonomyModeSchema.default("off") }).strict();

export const autonomyKey = (part: AutonomyPart): string => `autonomy-${part}`;

/** What each part is while nothing has been saved for it. A saved record that is damaged still reads as off. */
export const autonomyShipsOn: Partial<Record<AutonomyPart, AutonomyMode>> = {
  // The owner's rule (ships on, 2026-09-26): suggestions are worked out on this computer without a model and only offered; none of (a)–(f).
  suggestions: "when-needed",
  // The owner's rule (ships on, 2026-09-26): an order exists only once the owner makes or accepts one, bounded and held by the approval rules; none of (a)–(f).
  orders: "when-needed",
  // The owner's rule (ships on, 2026-09-26): /loop and /heartbeat start only when the owner types them, and every turn is bounded; none of (a)–(f).
  loops: "when-needed",
  // The owner's rule (ships on, 2026-09-26): the readiness check only looks at PATH and secret names, never runs or reads a value; none of (a)–(f).
  readiness: "when-needed",
  // The owner's rule (ships on, 2026-09-26): a "from now on" instruction is kept only after the owner says yes; none of (a)–(f).
  instructions: "when-needed",
  // Kept off, by the owner's rule (off for spending, sending, outside access, heavy disk): session-commands sends the conversation out (/handoff); procedures run steps without a yes at "auto".
};

/** What each part is, in the owner's words, for the card and for a refusal. */
export const autonomyLabels: Record<AutonomyPart, string> = {
  suggestions: "Suggested automations",
  orders: "Standing orders",
  loops: "Repeating in a conversation (/loop and /heartbeat)",
  "session-commands": "Sub-goals, background tasks and handing a conversation on (/subgoal, /bg, /handoff)",
  procedures: "Procedures that start themselves",
  readiness: "Checking what skills need before they are used",
  instructions: "\"From now on\" instructions",
};

/** The tools each part owns. None of them creates anything lasting: they read, or they ask the owner. */
export const autonomyTools: Record<AutonomyPart, readonly string[]> = {
  suggestions: ["automation.ideas", "automation.propose"],
  orders: ["orders.list", "orders.propose"],
  loops: [],
  "session-commands": [],
  procedures: ["procedures.auto.list", "procedures.auto.propose"],
  readiness: ["skills.readiness"],
  instructions: ["instructions.list", "instructions.propose"],
};

/** For src/feature-switches.ts: each part with tools — its settings record, why it is loaded, and its tools. */
export const autonomyToolFeatures: readonly (readonly [string, string, readonly string[], AutonomyMode])[] = autonomyParts
  .filter((part) => autonomyTools[part].length > 0)
  .map((part) => [autonomyKey(part), `${autonomyLabels[part].replace(/^"|"/g, "").toLowerCase()} is switched on`, autonomyTools[part], autonomyShipsOn[part] ?? "off"] as const);

export function autonomyMode(store: Pick<Store, "get">, owner: string, part: AutonomyPart): AutonomyMode {
  if (lockdownOverrides(store, owner, autonomyKey(part))) return "off"; // mac7/lockdown-fix
  const found = store.get("settings", owner, autonomyKey(part));
  if (!found) return autonomyShipsOn[part] ?? "off";
  const saved = RecordSchema.safeParse(found.data ?? {});
  return saved.success ? saved.data.mode : "off";
}

export function saveAutonomyMode(store: Store, owner: string, part: AutonomyPart, input: unknown): AutonomyMode {
  const { mode } = RecordSchema.parse(input);
  store.save("settings", owner, autonomyKey(part), { mode });
  return mode;
}

export class AutonomyOffError extends Error {
  override name = "AutonomyOffError";
}

export const offSentence = (part: AutonomyPart): string =>
  `${autonomyLabels[part]} is switched off. The owner can switch it on in Branch, under Automations.`;

/** Throws the one plain sentence a switched-off part answers with. */
export function requirePart(store: Pick<Store, "get">, owner: string, part: AutonomyPart): void {
  if (autonomyMode(store, owner, part) === "off") throw new AutonomyOffError(offSentence(part));
}

/**
 * The bounds on everything that runs by itself, whichever part started it. A turn past a bound is
 * not run and says why; nothing here can be raised past the hard ceilings.
 */
const limitFields = {
  /** Turns all these parts together may start in one day. */
  runsPerDay: z.number().int().min(1).max(200),
  /** Steps (model rounds) one turn may take. */
  stepsPerTurn: z.number().int().min(1).max(40),
  /** Tokens one turn may spend. */
  tokensPerTurn: z.number().int().min(1000).max(200_000),
};
export const LimitsSchema = z.object({
  runsPerDay: limitFields.runsPerDay.default(48),
  stepsPerTurn: limitFields.stepsPerTurn.default(12),
  tokensPerTurn: limitFields.tokensPerTurn.default(40_000),
}).strict();
/** Only the limits that were sent; a zod `.partial()` would fill the others with their defaults. */
const LimitsChange = z.object({
  runsPerDay: limitFields.runsPerDay.optional(),
  stepsPerTurn: limitFields.stepsPerTurn.optional(),
  tokensPerTurn: limitFields.tokensPerTurn.optional(),
}).strict();
export type Limits = z.infer<typeof LimitsSchema>;
const limitsKey = "autonomy-limits";

export function autonomyLimits(store: Pick<Store, "get">, owner: string): Limits {
  const saved = LimitsSchema.safeParse(store.get("settings", owner, limitsKey)?.data ?? {});
  return saved.success ? saved.data : LimitsSchema.parse({});
}

export function saveAutonomyLimits(store: Store, owner: string, input: unknown): Limits {
  const sent = LimitsChange.parse(input);
  const next = LimitsSchema.parse({ ...autonomyLimits(store, owner), ...Object.fromEntries(Object.entries(sent).filter(([, v]) => v !== undefined)) });
  store.save("settings", owner, limitsKey, { ...next });
  return next;
}

/** One line of untrusted text made safe to quote inside a prompt: no line breaks, spaces squeezed, capped. */
export function quoteLine(text: string, max = 300): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
