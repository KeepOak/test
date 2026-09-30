import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { appendFile, chmod, cp, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { posixHandOverScript, windowsKeep, windowsKeepOut } from "./hand-over.js";
import { checksumAssetName, type PackageType } from "./release-assets.js";
import type { LiveOutcome } from "../hot-update/live-build.js";
import { buildDev, devStanding, devToolsMissing, prepareBuildFolder, realRun, remoteHead, type DevBuildPlan, type DevBuilt, type DevStage, type DevStanding, type Run } from "./dev-build.js";
import { removeTree } from "./remove-tree.js";
import { folderPath, partFolder, pointerFiles, readPointer, sealAppFolder, type Layout } from "./app-folders.js";
import { failureName, invisibleWaitWords, shellUpMarker, type SwitchFailure } from "./shell-switch.js";
import { SwitchPlanSchema } from "./version-switch.js";
import { storeMigrations } from "../never-break/migrations.js";
import { runHostedBuild, type HostedBuild } from "./build-client.js";
import type { PauseReason } from "./quiet-build.js";
import { fetchAttestationBundles, isBuildProvenance, verifyAttestationBundle, type AttestationLookup } from "./provenance.js";
import { primaryRepo, fallbackRepo, isTrustedRepo } from "./repo-pair.js";
import { diagnose, type Level } from "../diagnostic-log.js";

/** One line in the activity log for each step an update takes (src/desktop/main-log.ts: main's lines reach the file). */
const note = (level: Level, message: string, fields?: Record<string, unknown>): void =>
  diagnose("updater", level, message, fields ? { fields } : {});

/**
 * One-button updates from GitHub Releases. The app downloads the published archive, checks it
 * against the published SHA-256, unpacks it beside the install, then hands over to a small script
 * that waits for the app to exit, mirrors the new files into place and starts the new version.
 */
export interface UpdaterOptions {
  repo: string;
  currentVersion: string;
  /** Stable installs GitHub's latest final release; Beta builds every merged change on this computer (dev-build.ts). */
  channel?: UpdateChannel;
  /** Folder that holds the running executable, or null when not running from an installed copy. */
  installDir: string | null;
  /** Windows and Linux: the program file. macOS: the `.app` bundle's folder name. */
  executableName: string;
  /** The download for this computer, or null when none is published for it. */
  assetName: string | null;
  scratchDir: string;
  /** True for a built app (not a source checkout), even when it is not where updates can reach it. */
  packaged?: boolean;
  /** The newest release published without a provenance record; defaults to LAST_RELEASE_WITHOUT_PROVENANCE. Tests of other steps name their own. */
  lastReleaseWithoutProvenance?: string;
  /** Linux: the installer this copy came from when a package manager owns its files (release-assets.ts packageTypeOf). */
  packageType?: PackageType | null;
  /** Which system the update is for; defaults to this computer's. */
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  /** Beta: the newest change on the line whose whole suite passed (dev-build.ts newestGreen); without it, the tip. */
  greenCommit?: (repo: string, tip: string) => Promise<string | null>;
  extract?: (archive: string, into: string) => Promise<void>;
  /**
   * Takes a safety copy of the person's saved work before the new files are put in place. When it
   * fails the update stops, because an update without something to go back to is not worth the risk.
   */
  backup?: () => Promise<void>;
  /** Re-check all tasks at the last safe point, before a background engine can be stopped. */
  beforeStop?: () => Promise<void>;
  /**
   * Politely closes the engine that keeps working with the window closed. A refusal defers the
   * update; it must not be swallowed and followed by a hand-over that forcibly ends the engine.
   */
  stopDaemon?: () => Promise<number | null>;
  /**
   * mac3/never-break: tries the unpacked version on a copy of the owner's data before anything is
   * swapped. Throws a plain sentence when the new version did not pass; the update then stops. `required`: the check
   * runs whatever the never-break switch says (Beta: a build no release has published).
   */
  canary?: (stagedDir: string, version: string, how?: { required: boolean }) => Promise<void>;
  /**
   * Beta: starts the staged new version for real, on a folder of its own (src/desktop/beta-smoke.ts): its engine, its
   * window, a message answered by a stand-in model, Settings. Answers the owner's sentence when it failed, or null.
   * Every Beta install runs it; a Beta install without it is refused.
   */
  tryOut?: (stagedDir: string, version: string) => Promise<string | null>;
  /** mac7/real-update: how long the download may go without a byte before it counts as dropped (60 s). */
  stallMs?: number;
  /** Windows: the registry key the update's recovery script is registered under (HKCU RunOnce); tests hand in their own. */
  runOnceKey?: string;
  /** Beta channel: the commit this copy was built from (dist/build-info.json), or null when it is not known. */
  currentCommit?: string | null;
  /** Beta channel: runs git and npm; tests hand in their own. */
  devRun?: Run;
  /**
   * Beta channel: the build's own folder, kept between builds so the next one only fetches, installs and compiles what
   * changed. In the data folder's `updates/`, which the assistant may never change and the data copy leaves out.
   */
  devBuildDir?: string | null;
  /** Told of every change to the status, so the window can show the update as it goes. */
  onChange?: (status: UpdateStatus) => void;
  /**
   * hot-update: Beta changes that the app's main process does not load are applied live, without packaging or a
   * restart (src/hot-update/). `build` answers "shell" for a change that must go the packaged way.
   */
  live?: LiveHooks;
  /**
   * Windows, versioned app folders (app-folders.ts): where this copy's versions sit and which one runs (folder "": a
   * flat copy from before). A new version is made beside it and switched to (shell-switch.ts); nothing is swapped or
   * copied over, and the background engine is never stopped for it. Left out: the flat swap, as before.
   */
  appFolders?: Layout | null;
  /** The saved work's folder: a versioned switch reads its format before it goes back (version-switch.ts). */
  dataDir?: string;
  /**
   * Versioned app folders: waits for the moment the switch may happen (the window out of sight, or the owner away) and
   * keeps what the window has open for the new version; answers whether the window was hidden, so the new version
   * starts the same way.
   */
  handOver?: (target: { version: string; stillWanted: () => boolean }) => Promise<{ minimized: boolean }>;
}
/** hot-update: how the updater builds and applies a change live (supplied by main, src/desktop/hot-apply.ts). */
export interface LiveHooks {
  pause?: (paused: boolean) => void;
  stop?: () => void;
  build: (release: ReleaseInfo, hooks: { onStage: (stage: DevStage, state: "running" | "skipped") => void; onVersion: (version: string) => void }) => Promise<LiveOutcome>;
  /** Checks the live build again, tries it (engine: on a copy of the work), and puts it to use; answers what ran. */
  apply: (outcome: Exclude<LiveOutcome, { tier: "shell" | "none" }>, hooks: { onStage: (stage: StageId) => void }) => Promise<LiveApplied>;
}
export interface LiveApplied { tier: "window" | "engine" | "gateway"; ms: number; words: string; version: string; commit: string }
export type UpdateChannel = "stable" | "beta";
/** Named, so the window hears a wait across IPC ("…: UpdateDeferredError: <why>") and does not report it as a failure. */
export class UpdateDeferredError extends Error { override name = "UpdateDeferredError"; }
/**
 * A wait the owner has to hear about: nothing was changed and the next look tries again, but it will not clear by itself
 * while tasks finish (a background engine that would not close, 2026-09-29). Its own name, so the window reports it (kept,
 * written to the activity log and said once) instead of only showing it as the reason the update waits.
 */
export class UpdateStuckError extends UpdateDeferredError { override name = "UpdateStuckError"; }
export interface ReleaseInfo {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  tag: string;
  title: string;
  notes: string;
  publishedAt: string | null;
  assetUrl: string;
  checksumUrl: string;
  assetBytes: number;
  pageUrl: string;
  channel: UpdateChannel;
  /** Dev: the commit that would be built. */
  commit?: string;
  /** Dev (dogfood F5): where the running change stands against it, from the history. */
  standing?: DevStanding;
  /**
   * Beta: the newest change does not contain the running change (a copy built from another line of work), so it is
   * not a newer version of this one. It is never installed by itself: only with the owner's confirmation of this exact
   * commit, in the window (`install({ confirm })`).
   */
  otherLine?: boolean;
  /** The repository this release was found from (used for provenance checks). */
  sourceRepo?: string;
}
/**
 * The steps an install goes through, as the update screen lists them. Beta: fetching the change, installing packages
 * (skipped when package-lock.json did not change), building, checking the new version, the safety copy, swapping,
 * restarting. Stable downloads instead of the first three. Each carries when it started and ended, for its time.
 */
export type StageId = DevStage | "downloading" | "checking" | "copying" | "swapping" | "restarting";
export type StageState = "waiting" | "running" | "done" | "skipped" | "failed";
export interface UpdateStage { id: StageId; state: StageState; startedAt: string | null; endedAt: string | null }
export const betaStages: readonly StageId[] = ["fetching", "installing", "building", "checking", "copying", "swapping", "restarting"];
export const stableStages: readonly StageId[] = ["downloading", "checking", "copying", "swapping", "restarting"];
/** hot-update: a live update has no restart; the window's own update skips the safety copy (it touches no saved work). */
export const liveStages: readonly StageId[] = ["fetching", "installing", "building", "checking", "copying", "swapping"];
/** The version being installed (null until a Beta build's source is here) and, for Beta, its change. */
export interface UpdateTarget { version: string | null; commit: string | null }
/** Where a failed install stopped, and the line of the build's output that says why (null when there is none). */
export interface UpdateFailure { stage: StageId | null; line: string | null }
export type UpdatePhase =
  | "idle" | "checking" | "current" | "available" | "downloading" | "verifying"
  | "unpacking" | "ready" | "applying" | "error" | "unsupported";
/** Q55: the build that is installed now: its version, and the commit it was built from (null when not recorded). */
export interface InstalledBuild { version: string; commit: string | null }
/**
 * Q55: after a failed update, what the owner still has. "kept": nothing was swapped, the installed
 * version still runs. "backgroundStopped": the engine working with the window closed was closed for
 * the update and stays closed until it is started again.
 */
export type UpdateOutcome = { kept: string; backgroundStopped: boolean } | null;
export interface UpdateStatus {
  phase: UpdatePhase;
  message: string;
  installed: InstalledBuild;
  /** Set only by a failed install, and cleared by whatever the updater does next. */
  outcome: UpdateOutcome;
  progress: number | null;
  release: ReleaseInfo | null;
  /** Download size so far and in total, while downloading. */
  bytes: { received: number; total: number } | null;
  updatedAt: string;
  /** What the build provenance check found for the download being installed, once it has run. */
  provenance?: { outcome: ProvenanceOutcome; message: string };
  /** The install under way, or the last one that failed: its steps, what it installs, and where it stopped. */
  stages: UpdateStage[] | null;
  target: UpdateTarget | null;
  failure: UpdateFailure | null;
  /** The install under way was started by update by itself, not by the owner: the window keeps it in the background until the swap. */
  automatic: boolean;
  /** hot-update: the last change applied live: which part, how long it took from the start of the update, and when. */
  live?: { tier: LiveApplied["tier"]; ms: number; at: string } | null;
  /**
   * The install under way is waiting because the owner is typing or a task is working (quiet-build.ts pauseReason):
   * the program running now is suspended when it may be, and the next step does not start. Null while it goes on.
   */
  paused: PauseReason | null;
  /** The owner asked this exact release to wait for tasks in the current desktop session. */
  waitingForTasks?: boolean;
}
export type ProvenanceOutcome = "checked" | "not-checked" | "none";
/**
 * The words for each provenance outcome. They are fixed sentences (no names filled in) so the
 * window can show them in the chosen language: the same words sit in public/locales under
 * `updates.provenance.*`. "checked" says what was checked and that the certificate chain was not.
 */
export const PROVENANCE_WORDS: Record<ProvenanceOutcome, string> = {
  checked: "A build provenance record was found for this download. It names this exact file and Branch's release workflow run for a version tag, and its signature matches the certificate that came with it. That certificate's chain back to Sigstore was not verified.",
  "not-checked": "The build provenance record for this download was not checked: GitHub could not be reached, did not answer in time, or sent a record that could not be read. The update relies on the published checksum alone, which it passed.",
  none: "No build provenance record is published for this download. The update relies on the published checksum alone, which it passed.",
};
const assetSchema = z.object({ name: z.string(), browser_download_url: z.string().url(), size: z.number().int().nonnegative() });
const releaseSchema = z.object({
  id: z.number().int().positive().optional(),
  tag_name: z.string().min(1),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  name: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  published_at: z.string().nullable().optional(),
  html_url: z.string().url(),
  assets: z.array(assetSchema),
});

export { compareVersions } from "./versions.js";
import { compareVersions } from "./versions.js";

/** Automatic updates accept only ordinary final SemVer tags, never aliases or prereleases. */
export function finalReleaseVersion(tag: string): string {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(tag);
  if (!match) throw new Error("The newest GitHub entry does not use a final release tag such as v1.2.3, so Branch did not offer it as an update.");
  return `${match[1]}.${match[2]}.${match[3]}${match[4] ?? ""}`;
}

/**
 * The last Stable release published before the release workflow recorded build provenance (#469). Every final
 * release after it carries a record, so for those the record is required: none published stops the update, and
 * one GitHub could not be asked about makes it wait. The switch follows the version, so it turns on by itself
 * as soon as the first release with a record is the newest.
 */
export const LAST_RELEASE_WITHOUT_PROVENANCE = "0.19.3";
export function provenanceRequired(version: string, lastWithout = LAST_RELEASE_WITHOUT_PROVENANCE): boolean {
  return compareVersions(version, lastWithout) > 0;
}

/**
 * The part of an install before the updater takes it over (reading the channel, waiting for work to be idle). A wait
 * or failure here is written to the activity log with its reason, then thrown on as before.
 */
export async function beforeInstall<T>(steps: () => Promise<T>): Promise<T> {
  try {
    return await steps();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof UpdateDeferredError) note(error instanceof UpdateStuckError ? "warn" : "info", `The update waits: ${message}`);
    else note("error", `The update could not start: ${message}`);
    throw error;
  }
}

