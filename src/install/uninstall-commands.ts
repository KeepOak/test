import { access } from "node:fs/promises";
import { win32 } from "node:path";
import { windowsAppsLink } from "../os-permissions.js";
import { unixLayout } from "./unix-install.js";

/**
 * Settings › Remove Branch: the exact line a person pastes to remove Branch themselves, with the real path of what
 * this copy's installer left behind. The window only shows and copies it; nothing here runs it.
 *
 * On Windows it is the uninstaller in the program's folder (`Uninstall Branch Agent.cmd`), started through `cmd /c`
 * so the same line works in Terminal, PowerShell, Command Prompt and the Run box. On a Mac or Linux it is the `branch`
 * command the installer wrote (`branch uninstall`). `--delete-data` removes conversations and files too; without it
 * they are always kept.
 */
export interface UninstallCommands {
  /** Keeps conversations and settings. */
  keep: string;
  /** Removes conversations and files as well. */
  deleteData: string;
  /** Windows' own page for removing a program (Add or remove programs), or "" where there is none. */
  settingsLink: string;
}

export const windowsUninstallerName = "Uninstall Branch Agent.cmd";
const deleteDataFlag = "--delete-data";

/* A character a pasted line would read as something other than part of the name: cmd's own specials (and `%`, which
   it expands), or on a Mac or Linux the quote that closes the path. Such a path is not offered as a line. */
const unsafeWindows = /["%!&<>()@^|]/;
const unsafeUnix = /['\n]/;

export interface UninstallCommandDeps {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => Promise<boolean>;
}
const fileExists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

/** The two lines for this computer, or null when this copy has nothing an installer put in place to run. */
export async function uninstallCommands(
  platform: NodeJS.Platform, installRoot: string | null, deps: UninstallCommandDeps = {},
): Promise<UninstallCommands | null> {
  const exists = deps.exists ?? fileExists;
  if (platform === "win32") {
    if (!installRoot) return null;
    const uninstaller = win32.join(installRoot, windowsUninstallerName);
    if (unsafeWindows.test(uninstaller) || !(await exists(uninstaller))) return null;
    const keep = `cmd /c "${uninstaller}" /quiet`;
    return { keep, deleteData: `${keep} ${deleteDataFlag}`, settingsLink: windowsAppsLink };
  }
  if (platform !== "darwin" && platform !== "linux") return null;
  const launcher = unixLayout(platform, deps.env ?? process.env).launcher;
  if (unsafeUnix.test(launcher) || !(await exists(launcher))) return null;
  const keep = `'${launcher}' uninstall`;
  return { keep, deleteData: `${keep} ${deleteDataFlag}`, settingsLink: "" };
}
