import { spawn } from "node:child_process";
import { constants, setPriority } from "node:os";
import { copyFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { gatewayFile, loadGatewayConfig, writeAtomic } from "./gateway-config.js";
import { repairRollback } from "./rollback.js";
import { storeMigrations } from "./migrations.js";

/** What `branch start` writes in self-test mode (see self-test.ts). */
export interface SelfTestCheck { name: string; ok: boolean; detail: string }
export interface SelfTestReport { ok: boolean; version: string; contract: number; format: number | null; checks: SelfTestCheck[] }
export async function readSelfTest(path: string): Promise<SelfTestReport | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as SelfTestReport; } catch { return null; }
}
export const selfTestReportName = (folder: string): string => join(folder, "self-test.json");

/**
 * Blue/green updates. The new version is unpacked beside the current one (the updater does that),
 * then started here as a canary: its own runtime and engine, on a copy of the owner's data, in
 * self-test mode. Only a clean report lets the swap go ahead. After the swap, `update-watch.json`
 * tells the new gateway to watch the first minutes and roll back if the new version does not stay
 * up. See docs/never-break.md, threats 5–7.
 */
export const watchFile = "update-watch.json";
export const canaryFolder = "updates";

/** Where the engine and the runtime sit inside an unpacked release. */
export function stagedEngine(stagedDir: string, platform: NodeJS.Platform, executableName: string): { executable: string; script: string } {
  // The release's own system decides the separator, not the computer this runs on (tests ask for all three).
  const { join } = platform === "win32" ? win32 : posix;
  if (platform === "darwin") {
    const contents = join(stagedDir, "Contents");
    return { executable: join(contents, "MacOS", executableName.replace(/\.app$/, "")), script: join(contents, "Resources", "app", "dist", "cli.js") };
  }
  return { executable: join(stagedDir, executableName), script: join(stagedDir, "resources", "app", "dist", "cli.js") };
}

/**
 * A copy of the saved work for the canary, taken by the process that holds the database (which is
 * the only one that can). The device key goes with it so saved secrets still open; the copy lives
 * in the data folder, closed to everyone else, and is removed when the canary is done.
 */
export async function snapshotData(input: { dataDir: string; database: DatabaseSync; journal?: DatabaseSync | null; at?: Date }): Promise<string> {
  const stamp = (input.at ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const folder = join(input.dataDir, canaryFolder, `canary-${stamp}`, "data");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const into = (path: string) => `VACUUM INTO '${path.replace(/'/g, "''")}'`;
  input.database.exec(into(join(folder, "branch.sqlite")));
  input.journal?.exec(into(join(folder, "journal.sqlite")));
  for (const name of ["locker.key", gatewayFile]) await copyFile(join(input.dataDir, name), join(folder, name)).catch(() => undefined);
  return folder;
}

export interface CanaryInput {
  engine: { executable: string; script: string };
  /** The copied data folder (from `snapshotData`), removed afterwards together with its parent. */
  dataCopy: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Release version selected by the updater; the new engine must report this exact value. */
  expectedVersion?: string;
}
export interface CanaryResult { ok: boolean; detail: string; report: SelfTestReport | null }

/** No gateway, resume or chat-app settings reach the copy: its chat bots would read the owner's real messages. */
const clean = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !/^BRANCH_(GATEWAY|RESUME|SELF_TEST|INTEGRATIONS)/.test(name) && name !== "NODE_TEST_CONTEXT"));

/** The copy must be one `snapshotData` made, inside the data folder's update area; anything else is refused before it is used or removed. */
export function isCanaryCopy(dataDir: string, folder: string): boolean {
  const rel = relative(resolve(dataDir, canaryFolder), resolve(folder));
  const parts = rel.split(/[\\/]/);
  return !isAbsolute(rel) && parts.length === 2 && /^canary-[0-9TZ-]+$/.test(parts[0]!) && parts[1] === "data";
}

