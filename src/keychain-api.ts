import { linuxSession, notificationSettingsLinks, type LinuxSession } from "./os-permissions.js";
import type { Store } from "./store.js";
import { keychainReference, readKeychainSettings, saveKeychainSettings, type KeychainSettings } from "./vault-sources.js";
import { byCard, recordedWrite } from "./settings-kit/recorded-write.js"; // Q48

/**
 * Settings → "Passwords from your Mac's Keychain": which Keychain entries Branch may read. Only the
 * names the owner typed travel here (a short name, the item's service and account); a password
 * never does, because nothing in this route ever asks the Keychain anything. Off until turned on.
 */
export const keychainSettingsPath = "/api/keychain/settings";

export interface KeychainScreen extends KeychainSettings {
  /** Whether this computer has a Keychain at all; the form says so plainly when it does not. */
  available: boolean;
  /** The reference to write for each entry, for example `secret://keychain/github`. */
  references: Record<string, string>;
}

function screen(settings: KeychainSettings, platform: string): KeychainScreen {
  const references = Object.fromEntries(settings.entries.map((entry) => [entry.name, keychainReference(entry.name)]));
  return { ...settings, available: platform === "darwin", references };
}

/** GET shows the list, POST saves it through the same checks and record as every other source. */
export async function keychainApi(
  store: Store, owner: string, method: string, body: () => Promise<unknown>, platform: string = process.platform,
): Promise<KeychainScreen> {
  if (method === "GET") return screen(readKeychainSettings(store, owner), platform);
  if (method === "POST") {
    const input = await body();
    return screen(recordedWrite(store, owner, byCard("keychain-entries"), ["keychain-entries"], () => saveKeychainSettings(store, owner, input)), platform);
  }
  throw new Error("That is not something Branch can do with the Keychain list");
}

/**
 * What the permissions card needs beside the list itself: which kind of computer this is, and on
 * Linux which desktop session is running, since that is what decides whether the screen can be used.
 */
export function permissionsContext(
  platform: string = process.platform, env: NodeJS.ProcessEnv = process.env,
): { platform: string; session?: LinuxSession; notificationsLink: string } {
  const notificationsLink = notificationSettingsLinks[platform] ?? "";
  return platform === "linux" ? { platform, session: linuxSession(env), notificationsLink } : { platform, notificationsLink };
}