export class Updater {
  status: UpdateStatus;
  private busy = false;
  private provenance: UpdateStatus["provenance"] | null = null;
  private channel: UpdateChannel;
  private generation = 0;
  /** True while a download, check, unpack or hand-over is under way. */
  get inProgress(): boolean { return this.busy; }
  private readonly fetch: typeof fetch;
  private readonly extract: (archive: string, into: string) => Promise<void>;
  private readonly platform: NodeJS.Platform;
  private installed: InstalledBuild;
  /** Q55: this install closed the background engine (a stop that found nothing running does not count). */
  private stoppedBackground = false;
  private stages: UpdateStage[] | null = null;
  private target: UpdateTarget | null = null;
  private automatic = false;
  private waitingForTasks = false;
  private paused: PauseReason | null = null;
  private resumed: (() => void)[] = [];
  private hosted: HostedBuild | null = null;
  /** Why the install under way was called off while it built or waited (the owner changed their mind), or null. */
  private calledOff: string | null = null;
  private devToolsFound = false;
  constructor(private readonly options: UpdaterOptions) {
    this.installed = { version: options.currentVersion, commit: options.currentCommit ?? null };
    this.status = this.fresh("idle", "Updates have not been checked yet.");
    this.channel = options.channel ?? "stable";
    this.fetch = options.fetch ?? globalThis.fetch;
    this.platform = options.platform ?? process.platform;
    const platform = this.platform;
    this.extract = options.extract ?? ((archive, into) => expandArchive(archive, into, platform));
    const reason = unsupportedReason(options, platform);
    if (reason)
      this.status = this.fresh("unsupported", reason);
  }
  get selectedChannel(): UpdateChannel { return this.channel; }
  setChannel(channel: UpdateChannel): UpdateStatus {
    if (this.busy) throw new Error("Wait for the current update before changing channels.");
    if (channel === this.channel) return this.status;
    this.channel = channel;
    this.generation++;
    this.provenance = null;
    this.stages = this.target = null;
    return this.set("idle", `Checking ${channel} updates has not started yet.`, null, null);
  }
  async check(): Promise<UpdateStatus> {
    if (this.busy) return this.status;
    this.provenance = null;
    this.stages = this.target = null;
    return this.lookUp();
  }
  /** The look-up itself. An install that has already claimed the updater uses this, not `check`. */
  private async lookUp(): Promise<UpdateStatus> {
    const status = await this.lookOnce();
    const release = status.release;
    note(status.phase === "error" ? "warn" : "info", `Looked for an update: ${status.message}`, { channel: this.channel, phase: status.phase,
      installed: this.installed.version, latest: release?.latestVersion ?? null, commit: release?.commit ?? null, available: release?.available ?? null });
    return status;
  }
  private async lookOnce(): Promise<UpdateStatus> {
    const generation = ++this.generation;
    this.set("checking", "Checking GitHub for a newer version…");
    try {
      const release = await this.latestRelease();
      if (generation !== this.generation) return this.status;
      if (release.channel === "beta") {
        const change = release.commit?.slice(0, 7), mine = this.installed.commit?.slice(0, 7);
        // Never offered as newer, and never installed by itself: only the owner's confirmation in the window moves to it.
        if (release.otherLine)
          return this.set("current", `The newest Beta change (${change}) does not include this copy's change (${mine}), so it is a different line of work, not a newer version of this one. It is installed only if you confirm it in Settings › Updates, and a safety copy of your work is kept first.`, null, release);
        return release.available
          ? this.set("available", `A newer Beta build (change ${change}) can be built and installed.`, null, release)
          : this.set("current", `You have the newest Beta build (change ${change}).`, null, release);
      }
      if (!release.available) return this.set("current", `You have the newest version (${release.currentVersion}).`, null, release);
      return this.set("available", `Version ${release.latestVersion} is ready to install.`, null, release);
    } catch (error) {
      if (generation !== this.generation) return this.status;
      return this.set("error", error instanceof Error ? error.message : String(error));
    }
  }
  /**
   * Downloads, verifies and unpacks the release; returns the hand-over script for the caller to launch.
   * CBQ-001: with `hold`, the claim is kept once this returns, because the caller still has the hand-over
   * to start - three scheduler calls of up to 15 s each - and a second request in that time would empty
   * the scratch folder the first hand-over is about to use and start a second one. `applying()` keeps
   * the claim from there; `release()` gives it back if the hand-over could not be started.
   */
  async install(options: { hold?: boolean; confirm?: string; automatic?: boolean } = {}): Promise<{ script: string; stagedDir: string } | { live: LiveApplied }> {
    // Each refusal leaves its reason in the activity log, as every other way an update ends does.
    const refuse = (message: string): never => { note("warn", `The update did not start: ${message}`); throw new Error(message); };
    const reason = unsupportedReason(this.options, this.platform);
    if (reason) refuse(reason);
    // Beta builds and runs code no release has published, so it never goes on without the safety copy and the copy of
    // the data folder (the `backup` the window hands in); checked first, so nothing is built for nothing.
    if (this.channel === "beta" && !this.options.backup)
      refuse("The Beta channel keeps a copy of your data folder before every update, and this copy of Branch cannot make one, so nothing was installed.");
    // selfdev: and a Beta build must start and pass its own check on a copy of the work before it replaces anything.
    if (this.channel === "beta" && !this.options.canary)
      refuse("The Beta channel tries every build on a copy of your work before using it, and this copy of Branch cannot, so nothing was installed.");
    if (this.channel === "beta" && !this.options.tryOut)
      refuse("The Beta channel tries every new version before using it, and this copy of Branch cannot, so nothing was installed.");
    if (this.busy) refuse("An update is already in progress.");
    // CBQ-001: claimed here, before anything is awaited. Looking the release up is a network round
    // trip, and `busy` used to be set only after it, so two requests arriving during that trip both
    // read `busy` as false and both went on. That is not two downloads of one file; the second one
    // empties the scratch folder the first is downloading into, and the first fails on its own
    // archive. Two hand-overs for one app is the multiplication this row forbids.
    this.busy = true;
    // One install at a time across the whole app: a window's and the gateway's own loop never build or switch together.
    const unlock = await installLock(`${this.options.scratchDir}.lock`).catch((error: unknown) => { this.busy = false; throw error; });
    this.stoppedBackground = false;
    this.automatic = options.automatic === true;
    this.calledOff = null;
    this.provenance = null;
    let release: ReleaseInfo | null | undefined;
    try {
      if (options.confirm !== undefined) release = await this.confirmedOtherLine(options.confirm);
      else {
        // Beta or Stable (#215): a release chosen for the other channel is looked up again.
        const selected = this.status.release;
        release = selected?.available && selected.channel === this.channel ? selected : (await this.lookUp()).release;
        if (!release?.available) throw new Error("There is no newer version to install.");
      }
    } catch (error) {
      // Nothing has been touched yet, so the claim is simply given back: no status change and no
      // files removed, exactly as when these two refusals happened before the claim existed.
      this.busy = false;
      note("warn", `The update did not start: ${error instanceof Error ? error.message : String(error)}`);
      await unlock();
      throw error;
    }
    let held = false;
    const beta = release.channel === "beta";
    note("info", "An update started", { channel: release.channel, from: this.installed.version, to: release.latestVersion,
      commit: release.commit ?? null, automatic: this.automatic });
    // hot-update: a Beta change main does not load is applied live; one it does goes the packaged way below.
    if (beta && this.options.live && release.otherLine !== true) {
      const applied = await this.tryLive(release).catch(async (error: unknown) => { this.busy = false; await unlock(); throw error; });
      if (applied) { this.busy = false; await unlock(); return { live: applied }; }
    }
    this.stages = (beta ? betaStages : stableStages).map((id) => ({ id, state: "waiting", startedAt: null, endedAt: null }));
    // A Beta build's version is known once its source is here; until then the screen names the change.
    this.target = { version: beta ? null : release.latestVersion, commit: release.commit ?? null };
    try {
      await removeTree(this.options.scratchDir);
      await mkdir(this.options.scratchDir, { recursive: true });
      if (this.platform !== "win32") await ensurePrivateDir(this.options.scratchDir);
      let archive = join(this.options.scratchDir, this.options.assetName!), expectedVersion = release.latestVersion;
      let stagedDir: string;
      if (beta) {
        const built = await this.buildDevRelease(release);
        expectedVersion = built.version;
        // From here on the Beta release is the version it was built as: the check, the record and the next start agree.
        release = { ...release, latestVersion: expectedVersion };
        this.status = { ...this.status, release };
        stagedDir = built.stagedDir ?? await this.unpack(built.archive!);
      }
      else {
        this.stage("downloading");
        // A required record is looked for first, against the published checksum, so a wait costs no download.
        const checked = this.mustHaveProvenance(release) ? await this.provenanceFirst(release) : null;
        await this.download(release, archive);
        this.stage("checking");
        await this.verify(archive, release, checked);
        stagedDir = await this.unpack(archive);
      }
      // Versioned app folders: a downloaded version goes into a folder of its own beside this one before it is tried.
      if (this.options.appFolders && !beta) stagedDir = await this.intoAppFolder(stagedDir, expectedVersion);
      this.stage("checking");
      await validateStagedPackage(stagedDir, expectedVersion, this.platform);
      await this.untilUnpaused();
      await this.tryCanary(stagedDir, expectedVersion); // mac3/never-break; a Beta build reports the version it was built as
      await this.untilUnpaused();
      if (release.channel === "beta") await this.tryOut(stagedDir, expectedVersion);
      this.stage("copying");
      await this.safetyCopy();
      await this.untilUnpaused();
      // Only once nothing is working: a task that started during the build defers the install, and the swap never began.
      await this.options.beforeStop?.();
      this.stage("swapping");
      // Versioned app folders: nothing is stopped or swapped; the new version takes over from this one (shell-switch.ts).
      const script = this.options.appFolders
        ? await this.writeSwitchScript(stagedDir, expectedVersion, release)
        : await this.writeScript(stagedDir, await this.stopBackground());
      this.set("ready", "Restarting to finish the update…", 1, release);
      note("info", "The update is ready to hand over", { version: expectedVersion });
      held = options.hold === true;
      return { script, stagedDir };
    } catch (error) {
      if (error instanceof UpdateDeferredError) { this.deferred(error); this.stages = this.target = null; this.set("available", error.message, null, release); }
      else this.keptAfter(error instanceof Error ? error.message : String(error), release, error);
      // mac7/real-update: a download that went wrong is 130 MB or more of nothing; it is not kept.
      await rm(join(this.options.scratchDir, this.options.assetName!), { force: true }).catch(() => undefined);
      await removeTree(join(this.options.scratchDir, "unpacked")).catch(() => undefined);
      throw error;
    } finally { if (!held) { this.busy = false; await unlock(); } }
  }
  /**
   * hot-update: builds the change the light way and, unless main must load it (answer null: the packaged way goes on),
   * applies it live. The steps and their times show as a packaged update's do, without the restart; the status then
   * says which part was updated and how long it took, from the start of the update to the new part in use.
   */
  private async tryLive(release: ReleaseInfo): Promise<LiveApplied | null> {
    const live = this.options.live!;
    const started = Date.now();
    this.stages = liveStages.map((id) => ({ id, state: "waiting", startedAt: null, endedAt: null }));
    this.target = { version: null, commit: release.commit ?? null };
    let outcome: LiveOutcome;
    try {
      outcome = await live.build(release, {
        onStage: (stage, state) => { this.stage(stage, state); if (state === "running") this.set("downloading", liveWords[stage], null, release); },
        onVersion: (version) => { this.target = { version, commit: release.commit ?? null }; },
      });
      await this.untilUnpaused();
    } catch (error) {
      const refusal = this.calledOff ? new UpdateDeferredError(this.calledOff) : error;
      if (refusal instanceof UpdateDeferredError) {
        this.deferred(refusal);
        this.stages = this.target = null;
        this.set("available", refusal.message, null, release);
        throw refusal;
      }
      this.keptAfter(error instanceof Error ? error.message : String(error), release, error);
      throw error;
    }
    note("info", outcome.tier === "shell" ? "The live build needs main to load it, so the update goes the packaged way"
      : `The live build finished: ${outcome.tier}`, { tier: outcome.tier });
    if (outcome.tier === "shell") {
      // The packaged way starts its own steps from the beginning; the source it needs is already fetched.
      this.stages = this.target = null;
      return null;
    }
    if (outcome.tier === "none") {
      this.installed = { version: outcome.version, commit: release.commit ?? this.installed.commit };
      this.stages = this.target = null;
      this.set("current", `You have the newest Beta build (change ${release.commit?.slice(0, 7)}).`, null, { ...release, available: false });
      return { tier: "window", ms: Date.now() - started, words: this.status.message, version: outcome.version, commit: release.commit ?? "" };
    }
    try {
      const applied = await live.apply(outcome, { onStage: (stage) => this.stage(stage, stage === "copying" && outcome.tier === "window" ? "skipped" : "running") });
      const at = new Date().toISOString();
      for (const stage of this.stages ?? []) if (stage.state === "running") Object.assign(stage, { state: "done", endedAt: at });
      this.installed = { version: applied.version, commit: applied.commit };
      const ms = Date.now() - started;
      this.stages = this.target = null;
      this.status = { ...this.fresh("current", `${applied.words} in ${liveSeconds(ms)}.`), release: { ...release, latestVersion: applied.version, available: false },
        live: { tier: applied.tier, ms, at } };
      this.options.onChange?.(this.status);
      return { ...applied, ms };
    } catch (error) {
      if (error instanceof UpdateDeferredError) { this.deferred(error); this.stages = this.target = null; this.set("available", error.message, null, release); throw error; }
      this.keptAfter(error instanceof Error ? error.message : String(error), release, error);
      throw error;
    }
  }
  /**
   * Beta: the owner confirmed, in the window, moving to this exact commit although it does not contain this copy's
   * change. It is looked up afresh and must still be Beta's newest change, and still not contain it; otherwise nothing
   * is installed. Update by itself never gets here (the window's automatic look never confirms, see updater-ipc.ts).
   */
  private async confirmedOtherLine(confirm: string): Promise<ReleaseInfo> {
    if (this.channel !== "beta" || !/^[0-9a-f]{40}$/.test(confirm))
      throw new Error("Only a Beta change that does not contain this copy's change can be confirmed, so nothing was installed.");
    const release = (await this.lookUp()).release;
    if (!release?.otherLine || release.commit !== confirm)
      throw new Error("The change you confirmed is no longer Beta's newest one, so nothing was installed. Check again and confirm the change shown.");
    return release;
  }
  /**
   * Versioned app folders: the new version did not say its window was up, so the switch went back to this one by itself
   * (shell-switch.ts). Said as a failed install of that release, with what is still installed, so the window tells the
   * owner once and update by itself does not try that same change again (the next one is).
   */
  switchFailed(failure: SwitchFailure): UpdateStatus {
    const short = failure.commit?.slice(0, 7);
    const release: ReleaseInfo = { currentVersion: this.options.currentVersion, latestVersion: failure.tried, available: false,
      tag: short ? `dev-${short}` : `v${failure.tried}`, title: short ? `Beta build of change ${short}` : `Version ${failure.tried}`, notes: "",
      publishedAt: null, assetUrl: "", checksumUrl: "", assetBytes: 0, pageUrl: "", channel: short ? "beta" : "stable",
      ...(failure.commit ? { commit: failure.commit } : {}) };
    return this.keptAfter(failure.message, release);
  }
  /** The live hooks to use from the next install (the gateway's engine can be replaced under it). */
  useLive(hooks: LiveHooks | null): void {
    if (hooks) this.options.live = hooks; else delete this.options.live;
  }
  /**
   * Versioned app folders with no window open (gateway-updates.ts): the new version is in use from the next window, as
   * `current.json` now says; nothing had to close. The claim is given back and the status says so.
   */
  switchedWithoutWindow(): UpdateStatus {
    const release = this.status.release;
    this.installed = { version: release?.latestVersion ?? this.installed.version, commit: release?.commit ?? this.installed.commit };
    this.busy = false;
    this.stages = this.target = null;
    return this.set("current", `Version ${this.installed.version} is in place; the next time Branch's window opens, it is this version.`, null, release ? { ...release, available: false } : null);
  }
  /** Gives back a claim `install({ hold: true })` kept, when the hand-over it was kept for did not start. */
  release(): void { this.busy = false; }
  waitForTasks(waiting: boolean, words: string): UpdateStatus {
    this.waitingForTasks = waiting;
    return this.set("available", words, null, this.status.release);
  }
  /**
   * The owner is typing, or a task is working (null: neither). An install under way waits for them: the build's own
   * process holds what it runs, and the next step (the check, the safety copy, the swap) does not start until this is null.
   */
  setPaused(reason: PauseReason | null): void {
    if (reason === this.paused) return;
    this.paused = reason;
    this.hosted?.pause(reason !== null);
    this.options.live?.pause?.(reason !== null);
    if (!reason) for (const wake of this.resumed.splice(0)) wake();
    if (this.stages) {
      this.status = { ...this.status, paused: reason, updatedAt: new Date().toISOString() };
      this.options.onChange?.(this.status);
    }
  }
  /**
   * Resolves once the install may take its next step; throws a wait (the install is given back, nothing was swapped)
   * when it was called off meanwhile.
   */
  async untilUnpaused(): Promise<void> {
    if (this.paused && !this.calledOff) await new Promise<void>((resolve) => this.resumed.push(resolve));
    if (this.calledOff) throw new UpdateDeferredError(this.calledOff);
  }
  /**
   * The owner changed their mind while this install built or waited (another channel, update by itself switched off):
   * the build stops, a wait for the owner ends, and the install is given back as a wait. A task that works for hours
   * must not keep the updater claimed with no way out.
   */
  callOff(why: string): void {
    if (!this.busy || this.calledOff) return;
    this.calledOff = why;
    note("info", `The update was called off: ${why}`);
    this.hosted?.stop();
    this.options.live?.stop?.();
    for (const wake of this.resumed.splice(0)) wake();
  }
  /** Q55: whether the install under way closed the background engine, so a failure can say so. */
  get backgroundStopped(): boolean { return this.stoppedBackground; }
  /**
   * Q55: an update that stopped before the hand-over swapped any file. The installed version is
   * what still runs, and the status says so; the claim is given back.
   */
  failed(message: string): UpdateStatus {
    this.busy = false;
    return this.keptAfter(message, this.status.release);
  }
  /** An update that waits leaves its reason in the log; a wait that will not clear by itself is a warning. */
  private deferred(error: UpdateDeferredError): void {
    note(error instanceof UpdateStuckError ? "warn" : "info", `The update waits: ${error.message}`, { automatic: this.automatic });
  }
  private keptAfter(message: string, release: ReleaseInfo | null | undefined, error?: unknown): UpdateStatus {
    const running = this.stages?.find((stage) => stage.state === "running") ?? null;
    if (running) Object.assign(running, { state: "failed", endedAt: new Date().toISOString() });
    const detail = error && typeof error === "object" && "detail" in error && typeof error.detail === "string" ? error.detail : null;
    note("error", `The update stopped: ${message}`, { step: running?.id ?? null, kept: this.installed.version,
      backgroundStopped: this.stoppedBackground, line: detail });
    this.status = { ...this.fresh("error", message), release: release ?? null,
      ...(this.provenance ? { provenance: this.provenance } : {}),
      outcome: { kept: this.installed.version, backgroundStopped: this.stoppedBackground },
      ...(this.stages ? { failure: { stage: running?.id ?? null, line: detail } } : {}) };
    this.options.onChange?.(this.status);
    return this.status;
  }
  /**
   * The install moves on to `id`: the step running until now is done, and `id` runs (or is skipped, with no time of
   * its own). Only the steps this install really goes through are marked; nothing is guessed ahead.
   */
  private stage(id: StageId, state: "running" | "skipped" = "running"): void {
    const stages = this.stages, at = new Date().toISOString();
    const next = stages?.find((stage) => stage.id === id);
    if (!stages || !next || next.state === state) return;
    note("info", `Update step: ${id}${state === "skipped" ? " (skipped)" : ""}`, { version: this.target?.version ?? null, commit: this.target?.commit ?? null });
    for (const stage of stages) if (stage.state === "running" && stage !== next) Object.assign(stage, { state: "done", endedAt: at });
    Object.assign(next, state === "running" ? { state, startedAt: at, endedAt: null } : { state, startedAt: at, endedAt: at });
    this.status = { ...this.status, stages: stages.map((stage) => ({ ...stage })), target: this.target ? { ...this.target } : null, automatic: this.automatic, paused: this.paused, updatedAt: at };
    this.options.onChange?.(this.status);
  }
  /** mac3/never-break: the new version must pass its own check on a copy of the data first. */
  private async tryCanary(stagedDir: string, version: string): Promise<void> {
    if (!this.options.canary) return;
    this.set("verifying", "Trying the new version on a copy of your work before using it…", null, this.status.release);
    note("info", "Trying the new version on a copy of the work", { version });
    try { await this.options.canary(stagedDir, version, { required: this.channel === "beta" }); }
    catch (error) {
      const why = (error instanceof Error ? error.message : String(error)).replace(/\.?$/, ".");
      throw new Error(`The new version did not pass its check, so nothing was changed. ${why}`);
    }
    note("info", "The new version passed its check on a copy of the work", { version });
  }
  /**
   * Beta: the new version is started for real before anything is swapped (src/desktop/beta-smoke.ts). A failed try-out
   * stops the install there: the staged copy is removed, the running version stays, and the owner reads which step failed.
   */
  private async tryOut(stagedDir: string, version: string): Promise<void> {
    this.set("verifying", "Trying the new Beta version: starting it, sending it a message and opening Settings…", null, this.status.release);
    const failure = await this.options.tryOut!(stagedDir, version).catch((error: unknown) =>
      `The new Beta version was not used: its try-out could not run (${error instanceof Error ? error.message : String(error)}). You are still on the version you had, and nothing was changed.`);
    if (failure) throw new Error(failure);
    note("info", "The new Beta version passed its try-out", { version });
  }
  /** The safety copy taken just before the files are swapped; three are kept by the caller. */
  private async safetyCopy(): Promise<void> {
    if (!this.options.backup) return;
    this.set("unpacking", "Making a safety copy of your work before the update…", null, this.status.release);
    try {
      await this.options.backup();
      note("info", "The safety copy was made");
    } catch (error) {
      const why = (error instanceof Error ? error.message : String(error)).replace(/\.?$/, ".");
      throw new Error(`The safety copy could not be made, so the update was stopped: ${why} Free some space on this drive, or move Branch's data folder somewhere it can write, then try the update again.`);
    }
  }
  /**
   * Closes the engine working in the background before the files are swapped, and answers with its
   * process id so the hand-over waits for it as well. A refusal stops this attempt.
   */
  private async stopBackground(): Promise<number | null> {
    if (!this.options.stopDaemon) return null;
    this.set("unpacking", "Closing the part of Branch that keeps working with the window closed…", null, this.status.release);
    note("info", "Closing the background engine for the update");
    const pid = await this.options.stopDaemon();
    // A null answer means nothing was working in the background, so nothing was closed.
    this.stoppedBackground = pid !== null;
    note("info", pid === null ? "No background engine was working, so none was closed" : "The background engine was closed", { pid });
    return pid;
  }
  private async latestRelease(): Promise<ReleaseInfo> {
    if (this.channel === "beta") return this.newestDevBuild();
    // The repository is moving from stabrea to KeepOak: the new name is asked first, and the old one only when GitHub
    // says the new one does not exist (404). Any other answer, or no answer, stops here. One request per name asked.
    const primary = await this.releaseList(primaryRepo);
    if (primary.status !== 404) return this.lookupLatestRelease(primaryRepo, primary);
    const fallback = await this.releaseList(fallbackRepo);
    if (fallback.status === 404) throw new Error("No release has been published yet.");
    return this.lookupLatestRelease(fallbackRepo, fallback);
  }

