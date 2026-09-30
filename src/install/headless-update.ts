import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Updater, type UpdaterOptions } from "../desktop/updater.js";
import { appEntryName, releaseAssetName } from "../desktop/release-assets.js";
import { snapshotData, updateCanary } from "../never-break/canary.js";
import {
  activationJournalName, databaseFormat, fingerprintTree, openActivationJournal, type ActivationRecord,
} from "../never-break/activation.js";
import { assertFormatReadable, dataOpenError, storeMigrations } from "../never-break/migrations.js";
import { Store } from "../store.js";
import { requestUpdateBackup } from "./background-engine.js";
import { databaseName } from "./layout.js";
import { quitRunning, runningNow, type QuitReport } from "./quit.js";
import { sessionTokenFileName, type RunningInstance } from "./running.js";
import { writeUpdateBackup } from "./update-backup.js";
import { takeDataCopy } from "./data-copy.js";
import { restartService, waitForReturn, type ReturnDeps } from "./service-return.js";
import { openWindow, rollbackCommand } from "./rollback-cli.js";

/**
 * `branch update --yes`: the app's Update button without the window. It uses the same updater, so the
 * download is checked against its published checksum, the new version is tried on a copy of the
 * work when that switch is on, a safety copy is written first, and the same hand-over script swaps
 * the files and keeps the version before as `<name>.previous`, logging to the same file. Branch is
 * closed for the swap and opened again only if its window was open before.
 */

import { primaryRepo } from "../desktop/repo-pair.js";

/**
 * The same repository the app's Update button reads (`updateSource` in src/desktop/updater-ipc.ts).
 * Uses the primary repo from the trusted pair, with fallback to the other on 404.
 * Note: for backward compatibility during the transfer, this points to the primary repo.
 * The Updater class implements the fallback logic internally.
 */
export const releaseRepo = primaryRepo;

export interface HeadlessUpdateInput {
  installRoot: string;
  dataDir: string;
  version: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** False only checks and says what would happen. */
  yes: boolean;
  print: (line: string) => void;
  deps?: HeadlessUpdateDeps;
}
export interface HeadlessUpdateDeps {
  fetch?: typeof fetch;
  extract?: UpdaterOptions["extract"];
  /** UpdaterOptions.lastReleaseWithoutProvenance: a test of another step names its own release. */
  lastReleaseWithoutProvenance?: string;
  scratchDir?: string;
  quit?: (dataDir: string) => Promise<QuitReport>;
  /** Runs the hand-over script and answers with its exit code. */
  runScript?: (script: string, args: string[]) => number;
  running?: (dataDir: string) => Promise<RunningInstance | null>;
  backup?: () => Promise<void>;
  snapshot?: () => Promise<string>;
  /** Starts the background service again through its manager (launchctl, systemctl, the scheduled task). */
  restartService?: () => Promise<void>;
  /** How long, and how, to wait for the new version to say it is running. */
  returnWait?: ReturnDeps;
  /** Goes back to the version before; answers with an exit code. */
  rollback?: (restart: () => Promise<void>) => Promise<number>;
  /** Writes down what this update is about to change; a test makes it fail after the stop. */
  record?: typeof recordActivation;
  /** Opens the installed Branch as a window again, when a window is what was running. */
  launch?: (target: string, executableName: string) => void | Promise<void>;
}

/** The safety copies this data folder holds, newest last, so a refusal can name one. */
async function backupPaths(dataDir: string): Promise<string[]> {
  const { listUpdateBackups } = await import("./update-backup.js");
  return listUpdateBackups(dataDir).then((points) => points.map((one) => one.path).reverse(), () => []);
}

