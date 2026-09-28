import { readCredentialSettings } from "./credential-cli.js";
import type { FeatureMode } from "./feature-switches.js";
import { chosenFields } from "./ship-on.js";
import type { Store } from "./store.js";

/**
 * RES-710: how filling a saved sign-in ships, under the owner's rule (src/ship-on.ts). It touches credentials, so it
 * is off until the owner connects a password manager (Settings → Saved sign-ins: the switch on, and a manager
 * chosen). Once one is connected it is on, and says why: "on because your vault is connected". A choice the owner
 * made on the switch itself is always kept, off included.
 *
 * Its own file so src/feature-switches.ts and src/vault-autofill.ts can both read it without importing each other.
 */
export const vaultAutofillKey = "vault-autofill";

type Reader = Pick<Store, "get">;

/** Whether the owner connected a password manager Branch may read from. */
export function vaultConnected(store: Reader, owner: string): boolean {
  const settings = readCredentialSettings(store as Store, owner);
  return settings.enabled && settings.services.length > 0;
}

/** What the switch reads as while the owner has not set it: on once a vault is connected, off before. */
export function vaultAutofillShipsAs(store: Reader, owner: string): FeatureMode {
  return vaultConnected(store, owner) ? "on" : "off";
}

/** Why it is on without the owner having switched it on, in their words; null when they chose, or it is off. */
export function vaultAutofillOnBecause(store: Reader, owner: string, mode: FeatureMode): string | null {
  if (mode === "off" || chosenFields(store, owner, vaultAutofillKey).some((field) => field === "mode" || field === "enabled")) return null;
  return vaultConnected(store, owner) ? "on because your vault is connected" : null;
}
