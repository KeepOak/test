import { app, dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { diagnose } from "../diagnostic-log.js"; // mac7/diagnostics
import { launchHandOver } from "./hand-over.js";
import { join } from "node:path";
import { Updater, UpdateDeferredError, beforeInstall, type LiveHooks, type UpdateChannel, type UpdateStatus } from "./updater.js";
import { changedMind, confirmedChange, type InstallStart, type UpdateReadiness } from "./update-readiness.js";
import { appEntryName, packageTypeOf, releaseAssetName } from "./release-assets.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { versionedLayout } from "./app-folders.js";
import { readSwitchFailure } from "./shell-switch.js";
import { UpdateLoop, type LoopFacts, type LoopPlan } from "./update-loop.js";
import { portableMarker } from "../install/layout.js";
import { installedAppRoot } from "./install-root.js";
import { openableSettingsPages } from "../os-permissions.js";
import { isOfferUrl } from "../usage-offers.js";
import { UpdateInstallClaim } from "./update-install-claim.js";
import { primaryRepo } from "./repo-pair.js";
import { watchForOwner, type OwnerWindow } from "./quiet-build.js";
import { newestGreen } from "./dev-build.js";
import { OwnerUpdateQueue, updateWorkQuestion } from "./update-work-choice.js";

/** Where an update is downloaded, built and handed over; the new version says it is up there too (selfdev). */
export const updateScratchDir = (): string => join(app.getPath("temp"), "branch-agent-update");
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
// mac2/desktop-ui: the pages of the computer's own settings the window may open, matched exactly (src/os-permissions.ts).
const settingsPages = openableSettingsPages(process.platform);

/**
 * What this launch can do before an update: take the safety copy, and close the engine that keeps
 * working with the window closed. Both are supplied whether this window runs the engine itself or
 * joined one that was already working, so an update behaves the same either way.
 */
export interface UpdateHooks {
  /** The saved work's folder (a versioned switch checks its format before going back, version-switch.ts). */
  dataDir?: string;
  /** Authenticated current channel and full task count from the local or joined engine. */
  readiness?: () => Promise<Pick<UpdateReadiness, "busyTasks" | "workingTasks" | "autoUpdate"> & { channel: UpdateChannel }>;
  backup: () => Promise<void>;
  stopDaemon?: () => Promise<number | null>;
  /** mac3/never-break: the new version's check on a copy of the data (see src/never-break/canary.ts). */
  canary?: (stagedDir: string, version: string, options?: { required: boolean }) => Promise<void>;
  /** Beta: the new version started for real before it is used (src/desktop/beta-smoke.ts). */
  tryOut?: (stagedDir: string, version: string) => Promise<string | null>;
  /**
   * mac7/safe-rollback: writes down what this update is about to change, before the hand-over moves
   * a single file, so it can be undone afterwards. It throws when it cannot be written, and the
   * update stops there — an update nobody can undo is not one worth making.
   */
  record?: (stagedDir: string, version: string) => Promise<void>;
  /** Beta: the build's own folder, kept between builds (the data folder's `updates/beta-build`). */
  buildDir?: string;
  /** Beta channel: the commit this copy was built from (src/desktop/build-identity.ts), found before the window opens. */
  currentCommit?: string | null;
  /** hot-update: Beta changes main does not load are applied live (src/desktop/hot-apply.ts). */
  live?: LiveHooks;
  /** Versioned app folders: the moment and the window's state for a shell switch (main.ts, shell-switch.ts). */
  handOver?: (target: { version: string; stillWanted: () => boolean }) => Promise<{ minimized: boolean }>;
  /** The engine's plan for update by itself (update-readiness.ts updatePlanFrom), for the app's own update loop. */
  plan?: (facts: LoopFacts) => Promise<LoopPlan>;
}

/**
 * The window hears each change to the update as it happens (the steps, their times, the version), so its update
 * screen never guesses. Only to the window's own page, and at most four times a second while a download counts bytes;
 * a new step, phase or version goes at once.
 */
export function statusSender(send: (status: UpdateStatus) => void, everyMs = 250, now = Date.now): (status: UpdateStatus) => void {
  let last = 0, lastKey = "", waiting: NodeJS.Timeout | null = null, latest: UpdateStatus | null = null;
  const flush = () => { waiting = null; if (latest) { last = now(); send(latest); latest = null; } };
  return (status) => {
    const key = JSON.stringify([status.phase, status.stages?.map((stage) => stage.state), status.target?.version ?? null, status.failure, status.paused]);
    latest = status;
    if (key !== lastKey || now() - last >= everyMs) {
      lastKey = key;
      if (waiting) clearTimeout(waiting);
      flush();
    } else if (!waiting) waiting = setTimeout(flush, everyMs - (now() - last));
  };
}


/** Stands in for the window while none is open (a start in the tray): no keys to hear, so only tasks hold an install. */
const noWindow: OwnerWindow = { isDestroyed: () => true, webContents: { on: () => undefined, off: () => undefined } };

/**
 * `window` answers the window open right now, or null: the updater and update by itself run for the life of the app,
 * with a window or without one (a start in the tray opens none until the owner does), and pick up whichever is open.
 * Called once per app run.
 */
export function registerUpdaterIpc(
  window: () => BrowserWindow | null, origin: string, version: string, requestQuit: () => void,
  hooks?: UpdateHooks,
): Updater {
  const open = (): BrowserWindow | null => { const now = window(); return now && !now.isDestroyed() ? now : null; };
  // Dogfood F1 (NAS): what the owner had chosen when the install under way began; the last gate reads it again.
  let started: InstallStart | null = null;
  let allowWorking = false;
  // hot-update: a live update needs no quiet moment (work is handed over, not stopped); the packaged swap still does (beforeStop).
  const ensureIdle = async (idleNeeded = true) => {
    if (!hooks?.readiness) throw new UpdateDeferredError("Branch cannot verify that work is idle, so the update is waiting.");
    const state = await hooks.readiness().catch(() => {
      throw new UpdateDeferredError("Branch cannot confirm that work is idle, so the update is waiting.");
    });
    if (idleNeeded && state.busyTasks > 0 && !(allowWorking && appFolders))
      throw new UpdateDeferredError("An update is ready, but Branch will wait until every task finishes or is answered.");
    const why = changedMind(state, started);
    if (why) throw new UpdateDeferredError(why);
  };
  const installDir = installedAppRoot(app.isPackaged, process.platform, process.execPath);
  // Windows: each version in a folder of its own beside the others, switched to without touching the one in use
  // (app-folders.ts). A portable copy keeps its data beside the program, so it keeps the flat swap.
  const appFolders = installDir ? versionedLayout(process.execPath, process.platform, existsSync(join(dirname(process.execPath), portableMarker))) : null;
  const updater = new Updater({
    ...(process.platform === "win32" ? updateSource : platformSource),
    currentVersion: version,
    installDir,
    packaged: app.isPackaged,
    packageType: packageTypeOf(process.platform, installDir, (path) => readFileSync(path, "utf8")),
    scratchDir: updateScratchDir(),
    // Beta takes the newest change whose whole suite passed on GitHub, not simply the newest (dev-build.ts).
    greenCommit: newestGreen(),
    // Beta channel: which change this copy was built from, and Branch's own clone of its source to build the next one.
    currentCommit: hooks?.currentCommit ?? null,
    ...(hooks ? { backup: hooks.backup } : {}),
    ...(hooks?.stopDaemon ? { stopDaemon: hooks.stopDaemon } : {}),
    ...(hooks?.canary ? { canary: hooks.canary } : {}),
    ...(hooks?.tryOut ? { tryOut: hooks.tryOut } : {}),
    beforeStop: () => ensureIdle(),
    ...(hooks?.live ? { live: hooks.live } : {}),
    ...(appFolders ? { appFolders } : {}),
    ...(hooks?.dataDir ? { dataDir: hooks.dataDir } : {}),
    ...(hooks?.handOver ? { handOver: hooks.handOver } : {}),
    devBuildDir: hooks?.buildDir ?? null,
    onChange: statusSender((status) => {
      const shown = open();
      if (!shown) return;
      // Only the page this window was opened on, as every handler here checks for the other direction.
      const at = (() => { try { return new URL(shown.webContents.getURL()).origin; } catch { return null; } })();
      if (at === origin) shown.webContents.send("branch:update-changed", status);
    }),
  });
  const authorized = (event: IpcMainInvokeEvent) => {
    const shown = open();
    if (!shown || event.sender !== shown.webContents ||
      event.senderFrame !== shown.webContents.mainFrame ||
      new URL(event.senderFrame.url).origin !== origin)
      throw new Error("Desktop update access denied");
  };
  const installClaim = new UpdateInstallClaim();
  // A new version that did not come up sent the switch back to this one: said now, once (shell-switch.ts).
  if (appFolders) void readSwitchFailure(updateScratchDir(), version).then((failure) => {
    if (!failure) return;
    updater.switchFailed(failure);
    diagnose("updater", "error", failure.message, { fields: { kept: failure.kept, tried: failure.tried } });
  }).catch(() => undefined);
  ipcMain.handle("branch:update-status", (event) => { authorized(event); return updater.status; });
  ipcMain.handle("branch:update-check", async (event) => {
    authorized(event);
    if (installClaim.active) return updater.status;
    // mac7/diagnostics: each look writes what it found (updater.ts, lookUp); one that cannot start says why here.
    try {
      if (!hooks?.readiness) throw new Error("Branch cannot read its update channel.");
      updater.setChannel((await hooks.readiness()).channel);
    } catch (error) {
      diagnose("updater", "warn", `Checking for updates failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    return updater.check();
  });
  /**
   * One install, the Update button's and the app's own update loop's alike (update-loop.ts): `automatic` for update by
   * itself, which never confirms another line's change. #215: one install at a time, claimed before anything is awaited.
   */
  const installNow = (automatic: boolean, confirmed: string | null, work: "ask" | "wait" = "ask"): Promise<UpdateStatus> =>
    installClaim.run(() => updater.status, () => updater.inProgress, async () => {
      allowWorking = false;
      if (!automatic && work === "ask" && hooks?.readiness) {
        const state = await hooks.readiness();
        if (updater.selectedChannel !== state.channel) {
          queue.stop();
          updater.waitForTasks(false, "The update channel changed. Check for an update on this channel first.");
          updater.setChannel(state.channel);
          throw new UpdateDeferredError("The update channel changed. Check for an update on this channel first.");
        }
        if (state.busyTasks > 0 || queue.pending) {
          const shown = open();
          if (!shown) throw new UpdateDeferredError("Open Branch to choose how this update handles your tasks.");
          const { response } = await dialog.showMessageBox(shown, updateWorkQuestion(state.busyTasks, queue.pending));
          queue.stop();
          updater.waitForTasks(false, "The waiting update was cancelled.");
          if (response === 2) { installClaim.release(); return updater.status; }
          if (response === 0) {
            const tag = updater.status.release?.tag;
            if (!tag) throw new UpdateDeferredError("Check for an update before asking it to wait.");
            queue.start({ tag, channel: state.channel, confirmed });
            installClaim.release();
            return updater.waitForTasks(true, "This update waits until every task finishes or is answered. Press Update now to change this choice.");
          }
          allowWorking = true;
        }
      }
      diagnose("updater", "info", automatic === true ? "Update by itself asked to install an update" : "The owner asked to install an update",
        { fields: { from: version, to: updater.status.release?.latestVersion ?? "" } });
      const read = hooks?.readiness;
      // Update by itself ignores a wait, so a wait before the install starts is written down here (the updater writes
      // its own from there on): without it, an update that never went in left no reason anywhere.
      await beforeInstall(async () => {
        if (!read) throw new Error("Branch cannot read its update channel.");
        const readiness = await read();
        const moved = updater.selectedChannel !== readiness.channel;
        updater.setChannel(readiness.channel);
        // NAS 2e3ead6: an automatic install that finds the channel just changed only switches it. The release it
        // would take was never looked at on this channel (a Dev change that failed here, say), so the next turn looks
        // first, and the plan weighs what that look finds. The Update button, pressed by the owner, goes on.
        // Thrown, not returned: the install claim is only given back on a throw (NAS 1f61d43), and the automatic
        // look ignores a deferral.
        if (automatic === true && moved) throw new UpdateDeferredError("The update channel was just changed, so Branch looks again before installing.");
        started = { channel: readiness.channel, automatic: automatic === true };
        await ensureIdle(!(hooks?.live && readiness.channel === "beta"));
      });
      // From here the install waits for the owner's typing and for tasks at work, until it ends either way.
      const stopWatching = watchForOwner(open() ?? noWindow, updater, async () => {
        const state = await read!();
        // Dogfood F1 while it builds or waits: a changed channel, or update by itself switched off, calls it off now.
        const why = changedMind(state, started);
        if (why) updater.callOff(why);
        return allowWorking ? 0 : state.workingTasks ?? state.busyTasks;
      });
      // CBQ-001: the updater's own claim is also held past install() until the hand-over is running, so
      // anything asking the updater whether it is busy hears yes (src/desktop/updater.ts, install).
      // Every way install() ends is written to the activity log by the updater itself.
      const installed = await updater.install({ hold: true, automatic: automatic === true, ...(confirmed ? { confirm: confirmed } : {}) })
        .finally(stopWatching);
      // hot-update: applied live; nothing to hand over, nothing restarts.
      if ("live" in installed) {
        diagnose("updater", "info", "Updated live", { fields: { tier: installed.live.tier, ms: String(installed.live.ms), to: installed.live.version } });
        // The app keeps running, so the next change must find the install free again (it was left claimed for good).
        installClaim.release();
        return updater.status;
      }
      const { script, stagedDir } = installed;
      try {
        // mac7/safe-rollback: recorded here, marked as landed by the next start (`settleActivation`),
        // because this process quits into the hand-over and never sees how it went.
        // Versioned app folders need no record to undo: the version before stays whole and the switch goes back by itself.
        if (hooks?.record && !appFolders) await hooks.record(stagedDir, updater.status.release?.latestVersion ?? "");
        // The background engine is already closed by this point, so say so if the hand-over cannot start.
        diagnose("updater", "info", "Starting the hand-over", { fields: { to: updater.status.release?.latestVersion ?? "" } });
        await launchHandOver(script, process.pid).catch((error: unknown) => {
          const why = error instanceof Error ? error.message : String(error);
          throw new Error(updater.backgroundStopped
            ? `The update could not be started: ${why}. Branch has stopped working in the background; it starts again next time you sign in to ${signInPlace}.`
            : `The update could not be started: ${why}.`);
        });
        diagnose("updater", "info", "The hand-over started; this window closes for it");
      } catch (error) {
        // Q55: nothing was swapped, so the status says what is still installed instead of "Restarting…".
        // (`failed` writes the reason to the activity log.)
        updater.failed(error instanceof Error ? error.message : String(error));
        throw error;
      }
      const status = updater.applying();
      setTimeout(requestQuit, 750);
      // If a polite quit gets stuck, leave anyway: the hand-over script is already waiting for this process to end.
      setTimeout(() => app.exit(0), 20000).unref();
      return status;
    });
  const queue: OwnerUpdateQueue = new OwnerUpdateQueue({
    state: async () => {
      if (!hooks?.readiness) throw new Error("Branch cannot read its current tasks.");
      const state = await hooks.readiness();
      return { tag: updater.status.release?.tag ?? null, channel: state.channel, busyTasks: state.busyTasks,
        installing: installClaim.active || updater.inProgress };
    },
    install: async (request) => {
      updater.waitForTasks(false, "Your tasks finished; starting the requested update.");
      try { await installNow(false, request.confirmed, "wait"); }
      catch (error) {
        if (!(error instanceof UpdateDeferredError)) throw error;
        queue.start(request);
        updater.waitForTasks(true, error.message);
      }
    },
    cancelled: (words) => { updater.waitForTasks(false, words); diagnose("updater", "info", words); },
    failed: (words) => { diagnose("updater", "warn", words); },
  });
  ipcMain.handle("branch:update-install", async (event, automatic: unknown, confirm: unknown) => {
    authorized(event);
    // A Beta change that does not contain this copy's goes in only on the owner's confirmation of that exact change,
    // pressed in the window; update by itself never confirms anything.
    if (automatic === true && queue.pending) return updater.status;
    return installNow(automatic === true, confirmedChange(automatic, confirm));
  });
  // Update by itself runs here, in the app, not in the window's page: it goes on whether the page is loaded, closed to
  // the tray or gone (update-loop.ts). The page only shows what it says.
  // Only an installed copy updates itself; one run from its source is updated with `branch update`.
  const loop = app.isPackaged && hooks?.readiness && hooks.plan ? new UpdateLoop({
    readiness: async () => { const state = await hooks.readiness!(); return { channel: state.channel, autoUpdate: queue.pending ? "off" : state.autoUpdate ?? "off" }; },
    plan: hooks.plan, updater, install: async () => { await installNow(true, null); },
    tell: (words) => { open()?.webContents.send("branch:update-said", words); diagnose("updater", "warn", words); },
  }) : null;
  // The first look waits a minute: the window and its engine settle first, and nothing is built during start-up.
  loop?.start(60_000);
  ipcMain.handle("branch:update-loop", (event) => { authorized(event); return loop ? { inMain: true, ...loop.last } : { inMain: false }; });
  ipcMain.handle("branch:open-external", async (event, url: unknown) => {
    authorized(event);
    // The usage bar's "more usage" pages (src/usage-offers.ts) are matched on their origin and path exactly.
    if (typeof url !== "string" || !(externalAllowed.some((prefix) => url.startsWith(prefix)) || settingsPages.has(url) || isOfferUrl(url)))
      throw new Error("That link cannot be opened from here");
    await shell.openExternal(url);
    return true;
  });
  // Nothing is torn down when a window closes: the app, closed to the tray or with no window yet, keeps itself up to date.
  app.once("will-quit", () => { queue.stop(); loop?.stop(); });
  return updater;
}