async function engineCall(dataDir: string, note: RunningInstance, path: string): Promise<Response> {
  const token = (await readFile(join(dataDir, sessionTokenFileName), "utf8")).trim();
  return fetch(`${note.url}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}", signal: AbortSignal.timeout(180000) });
}

/**
 * Opens the saved work directly, for when nothing is running that holds it. mac7/install-torture:
 * the format is read first, so an older `branch update --yes` run against work a newer Branch saved
 * refuses while that work is still untouched — the store's own opening rewrites tasks that were
 * running, throws temporary sessions away and adds columns, all before anything could refuse.
 */
async function withStore<T>(dataDir: string, use: (store: Store) => Promise<T>): Promise<T> {
  const path = join(dataDir, databaseName);
  assertFormatReadable(path, storeMigrations);
  let store: Store;
  try { store = new Store(path); }
  catch (error) { throw dataOpenError(path, error); }
  try { return await use(store); } finally { store.close(); }
}

/** The safety copy: asked of the running engine, or written here when nothing is running. */
function defaultBackup(dataDir: string, version: string, note: RunningInstance | null, print: (line: string) => void): () => Promise<void> {
  return async () => {
    if (note) {
      const token = (await readFile(join(dataDir, sessionTokenFileName), "utf8")).trim();
      return requestUpdateBackup(note.url, token);
    }
    if (!existsSync(join(dataDir, databaseName))) { print("There is no saved work yet, so no safety copy was needed."); return; }
    await withStore(dataDir, async (store) => { await writeUpdateBackup(dataDir, store.backup(version), version); });
    await takeDataCopy({ dataDir, version }); // the whole data folder too (src/install/data-copy.ts)
  };
}

function defaultSnapshot(dataDir: string, note: RunningInstance | null): () => Promise<string> {
  return async () => {
    if (!note) return withStore(dataDir, (store) => snapshotData({ dataDir, database: store.sqlite }));
    const response = await engineCall(dataDir, note, "/api/never-break/snapshot");
    const body = await response.json().catch(() => null) as { folder?: unknown } | null;
    if (!response.ok || typeof body?.folder !== "string") throw new Error("The running Branch did not make a copy of your work.");
    return body.folder;
  };
}

/**
 * mac7/safe-rollback: writes down what this update is about to change, before a single file moves.
 * The fingerprints are taken of the program that is there now (which the hand-over keeps as
 * `<target>.previous`) and of the unpacked version that will replace it, so an undo can tell whether
 * either has moved since. `understood` is read here, in the version that is still running, because
 * it is that version's reach that decides whether going back stays safe.
 *
 * It is written with the same rule as the task journal: a record that cannot be written stops the
 * update, because an update nobody can undo is not one worth making. The entry stays `staged` until
 * something has seen the swap land: `branch update --yes` sees the hand-over's exit code, and the
 * app's Update button, which quits into the script, leaves it to the next start (`settleActivation`).
 */
export async function recordActivation(input: {
  dataDir: string; installRoot: string; stagedDir: string; fromVersion: string; toVersion: string;
  executableName: string;
}): Promise<{ id: number; activated: () => void; failed: () => void; close: () => void }> {
  const { journal } = openActivationJournal(join(input.dataDir, activationJournalName));
  try {
    const [previous, candidate] = await Promise.all([
      fingerprintTree(input.installRoot).catch(() => null),
      fingerprintTree(input.stagedDir).catch(() => null),
    ]);
    let store: { version: number; readableBy: number } | null = null;
    if (existsSync(join(input.dataDir, databaseName)))
      store = await withStore(input.dataDir, async (opened) => databaseFormat(opened.sqlite)).catch(() => null);
    const record: ActivationRecord = {
      kind: "update", fromVersion: input.fromVersion, toVersion: input.toVersion, target: input.installRoot,
      previous, candidate, launcher: null, executableName: input.executableName,
      understood: storeMigrations.at(-1)?.version ?? 0,
      databases: store ? [{ name: databaseName, before: store, after: store, ran: [], backup: null }] : [],
      backups: await backupPaths(input.dataDir),
    };
    const id = journal.stage(record);
    return {
      id,
      activated: () => { try { journal.activated(id); } catch { /* the swap already happened; the record is best effort from here */ } },
      failed: () => { try { journal.failed(id); } catch { /* see above */ } },
      close: () => journal.close(),
    };
  } catch (error) { journal.close(); throw error; }
}

/** A process id that has already ended, so the hand-over script does not wait for anything. */
const endedPid = (): number => spawnSync("/bin/sh", ["-c", "exit 0"]).pid ?? 0;
const runSh = (script: string, args: string[]): number => spawnSync("/bin/sh", [script, ...args], { stdio: "ignore" }).status ?? 1;

function makeUpdater(input: HeadlessUpdateInput, note: RunningInstance | null, stopped: { report: QuitReport | null }): Updater {
  const platform = input.platform ?? process.platform, deps = input.deps ?? {};
  const executableName = appEntryName(platform);
  return new Updater({
    repo: releaseRepo, currentVersion: input.version, installDir: input.installRoot, executableName,
    assetName: releaseAssetName(platform, input.arch ?? process.arch), packaged: true, platform,
    scratchDir: deps.scratchDir ?? join(tmpdir(), "branch-agent-update"),
    ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.extract ? { extract: deps.extract } : {}),
    ...(deps.lastReleaseWithoutProvenance ? { lastReleaseWithoutProvenance: deps.lastReleaseWithoutProvenance } : {}),
    backup: deps.backup ?? defaultBackup(input.dataDir, input.version, note, input.print),
    canary: updateCanary({ dataDir: input.dataDir, platform, executableName, fromVersion: input.version,
      target: input.installRoot, snapshot: deps.snapshot ?? defaultSnapshot(input.dataDir, note) }),
    stopDaemon: async () => {
      // A Branch that would not close stops the update below; it is never ended mid-work to make room.
      // A stop that fails outright counts as "would not close": the swap must never run under a live Branch.
      stopped.report = await (deps.quit ?? quitRunning)(input.dataDir).catch((error: unknown) => ({
        stopped: false, wasRunning: true, pid: null,
        message: `Branch Agent could not be closed (${error instanceof Error ? error.message : String(error)}).`,
      }));
      return stopped.report.stopped ? stopped.report.pid : null;
    },
  });
}

/** Checks, and with `yes` installs, the newest release. Answers with the exit code. */
export async function headlessUpdate(input: HeadlessUpdateInput): Promise<number> {
  const platform = input.platform ?? process.platform, deps = input.deps ?? {};
  if (platform === "win32") {
    input.print("On Windows, update from the app: Settings, Updates. `branch update --yes` works on macOS and Linux.");
    return 1;
  }
  const note = await (deps.running ?? runningNow)(input.dataDir);
  const stopped: { report: QuitReport | null } = { report: null };
  const updater = makeUpdater(input, note, stopped);
  const status = await updater.check();
  if (status.phase !== "available") { input.print(status.message); return status.phase === "current" ? 0 : 1; }
  const to = status.release!.latestVersion;
  if (!input.yes) { input.print(`Version ${to} is ready (you have ${input.version}). Run \`branch update --yes\` to install it.`); return 0; }
  input.print(`Updating Branch Agent from ${input.version} to ${to}...`);
  const installed = await updater.install().catch((error: unknown) => {
    input.print(error instanceof Error ? error.message : String(error));
    return { script: null, stagedDir: "" };
  });
  // The terminal's update is always the packaged one: it hands the updater no live hooks (src/hot-update/).
  if ("live" in installed) { input.print(installed.live.words); return 0; }
  const { script, stagedDir } = installed;
  if (!script) return 1;
  if (!stopped.report || !stopped.report.stopped) {
    input.print(`${stopped.report?.message ?? "Branch Agent was not closed."} Nothing was changed; the update can be run again once Branch has closed.`);
    return 1;
  }
  // mac7/safe-rollback: what this update changes is written down before anything moves.
  let activation: Awaited<ReturnType<typeof recordActivation>> | null = null;
  try {
    activation = await (deps.record ?? recordActivation)({ dataDir: input.dataDir, installRoot: input.installRoot, stagedDir,
      fromVersion: input.version, toVersion: to, executableName: appEntryName(platform) });
  } catch (error) {
    input.print(`${error instanceof Error ? error.message : String(error)} Nothing was changed.`);
    // Nothing on disk was changed — but the service was already stopped to make the change, and
    // writing down what an update would do is a disk write like any other. Leaving here is the exact
    // down-service condition the rest of this file exists to prevent, arrived at through the one
    // door that had no recovery behind it.
    // Not `serviceBack`: that falls back to putting the version before back, and there is nothing to
    // put back. Nothing was written down, so `branch rollback` has no record to work from and would
    // answer "there is no record of an update to go back from". Reaching for it here would offer the
    // owner a way out that does not exist. What can be done is to start the version that is still
    // installed -- the files were never touched -- and to say plainly when even that will not come
    // up, because a stopped service nobody is told about is the whole failure.
    if (stopped.report?.wasRunning && note) await putBackWhatWasRunning(input, note);
    // The service being back is the least this owes them, never a successful update.
    return 1;
  }
  // The stop already happened (and was waited for) in the updater, so the script waits for nothing.
  const reopen = stopped.report?.wasRunning === true && note?.mode === "app";
  const code = (deps.runScript ?? runSh)(script, [String(stopped.report?.pid ?? endedPid()), ...(reopen ? [] : ["stay"])]);
  const log = join(deps.scratchDir ?? join(tmpdir(), "branch-agent-update"), "apply-update.log");
  if (code !== 0) {
    activation.failed();
    activation.close();
    input.print(`The update did not finish, so Branch stays on the version it had. What happened is in ${log}.`);
    // The hand-over has already closed the service and told the script not to reopen it. Stopping
    // here would leave the owner with the version they had and nothing running it, which is the
    // one outcome none of this is allowed to produce. So the same recovery runs, for the version
    // that is still installed — but the update still failed, and the answer given to whatever asked
    // for it says so. Recovering the old service is the least this owes them, not a success.
    if (stopped.report?.wasRunning && note)
      await putBackAfterScript(input, note, log);
    return 1;
  }
  activation.activated();
  activation.close();
  input.print(`Updated Branch Agent from ${input.version} to ${to}. The version before is kept beside it. Log: ${log}`);
  if (stopped.report?.wasRunning && note?.mode === "daemon") return serviceBack(input, note, to, log);
  return 0;
}

