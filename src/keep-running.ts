import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Store } from "./store.js";
import { defaultGatewayConfig, gatewayFile, saveGatewayConfig } from "./never-break/gateway-config.js";
import { onboardingRecord } from "./onboarding.js";
import { readComfort, saveComfort } from "./comfort/settings.js";

/**
 * The owner's ship-on rule (2026-09-26): a feature ships on unless it spends money, sends something out on its own,
 * deletes, uses the microphone or camera, uses heavy CPU, or loosens approvals or safety. Keeping Branch running is
 * none of those, so a new install has it on without a setup step (setup used to switch it on in "Keep it running"):
 *   - the gateway (src/never-break/): its settings file is written with the switch on, unless one is already there;
 *   - starting at sign-in: the installed app registers itself (`startAtSignIn`, POST /api/deployment/autostart's own
 *     work), when this computer can;
 *   - updating by itself: notify.autoUpdate "install" (src/comfort/settings.ts), the updater's own safety copy and
 *     wait-until-idle included. Only the installed app updates, so it is switched on here, not in the card's default.
 *
 * Only the installed app does this (a source checkout has no program to register), once, the first time it starts
 * before setup is done: an install whose setup is already done made its own choices. It is written down in the
 * owner's settings (`shippedKey`), so what the owner turns off afterwards (Overview's Finish setting up, or Settings)
 * stays off.
 */
export const shippedKey = "keep-running-shipped";

export interface KeepRunningShip {
  store: Store;
  owner: string;
  dataDir: string;
  /** Registers starting at sign-in; answers false when this computer cannot. */
  startAtSignIn: () => Promise<boolean>;
}

export async function shipKeepRunningOn(input: KeepRunningShip): Promise<void> {
  const { store, owner, dataDir } = input;
  if (store.get("settings", owner, shippedKey)) return;
  const fresh = !onboardingRecord(store, owner).done;
  if (fresh && !existsSync(join(dataDir, gatewayFile))) await saveGatewayConfig(dataDir, { ...defaultGatewayConfig(), mode: "on" });
  if (fresh && readComfort(store, owner, "notify").autoUpdate === "off") saveComfort(store, owner, "notify", { autoUpdate: "install" });
  const signIn = fresh ? await input.startAtSignIn() : false;
  store.save("settings", owner, shippedKey, { at: new Date().toISOString(), fresh, signIn });
}
