import { join } from "node:path";
import { defaultUninstallHive, shippedIconPath, uninstallKey } from "./installer.js";
import { readRegistryValue, writeRegistryValues } from "./windows.js";

/**
 * mac7/win-icon: what Windows needs to show the mascot for Branch instead of Electron's atom.
 *
 * The program file is the stock Electron one (scripts/package-desktop.mjs keeps it byte-for-byte so
 * Smart App Control recognises it), so its own icon is the atom. The taskbar takes a running app's
 * icon from the Start-menu shortcut that belongs to it, and 0.18.0 wrote shortcuts whose icon was
 * the program file itself: that is the atom the taskbar showed. Three things fix it for good:
 *  - one fixed app ID, set before any window, that the taskbar groups the windows under;
 *  - every shortcut to this copy of Branch names that ID and the mascot `.ico`;
 *  - the Add or remove programs entry names the `.ico` too.
 * Updates only swap the program folder, so the app itself puts the shortcuts right at every start;
 * the installer asks the freshly installed app to do the same once (only Electron can write the ID).
 */
export const windowsAppId = "KeepOak.BranchAgent";
export const shortcutName = "Branch Agent.lnk";
/** Started with this, the app puts its shortcuts right and quits without opening a window. */
export const refreshShortcutsFlag = "--refresh-shortcuts";

/** The fields of a shortcut this file reads and writes; Electron's `shell` uses the same names. */
export interface ShortcutFields {
  target: string;
  icon?: string;
  iconIndex?: number;
  appUserModelId?: string;
}

export interface IdentityDeps {
  /** Electron's `shell.readShortcutLink`; throws when the file is not there or is not a shortcut. */
  readShortcut: (path: string) => ShortcutFields;
  /** Electron's `shell.writeShortcutLink(path, "update", fields)`: only the named fields change. */
  updateShortcut: (path: string, fields: ShortcutFields) => boolean;
  exists: (path: string) => boolean;
  readRegistry?: typeof readRegistryValue;
  writeRegistry?: typeof writeRegistryValues;
}

export interface IdentityReport { updated: string[]; displayIcon: boolean }

/**
 * The Start-menu and desktop shortcuts the installer makes (src/install/install-cli.ts), and the one
 * Windows makes when a person pins Branch to the taskbar, which keeps its own copy of the icon.
 */
export function shortcutPaths(env: NodeJS.ProcessEnv): string[] {
  const appData = env.APPDATA ?? join(env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Roaming");
  const paths = [join(appData, "Microsoft", "Windows", "Start Menu", "Programs", shortcutName),
    join(appData, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar", shortcutName)];
  if (env.USERPROFILE) paths.push(join(env.USERPROFILE, "Desktop", shortcutName));
  return paths;
}

const samePath = (a: string, b: string) => a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

/**
 * What a shortcut to this copy should say, or null when it already says it. A shortcut that points at
 * another program (another copy of Branch, a portable one) is left exactly as it is.
 */
export function shortcutChanges(existing: ShortcutFields, executable: string, icon: string | null): ShortcutFields | null {
  if (!samePath(existing.target, executable)) return null;
  const wanted = { target: existing.target, appUserModelId: windowsAppId, ...(icon ? { icon, iconIndex: 0 } : {}) };
  const same = existing.appUserModelId === wanted.appUserModelId
    && (!icon || (samePath(existing.icon ?? "", icon) && (existing.iconIndex ?? 0) === 0));
  return same ? null : wanted;
}

/** Points this copy's shortcuts and its Add or remove programs entry at the mascot. */
export async function refreshWindowsIdentity(
  options: { installRoot: string; executableName: string; env: NodeJS.ProcessEnv; hive?: string }, deps: IdentityDeps,
): Promise<IdentityReport> {
  const executable = join(options.installRoot, options.executableName);
  const iconFile = join(options.installRoot, shippedIconPath);
  const icon = deps.exists(iconFile) ? iconFile : null;
  const updated: string[] = [];
  for (const path of shortcutPaths(options.env)) {
    if (!deps.exists(path)) continue;
    let existing: ShortcutFields;
    try { existing = deps.readShortcut(path); } catch { continue; }
    const changes = shortcutChanges(existing, executable, icon);
    if (changes && deps.updateShortcut(path, changes)) updated.push(path);
  }
  return { updated, displayIcon: icon ? await refreshDisplayIcon(options, icon, deps) : false };
}

/** Rewrites DisplayIcon, but only on the entry that belongs to this very install folder. */
async function refreshDisplayIcon(
  options: { installRoot: string; hive?: string }, icon: string, deps: IdentityDeps,
): Promise<boolean> {
  const key = uninstallKey(options.hive ?? defaultUninstallHive);
  const read = deps.readRegistry ?? readRegistryValue, write = deps.writeRegistry ?? writeRegistryValues;
  const location = await read(key, "InstallLocation");
  if (!location || !samePath(location, options.installRoot)) return false;
  const current = await read(key, "DisplayIcon");
  if (current && samePath(current, icon)) return false;
  await write(key, [{ name: "DisplayIcon", type: "REG_SZ", value: icon }]);
  return true;
}
