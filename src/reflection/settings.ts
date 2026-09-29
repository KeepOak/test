import { z } from "zod";
import { optionalFields } from "../feature-switches.js"; // Q65
import type { Store } from "../store.js";
import { markChosen, savedFields, shippedUnlessChosen } from "../ship-on.js";

/**
 * The owner's two switches for memory and skills that keep themselves in shape. Both ship off.
 *
 * Looking back (`reflection`):
 * - `off`: nothing runs.
 * - `when-needed`: a conversation is looked back over only when it is about to be shortened (the
 *   moment older turns would otherwise be summarised away), or when the owner asks.
 * - `on`: also every `everyTurns` turns of a conversation.
 *
 * Writing new skills (`newSkills`):
 * - `off`: nothing is drafted, and asking for one says the switch is off.
 * - `when-needed`: a skill is drafted only when asked — "make this into a skill", the button, or
 *   accepting a skill idea — and the assistant sees one short tool for the first of those.
 * - `on`: also a look back may suggest one. (A skill is never drafted after a task just because it used
 *   several tools; the Gardener's four triggers decide that, src/seasons/triggers.ts.)
 *
 * Whatever the positions, nothing is written or switched on without the owner saying yes.
 *
 * The trigger model (off / every N steps / on compaction, default 25) follows Letta Code's
 * `reflection-settings.ts` (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
export const SwitchSchema = z.enum(["off", "when-needed", "on"]);
export type SwitchPosition = z.infer<typeof SwitchSchema>;
export const ReflectionSettingsSchema = z.object({
  reflection: SwitchSchema.default("off"),
  /** With looking back on, how many of the owner's turns pass between two looks at a conversation. */
  everyTurns: z.number().int().min(5).max(500).default(25),
  newSkills: SwitchSchema.default("off"),
  /** A skill nobody has used for this many days is offered for setting aside (never removed). */
  retireAfterDays: z.number().int().min(7).max(365).default(60),
}).strict();
export type ReflectionSettings = z.infer<typeof ReflectionSettingsSchema>;

const settingsKey = "reflection";
/**
 * The owner's rule (ships on, 2026-09-26): "when needed" drafts a new skill only when the owner asks; none of (a)–(f). Looking back
 * stays off: it asks the model at every compaction by itself (a).
 */
export const reflectionShipsOn: Partial<ReflectionSettings> = { newSkills: "when-needed" };

export function reflectionSettings(store: Store, owner: string): ReflectionSettings {
  const saved = ReflectionSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? shippedUnlessChosen(store, owner, settingsKey, saved.data, reflectionShipsOn) : ReflectionSettingsSchema.parse({});
}

/**
 * Saves the switches; a field left out keeps its saved value. Q65: read through `optionalFields`, not
 * `.partial()`, which in zod 4 fills each field left out with its default (turning looking back on used
 * to put the other switch and both numbers back to how they started).
 */
export function saveReflectionSettings(store: Store, owner: string, input: unknown): ReflectionSettings {
  const patch = optionalFields(ReflectionSettingsSchema).parse(input ?? {});
  const before = store.get("settings", owner, settingsKey)?.data;
  const value = ReflectionSettingsSchema.parse({ ...reflectionSettings(store, owner), ...patch });
  store.save("settings", owner, settingsKey, { ...value });
  // Over an unreadable record both switches read off; writing them down keeps them off (src/ship-on.ts savedFields).
  markChosen(store, owner, settingsKey, savedFields(before, ReflectionSettingsSchema.safeParse(before ?? {}).success, patch, reflectionShipsOn));
  return value;
}
