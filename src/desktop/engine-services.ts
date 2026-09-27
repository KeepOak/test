import { app, BrowserWindow, safeStorage, screen, utilityProcess, type UtilityProcess } from "electron";
import { constants, setPriority } from "node:os";
import { join } from "node:path";
import { FileTokenVault } from "../chatgpt-auth.js";
import { electronBannerWindow } from "./banner-window.js";
import { macLoginItem } from "./login-item.js";
import type { EngineBrokerOptions } from "./engine-broker.js";

/** The same device-key protection and Stop notice for an engine owned by a window or a detached gateway. */
export function desktopEngineServices(base: string): Pick<EngineBrokerOptions, "vault" | "banner" | "loginItem"> {
  return {
    vault: new FileTokenVault(join(base, "chatgpt-auth.json"), {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    }),
    banner: electronBannerWindow({ create: (options) => new BrowserWindow(options), workArea: () => screen.getPrimaryDisplay().workArea }),
    loginItem: app.isPackaged && process.platform === "darwin" ? macLoginItem(app) : null,
  };
}

/** Stock Electron's utility process, below normal priority; no separate executable is built or renamed. */
export function forkDesktopEngine(file: string): UtilityProcess {
  const child = utilityProcess.fork(file, [], { serviceName: "Branch Agent engine", stdio: "inherit" });
  child.once("spawn", () => {
    try { if (child.pid) setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL); }
    catch (error) { console.error("Engine priority:", (error as Error).message); }
  });
  return child;
}
