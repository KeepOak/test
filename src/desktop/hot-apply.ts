import { join } from "node:path";
import type { LiveOutcome } from "../hot-update/live-build.js";
import { runHostedLiveBuild, type HostedBuild } from "./build-client.js";
import { proveOnce } from "../engine-proof.js";
import { checkedInUse, pruneLive, readLiveState, writeLiveState, type InUse, type LiveState } from "../hot-update/live-folder.js";
import { isCanaryCopy, runCanary } from "../never-break/canary.js";
import type { EngineChild, EngineHost, HandOverOutcome } from "./engine-host.js";
import { UpdateDeferredError, type LiveApplied, type LiveHooks, type ReleaseInfo } from "./updater.js";
import { WindowUpdateDeferred, windowPlan, type WindowUpdate } from "./live-window-ipc.js";
import type { PreparedGatewayCode } from "./gateway-code.js";

/**
 * Live updates (hot-update), main's part: which live build the engine and the window use at start, and how a Beta
 * change is applied live (the updater's `live` hooks, src/desktop/updater.ts).
 *
 * - Window: the engine checks the live build and serves its window files; the open window takes them in place.
 * - Engine (and compatible retained gateway methods): the live build is checked again,
 *   tried on a copy of the owner's work (the Beta try-out, src/never-break/canary.ts), a safety copy of the work is
 *   taken, and the new engine takes over at the window's address (EngineHost.handOver). A new engine that fails is
 *   rolled back and the update says so; nothing half-applied is kept.
 *
 * `live/current.json` is written only after a part is in use, so a start after any failure uses what last worked.
 */
export interface HotApplyOptions {
  appRoot: string;
  dataDir: string;
  repo: string;
  buildDir: string;
  /** The change main was packaged from (null: not recorded, and every change goes the packaged way). */
  packaged: string | null;
  host: () => EngineHost | undefined;
  /** Starts an engine process from a live build's engine-process.js. */
  forkLive: (engineFile: string) => EngineChild;
  /** A copy of the saved work for the try-out (the engine that holds the database makes it). */
  snapshot: () => Promise<string>;
  /** The safety copy of the work taken before an update; the same as a packaged update's. */
  backup: () => Promise<void>;
  /** Tells the open window what changed (src/desktop/live-window-ipc.ts). */
  tellWindow: (update: WindowUpdate) => Promise<void>;
  /** Reload the previous served page under the retained picture after a failed renderer acknowledgment. */
  recoverWindow: () => Promise<void>;
  /** Close leases owned by the departed engine, after its Link closes and before its successor begins. */
  onEngineDeparture?: () => void;
  /** The retained gateway wakes public requests only after a candidate or rollback proves its internal address. */
  gateway?: { ready(version: string, provisional?: boolean): void; checking(): void; packagedVersion: string;
    prepareCode?: (inUse: InUse) => Promise<PreparedGatewayCode> };
  /** The runtime a live engine's try-out runs under (the app's own program, as Node). */
  runtime: string;
  /** Told what is in use once a live build went into use. */
  onApplied?: (state: LiveState) => void;
  log?: (line: string) => void;
}

export const engineFileOf = (dir: string): string => join(dir, "dist", "desktop", "engine-process.js");

/** At start: the live builds in use that still check out (anything that does not is left for the packaged one). */
export async function liveAtStart(appRoot: string, log: (line: string) => void = () => undefined): Promise<{ state: LiveState; engineFile: string | null; window: InUse | null }> {
  const state = await readLiveState(appRoot);
  const checked = async (inUse: InUse | null): Promise<string | null> => {
    try { return (await checkedInUse(appRoot, inUse))?.dir ?? null; }
    catch (error) { log(`Live build not used: ${error instanceof Error ? error.message : String(error)}`); return null; }
  };
  const engineDir = await checked(state.engine);
  const windowDir = state.window && state.window.commit !== state.engine?.commit ? await checked(state.window) : engineDir;
  const window = windowDir ? (state.window ?? state.engine) : null;
  return { state, engineFile: engineDir ? engineFileOf(engineDir) : null, window };
}

