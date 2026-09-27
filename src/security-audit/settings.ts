import { z } from "zod";
import type { Store } from "../store.js";
import { markChosen, savedFields, shippedUnlessChosen } from "../ship-on.js";

/**
 * The two switches of the security self-check. Both ship "when needed" (`securityCheckShipsOn`).
 *
 * `audit` — off: the check runs only when you ask for it (the button, or `branch security audit`).
 * When needed: the assistant also has one read-only tool, `settings.security_check`, and uses it when
 * the work calls for it ("is my setup safe?"). On: the check also runs by itself each time Branch
 * starts, so the Settings card opens on a fresh answer.
 *
 * `malware` — off: nothing is looked up. When needed: a package an outside server is fetched from is
 * looked up in the public malware list the first time Branch starts it, and the answer is kept for a
 * week. On: it is looked up again whenever the last answer is more than an hour old.
 */
const mode = z.enum(["off", "when-needed", "on"]);
export const SecurityCheckSettingsSchema = z.object({
  audit: mode.default("off"),
  malware: mode.default("off"),
}).strict();
export type SecurityCheckSettings = z.infer<typeof SecurityCheckSettingsSchema>;

const settingsKey = "security-check";
/**
 * The owner's rule (ships on, 2026-09-26): the self-check only reads this computer's own settings; none of (a)–(f). The malware lookup
 * too (2026-09-27): it only tightens, and it sends nothing but the public name of a package the owner's own tool server is
 * already fetching from its registry, to the public malware list; nothing of the owner's goes to anyone.
 */
export const securityCheckShipsOn: Partial<SecurityCheckSettings> = { audit: "when-needed", malware: "when-needed" };

export function securityCheckSettings(store: Store, owner: string): SecurityCheckSettings {
  const saved = SecurityCheckSettingsSchema.safeParse(store.get("settings", owner, settingsKey)?.data ?? {});
  return saved.success ? shippedUnlessChosen(store, owner, settingsKey, saved.data, securityCheckShipsOn) : SecurityCheckSettingsSchema.parse({});
}

/** Saves either switch; the one left out keeps its value. */
export function saveSecurityCheckSettings(store: Store, owner: string, input: unknown): SecurityCheckSettings {
  const before = store.get("settings", owner, settingsKey)?.data;
  const next = SecurityCheckSettingsSchema.parse({ ...securityCheckSettings(store, owner), ...(input as object ?? {}) });
  store.save("settings", owner, settingsKey, { ...next });
  markChosen(store, owner, settingsKey, savedFields(before, SecurityCheckSettingsSchema.safeParse(before ?? {}).success, input, securityCheckShipsOn));
  return next;
}