/**
 * A Branch that was working in the background comes back by itself on the new version, and when it
 * does not come up the version before is put back and started instead: the owner is never left with
 * no Branch running.
 */
/**
 * Starts the version that is still installed, for a failure that happened after the stop and before
 * anything moved. There is no way back to offer and none is implied: either the service answers for
 * itself on the version it was already running, or the owner is told it is not running and how to
 * start it.
 */
/**
 * What to do after the hand-over script failed. The script can fail **before** it launches anything
 * and **after** it has put the previous version back and launched it — and nothing in the exit code
 * tells the two apart. Reopening either way is wrong half the time: once it leaves the owner with
 * nothing running, once it leaves them with two windows.
 *
 * So it is not guessed. A background service is asked to come back and has to answer for itself, as
 * it always did. A window is looked for first: if Branch is already running, the script got far
 * enough and nothing more is done; if nothing is running, the window is opened.
 */
async function putBackAfterScript(input: HeadlessUpdateInput, before: RunningInstance, log: string): Promise<void> {
  if (before.mode === "daemon") { await serviceBack(input, before, input.version, log); return; }
  const deps = input.deps ?? {};
  // "Some other process id is running" is not the window being back, and the note on disk is written
  // by whatever started -- so a background service, or a note left by anything at all, would have
  // satisfied it. The same proof the forward update already demands: the right kind of Branch, on
  // the version that is still installed, started since the one we closed, answering for itself.
  const back = await waitForReturn(input.dataDir, { pid: before.pid, startedAt: before.startedAt },
    { version: input.version, mode: "app" }, { ...deps.returnWait, waitMs: deps.returnWait?.waitMs ?? 2000 });
  if (back) {
    input.print(`Branch is open again, on version ${input.version}.`);
    return;
  }
  await putBackWhatWasRunning(input, before);
}