  /** GitHub's newest final release for one repository name (Stable; Beta is built, never downloaded). */
  private releaseList(repo: string): Promise<Response> {
    return this.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": `BranchAgent/${this.options.currentVersion}` },
      signal: AbortSignal.timeout(15000),
    });
  }

  private async lookupLatestRelease(sourceRepo: string, response: Response): Promise<ReleaseInfo> {
    if (!response.ok) throw new Error(`GitHub did not answer (HTTP ${response.status}). Try again later.`);
    const raw = await response.json();
    const data = releaseSchema.parse(raw);
    if (data.draft || data.prerelease) throw new Error("The newest stable release is not a published final release.");
    const assets = await this.releaseAssets(data, sourceRepo);
    const asset = assets.find((entry) => entry.name === this.options.assetName);
    const checksum = assets.find((entry) => entry.name === checksumAssetName(this.options.assetName ?? ""));
    if (!asset || !checksum) throw new Error(`The newest release is missing its ${systemName(this.platform)} download or checksum.`);
    const latestVersion = finalReleaseVersion(data.tag_name);
    return {
      currentVersion: this.options.currentVersion, latestVersion, tag: data.tag_name,
      // Switching from Beta never goes back: a Beta build of 0.19.2's line is 0.19.3-dev…, above 0.19.2 and below 0.19.3.
      available: compareVersions(latestVersion, this.options.currentVersion) > 0,
      title: data.name || data.tag_name, notes: data.body ?? "", publishedAt: data.published_at ?? null,
      assetUrl: asset.browser_download_url, checksumUrl: checksum.browser_download_url, assetBytes: asset.size,
      pageUrl: data.html_url,
      channel: "stable",
      sourceRepo,
    };
  }
  /**
   * Dev reads and builds with git, which has no answer to fall back on: the new name does not exist until the
   * move, and asking it fails as a sign-in prompt, not a 404. So Dev uses the name Branch has now, which GitHub
   * keeps sending to the new one after the move. A repository outside Branch's two names is used as given.
   */
  private devRepo(): string {
    return isTrustedRepo(this.options.repo) ? fallbackRepo : this.options.repo;
  }
  /**
   * Beta: the newest merged change on Beta's line of work (dev-build.ts betaLine), offered when it is not the one this
   * copy was built from. When it does not contain the running change (a copy built from another line, or ahead of
   * this one), it is never offered as newer, and installed only on the owner's confirmation (`otherLine`).
   */
  private async newestDevBuild(): Promise<ReleaseInfo> {
    const run = this.options.devRun ?? realRun(this.platform);
    // Found once, then trusted for this run of the app: a look every minute need not start three programs each time.
    if (!this.devToolsFound) {
      const missing = await devToolsMissing(run);
      if (missing) throw new Error(missing);
      this.devToolsFound = true;
    }
    const tip = await remoteHead(run, this.devRepo());
    // The newest change whose whole suite passed, not simply the newest (dev-build.ts newestGreen).
    const commit = (await this.options.greenCommit?.(this.devRepo(), tip).catch(() => null)) ?? tip;
    const short = commit.slice(0, 7), running = this.installed.commit;
    // Dogfood F5: a copy built ahead of the line is not offered the line's older head as "newer".
    const standing = running && running !== commit ? await this.devHistoryStanding(run, running, commit) : undefined;
    const otherLine = standing === "ahead" || standing === "apart";
    return {
      currentVersion: this.options.currentVersion, latestVersion: this.options.currentVersion, tag: `dev-${short}`,
      available: commit !== running && !otherLine, ...(standing ? { standing } : {}), ...(otherLine ? { otherLine } : {}),
      title: `Beta build of change ${short}`, notes: "", publishedAt: null,
      assetUrl: "", checksumUrl: "", assetBytes: 0, pageUrl: `https://github.com/${this.devRepo()}/commit/${commit}`,
      channel: "beta", commit,
    };
  }
  /**
   * Dev (dogfood F5): where the running change stands, from a history kept in the updater's own folder. That folder is
   * made private first, as an install makes it (NAS cfc3808); one that is not safe to use leaves the answer unknown.
   */
  private async devHistoryStanding(run: Run, running: string, commit: string): Promise<DevStanding> {
    try {
      await mkdir(this.options.scratchDir, { recursive: true });
      if (this.platform !== "win32") await ensurePrivateDir(this.options.scratchDir);
    } catch { return "unknown"; }
    return devStanding(run, join(this.options.scratchDir, "dev-history"), this.devRepo(), running, commit);
  }
  /**
   * Beta: builds the change on this computer, in the build's own folder, kept between builds. Windows: the app folder
   * the build made goes where a download is unpacked (no zip to write and unpack again). macOS and Linux: the build's
   * download goes where a downloaded one would, and is unpacked as one is. The steps after it are a release's.
   */
  private async buildDevRelease(release: ReleaseInfo): Promise<{ version: string; stagedDir?: string; archive?: string }> {
    if (!release.commit || !/^[0-9a-f]{40}$/.test(release.commit))
      throw new Error("The Beta build is not set up on this computer, so nothing was changed.");
    const buildDir = this.options.devBuildDir;
    if (!buildDir) throw new Error("This copy of Branch has no folder to build Beta in, so nothing was changed. Choose Stable.");
    const words: Record<DevStage, string> = {
      fetching: "Getting the newest change from GitHub…",
      installing: "Installing the packages Branch builds with…",
      building: "Building Branch on this computer…",
    };
    await prepareBuildFolder(buildDir, this.platform);
    // Each build's programs and their output, newest build only; the screen shows the line that says what failed.
    const log = join(buildDir, "build.log");
    await rm(log, { force: true });
    await writeFile(log, `Beta build of ${release.commit} from ${this.installed.version}, started ${new Date().toISOString()}\n\n`);
    const plan: DevBuildPlan = {
      repo: this.devRepo(), buildDir, commit: release.commit, running: this.installed.commit, assetName: this.options.assetName!,
      platform: this.platform, otherLineConfirmed: release.otherLine === true,
      ...(this.options.appFolders ? { appFolder: { root: this.options.appFolders.root,
        running: folderPath(this.options.appFolders.root, this.options.appFolders.folder), executableName: this.options.executableName } } : {}),
      onStage: (stage, state) => {
        this.stage(stage, state);
        if (state === "running") this.set("downloading", words[stage], null, this.status.release);
      },
      onVersion: (version) => {
        this.target = { version, commit: release.commit ?? null };
        this.set("downloading", this.status.message, null, this.status.release ? { ...this.status.release, latestVersion: version } : null);
      },
    };
    // The real build runs in a low-priority process of its own (build-host.ts), so neither this process nor the
    // computer is kept busy by it; a runner handed in (tests) runs here.
    // The real build takes GitHub's own build of the change when it is there and checks out (build-output.ts).
    const built = await (this.options.devRun ? buildDev(this.options.devRun, plan) : this.hostedBuild({ ...plan, builtOutput: { repo: this.devRepo() } }, log));
    // Without the change the running version was built from, its version is the only way to see going back.
    if (!this.installed.commit && compareVersions(built.version, this.installed.version) < 0)
      throw new Error(`The newest Beta build (${built.version}) is older than the version running now (${this.options.currentVersion}), so nothing was changed. It is offered again once it catches up.`);
    this.stage("checking");
    this.set("verifying", "Checking the build is whole…", null, this.status.release);
    // Versioned app folders: already in place beside the running version, whole (it was renamed in only once it was).
    if ("appFolder" in built) return { version: built.version, stagedDir: built.appFolder };
    if ("folder" in built) {
      const app = await findExecutableDir(built.folder, this.options.executableName);
      const into = join(this.options.scratchDir, "unpacked"), stagedDir = join(into, basename(app));
      await mkdir(into, { recursive: true });
      // One rename on the same drive; a copy when the data folder is on another one.
      await rename(app, stagedDir).catch(() => cp(app, stagedDir, { recursive: true, verbatimSymlinks: true }));
      return { version: built.version, stagedDir };
    }
    const expected = /^([a-f0-9]{64})\b/i.exec((await readFile(built.checksumFile, "utf8")).trim())?.[1]?.toLowerCase();
    const hash = createHash("sha256");
    const { createReadStream } = await import("node:fs");
    for await (const chunk of createReadStream(built.archive)) hash.update(chunk as Buffer);
    // This only proves the file was written whole; the trust in its contents comes from git over https.
    if (!expected || hash.digest("hex") !== expected) throw new Error("The Beta build came out incomplete, so nothing was changed. Try the update again.");
    // The download goes where a downloaded release would be.
    const archive = join(this.options.scratchDir, this.options.assetName!);
    await rename(built.archive, archive).catch(async () => { await cp(built.archive, archive); await rm(built.archive, { force: true }); });
    return { version: built.version, archive };
  }
  private async hostedBuild(plan: DevBuildPlan, log: string): Promise<DevBuilt> {
    const hosted = runHostedBuild(plan, { log });
    this.hosted = hosted;
    if (this.paused) hosted.pause(true);
    // The log says how the build was lowered (or that the helper could not run, and only its priority class was).
    void hosted.lowered.then((words) => appendFile(log, `Build priority: ${words}\n\n`)).catch(() => undefined);
    try { return await hosted.done; }
    catch (error) { throw this.calledOff ? new UpdateDeferredError(this.calledOff) : error; }
    finally { this.hosted = null; }
  }
  /**
   * Q37: for minutes after a release is published, GitHub's release list (and its tag look-up) can still show no
   * assets while the release's own assets list already has them all (measured on v0.19.3-beta.2). When the listed
   * assets lack this computer's download or checksum, ask that list, which is current.
   */
  private async releaseAssets(release: z.infer<typeof releaseSchema>, sourceRepo: string): Promise<z.infer<typeof assetSchema>[]> {
    const names = new Set(release.assets.map((entry) => entry.name));
    if (!release.id || (names.has(this.options.assetName ?? "") && names.has(checksumAssetName(this.options.assetName ?? ""))))
      return release.assets;
    const response = await this.fetch(`https://api.github.com/repos/${sourceRepo}/releases/${release.id}/assets?per_page=100`, {
      headers: { accept: "application/vnd.github+json", "user-agent": `BranchAgent/${this.options.currentVersion}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return release.assets;
    return z.array(assetSchema).parse(await response.json());
  }
  private async download(release: ReleaseInfo, target: string): Promise<void> {
    this.set("downloading", "Downloading the new version…", 0, release);
    // mac7/real-update: a connection that drops shows up as "terminated" and one that goes quiet
    // hangs for minutes; both now end the same way, in plain words, with nothing changed.
    const stalled = new AbortController();
    let quiet: NodeJS.Timeout | undefined;
    const listen = () => { clearTimeout(quiet); quiet = setTimeout(() => stalled.abort(), this.options.stallMs ?? 60000); };
    const dropped = () => new Error("The download stopped before it finished, so nothing was changed. Check the internet connection and press Update again.");
    listen();
    let response: Response;
    try {
      response = await this.fetch(release.assetUrl, { headers: { "user-agent": `BranchAgent/${this.options.currentVersion}` }, signal: stalled.signal });
    } catch { clearTimeout(quiet); throw dropped(); }
    if (!response.ok || !response.body) { clearTimeout(quiet); throw new Error(`Branch could not download the new version (the server answered ${response.status}), so nothing was changed. Check this computer's internet connection and try the update again.`); }
    const total = Number(response.headers.get("content-length")) || release.assetBytes || 0;
    const file = createWriteStream(target, { flags: "wx" });
    let received = 0;
    const reader = response.body.getReader();
    // One listener for the whole download (one per chunk would pile up thousands on the same signal).
    const quietTooLong = new Promise<never>((_resolve, reject) => {
      stalled.signal.addEventListener("abort", () => reject(dropped()), { once: true });
    });
    quietTooLong.catch(() => undefined);
    const next = () => Promise.race([reader.read().catch(() => { throw dropped(); }), quietTooLong]);
    try {
      for (let part = await next(); !part.done; part = await next()) {
        listen();
        received += part.value.byteLength;
        if (received > 1_500_000_000) throw new Error("The download of the new version was larger than the release says it should be, so Branch stopped it and changed nothing. Try the update again.");
        if (!file.write(part.value)) await new Promise<void>((resolve) => file.once("drain", resolve));
        if (total) this.set("downloading", "Downloading the new version…", Math.min(0.99, received / total), release, { received, total });
      }
    } finally {
      clearTimeout(quiet);
      reader.cancel().catch(() => undefined);
      await new Promise<void>((resolve, reject) => file.end((error?: Error | null) => error ? reject(error) : resolve()));
    }
    if (total && received < total) throw dropped();
  }
  /** The SHA-256 published beside the download. */
  private async publishedDigest(release: ReleaseInfo): Promise<string> {
    const response = await this.fetch(release.checksumUrl, { headers: { "user-agent": `BranchAgent/${this.options.currentVersion}` } });
    if (!response.ok) throw new Error("Branch could not read the checksum published with the new version, so it did not install the download. Branch is still on the version it had, and nothing was changed. Check this computer's internet connection and try the update again.");
    const expected = /^([a-f0-9]{64})\b/i.exec((await response.text()).trim())?.[1]?.toLowerCase();
    if (!expected) throw new Error("The checksum published with the new version did not arrive in full, so Branch did not install it. Branch is still on the version it had. Try the update again in a moment.");
    return expected;
  }
  /** A release that must have a record: the record for the published checksum is checked before anything is downloaded. */
  private async provenanceFirst(release: ReleaseInfo): Promise<string> {
    const expected = await this.publishedDigest(release);
    await this.verifyProvenance(release, expected);
    return expected;
  }
  /** `checked`: the published checksum whose provenance record was already checked (provenanceFirst). */
  private async verify(archive: string, release: ReleaseInfo, checked: string | null = null): Promise<void> {
    this.set("verifying", "Checking the download is exactly what was published…", null, release);
    const expected = checked ?? await this.publishedDigest(release);
    const hash = createHash("sha256");
    const { createReadStream } = await import("node:fs");
    for await (const chunk of createReadStream(archive)) hash.update(chunk as Buffer);
    const digestHex = hash.digest("hex");
    if (digestHex !== expected) throw new Error("The download did not match the published checksum, so Branch did not install it. Branch is still on the version it had, and nothing was changed. Try the update again; if it keeps happening, download the new version from the releases page by hand.");
    if (checked === null) await this.verifyProvenance(release, digestHex);
  }
  /**
   * A second check on top of the checksum above: whether GitHub has published a signed build
   * provenance record for this exact file, naming this repository's release workflow at that
   * release's own tag. Releases from package.yml carry one; older releases (0.19.3 and before) do
   * not, so for those having none is not a failure and the update goes on with only the checksum behind it; every
   * release after them must have one (provenanceRequired, provenanceFound). Other kinds of record GitHub
   * publishes for the file (its own release attestation) are not build provenance and count as none.
   * When GitHub cannot be asked (a rate limit, a timeout) or a record cannot be read, the outcome is
   * "not checked", said as such, and the checksum alone stands. A build-provenance record that fails
   * the checks — a different file, some other workflow, a signature that does not verify — stops the
   * update the same way a bad checksum does, because a provenance record that lies is worse than no
   * provenance record at all.
   */
  private async verifyProvenance(release: ReleaseInfo, digestHex: string): Promise<void> {
    this.set("verifying", "Checking for a build provenance record…", null, release);
    let lookup: AttestationLookup | null;
    try {
      // Fetch from the source repo that served this release. Verify against all trusted repos.
      lookup = await fetchAttestationBundles({
        fetch: this.fetch, repo: release.sourceRepo ?? this.options.repo, digestHex,
        userAgent: `BranchAgent/${this.options.currentVersion}`,
      });
    } catch { return this.provenanceFound("not-checked", release); }
    const failures: string[] = [];
    for (const bundle of (lookup?.bundles ?? []).filter(isBuildProvenance)) {
      try {
        // Verify against the trusted repos; don't limit to just the source repo.
        verifyAttestationBundle(bundle, { repo: release.sourceRepo ?? this.options.repo, digestHex, version: release.latestVersion });
        return this.provenanceFound("checked", release);
      } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
    }
    if (failures.length)
      throw new Error(`The download's build provenance record did not check out (${failures[0]}), so Branch did not install it. Branch is still on the version it had, and nothing was changed.`);
    this.provenanceFound(lookup && lookup.unreadable > 0 ? "not-checked" : "none", release);
  }
  private mustHaveProvenance(release: ReleaseInfo): boolean {
    return provenanceRequired(release.latestVersion, this.options.lastReleaseWithoutProvenance);
  }
  private provenanceFound(outcome: ProvenanceOutcome, release: ReleaseInfo): void {
    if (outcome !== "checked" && this.mustHaveProvenance(release)) {
      if (outcome === "none")
        throw new Error(`No build provenance record is published for this download, and every release after ${this.options.lastReleaseWithoutProvenance ?? LAST_RELEASE_WITHOUT_PROVENANCE} has one, so Branch did not install it. Branch is still on the version it had, and nothing was changed.`);
      throw new UpdateDeferredError("This version's build provenance record could not be checked yet (GitHub could not be reached, did not answer in time, or sent a record that could not be read), so the update waits and tries again. Nothing was downloaded or changed.");
    }
    const message = PROVENANCE_WORDS[outcome];
    this.provenance = { outcome, message };
    this.set("verifying", message, null, release);
  }
  private async unpack(archive: string): Promise<string> {
    this.set("unpacking", "Unpacking…", null, this.status.release);
    const into = join(this.options.scratchDir, "unpacked");
    await mkdir(into, { recursive: true });
    await this.extract(archive, into);
    if (this.platform === "darwin") return findBundle(into, this.options.executableName);
    return findExecutableDir(into, this.options.executableName);
  }
  /**
   * selfdev: on Beta a build that passed its check but fails after the swap is put back by itself, always, not
   * only with the never-break switch on: it counts as up only once its engine says so (`markStarted`).
   */
  private startedFile(): string | undefined {
    const version = this.status.release?.latestVersion;
    return this.channel === "beta" && version ? startedMarker(this.options.scratchDir, version) : undefined;
  }
  private async writeScript(stagedDir: string, daemonPid: number | null = null): Promise<string> {
    if (this.platform !== "win32") return this.writePosixScript(stagedDir, daemonPid);
    const script = join(this.options.scratchDir, "apply-update.cmd");
    const install = this.options.installDir!, image = this.options.executableName;
    const exe = join(install, image), previous = `${install}.previous`, log = join(this.options.scratchDir, "apply-update.log");
    const recover = join(this.options.scratchDir, "recover-update.cmd");
    const runOnceKey = this.options.runOnceKey ?? "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce";
    await writeFile(recover, windowsRecoveryScript({ install, previous, failed: `${install}.failed`, incoming: `${install}.incoming`, log, runOnceKey }), "utf8");
    // System32 paths: the script may inherit a PATH where "find" is a Unix tool. tasklist's image
    // filter misses names with spaces, so the CSV listing is searched instead.
    const sys = "%SystemRoot%\\System32\\";
    const mirror = (from: string, to: string, extra = "") => `${sys}robocopy.exe "${from}" "${to}" /MIR${extra} /R:10 /W:1 /NP /NFL /NDL >>"${log}" 2>&1`;
    const running = `${sys}tasklist.exe /NH /FO CSV 2>NUL | ${sys}find.exe /I "${image}" >NUL`;
    // `ping` is used as a sleep because `timeout` exits at once when standard input is not a console.
    const sleep = (seconds: number) => `${sys}ping.exe -n ${seconds + 1} 127.0.0.1 >NUL`;
    const waitFor = (pid: string, label: string, counter: string, what: string) => [
      `set ${counter}=0`, `:${label}`, `${sys}tasklist.exe /FI "PID eq ${pid}" /NH /FO CSV 2>NUL | ${sys}find.exe ",""${pid}""," >NUL`,
      `if not errorlevel 1 if %${counter}% lss 60 ( set /a ${counter}+=1 & ${sleep(1)} & goto ${label} )`,
      `if not errorlevel 1 ( echo [%time%] ${what} still open after %${counter}% waits; ending it >>"${log}" & ${sys}taskkill.exe /PID ${pid} /T /F >NUL 2>&1 & ${sleep(2)} )`,
      `echo [%time%] ${what} closed >>"${log}"`,
    ];
    await writeFile(script, [
      "@echo off", "setlocal", 'set "PID=%~1"', "set TRIES=0", `echo [%date% %time%] update started for pid %PID% >>"${log}"`,
      // The app asked itself to close; if it has not gone within about two minutes, end it so the update still lands.
      ...waitFor("%PID%", "wait", "WAITED", "app"),
      // The engine that keeps working with the window closed holds the same files open, so it is
      // waited for too; it was already asked to close before this script was started.
      ...(daemonPid ? waitFor(String(daemonPid), "engine", "EWAITED", "background engine") : []),
      "set DRAIN=0", ":drain", running, `if not errorlevel 1 if %DRAIN% lss 15 ( set /a DRAIN+=1 & ${sleep(1)} & goto drain )`, sleep(2),
      // mac7/real-update: the first real update showed that mirroring the new files straight over the
      // program folder, when cut off part-way, leaves a folder that is neither version. The new version is
      // now copied in beside the old one and the two folders swap by renaming, which is all or nothing.
      // Only when the folder cannot be renamed (something has it open) is it copied over as before.
      ...windowsSwap({ install, staged: stagedDir, previous, exe, log, sys, mirror, sleep, running, recover, runOnceKey, image,
        started: this.startedFile(),
        archive: join(this.options.scratchDir, this.options.assetName!), unpacked: join(this.options.scratchDir, "unpacked") }),
    ].join("\r\n"), "utf8");
    return script;
  }
  /** Versioned app folders: a downloaded version, unpacked in the scratch folder, moved into its own folder beside this one. */
  private async intoAppFolder(stagedDir: string, version: string): Promise<string> {
    const { root } = this.options.appFolders!;
    const part = partFolder(root, version);
    await removeTree(part);
    await rename(stagedDir, part).catch(async () => { await cp(stagedDir, part, { recursive: true, verbatimSymlinks: true }); await removeTree(stagedDir); });
    return sealAppFolder(root, version, await readPointer(root));
  }
  /**
   * Versioned app folders: the pointers the switch renames, the note the old version reads if the new one does not come
   * up, and the plan the hand-over runner follows to switch and watch it (version-switch.ts). Written only after the window has
   * reached its moment (`handOver`), so the new version starts shown or in the tray exactly as this one was.
   */
  private async writeSwitchScript(stagedDir: string, version: string, release: ReleaseInfo): Promise<string> {
    const { root, folder } = this.options.appFolders!;
    const running = { folder, version: this.options.currentVersion };
    const next = { folder: basename(stagedDir), version };
    this.set("ready", invisibleWaitWords, 1, release);
    const { minimized } = this.options.handOver ? await this.options.handOver({ version, stillWanted: () => !this.calledOff }) : { minimized: false };
    await this.untilUnpaused();
    const files = await pointerFiles(root, running, next);
    const scratch = this.options.scratchDir, exe = this.options.executableName;
    const failure: SwitchFailure = { kept: this.options.currentVersion, tried: version, commit: release.commit ?? null, at: new Date().toISOString(),
      message: `Version ${version} did not open its window within two minutes, so Branch went back to ${this.options.currentVersion} by itself. Your conversations and chat apps kept running. The next change is tried as soon as it lands.` };
    await writeFile(join(scratch, `${failureName}.draft`), JSON.stringify(failure));
    await rm(join(scratch, failureName), { force: true });
    // Read by the hand-over runner (hand-over.ts), which switches from this version's own folder (version-switch.ts).
    const script = join(scratch, "switch-version.json");
    const plan = SwitchPlanSchema.parse({ root, next: files.next, rollback: folder ? files.rollback : null,
      newExe: join(stagedDir, exe), oldExe: join(folderPath(root, folder), exe), pid: process.pid, marker: shellUpMarker(scratch, version),
      failureDraft: join(scratch, `${failureName}.draft`), failure: join(scratch, failureName), log: join(scratch, "apply-update.log"), minimized,
      version, kept: this.options.currentVersion, commit: release.commit ?? null,
      // Going back is refused when the new version has moved the saved work past what this version can read.
      dataDir: this.options.dataDir ?? null, understood: storeMigrations.at(-1)?.version ?? null });
    await writeFile(script, JSON.stringify(plan, null, 2), "utf8");
    return script;
  }
  /** macOS and Linux: the shell hand-over from hand-over.ts, written beside the download. */
  private async writePosixScript(stagedDir: string, daemonPid: number | null): Promise<string> {
    const script = join(this.options.scratchDir, "apply-update.sh");
    await writeFile(script, posixHandOverScript({
      platform: this.platform === "darwin" ? "darwin" : "linux",
      target: this.options.installDir!, staged: stagedDir,
      log: join(this.options.scratchDir, "apply-update.log"),
      executableName: this.options.executableName, daemonPid,
      archive: join(this.options.scratchDir, this.options.assetName!),
      ...(this.startedFile() ? { started: this.startedFile()! } : {}),
    }), { encoding: "utf8", mode: 0o700 });
    return script;
  }
  private set(phase: UpdatePhase, message: string, progress: number | null = null, release: ReleaseInfo | null = this.status.release, bytes: UpdateStatus["bytes"] = null): UpdateStatus {
    this.status = { ...this.fresh(phase, message), progress, release, bytes,
      ...(this.provenance ? { provenance: this.provenance } : {}) };
    this.options.onChange?.(this.status);
    return this.status;
  }
  private fresh(phase: UpdatePhase, message: string): UpdateStatus {
    return { phase, message, installed: this.installed, outcome: null, progress: null, release: null, bytes: null, updatedAt: new Date().toISOString(),
      stages: this.stages?.map((stage) => ({ ...stage })) ?? null, target: this.target ? { ...this.target } : null, failure: null,
      automatic: this.stages ? this.automatic : false, paused: this.stages ? this.paused : null, waitingForTasks: this.waitingForTasks };
  }
  /** Marks the hand-over as running once the script has been launched; the app is about to close and restart. */
  applying(): UpdateStatus {
    this.busy = true;
    note("info", "Handing over: closing to finish the update");
    this.stage("restarting");
    return this.set("applying", "Closing to finish the update. The app opens again by itself in a moment.", 1, this.status.release);
  }
}

const packagedManifestSchema = z.object({ name: z.literal("branch-agent"), version: z.string() }).passthrough();

/** The bytes inside the archive must identify the same Branch release GitHub selected. */
export async function validateStagedPackage(stagedDir: string, expectedVersion: string, platform: NodeJS.Platform): Promise<void> {
  const manifest = platform === "darwin"
    ? join(stagedDir, "Contents", "Resources", "app", "package.json")
    : join(stagedDir, "resources", "app", "package.json");
  let raw: unknown;
  try { raw = JSON.parse(await readFile(manifest, "utf8")); }
  catch { throw new Error("The download did not contain a readable Branch Agent package identity, so nothing was changed."); }
  const parsed = packagedManifestSchema.safeParse(raw);
  if (!parsed.success) throw new Error("The download is not a Branch Agent package, so nothing was changed.");
  if (parsed.data.version !== expectedVersion)
    throw new Error(`The download contains version ${parsed.data.version}, but the selected release is ${expectedVersion}, so nothing was changed.`);
}

export { windowsKeep };

interface WindowsSwapPlan {
  install: string; staged: string; previous: string; exe: string; log: string; sys: string; archive: string; unpacked: string;
  mirror: (from: string, to: string, extra?: string) => string; sleep: (seconds: number) => string; running: string;
  /** selfdev (Beta): the file the new version writes once its engine is up; see `posixHandOverScript`'s `started`. */
  started?: string | undefined;
  /** The program's file name, for ending a new version that never said it was up. */
  image?: string;
  /** The script that puts a whole version back at the next sign-in if this one is cut off between the two renames. */
  recover: string;
  /** Where that script is registered to run once (HKCU RunOnce; tests hand in their own key). */
  runOnceKey: string;
}

/** selfdev: where a new version says its engine is up, for the hand-over script to see (Beta). */
export function startedMarker(scratchDir: string, version: string): string {
  return join(scratchDir, `started-${version.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 60)}`);
}
/** selfdev: written by the app once its engine is up; harmless when no update is waiting for it. */
export async function markStarted(scratchDir: string, version: string): Promise<void> {
  await mkdir(scratchDir, { recursive: true });
  await writeFile(startedMarker(scratchDir, version), new Date().toISOString(), "utf8");
}

/** The value name under RunOnce; removed again as soon as the folders are whole. */
export const recoveryValueName = "Branch Agent update recovery";

/**
 * mac7/real-update, integrator review. Between the two renames there is no program folder at all, and
 * the Start menu shortcut points into it. That moment is milliseconds long, but a power cut or a sign
 * out there would leave nothing to start, so the script below is registered to run once at the next
 * sign-in first and taken off again straight after. It only acts when the program folder is missing,
 * and then moves the previous version (which still has everything) back.
 */
export function windowsRecoveryScript(plan: { install: string; previous: string; failed: string; incoming: string; log: string; runOnceKey: string }): string {
  const { install } = plan;
  const back = (from: string) => `if not exist "${install}\\" if exist "${from}\\" move "${from}" "${install}" >NUL 2>&1`;
  return [
    "@echo off", `if exist "${install}\\" exit /b 0`,
    `echo [%date% %time%] the last update was cut off with no program folder; putting a whole version back >>"${plan.log}"`,
    back(plan.previous), back(plan.incoming), back(plan.failed),
    `%SystemRoot%\\System32\\reg.exe delete "${plan.runOnceKey}" /v "${recoveryValueName}" /f >NUL 2>&1`, "exit /b 0", "",
  ].join("\r\n");
}

/** The Windows swap: copy beside, rename twice, carry what is kept; the copy over the folder is the fallback. */
export function windowsSwap(plan: WindowsSwapPlan): string[] {
  const { install, previous, log, exe } = plan;
  const incoming = `${install}.incoming`, failed = `${install}.failed`, folder = windowsKeep.folder;
  const note = (text: string) => `echo [%time%] ${text} >>"${log}"`;
  const reg = `${plan.sys}reg.exe`;
  // Armed only for the two renames, so a cut there is put right at the next sign-in.
  const arm = `${reg} add "${plan.runOnceKey}" /v "${recoveryValueName}" /t REG_SZ /d "\\"${plan.recover}\\"" /f >NUL 2>&1`;
  const disarm = `${reg} delete "${plan.runOnceKey}" /v "${recoveryValueName}" /f >NUL 2>&1`;
  // A folder move onto one that exists nests instead of replacing, so Branch Data only moves into a copy without one.
  const carry = (from: string, to: string) => [
    ...windowsKeep.files.map((f) => `if exist "${from}\\${f}" copy /y "${from}\\${f}" "${to}\\" >NUL`),
    `if exist "${from}\\${folder}\\" if not exist "${to}\\${folder}\\" move "${from}\\${folder}" "${to}\\${folder}" >NUL`,
  ];
  return [
    ":copy", "set /a TRIES+=1", note("copying new version beside the old one, attempt %TRIES%"),
    `rmdir /s /q "${incoming}" 2>NUL`, plan.mirror(plan.staged, incoming),
    `if errorlevel 8 ( if %TRIES% lss 3 ( ${plan.sleep(3)} & goto copy ) else ( ${note("copy failed; nothing was changed")} & rmdir /s /q "${incoming}" 2>NUL & start "" "${exe}" & exit /b 1 ) )`,
    `call :drop "${previous}-2"`,
    `if exist "${previous}\\" if not exist "${previous}-2\\" move "${previous}" "${previous}-2" >NUL`,
    note("keeping previous version"),
    // A previous copy that could not be moved aside would swallow the program folder as a subfolder.
    `if exist "${previous}\\" goto inplace`,
    arm, `move "${install}" "${previous}" >NUL 2>&1`, `if errorlevel 1 ( ${disarm} & goto inplace )`,
    `move "${incoming}" "${install}" >NUL 2>&1`,
    `if errorlevel 1 ( ${note("new version could not be moved in; restoring previous")} & move "${previous}" "${install}" >NUL & ${disarm} & start "" "${exe}" & exit /b 1 )`,
    disarm, ...carry(previous, install), "goto swapped",
    ":inplace", note("the program folder is in use; copying over it instead"),
    plan.mirror(install, previous, windowsKeepOut), `if errorlevel 8 ( ${note("could not keep the previous version; nothing was changed")} & start "" "${exe}" & exit /b 1 )`,
    plan.mirror(incoming, install, windowsKeepOut), `if errorlevel 8 goto restore`, `rmdir /s /q "${incoming}" 2>NUL`,
    ":swapped",
    'if "%~2"=="stay" exit /b 0',
    ...(plan.started ? [`del /q "${plan.started}" 2>NUL`] : []),
    note("starting new version"), `start "" "${exe}"`, plan.sleep(20),
    // selfdev (Beta): up means it said so (its engine started) within about ninety seconds and is still running.
    ...(plan.started ? ["set UPWAIT=0", ":upwait", `if exist "${plan.started}" goto upcheck`,
      `if %UPWAIT% lss 70 ( set /a UPWAIT+=1 & ${plan.sleep(1)} & goto upwait )`,
      note("new version did not say it was up; ending it"), `${plan.sys}taskkill.exe /IM "${plan.image}" /T /F >NUL 2>&1`, plan.sleep(2), "goto restore",
      ":upcheck", plan.running, "if not errorlevel 1 goto done", "goto restore"] : []),
    plan.running, "if not errorlevel 1 goto done",
    plan.sleep(15), plan.running, "if not errorlevel 1 goto done",
    ":restore", note("new version did not start; restoring previous"),
    `call :drop "${failed}"`, `if exist "${failed}\\" goto restorecopy`,
    arm, `move "${install}" "${failed}" >NUL 2>&1`, `if errorlevel 1 ( ${disarm} & goto restorecopy )`,
    `move "${previous}" "${install}" >NUL 2>&1`, `if errorlevel 1 ( move "${failed}" "${install}" >NUL & ${disarm} & goto restorecopy )`,
    disarm, ...carry(failed, install), "goto restored",
    ":restorecopy", plan.mirror(previous, install, windowsKeepOut),
    ":restored", note("previous version is back"), `start "" "${exe}"`, "exit /b 1",
    ":done", note("new version is running"), `rmdir /s /q "${plan.unpacked}" 2>NUL`, `del /q "${plan.archive}" 2>NUL`, "exit /b 0",
    // Removes an old copy, first moving any Branch Data left in it out beside the program; keeps the copy when that fails.
    ":drop", `if not exist "%~1\\" exit /b 0`,
    `if exist "%~1\\${folder}\\" move "%~1\\${folder}" "${install} - saved ${folder} %RANDOM%" >NUL 2>&1`,
    `if exist "%~1\\${folder}\\" ( ${note("kept %~1 because it holds " + folder)} & exit /b 1 )`,
    `rmdir /s /q "%~1" 2>NUL`, "exit /b 0", "",
  ];
}

/**
 * The app-wide install lock: a file naming the process installing. One whose process has ended is stale and taken
 * over; one whose process runs means another part of Branch is installing, and this install waits (said, not failed).
 * Answers how to give it back.
 */
export async function installLock(path: string, pid = process.pid): Promise<() => Promise<void>> {
  const { open, readFile: read, rm: remove } = await import("node:fs/promises");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, "wx");
      await file.writeFile(String(pid)); await file.close();
      return async () => { const owner = Number(await read(path, "utf8").catch(() => "")); if (owner === pid) await remove(path, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(await read(path, "utf8").catch(() => ""));
      let alive = false;
      try { if (owner > 0 && owner !== pid) { process.kill(owner, 0); alive = true; } } catch (probe) { alive = (probe as NodeJS.ErrnoException).code === "EPERM"; }
      if (alive) throw new UpdateDeferredError("Another part of Branch is installing an update right now, so this one waits for it.");
      await remove(path, { force: true });
    }
  }
  throw new UpdateDeferredError("Branch could not take the update lock, so the update waits.");
}

/** hot-update: how long a live update took, as the status says it ("1.4 s", "38 s"). */
export const liveSeconds = (ms: number): string => `${ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)} s`;
/** hot-update: what the status says while a live update builds (the same words as a packaged Beta build's steps). */
const liveWords: Record<DevStage, string> = {
  fetching: "Getting the newest change from GitHub…",
  installing: "Installing the packages Branch builds with…",
  building: "Building Branch on this computer…",
};

const systemName = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "Windows" : platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : "this computer's";

/** Why this copy cannot update itself, in plain words, or null when it can. */
function unsupportedReason(options: UpdaterOptions, platform: NodeJS.Platform): string | null {
  if (!options.assetName) return "Automatic updates are not available for this kind of computer yet. Download the newest version from GitHub instead.";
  if (options.packageType === "deb")
    return "This copy was installed from the .deb package, so it is updated by installing the newest .deb from the releases page.";
  if (options.packageType === "appimage")
    return "This copy is an AppImage, so it is updated by downloading the newest AppImage from the releases page.";
  if (options.installDir) return null;
  if (platform === "win32") return "Updates apply to the installed app only.";
  if (options.packaged && platform === "darwin")
    return "Updates apply to the installed app only. Move Branch Agent into your Applications folder, open it from there, and try again.";
  return "Updates apply to the installed app only. This copy is running from its source code, so update it with `branch update` instead.";
}

/**
 * macOS and Linux: the scratch folder can sit in a temp folder other people can write to (/tmp on
 * Linux), so it must be a real folder owned by this person and closed to everyone else before the
 * download and the hand-over script go into it.
 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  const info = await lstat(dir);
  const uid = process.getuid?.();
  if (!info.isDirectory() || info.isSymbolicLink() || (uid !== undefined && info.uid !== uid))
    throw new Error("The update folder is not safe to use (it belongs to someone else). Restart the computer and try again.");
  await chmod(dir, 0o700);
}

/** macOS: the unpacked `.app` bundle itself, wherever it sits in the download. */
async function findBundle(root: string, bundleName: string): Promise<string> {
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift()!;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === bundleName) return join(dir, entry.name);
      if (!entry.name.endsWith(".app")) queue.push(join(dir, entry.name));
    }
  }
  throw new Error("The download did not contain a Branch to install, so nothing was changed. Branch is still on the version it had. Try the update again.");
}

