import { z } from "zod";
import { optionalFields } from "../feature-switches.js";
import type { Store } from "../store.js";

/**
 * Seasons: the whole self-improvement loop (work, then Rings overnight, then the Gardener, then better Trunks).
 * These are the owner's switches for it, kept in one settings record of the owner's own. A household person's
 * night runs under the owner's switches but only ever over that person's own work and memory.
 *
 * Ship-on rule: Rings ships on. It never spends money on its own (a): it answers only through a model on this
 * computer or a subscription sign-in, and a connection billed per call is used only once the owner turns
 * `paidModels` on. It never uses heavy CPU while the owner works (e): it runs inside the night window, only after
 * the owner has been away for `idleMinutes`, and it stops between steps the moment the owner starts a task.
 *
 * The three promotion gates follow OpenClaw's dreaming (minScore, minRecallCount, minUniqueQueries), all of which
 * must pass; see docs/seasons.md for what each one counts here.
 */
export const seasonsKey = "seasons";
export const SeasonsSettingsSchema = z.object({
  rings: z.enum(["off", "on"]).default("on"),
  /** The night window, in this computer's local hours: from `nightFrom` up to (not including) `nightTo`. */
  nightFrom: z.number().int().min(0).max(23).default(1),
  nightTo: z.number().int().min(0).max(23).default(6),
  /** How long nobody has started or worked a task before the night may begin. */
  idleMinutes: z.number().int().min(5).max(720).default(30),
  /** Ship-on (a): a connection billed per call is never used overnight unless the owner says so here. */
  paidModels: z.boolean().default(false),
  /** Deep-phase gates: every one must pass before a fact is kept for good. */
  minScore: z.number().min(0).max(1).default(0.6),
  minRecallCount: z.number().int().min(1).max(20).default(3),
  minUniqueQueries: z.number().int().min(1).max(20).default(2),
  /**
   * The Gardener (src/seasons/gardener.ts). It ships on: it drafts only from the owner's four triggers, on the same
   * free model and in the same quiet night, and adopts a skill only when replaying its tasks proves a gain.
   */
  gardener: z.enum(["off", "on"]).default("on"),
  /** The smallest proved gain (on a 0 to 1 grade) a new skill needs before it is adopted. */
  minGain: z.number().min(0.01).max(1).default(0.1),
  /** A skill the Gardener adopted and nothing used for this long is stale; after `archiveAfterDays` it is set aside. */
  staleAfterDays: z.number().int().min(1).max(365).default(14),
  archiveAfterDays: z.number().int().min(2).max(730).default(30),
  /** The cap is on context cost, not on count: what every adopted skill's one-line index entry may cost, in tokens. */
  indexBudget: z.number().int().min(50).max(4000).default(400),
  /** An adopted skill stays short: a longer draft is discarded. */
  maxSkillChars: z.number().int().min(400).max(8000).default(2400),
}).strict();
export type SeasonsSettings = z.infer<typeof SeasonsSettingsSchema>;

export function seasonsSettings(store: Pick<Store, "get">, owner: string): SeasonsSettings {
  const saved = SeasonsSettingsSchema.safeParse(store.get("settings", owner, seasonsKey)?.data ?? {});
  return saved.success ? saved.data : SeasonsSettingsSchema.parse({});
}

/** Saves the switches; a field left out keeps its saved value. */
export function saveSeasonsSettings(store: Pick<Store, "get" | "save">, owner: string, input: unknown): SeasonsSettings {
  const patch = optionalFields(SeasonsSettingsSchema).parse(input ?? {});
  const value = SeasonsSettingsSchema.parse({ ...seasonsSettings(store, owner), ...patch });
  store.save("settings", owner, seasonsKey, { ...value });
  return value;
}
