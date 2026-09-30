import { z } from "zod";
import type { Store } from "../store.js";
import { shippedUnlessChosen } from "../ship-on.js";

/**
 * The owner's three-way switch for the learning core. It ships "when needed" (the owner's ship-on rule, src/ship-on.ts).
 *
 * - `off`: nothing runs and nothing is stored; the core's tables are not even created.
 * - `when-needed`: finished tasks are still learned from (it costs no model call), but nothing is
 *   worked out as a task starts. The model sees one short tool, `learning.suggest`, and asks it
 *   only when the work calls for it, the same way other tools wait in the catalog until needed
 *   (src/tool-loading.ts).
 * - `on`: every task also has its suggestions worked out and written down as it starts.
 */
export const FlyCoreSettingsSchema = z.object({
  mode: z.enum(["off", "when-needed", "on"]).default("off"),
}).strict();
export type FlyCoreSettings = z.infer<typeof FlyCoreSettingsSchema>;
export type FlyCoreMode = FlyCoreSettings["mode"];

const settingsKey = "fly-core";
export const suggestToolName = "learning.suggest";

// The owner's rule (ships on, 2026-09-26): it learns from finished tasks on this computer and costs no model call; none of (a)–(f).
export const flyCoreShipsAs: FlyCoreMode = "when-needed";

export function flyCoreSettings(store: Store, owner: string): FlyCoreSettings {
  const saved = FlyCoreSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? shippedUnlessChosen(store, owner, settingsKey, saved.data, { mode: flyCoreShipsAs }) : FlyCoreSettingsSchema.parse({});
}

/** Saves the switch. src/fly-core/tool.ts `setFlyCoreMode` also adds or removes the tool. */
export function saveFlyCoreSettings(store: Store, owner: string, input: unknown): FlyCoreSettings {
  const value = FlyCoreSettingsSchema.parse(input);
  store.save("settings", owner, settingsKey, { ...value });
  return value;
}
