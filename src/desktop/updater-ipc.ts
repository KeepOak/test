import { app, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { diagnose } from "../diagnostic-log.js"; // mac7/diagnostics
import { launchHandOver } from "./hand-over.js";
import { join } from "node:path";
import { Updater, UpdateDeferredError, type UpdateChannel } from "./updater.js";
import { changedMind, type InstallStart, type UpdateReadiness } from "./update-readiness.js";
import { appEntryName, releaseAssetName } from "./release-assets.js";
import { installedAppRoot } from "./install-root.js";
import { macSettingsLinks } from "../os-permissions.js";
import { macLoginItemsLink } from "../install/autostart.js";
import { UpdateInstallClaim } from "./update-install-claim.js";
import { builtFrom } from "./build-identity.js";
import { primaryRepo } from "./repo-pair.js";

export const updateSource = {
  /* Tried first; the Updater falls back to the other name of the pair on a 404 (src/desktop/repo-pair.ts). */
  repo: primaryRepo,
  assetName: "Branch-Agent-windows-x64.zip",
  executableName: "Branch Agent.exe",
} as const;

// mac1/service-update: the download, program and folder for this computer. On Windows these come
// out as the same literals as above.
const platformSource = {
  repo: updateSource.repo,
  assetName: releaseAssetName(process.platform, process.arch),
  executableName: appEntryName(process.platform),
};
const signInPlace = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "your Mac" : "this computer";
const externalAllowed = ["https://auth.openai.com/", "https://github.com/stabrea/Branch-Agent", "https://github.com/KeepOak/Branch-Agent"];
// mac2/desktop-ui: the four System Settings pages the permissions card offers, matched exactly, and Login Items,
// where macOS asks the person to approve "Start when you log in".
const settingsPages = new Set<string>(process.platform === "darwin" ? [...Object.values(macSettingsLinks), macLoginItemsLink] : []);

/**
 * What this launch can do before an update: take the safety copy, and close the engine that keeps
 * working with the window closed. Both are supplied whether this window runs the engine itself or
 * joined one that was already working, so an update behaves the same either way.
 */
export interface UpdateHooks {
  /** Authenticated current channel and full task count from the local or joined engine. */
  readiness?: () => Promise<Pick<UpdateReadiness, "busyTasks" | "autoUpdate"> & { channel: UpdateChannel }>;
  backup: () => Promise<void>;
  stopDaemon?: () => Promise<number | null>;
  /** mac3/never-break: the new version's check on a copy of the data (see src/never-break/canary.ts). */
  canary?: (stagedDir: string, version: string) => Promise<void>;
  /**
   * mac7/safe-rollback: writes down what this update is about to change, before the hand-over moves
   * a single file, so it can be undone afterwards. It throws when it cannot be written, and the
   * update stops there — an update nobody can undo is not one worth making.
   */
  record?: (stagedDir: string, version: string) => Promise<void>;
}


export function registerUpdaterIpc(
  window: BrowserWindow, origin: string, version: string, requestQuit: () => void,
  hooks?: UpdateHooks,
): Updater {
  // Dogfood F1 (NAS): what the owner had chosen when the install under way began; the last gate reads it again.
  let started: InstallStart | null = null;
  const ensureIdle = async () => {
    if (!hooks?.readiness) throw new UpdateDeferredError("Branch cannot verify that work is idle, so the update is waiting.");
    const state = await hooks.readiness().catch(() => {
      throw new UpdateDeferredError("Branch cannot confirm that work is idle, so the update is waiting.");
    });
    if (state.busyTasks > 0) throw new UpdateDeferredError("An update is ready, but Branch will wait until every task finishes or is answered.");
    const why = changedMind(state, started);
    if (why) throw new UpdateDeferredError(why);
  };
  const updater = new Updater({
    ...(process.platform === "win32" ? updateSource : platformSource),
    currentVersion: version,
    installDir: installedAppRoot(app.isPackaged, process.platform, process.execPath),
    packaged: app.isPackaged,
    scratchDir: join(app.getPath("temp"), "branch-agent-update"),
    // Dev channel: which change this copy was built from, and Branch's own clone of its source to build the next one.
    currentCommit: builtFrom(app.getAppPath(), app.isPackaged),
    ...(hooks ? { backup: hooks.backup } : {}),
    ...(hooks?.stopDaemon ? { stopDaemon: hooks.stopDaemon } : {}),
    ...(hooks?.canary ? { canary: hooks.canary } : {}),
    beforeStop: ensureIdle,
  });
  const authorized = (event: IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== origin)
      throw new Error("Desktop update access denied");
  };
  const installClaim = new UpdateInstallClaim();
  ipcMain.handle("branch:update-status", (event) => { authorized(event); return updater.status; });
  ipcMain.handle("branch:update-check", async (event) => {
    authorized(event);
    if (installClaim.active) return updater.status;
    // mac7/diagnostics: each check, and any failure, is a line in the activity log.
    if (!hooks?.readiness) throw new Error("Branch cannot read its update channel.");
    updater.setChannel((await hooks.readiness()).channel);
    return updater.check().then((status) => {
      diagnose("updater", "info", "Checked for updates", { fields: { current: version, latest: updater.status.release?.latestVersion ?? "" } });
      return status;
    }, (error: unknown) => {
      diagnose("updater", "warn", `Checking for updates failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    });
  });
  ipcMain.handle("branch:update-install", async (event, automatic: unknown) => {
    authorized(event);
    // #215: one install at a time for this window, claimed before anything is awaited.
    return installClaim.run(() => updater.status, () => updater.inProgress, async () => {
      if (!hooks?.readiness) throw new Error("Branch cannot read its update channel.");
      const readiness = await hooks.readiness();
      const moved = updater.selectedChannel !== readiness.channel;
      updater.setChannel(readiness.channel);
      // NAS 2e3ead6: an automatic install that finds the channel just changed only switches it. The release it
      // would take was never looked at on this channel (a Dev change that failed here, say), so the next turn looks
      // first, and the plan weighs what that look finds. The Update button, pressed by the owner, goes on.
      // Thrown, not returned: the install claim is only given back on a throw (NAS 1f61d43), and the window's
      // automatic look ignores a deferral.
      if (automatic === true && moved) throw new UpdateDeferredError("The update channel was just changed, so Branch looks again before installing.");
      started = { channel: readiness.channel, automatic: automatic === true };
      await ensureIdle();
      diagnose("updater", "info", "Installing an update", { fields: { from: version, to: updater.status.release?.latestVersion ?? "" } });
      // CBQ-001: the updater's own claim is also held past install() until the hand-over is running, so
      // anything asking the updater whether it is busy hears yes (src/desktop/updater.ts, install).
      const { script, stagedDir } = await updater.install({ hold: true }).catch((error: unknown) => {
        diagnose("updater", "error", `The update could not be installed: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      });
      try {
        // mac7/safe-rollback: recorded here, marked as landed by the next start (`settleActivation`),
        // because this process quits into the hand-over and never sees how it went.
        if (hooks?.record) await hooks.record(stagedDir, updater.status.release?.latestVersion ?? "");
        // The background engine is already closed by this point, so say so if the hand-over cannot start.
        await launchHandOver(script, process.pid).catch((error: unknown) => {
          const why = error instanceof Error ? error.message : String(error);
          throw new Error(updater.backgroundStopped
            ? `The update could not be started: ${why}. Branch has stopped working in the background; it starts again next time you sign in to ${signInPlace}.`
            : `The update could not be started: ${why}.`);
        });
      } catch (error) {
        // Q55: nothing was swapped, so the status says what is still installed instead of "Restarting…".
        updater.failed(error instanceof Error ? error.message : String(error));
        throw error;
      }
      const status = updater.applying();
      setTimeout(requestQuit, 750);
      // If a polite quit gets stuck, leave anyway: the hand-over script is already waiting for this process to end.
      setTimeout(() => app.exit(0), 20000).unref();
      return status;
    });
  });
  ipcMain.handle("branch:open-external", async (event, url: unknown) => {
    authorized(event);
    if (typeof url !== "string" || !(externalAllowed.some((prefix) => url.startsWith(prefix)) || settingsPages.has(url)))
      throw new Error("That link cannot be opened from here");
    await shell.openExternal(url);
    return true;
  });
  window.on("closed", () => {
    for (const channel of ["branch:update-status", "branch:update-check", "branch:update-install", "branch:open-external"])
      ipcMain.removeHandler(channel);
  });
  return updater;
}
