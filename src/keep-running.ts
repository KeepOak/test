import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.js";
import { defaultGatewayConfig, gatewayFile, saveGatewayConfig } from "./never-break/gateway-config.js";
import { chosenFields } from "./ship-on.js";
import type { FirstStartCheck } from "./install/update-backup.js";

/**
 * The owner's ship-on rule (2026-09-26): a feature ships on unless it spends money, sends something out on its own,
 * deletes, uses the microphone or camera, uses heavy CPU, or loosens approvals or safety. Keeping Branch running is
 * none of those, so a new install has it on without a setup step (setup used to switch it on in "Keep it running"):
 *   - the gateway (src/never-break/): its settings file is written with the switch on, unless one is already there;
 *   - starting at sign-in: the installed app registers itself (`startAtSignIn`, POST /api/deployment/autostart's own
 *     work), when this computer can.
 * Updating by itself is not written here: it ships on in the settings themselves (src/comfort/settings.ts
 * `comfortShipsOn`, #467), on Stable, with every choice the owner made kept (src/ship-on.ts).
 *
 * Only the installed app does this (a source checkout has no program to register), once, and only for an install that
 * has never been set up at all (no setup record saved): an owner who started setup, even without finishing it, may
 * already have made these choices in its old Keep it running step. It is written down in the owner's settings
 * (`shippedKey`), so what the owner turns off afterwards (Overview's Finish setting up, or Settings) stays off.
 *
 * Starting at sign-in leaves no trace of an owner's "off" on the computer itself (a missing sign-in entry looks the same
 * as one never made), so it is registered only for a brand-new install: never when an earlier version of Branch already
 * ran here (`first-start.json`, read before this start rewrites it), and never when the owner has set it themselves
 * (POST /api/deployment/autostart writes that down in the ship-on book, `autostartChoiceKey`).
 */
export const shippedKey = "keep-running-shipped";
/** Where the owner's own start-at-sign-in choice is written down (src/ship-on.ts markChosen). */
export const autostartChoiceKey = "deployment-autostart";

export interface KeepRunningShip {
  store: Store;
  owner: string;
  dataDir: string;
  /** Registers starting at sign-in; answers false when this computer cannot. */
  startAtSignIn: () => Promise<boolean>;
  /** This version, and how the first start of each version went as it was before this start (src/install/update-backup.ts). */
  version: string;
  firstStart: FirstStartCheck | null;
}

/** Whether a version of Branch other than this one has run on this computer before. */
const ranBefore = (check: FirstStartCheck | null, version: string): boolean =>
  check !== null && (check.version !== version || check.previousVersion !== null);

export async function shipKeepRunningOn(input: KeepRunningShip): Promise<void> {
  const { store, owner, dataDir } = input;
  if (store.get("settings", owner, shippedKey)) return;
  const fresh = !store.get("settings", owner, "onboarding");
  if (fresh && !existsSync(join(dataDir, gatewayFile))) await saveGatewayConfig(dataDir, { ...defaultGatewayConfig(), mode: "on" });
  const chose = chosenFields(store, owner, autostartChoiceKey).includes("enabled");
  const signIn = fresh && !chose && !ranBefore(input.firstStart, input.version) ? await input.startAtSignIn() : false;
  store.save("settings", owner, shippedKey, { at: new Date().toISOString(), fresh, signIn });
}
