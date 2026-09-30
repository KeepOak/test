import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { activationJournalName, readCurrentActivation } from "../never-break/activation.js";
import { formatOf, storeMigrations } from "../never-break/migrations.js";
import { assessRollback, observeForRollback } from "../never-break/rollback.js";
import { rollBackUpdate } from "../never-break/worker-link.js";
import type { UpdateWatch } from "../never-break/canary.js";
import { databaseName } from "../install/layout.js";
import { appEntryName } from "./release-assets.js";
import { diagnose } from "../diagnostic-log.js";
import { spawn, type SpawnOptions } from "node:child_process";
import { launchHandOver } from "./hand-over.js";

export interface DesktopRollbackOptions {
  dataDir: string;
  target: string | null;
  version: string;
  platform: NodeJS.Platform;
  stop: () => Promise<void>;
  exit: () => void;
}

function savedFormat(dataDir: string): { version: number; readableBy: number } | null {
  const path = join(dataDir, databaseName);
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=2000");
    const found = formatOf(db);
    if (![found.version, found.readableBy].every((value) => Number.isSafeInteger(value) && value >= 0))
      throw new Error("The saved-work format cannot be checked safely.");
    return found;
  }
  finally { db.close(); }
}

/** Scheduler dispatch is acknowledged by its command; direct fallback must emit spawn before the broker may stop. */
async function dispatchRecovery(script: string, pid: number): Promise<void> {
  const launched: Promise<void>[] = [];
  await launchHandOver(script, pid, { spawn: (command, args, options) => {
    const child = spawn(command, args, options as SpawnOptions);
    launched.push(new Promise((resolve, reject) => { child.once("spawn", () => resolve()); child.once("error", reject); }));
    return child;
  } });
  await Promise.all(launched);
}

/** A files-only rollback must have matching evidence and leave the saved work's format untouched. */
async function checkWatch(watch: UpdateWatch, options: DesktopRollbackOptions): Promise<void> {
  if (!options.target || watch.platform !== options.platform || watch.to !== options.version || watch.executableName !== appEntryName(options.platform))
    throw new Error("The update watch does not describe this installed desktop version.");
  const target = await realpath(options.target);
  if (await realpath(watch.target) !== target) throw new Error("The update watch names another installed program.");
  if (existsSync(join(target, "current.json")) || /[\\/]app-[^\\/]+$/.test(target))
    throw new Error("Versioned app folders need pointer-based rollback; this files-only recovery was refused.");
  const entry = readCurrentActivation(join(options.dataDir, activationJournalName));
  if (!entry || entry.kind !== "update" || entry.executableName !== watch.executableName
      || entry.fromVersion !== watch.from || entry.toVersion !== watch.to || await realpath(entry.target) !== target
      || !entry.previous || !entry.candidate || entry.previous.partial || entry.candidate.partial)
    throw new Error("No complete matching activation record exists for this update.");
  // observeForRollback tolerates store-read errors as absent data; unattended recovery must refuse instead.
  const store = savedFormat(options.dataDir);
  const observed = await observeForRollback(entry, { runnerKnows: storeMigrations.at(-1)?.version ?? 0,
    storeFormat: async () => store });
  const decision = assessRollback(entry, observed);
  if (!decision.ok) throw new Error(decision.message);
  if (decision.data.action !== "leave-alone")
    throw new Error("Going back requires a saved-work format repair. Use the reviewed manual rollback flow.");
}

/** Dispatch the existing detached recovery first. A refusal throws so the gateway continues its crash-recovery loop. */
export function desktopGatewayRollback(options: DesktopRollbackOptions): (watch: UpdateWatch) => Promise<void> {
  return async (watch) => {
    try {
      await checkWatch(watch, options);
      await rollBackUpdate(watch, options.dataDir, async (script, pid) => { await dispatchRecovery(script, pid); return "spawn"; });
    } catch (error) {
      const words = `The desktop update rollback was refused: ${error instanceof Error ? error.message : String(error)}`;
      diagnose("updater", "warn", words);
      throw new Error(words);
    }
    diagnose("updater", "warn", "The desktop update rollback launcher was dispatched; the previous version is not confirmed running yet.");
    try { await options.stop(); } finally { options.exit(); }
  };
}