/** The newest change running: the window's live build, else the engine's, else the packaged one. */
export const runningChange = (state: LiveState, packaged: string | null): string | null => state.window?.commit ?? state.engine?.commit ?? packaged;

/**
 * A gateway change is live only where a retained gateway can take its checked code in place. Without one (the window's
 * own engine), src/never-break/gateway.ts is loaded by main, so the change goes the packaged way, as it did before.
 */
export function residentGatewayOutcome(outcome: LiveOutcome, options: Pick<HotApplyOptions, "gateway">): LiveOutcome {
  if (outcome.tier !== "gateway" || options.gateway?.prepareCode) return outcome;
  return { tier: "shell", version: outcome.version, reason: "This copy has no retained gateway to take the new gateway code live." };
}

export function liveHooks(options: HotApplyOptions): LiveHooks {
  let state: LiveState | null = null;
  let hosted: HostedBuild<LiveOutcome> | null = null, paused = false;
  const current = async () => (state ??= await readLiveState(options.appRoot));
  return {
    pause: (next) => { paused = next; hosted?.pause(next); },
    stop: () => hosted?.stop(),
    build: async (release: ReleaseInfo, hooks) => {
      const now = await current();
      if (!release.commit) throw new Error("The Beta build is not set up on this computer, so nothing was changed.");
      hosted = runHostedLiveBuild({
        repo: options.repo, buildDir: options.buildDir, commit: release.commit, running: runningChange(now, options.packaged),
        packaged: options.packaged, engineAt: now.engine?.commit ?? options.packaged, windowAt: runningChange(now, options.packaged),
        appRoot: options.appRoot, onStage: hooks.onStage, onVersion: hooks.onVersion,
        // GitHub's own build of the change, taken instead of compiling here once it checks out (build-output.ts).
        builtOutput: { repo: options.repo },
      }, { log: join(options.buildDir, "live-build.log") });
      if (paused) hosted.pause(true);
      try { return residentGatewayOutcome(await hosted.done, options); } finally { hosted = null; }
    },
    apply: async (outcome, hooks) => {
      const now = await current();
      const inUse: InUse = { commit: outcome.manifest.commit, digest: outcome.digest, version: outcome.version, at: new Date().toISOString() };
      hooks.onStage("checking");
      const checked = await checkedInUse(options.appRoot, inUse);
      if (!checked) throw new Error("The live build could not be checked, so nothing was changed.");
      const applied = await applyChecked(options, outcome, inUse, checked.dir, now, hooks);
      const next: LiveState = { engine: outcome.tier === "window" ? now.engine : inUse, window: inUse, previous: { engine: now.engine, window: now.window } };
      await writeLiveState(options.appRoot, next);
      state = next;
      options.onApplied?.(next);
      await pruneLive(options.appRoot, next).catch(() => undefined);
      return applied;
    },
  };
}

async function applyChecked(options: HotApplyOptions, outcome: Exclude<LiveOutcome, { tier: "shell" | "none" }>, inUse: InUse,
  dir: string, now: LiveState, hooks: { onStage: (stage: "copying" | "swapping") => void }): Promise<LiveApplied> {
  try { return outcome.tier === "window" ? await applyWindow(options, inUse, hooks) : await applyEngine(options, outcome, inUse, dir, hooks); }
  catch (error) {
    // EngineHost has rolled a failed engine check back before this runs. Window-only failures still use the old engine.
    const restoredVersion = now.engine?.version ?? options.gateway?.packagedVersion;
    if (outcome.tier !== "window" && restoredVersion) options.gateway?.ready(restoredVersion, true);
    // The previous engine is running again either way, so the gateway goes back to passing requests on even when the
    // window cannot be restored: left provisional, it held every request that was not the window's own for good.
    try {
      await options.host()?.call("use-window", { appRoot: options.appRoot, inUse: now.window ?? now.engine }, 60_000);
      await options.recoverWindow();
    } finally {
      if (outcome.tier !== "window" && restoredVersion) options.gateway?.ready(restoredVersion);
    }
    if (error instanceof WindowUpdateDeferred) throw new UpdateDeferredError(error.message);
    throw error;
  }
}

