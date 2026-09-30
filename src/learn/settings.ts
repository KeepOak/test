import { z } from "zod";
import type { Store } from "../store.js";
import { markChosen, sentKeys, shippedUnlessChosen } from "../ship-on.js";

/**
 * mac7/learn: the owner's three-way switch for "Understanding something", and its one limit.
 *
 * It ships "when needed" (the owner's ship-on rule, src/ship-on.ts): off means /learn and its tools
 * refuse in one plain sentence and are not advertised; when needed means they are a line in the index
 * until the work calls for them; on means they are loaded from the first round.
 *
 * This file imports nothing from Branch but the store type, so src/feature-switches.ts can read it
 * without an import loop -- which is why the three modes are written out here rather than taken
 * from that file. They are the same three, and src/feature-switches.ts is where they are explained.
 */
const ModeSchema = z.enum(["off", "when-needed", "on"]);
export type LearnMode = z.infer<typeof ModeSchema>;
export const learnKey = "learn";
export const learnLabel = "Understanding something";

export const LearnSettingsSchema = z.object({
  /** off, when needed, or on. Read through `learnSettings`, which gives the shipped mode unless the owner chose one. */
  mode: ModeSchema.default("off"),
  /** How many stops a tour may have. Seven to twelve is as much as anybody holds in one go. */
  steps: z.number().int().min(3).max(12).default(8),
}).strict();
export type LearnSettings = z.infer<typeof LearnSettingsSchema>;

/** The tools this feature owns, so they are not advertised while it is off. */
export const learnTools = ["learn.map", "learn.tour", "learn.cost"] as const;
/** For src/feature-switches.ts: the record, why the tools are loaded, and the tools. */
export const learnToolFeatures: readonly (readonly [string, string, readonly string[]])[] = [
  [learnKey, "understanding something is switched on", learnTools],
];

type Reader = Pick<Store, "get">;

/** The owner's rule (ships on, 2026-09-26): a map and a tour of the owner's own project, made only when asked; none of (a)–(f). */
export const learnShipsAs: LearnMode = "when-needed";

export function learnSettings(store: Reader, owner: string): LearnSettings {
  const saved = LearnSettingsSchema.safeParse(store.get("settings", owner, learnKey)?.data ?? {});
  if (!saved.success) return LearnSettingsSchema.parse({});
  return shippedUnlessChosen(store, owner, learnKey, saved.data, { mode: learnShipsAs });
}
export const learnMode = (store: Reader, owner: string): LearnMode => learnSettings(store, owner).mode;

export function saveLearnSettings(store: Store, owner: string, input: unknown): LearnSettings {
  const value = LearnSettingsSchema.parse({ ...learnSettings(store, owner), ...(input && typeof input === "object" ? input : {}) });
  store.save("settings", owner, learnKey, value);
  markChosen(store, owner, learnKey, sentKeys(input));
  return value;
}

export class LearnOffError extends Error {
  override name = "LearnOffError";
}
/** The one plain sentence a switched-off feature answers with, the way every other part does. */
export function requireLearn(store: Reader, owner: string): void {
  if (learnMode(store, owner) === "off")
    throw new LearnOffError(`${learnLabel} is switched off. The owner can switch it on in Branch.`);
}