/** Starts the new version on the copy and reads its verdict. Nothing of the running install is touched. */
export async function runCanary(input: CanaryInput): Promise<CanaryResult> {
  const folder = join(input.dataCopy, "..");
  const report = selfTestReportName(folder);
  try {
    await stat(input.engine.script).catch(() => { throw new Error("The new version's engine was not found in the download."); });
    const env = { ...clean(input.env ?? process.env), ELECTRON_RUN_AS_NODE: "1", BRANCH_SELF_TEST: report,
      BRANCH_DATA_DIR: input.dataCopy, BRANCH_WORKSPACE: join(folder, "workspace"), BRANCH_PORT: "0" };
    const exit = await started(input.engine, env, input.timeoutMs ?? 180_000);
    const result = await readSelfTest(report);
    if (!result) return { ok: false, detail: `The new version did not finish its check (${exit}).`, report: null };
    if (input.expectedVersion && result.version !== input.expectedVersion)
      return { ok: false, detail: `The new engine reported version ${result.version}, but the update expected ${input.expectedVersion}.`, report: result };
    const failed = result.checks.filter((one) => !one.ok);
    return { ok: result.ok, report: result, detail: result.ok
      ? `Version ${result.version} passed its check on a copy of your work.`
      : `Version ${result.version} failed its check on a copy of your work: ${failed.map((one) => `${one.name} (${one.detail})`).join("; ")}.` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error), report: null };
  } finally {
    await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
  }
}

/**
 * The go-between that starts the new version (this program again, as plain Node). Windows checks a program it has
 * never run before starting it, and holds the thread that asked for the whole check: about 4 s for a freshly built
 * Branch, measured on 2026-09-27. Asked from the app's main process, that froze the window; asked from here, only this
 * go-between waits. It says how the new version ended, and ends it if the caller goes away.
 */
export const canaryRelay = `const { spawn } = require("node:child_process");
const [executable, script] = process.argv.slice(1);
const child = spawn(executable, [script, "start"], { env: process.env, stdio: "ignore", windowsHide: true });
const tell = (message) => { if (process.connected) process.send(message, () => process.exit(0)); else process.exit(0); };
child.once("error", (error) => tell({ error: error.message }));
child.once("exit", (code, signal) => tell({ code, signal }));
process.once("disconnect", () => { child.kill("SIGKILL"); process.exit(0); });`;

function started(engine: { executable: string; script: string }, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const relay = spawn(process.execPath, ["-e", canaryRelay, engine.executable, engine.script],
      { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
    // The new version's check runs below normal priority, as the build does (src/desktop/quiet-build.ts), so the
    // owner's own programs come first (what the go-between starts inherits it); when it cannot be lowered it still runs.
    if (relay.pid !== undefined) try { setPriority(relay.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* it has already ended */ }
    let settled = false;
    const finish = (why: string) => { if (settled) return; settled = true; clearTimeout(timer); if (relay.connected) relay.disconnect(); resolve(why); };
    const timer = setTimeout(() => finish("it took too long and was stopped"), timeoutMs);
    relay.on("message", (message: { code?: number | null; signal?: string | null; error?: string }) => {
      if (message.error !== undefined) finish(`it could not be started: ${message.error}`);
      else finish(message.signal ? `it was ended by ${message.signal}` : `it exited with code ${message.code}`);
    });
    relay.once("error", (error) => finish(`it could not be started: ${error.message}`));
    relay.once("exit", (code) => finish(`it could not be started (the program that starts it ended with code ${code})`));
  });
}

export interface UpdateCanaryInput {
  dataDir: string;
  platform: NodeJS.Platform;
  executableName: string;
  fromVersion: string;
  /** The installed program, watched after the swap; null when this copy cannot be updated. */
  target: string | null;
  /** Takes the copy of the saved work (in-process, or by asking the background engine). */
  snapshot: () => Promise<string>;
  timeoutMs?: number;
}

/**
 * The updater's canary step. With the switch off it does nothing, as before, except for a Beta install. Otherwise the new
 * version must pass its check on a copy, and the gateway is told to watch it after the swap.
 */
/**
 * `required` (a Beta build, which no release has published): the check runs even with the never-break switch off, so
 * a build whose engine will not start never replaces the running one. The watch after the swap is written only when
 * the switch is on, since only then is a gateway there to read it.
 */
export function updateCanary(input: UpdateCanaryInput): (stagedDir: string, version: string, how?: { required: boolean }) => Promise<void> {
  return async (stagedDir, version, how) => {
    const off = (await loadGatewayConfig(input.dataDir)).config.mode === "off";
    if (off && !how?.required) return;
    const dataCopy = await input.snapshot();
    if (!isCanaryCopy(input.dataDir, dataCopy)) throw new Error("The copy of your work was not where Branch keeps update copies, so it was not used.");
    const result = await runCanary({ engine: stagedEngine(stagedDir, input.platform, input.executableName),
      dataCopy, expectedVersion: version, ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) });
    if (!result.ok) throw new Error(result.detail);
    const platform = input.platform === "win32" || input.platform === "darwin" ? input.platform : "linux";
    if (input.target && !off) await writeWatch(input.dataDir, { from: input.fromVersion, to: version, target: input.target, platform,
      executableName: input.executableName, startedAt: new Date().toISOString(), understood: storeMigrations.at(-1)?.version ?? 0 });
  };
}