async function findExecutableDir(root: string, executableName: string): Promise<string> {
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift()!;
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === executableName)) return dir;
    for (const entry of entries) if (entry.isDirectory()) queue.push(join(dir, entry.name));
  }
  throw new Error("The download did not contain a Branch to install, so nothing was changed. Branch is still on the version it had. Try the update again.");
}
type RunFile = (file: string, args: string[]) => Promise<unknown>;
const runFile: RunFile = (file, args) => promisify(execFile)(file, args, { maxBuffer: 1048576 });

/**
 * The unpack command for macOS and Linux. macOS uses ditto, which keeps the links and permissions
 * inside an app bundle that plain unzip would break.
 */
export function posixExtractCommand(platform: NodeJS.Platform, archive: string, into: string): [string, string[]] {
  if (platform === "darwin") return ["/usr/bin/ditto", ["-x", "-k", archive, into]];
  return ["tar", ["-xzf", archive, "-C", into]];
}

export async function expandArchive(archive: string, into: string, platform: NodeJS.Platform = process.platform, run: RunFile = runFile): Promise<void> {
  if (platform !== "win32") {
    const [file, args] = posixExtractCommand(platform, archive, into);
    await run(file, args);
    await stat(into);
    return;
  }
  await expandWindowsArchive(archive, into);
}

/** Unpacks with the built-in tar (fast) and falls back to PowerShell's Expand-Archive when tar is missing. */
async function expandWindowsArchive(archive: string, into: string): Promise<void> {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const tar = join(root, "System32", "tar.exe");
  try {
    await stat(tar);
    await promisify(execFile)(tar, ["-xf", archive, "-C", into], { windowsHide: true, maxBuffer: 1048576 });
  } catch {
    await promisify(execFile)("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      "Expand-Archive -LiteralPath $env:BRANCH_ARCHIVE -DestinationPath $env:BRANCH_INTO -Force",
    ], { env: { ...process.env, BRANCH_ARCHIVE: archive, BRANCH_INTO: into }, windowsHide: true, maxBuffer: 1048576 });
  }
  await stat(into);
}
