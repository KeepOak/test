import type { FeatureMode } from "./feature-switches.js";
import type { Store } from "./store.js";
import { unsetRecord } from "./ship-on.js";

/**
 * The sdk.* tools' switch on its own, so the settings kit can read it without loading the tools (src/sdk-kit.ts).
 *
 * The owner's ship-on rule (defaults audit, 2026-09-28): the sdk.* tools only read Branch's own route list and write
 * example code; "when needed" keeps them a line in the index until a task asks. None of (a)–(f), so they ship on. A saved
 * switch is the owner's own (a record that holds only it is only written by moving it); one that can't be read is off.
 */
const sdkKitSettingsKey = "sdk-kit"; // src/sdk-kit.ts saves it
export const sdkKitShipsAs: FeatureMode = "when-needed";
const modes: readonly string[] = ["off", "when-needed", "on"];

export function sdkKitMode(store: Pick<Store, "get">, owner: string): FeatureMode {
  const found = store.get("settings", owner, sdkKitSettingsKey);
  if (!found || unsetRecord(found.data)) return sdkKitShipsAs;
  const mode = (found.data as { mode?: unknown } | undefined)?.mode;
  return typeof mode === "string" && modes.includes(mode) ? mode as FeatureMode : "off";
}