/* ---------- watching the first minutes after the swap ---------- */

export const UpdateWatchSchema = z.object({
  from: z.string().max(40),
  to: z.string().max(40),
  /** The installed program: the `.app` bundle on macOS, the program folder elsewhere. */
  target: z.string().min(1).max(4096),
  platform: z.enum(["win32", "darwin", "linux"]),
  executableName: z.string().min(1).max(200),
  startedAt: z.iso.datetime(),
  /** The newest data format the version updated from understands: going back is refused past it (worker-link.ts). */
  understood: z.number().int().nonnegative().optional(),
}).strict();
export type UpdateWatch = z.infer<typeof UpdateWatchSchema>;

export async function writeWatch(dataDir: string, watch: UpdateWatch): Promise<void> {
  await writeAtomic(join(dataDir, watchFile), JSON.stringify(UpdateWatchSchema.parse(watch)));
}
export async function readWatch(dataDir: string): Promise<UpdateWatch | null> {
  try {
    return UpdateWatchSchema.parse(JSON.parse(await readFile(join(dataDir, watchFile), "utf8")));
  } catch { return null; }
}
export async function clearWatch(dataDir: string): Promise<void> {
  await rm(join(dataDir, watchFile), { force: true });
}

/**
 * Pure: what the gateway should do about a watched update. Roll back when the new version keeps
 * failing inside the window; call the update done once it has been up for the whole window.
 */
export function watchVerdict(watch: UpdateWatch | null, input: { now: number; watchSeconds: number; runningVersion: string | null; failing: boolean }): "none" | "watching" | "done" | "roll-back" {
  if (!watch) return "none";
  // mac7/install-torture: a clock that jumped backwards (or an unreadable time) puts the update's
  // start in the future. Counting that as "still inside the window" would roll a good version back
  // on the first ordinary crash and never let the watch finish, so it counts as outside instead.
  const since = input.now - Date.parse(watch.startedAt);
  const inside = Number.isFinite(since) && since >= 0 && since <= input.watchSeconds * 1000;
  if (input.failing && inside) return "roll-back";
  if (input.runningVersion !== watch.to) return inside ? "watching" : "none";
  return inside ? "watching" : "done";
}

/**
 * An update interrupted part-way (power cut, killed script) leaves the program folder in one of a
 * few shapes. This puts it back to a whole version: the current one if it is there, else the
 * previous one, and removes a half-copied new one. Answers what it did, in plain words.
 */
export async function repairSwap(target: string): Promise<string[]> {
  const exists = (path: string) => stat(path).then(() => true, () => false);
  const done: string[] = [];
  const previous = `${target}.previous`, incoming = `${target}.incoming`;
  // `<target>.failed` only ever exists because a rollback was running, so that shape belongs to
  // `repairRollback` below and is left alone here rather than being described as a half-done update.
  const rollingBack = await exists(`${target}.failed`);
  if (!rollingBack && !(await exists(target)) && (await exists(previous))) {
    await rename(previous, target);
    done.push("The update had stopped half-way; the previous version was put back.");
  }
  if (await exists(incoming)) {
    await rm(incoming, { recursive: true, force: true });
    done.push("A half-copied new version was removed.");
  }
  // A rollback cut off part-way leaves its own shapes (`.failed` beside a missing program); the same
  // start-up tidy-up puts those back to one whole version too. See never-break/rollback.ts.
  done.push(...await repairRollback(target).catch(() => [] as string[]));
  return done;
}
