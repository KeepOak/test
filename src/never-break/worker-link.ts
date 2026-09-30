import { existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { launchHandOver, posixRollbackScript, windowsRollbackScript, windowsStartAfterScript } from "../desktop/hand-over.js";
import { appFolderPattern, folderPath, readPointer, rollBackPointer } from "../desktop/app-folders.js";
import { goingBackIsSafe } from "../desktop/version-switch.js";
import type { UpdateWatch } from "./canary.js";
import { gatewayContract, GatewayMessageSchema } from "./contract.js";
import { loadGatewayConfig } from "./gateway-config.js";
import { Gateway } from "./gateway.js";
import { activationJournalName, databaseFormat, openActivationJournal } from "./activation.js";
import { storeMigrations } from "./migrations.js";
import { assessRollback, observeForRollback } from "./rollback.js";
import { databaseName } from "../install/layout.js";
import { openGatewayRecord } from "./flight-record.js";

/**
 * The engine's side of the gateway. When the engine was started by a gateway it says where it is
 * listening once it is ready, closes itself when asked, and closes itself when the gateway goes
 * away — so a gateway that is killed never leaves an engine behind holding the database.
 */
export interface GatewayLink {
  ready(port: number, version: string): void;
  onStop(stop: () => Promise<void> | void): void;
}

type Channel = Pick<NodeJS.Process, "send" | "on" | "connected" | "disconnect" | "exit" | "env" | "pid">;

export function joinGateway(host: Channel = process): GatewayLink | null {
  if (host.env.BRANCH_GATEWAY_CHILD !== "1" || typeof host.send !== "function") return null;
  let stopper: (() => Promise<void> | void) | null = null;
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // Whatever happens while closing, the engine is gone within twenty seconds.
    setTimeout(() => host.exit(0), 20_000).unref();
    void Promise.resolve(stopper?.()).catch(() => undefined).finally(() => {
      if (host.connected) host.disconnect();
      setTimeout(() => host.exit(0), 500).unref();
    });
  };
  host.on("disconnect", stop);
  // QA retest 2026-09-28 (X1): on macOS and Linux an engine sent SIGTERM closed its server but the open channel to the
  // gateway kept it running, closed, and never restarted; it now leaves, so the gateway sees it stop and starts another.
  host.on("SIGTERM", stop);
  host.on("message", (message: unknown) => {
    const parsed = GatewayMessageSchema.safeParse(message);
    if (parsed.success && parsed.data.type === "stop") stop();
  });
  return {
    ready: (port, version) => {
      host.send?.({ type: "ready", contract: gatewayContract.speaks, accepts: gatewayContract.accepts, port, version, pid: host.pid });
    },
    onStop: (fn) => { stopper = fn; },
  };
}

/**
 * `branch start` with the switch on: run the gateway, which runs the engine. Answers false when the
 * switch is off (or this process already is the engine), so the caller starts the engine itself.
 */
export async function runGatewayIfSwitchedOn(input: { dataDir: string; script: string; version: string; port: number }): Promise<boolean> {
  if (process.env.BRANCH_GATEWAY_CHILD === "1") return false;
  const { config } = await loadGatewayConfig(input.dataDir);
  if (config.mode === "off") return false;
  // QA retest 2026-09-28 (X1): the gateway's own flight record (src/never-break/flight-record.ts).
  const record = openGatewayRecord(input.dataDir, input.version);
  let closing = false;
  const stop = (why: string, code = 0) => {
    record.asked(why);
    if (closing) return;
    closing = true;
    void gateway.stop().finally(() => process.exit(code));
  };
  const gateway: Gateway = new Gateway({ ...input, presence: true,
    rollBack: async (watch) => {
      const allowed = await rollbackAllowed(watch, input.dataDir);
      if (!allowed.ok) { console.error(allowed.message); record.log.write({ level: "warn", component: "gateway", message: "Going back was refused", fields: { reason: allowed.message } }); return; }
      try { await rollBackUpdate(watch, input.dataDir); }
      catch (error) {
        if (!(error instanceof RollbackRefusedError)) throw error;
        console.error(error.message);
        record.log.write({ level: "warn", component: "gateway", message: "Going back was refused", fields: { reason: error.message } });
        return;
      }
      stop("the update was put back", 1);
    },
    quit: () => stop("branch quit"),
    onWorker: (event) => {
      if (event.kind === "ready") record.log.write({ level: "info", component: "gateway", message: "The engine is ready", fields: { pid: event.ready.pid ?? null, version: event.ready.version } });
      else record.log.write({ level: "error", component: "gateway", message: "The engine stopped unexpectedly", fields: { code: event.code, signal: event.signal, tripped: event.tripped } });
    } });
  const url = await gateway.start();
  console.log(`Branch gateway listening at ${url}\nThe engine runs behind it and is started again if it stops.`);
  process.once("SIGINT", () => stop("Ctrl+C"));
  process.once("SIGTERM", () => stop("asked to stop"));
  return true;
}

