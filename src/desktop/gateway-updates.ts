import { app } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Updater, UpdateDeferredError, type LiveHooks } from "./updater.js";
import { gatewayInstall } from "./gateway-install.js";
import { newestGreen } from "./dev-build.js";
import { versionedLayout } from "./app-folders.js";
import { UpdateLoop, type LoopPlan } from "./update-loop.js";
import { installedAppRoot } from "./install-root.js";
import { appEntryName, packageTypeOf, releaseAssetName } from "./release-assets.js";
import { primaryRepo } from "./repo-pair.js";
import { builtFrom } from "./build-identity.js";
import { stagedEngine, updateCanary } from "../never-break/canary.js";
import { runStagedSmoke } from "./beta-smoke.js";
import { portableMarker } from "../install/layout.js";
import { diagnose } from "../diagnostic-log.js";

/**
 * Update by itself when no window is open: only the detached gateway runs (src/desktop/gateway-desktop.ts), so it
 * keeps Branch up to date itself. Engine and window changes are applied live through the gateway's own engine, as a
 * window would; a change to the app itself is built as a new version folder beside this one and put in use by
 * switching `current.json` (app-folders.ts), so the next window opens as the new version. Nothing is stopped: the
 * gateway and its engine keep running through it. While a window is open, its own loop (updater-ipc.ts) does this
 * instead, so only one of the two ever installs.
 */
export interface GatewayUpdatesOptions {
  dataDir: string; appRoot: string;
  /** Whether a window (a shell) is joined right now: then it updates, not this. */
  shellOpen: () => boolean;
  live: () => LiveHooks | null;
  /** The engine's API, through the retained engine's proved connection. */
  engine: (path: string, body?: unknown) => Promise<unknown>;
  snapshot: () => Promise<string>;
  backup: () => Promise<void>;
  scratchDir: string;
  /** Runs an install as the broker's one adoption at a time (gateway-live.ts gatewayApplyOwner), begun with no shell. */
  adopt?: <T>(action: () => Promise<T>) => Promise<T>;
}

export async function gatewayUpdates(options: GatewayUpdatesOptions): Promise<{ loop: UpdateLoop; updater: Updater }> {
  const installDir = installedAppRoot(app.isPackaged, process.platform, process.execPath);
  const appFolders = installDir ? versionedLayout(process.execPath, process.platform, existsSync(join(dirname(process.execPath), portableMarker))) : null;
  const executableName = appEntryName(process.platform);
  const updater = new Updater({
    repo: primaryRepo, assetName: releaseAssetName(process.platform, process.arch), executableName,
    currentVersion: app.getVersion(), installDir, packaged: app.isPackaged,
    packageType: packageTypeOf(process.platform, installDir, (path) => readFileSync(path, "utf8")),
    scratchDir: options.scratchDir, currentCommit: await builtFrom(options.appRoot, app.isPackaged),
    devBuildDir: join(options.dataDir, "updates", "beta-build"),
    // Beta takes the newest change whose whole suite passed on GitHub, not simply the newest (dev-build.ts).
    greenCommit: newestGreen(),
    backup: options.backup,
    canary: updateCanary({ dataDir: options.dataDir, platform: process.platform, executableName, fromVersion: app.getVersion(),
      target: installDir, snapshot: options.snapshot }),
    tryOut: (stagedDir) => runStagedSmoke({ executable: stagedEngine(stagedDir, process.platform, executableName).executable, args: [] },
      join(app.getPath("temp"), "branch-agent-try-out"), process.env),
    beforeStop: async () => {
      const state = await readiness(options);
      if (state.busyTasks > 0) throw new UpdateDeferredError("An update is ready, but Branch will wait until every task finishes or is answered.");
    },
    ...(appFolders ? { appFolders } : {}),
    // No window to hand over: the switch is only the pointer (below), and the next window opens as the new version.
    handOver: async () => ({ minimized: true }),
  });
  const loop = new UpdateLoop({
    readiness: async () => {
      if (options.shellOpen()) return { channel: updater.selectedChannel, autoUpdate: "off" as const }; // the window's loop has it
      const state = await readiness(options);
      return { channel: state.channel, autoUpdate: state.autoUpdate ?? "off" };
    },
    plan: async (facts) => await options.engine("/api/comfort/update-plan", facts) as LoopPlan,
    updater,
    install: async () => {
      const done = await gatewayInstall({ shellOpen: options.shellOpen, updater, live: options.live, appFolders,
        ...(options.adopt ? { adopt: options.adopt } : {}) });
      if (done === "switched") diagnose("updater", "info", "Updated with no window open", { fields: { to: updater.status.installed.version } });
    },
    tell: (words) => diagnose("updater", "warn", words),
  });
  return { loop, updater };
}

async function readiness(options: GatewayUpdatesOptions): Promise<{ channel: "stable" | "beta"; autoUpdate?: "off" | "check" | "install"; busyTasks: number }> {
  const state = await options.engine("/api/comfort/update-readiness") as { channel: string; autoUpdate?: "off" | "check" | "install"; busyTasks: number };
  return { ...state, channel: state.channel === "stable" ? "stable" : "beta" };
}