async function putBackWhatWasRunning(input: HeadlessUpdateInput, before: RunningInstance): Promise<void> {
  const deps = input.deps ?? {}, platform = input.platform ?? process.platform;
  // A window is put back as a window. The hand-over script is what normally reopens one, and this
  // failure happens before there is a script to run, so nothing else in this path will do it -- the
  // owner's window closed, the update stopped, and the words on the screen said nothing had changed.
  // Nothing on disk had. Their window was still gone.
  if (before.mode === "app") {
    try {
      await (deps.launch ?? openWindow)(input.installRoot, appEntryName(platform));
      input.print(`Branch has been opened again, on version ${input.version}.`);
    } catch (error) {
      input.print(`Branch could not be opened again (${error instanceof Error ? error.message : String(error)}). `
        + `Nothing on this computer was changed, so version ${input.version} is still the one installed: `
        + "open Branch as you normally would.");
    }
    return;
  }
  const restart = deps.restartService ?? (() => restartService(platform));
  const started = await restart().then(() => true, () => false);
  if (started && await waitForReturn(input.dataDir, { pid: before.pid, startedAt: before.startedAt },
    { version: input.version }, deps.returnWait)) {
    input.print(`Branch is working in the background again, on version ${input.version}.`);
    return;
  }
  input.print(`Branch is not running in the background. Nothing on this computer was changed, so version `
    + `${input.version} is still the one installed: start it with \`branch start\`.`);
}

async function serviceBack(
  input: HeadlessUpdateInput, before: RunningInstance, expected: string, log: string,
): Promise<number> {
  const deps = input.deps ?? {}, platform = input.platform ?? process.platform;
  const restart = deps.restartService ?? (() => restartService(platform));
  const started = await restart().then(() => true, () => false);
  if (started && (await waitForReturn(input.dataDir, before, { version: expected }, deps.returnWait))) {
    input.print(`Branch is working in the background again, on version ${expected}.`);
    return 0;
  }
  input.print(`Version ${expected} did not come back up in the background, so Branch is going back to the version it had. Log: ${log}`);
  // What was running before this started is carried into the undo. By now nothing is running — that is
  // the whole reason we are here — so asking the disk again would answer "nothing was running" and the
  // undo would put the files back and start nothing.
  const rollback = deps.rollback ?? ((again: () => Promise<void>) => rollbackCommand({
    dataDir: input.dataDir, version: expected, yes: true, platform, print: input.print,
    deps: { restartService: again, wasRunning: before },
  }));
  const code = await rollback(restart).catch(() => 1);
  if (code !== 0) input.print("Going back did not finish either. Start Branch with `branch start`, or see what happened with `branch rollback`.");
  return 1;
}