/**
 * mac7/safe-rollback: before a single file moves, the same gate `branch rollback` uses is asked
 * whether going back is still safe. A new version that crashed but has already moved the owner's
 * work to a format the old one cannot read must **not** be swapped away underneath it — the crash
 * loop is recoverable, a database the installed program cannot open is not. A refusal is written
 * where the owner will see it and the gateway stays where it is.
 */
export async function rollbackAllowed(watch: UpdateWatch, dataDir: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const { journal } = openActivationJournal(join(dataDir, activationJournalName));
  try {
    const entry = journal.current();
    // Nothing recorded (a version from before this was built, or a journal put aside) leaves the
    // old behaviour alone: the files-only swap was already safe, and refusing here would take away
    // the one recovery a crash loop has.
    if (!entry || entry.toVersion !== watch.to) return { ok: true };
    const observed = await observeForRollback(entry, {
      runnerKnows: storeMigrations.at(-1)?.version ?? 0,
      storeFormat: async () => readStoreFormat(dataDir),
    });
    const decision = assessRollback(entry, observed);
    if (decision.ok) return { ok: true };
    journal.step(entry.id, "checked whether going back is safe", false, `refused: ${decision.reason}`);
    return { ok: false, message: decision.message };
  } catch { return { ok: true }; }
  finally { journal.close(); }
}

/** The saved work's format, read and closed again; null when there is none or it cannot be opened. */
async function readStoreFormat(dataDir: string): Promise<{ version: number; readableBy: number } | null> {
  const path = join(dataDir, databaseName);
  if (!existsSync(path)) return null;
  const { Store } = await import("../store.js");
  const store = new Store(path);
  try { return databaseFormat(store.sqlite); } catch { return null; } finally { store.close(); }
}

/** Going back was not safe or not possible; nothing was changed. */
export class RollbackRefusedError extends Error { override name = "RollbackRefusedError"; }

/**
 * Windows, versioned app folders (src/desktop/app-folders.ts): the watched install is a version folder of a root whose
 * `current.json` names the version in use. Answers that root, or null for a flat copy (a portable one keeps the swap).
 */
async function versionedRoot(target: string): Promise<string | null> {
  const root = appFolderPattern.test(basename(target)) ? dirname(target) : target;
  return (await readPointer(root)) ? root : null;
}

/**
 * Versioned app folders: going back is one rename of `current.json` to the version before, made here and now (nothing
 * is moved, so nothing has to wait for this gateway to close), after the same check the switch makes: the version
 * before must still read the saved work. A small hidden script then starts that version once this gateway has closed.
 */
async function rollBackVersion(watch: UpdateWatch, dataDir: string, root: string, launch: typeof launchHandOver): Promise<string> {
  const safe = await goingBackIsSafe({ dataDir, understood: watch.understood ?? null },
    { format: readStoreFormat, note: async (line) => console.error(line) });
  if (!safe.ok)
    throw new RollbackRefusedError(`Version ${watch.to} keeps failing, but it has already moved your saved work to format ${safe.format.version}, which ${watch.from} cannot read, so Branch stays on ${watch.to}. Your conversations are kept; the safety copy taken before the update can be restored from Settings, Updates.`);
  const back = await rollBackPointer(root, watch.executableName);
  if (!back) throw new RollbackRefusedError(`Version ${watch.to} keeps failing, but the version before it is not kept whole beside it, so there is nothing to go back to.`);
  const folder = join(dataDir, "updates");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const program = folderPath(root, back.folder);
  const script = join(folder, "roll-back.cmd");
  await writeFile(script, windowsStartAfterScript({ exe: join(program, watch.executableName), log: join(folder, "roll-back.log"),
    words: `version ${back.version} is back in use` }), "utf8");
  await launch(script, process.pid, { platform: "win32", runtime: program, executableName: watch.executableName });
  return script;
}

/**
 * Writes the way-back script beside the data and starts it so that it outlives this gateway: on
 * Windows through the same hidden launcher the update uses (no console window), elsewhere as a
 * detached shell. The script waits for this process to close before it moves anything.
 */
export async function rollBackUpdate(watch: UpdateWatch, dataDir: string, launch = launchHandOver): Promise<string> {
  const root = watch.platform === "win32" ? await versionedRoot(watch.target) : null;
  if (root) return rollBackVersion(watch, dataDir, root, launch);
  const folder = join(dataDir, "updates");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const log = join(folder, "roll-back.log");
  const windows = watch.platform === "win32";
  const script = join(folder, windows ? "roll-back.cmd" : "roll-back.sh");
  const text = windows
    ? windowsRollbackScript({ install: watch.target, exe: join(watch.target, watch.executableName), log })
    : posixRollbackScript({ platform: watch.platform === "darwin" ? "darwin" : "linux", target: watch.target, log, executableName: watch.executableName });
  await writeFile(script, text, { encoding: "utf8", mode: 0o700 });
  if (!windows) await chmod(script, 0o700);
  await launch(script, process.pid, { platform: watch.platform, ...(windows ? { runtime: watch.target, executableName: watch.executableName } : {}) });
  return script;
}