async function applyWindow(options: HotApplyOptions, inUse: InUse, hooks: { onStage: (stage: "copying" | "swapping") => void }): Promise<LiveApplied> {
  const host = options.host();
  if (!host?.running) throw new Error("Branch's engine is not running, so the window was not updated.");
  hooks.onStage("copying");
  hooks.onStage("swapping");
  const started = Date.now();
  const served = await host.call<{ changed: string[]; ms: number }>("use-window", { appRoot: options.appRoot, inUse }, 60_000);
  const plan = windowPlan(inUse.commit, served.changed);
  if (plan) await options.tellWindow(plan);
  const ms = Date.now() - started;
  return { tier: "window", ms, words: "Updated the window live", version: inUse.version, commit: inUse.commit };
}

async function applyEngine(options: HotApplyOptions, outcome: Exclude<LiveOutcome, { tier: "shell" | "none" | "window" }>, inUse: InUse, dir: string,
  hooks: { onStage: (stage: "copying" | "swapping") => void }): Promise<LiveApplied> {
  const host = options.host();
  if (!host?.running) throw new Error("Branch's engine is not running, so it was not updated live.");
  // The Beta try-out: the new engine starts on a copy of the work, in its self-test, before it goes near the real work.
  const copy = await options.snapshot();
  if (!isCanaryCopy(options.dataDir, copy)) throw new Error("The copy of your work was not where Branch keeps update copies, so it was not used.");
  const tried = await runCanary({ engine: { executable: options.runtime, script: join(dir, "dist", "cli.js") }, dataCopy: copy, expectedVersion: inUse.version });
  if (!tried.ok) throw new Error(`The new engine did not pass its check, so nothing was changed. ${tried.detail}`);
  if (outcome.tier === "gateway" && !options.gateway?.prepareCode)
    throw new Error("This copy cannot replace its resident gateway code, so the update was not applied live.");
  const gatewayCode = outcome.tier === "gateway" ? await options.gateway!.prepareCode!(inUse) : null;
  hooks.onStage("copying");
  await options.backup();
  hooks.onStage("swapping");
  await options.tellWindow({ engine: true });
  const plan = windowPlan(inUse.commit, outcome.changed.filter((file) => file.part === "window").map((file) => file.path.replace(/^public\//, "")));
  let refused: WindowUpdateDeferred | undefined;
  options.gateway?.checking();
  const handed: HandOverOutcome = await host.handOver({
    fork: () => options.forkLive(engineFileOf(dir)), commit: inUse.commit,
    onSwitch: options.onEngineDeparture ?? (() => undefined),
    // The new engine serves the window files of its own build, checked, from memory (src/hot-update/window-files.ts).
    config: { appRoot: options.appRoot, liveWindow: inUse },
    check: async (url) => {
      if (!(await proveOnce(url, host.token, 10_000))) throw new Error("the new engine did not prove its identity");
      try {
        gatewayCode?.apply();
        options.gateway?.ready(inUse.version, true);
        if (plan) await options.tellWindow(plan);
      } catch (error) { gatewayCode?.rollback(); if (error instanceof WindowUpdateDeferred) refused = error; throw error; }
    },
  });
  if (!handed.ok) throw refused ?? new Error(`The new engine did not start properly, so the engine that was running before was started again and nothing was changed (${handed.why}).`);
  options.gateway?.ready(inUse.version);
  options.log?.(`Engine handed over in ${handed.ms} ms (${handed.handedOver.length} task(s) carried on).`);
  return { tier: outcome.tier === "gateway" ? "gateway" : "engine", ms: handed.ms,
    words: gatewayCode ? "Updated Branch's engine and resident gateway code live" : "Updated Branch's engine live", version: inUse.version, commit: inUse.commit };
}
