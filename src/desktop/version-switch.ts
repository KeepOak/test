import { execFile, spawn } from "node:child_process";
import { appendFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { databaseName } from "../install/layout.js";
import { minimizedFlag } from "../install/autostart.js";
import { pointerName } from "./app-folders.js";
import { FailureSchema, type SwitchFailure } from "./shell-switch.js";

/**
 * The switch to a new version with versioned app folders (app-folders.ts), run by the hand-over runner (hand-over.ts)
 * after the window has closed, from the version that was in use: its folder is never moved, so it can run from there.
 * Written in the app's own language rather than as a batch script, so it is tested like the rest of the app and needs
 * no script host.
 *
 * 1. Waits for the old window's process to end (a minute, then ends that one process by its id).
 * 2. Switches: one rename of `current.next.json` onto `current.json`, all or nothing. A pointer file something holds
 *    open is tried again for a few seconds; if it stays locked, nothing is switched and the old version starts again.
 * 3. Starts the new version and waits for it to say its window is up (`shellUpMarker`).
 * 4. If it does not, ends that process (by its id, with what it started) and goes back, but only when going back is
 *    safe: the version before must still be able to read the saved work (`readableBy`, src/never-break/migrations.ts).
 *    When the new version has already moved the work to a format the old one cannot read, going back would leave a
 *    Branch that cannot open the owner's conversations, so the new version is kept and started again, and the note
 *    says why. Otherwise the old pointer is renamed back and the old version starts, with the note it reads.
 *
 * Nothing is ever deleted here but the switch's own scratch files: both versions stay whole in their folders.
 */
export const SwitchPlanSchema = z.object({
  root: z.string().min(1),
  /** current.next.json, renamed onto current.json to switch. */
  next: z.string().min(1),
  /** current.rollback.json, renamed back to go back; null when the version before is a flat copy (then current.json goes). */
  rollback: z.string().min(1).nullable(),
  newExe: z.string().min(1), oldExe: z.string().min(1),
  /** The window process of the version in use, waited for before anything is switched. */
  pid: z.number().int().nonnegative(),
  marker: z.string().min(1),
  /** The note the old version reads if it is back, pre-written, and where it goes. */
  failureDraft: z.string().min(1), failure: z.string().min(1),
  log: z.string().min(1),
  minimized: z.boolean(),
  upSeconds: z.number().int().positive().default(120),
  /** More arguments for the program started (a test's own inspector port; none in the app). */
  args: z.array(z.string()).default([]),
  version: z.string().min(1).max(100), kept: z.string().min(1).max(100), commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  /** The saved work's folder, and the newest data format the version in use understands (null: not known). */
  dataDir: z.string().min(1).nullable(), understood: z.number().int().nonnegative().nullable(),
}).strict();
export type SwitchPlan = z.infer<typeof SwitchPlanSchema>;
export type StoreFormat = { version: number; readableBy: number };

export interface SwitchDeps {
  alive: (pid: number) => boolean;
  /** Ends one process by its id (and what it started, with `tree`). Never by name. */
  end: (pid: number, tree: boolean) => Promise<void>;
  /** Starts a program on its own; answers its process id. */
  start: (exe: string, args: string[]) => number | null;
  exists: (path: string) => Promise<boolean>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  write: (path: string, text: string) => Promise<void>;
  /** The saved work's format, or null when there is none; throws when it cannot be read. */
  format: (dataDir: string) => Promise<StoreFormat | null>;
  sleep: (ms: number) => Promise<void>;
  note: (line: string) => Promise<void>;
  now: () => Date;
}

/** Tries `work` until it succeeds, `tries` times in all, `pauseMs` apart (a file held open by a scanner, say). */
async function persist(work: () => Promise<void>, deps: Pick<SwitchDeps, "sleep">, tries = 10, pauseMs = 500): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try { await work(); return true; } catch {
      if (attempt >= tries) return false;
      await deps.sleep(pauseMs);
    }
  }
}

async function waitFor(check: () => boolean | Promise<boolean>, seconds: number, deps: Pick<SwitchDeps, "sleep">): Promise<boolean> {
  for (let waited = 0; waited < seconds; waited++) {
    if (await check()) return true;
    await deps.sleep(1000);
  }
  return check();
}

/** Whether going back to the version before is safe for the saved work: it must still be able to read it. */
export async function goingBackIsSafe(plan: Pick<SwitchPlan, "dataDir" | "understood">, deps: Pick<SwitchDeps, "format" | "note">):
  Promise<{ ok: true } | { ok: false; format: StoreFormat }> {
  if (!plan.dataDir || plan.understood === null) return { ok: true }; // not known: as before, going back is allowed
  let format: StoreFormat | null;
  try { format = await deps.format(plan.dataDir); }
  catch (error) {
    await deps.note(`the saved work's format could not be read (${error instanceof Error ? error.message : String(error)}); going back as before`);
    return { ok: true };
  }
  return format === null || format.readableBy <= plan.understood ? { ok: true } : { ok: false, format };
}

const launchArgs = (plan: SwitchPlan): string[] => [...(plan.minimized ? [minimizedFlag] : []), ...plan.args];

async function note(deps: SwitchDeps, path: string, failure: SwitchFailure): Promise<void> {
  await deps.write(path, JSON.stringify(FailureSchema.parse(failure)));
}

/** The switch itself. Answers 0 when the new version is up, 1 otherwise (whichever version then runs). */
export async function switchVersion(plan: SwitchPlan, deps: SwitchDeps): Promise<number> {
  const pointer = join(plan.root, pointerName);
  await deps.note(`switching to ${plan.version} once process ${plan.pid} has closed`);
  if (!(await waitFor(() => !deps.alive(plan.pid), 60, deps))) {
    await deps.note("the window was still open after a minute; ending that one process");
    await deps.end(plan.pid, false).catch(() => undefined);
    await deps.sleep(2000);
  }
  await deps.remove(plan.marker).catch(() => undefined);
  if (!(await persist(() => deps.rename(plan.next, pointer), deps))) {
    await deps.note("the new version could not be put in use (its pointer file stayed locked); starting the one there was");
    deps.start(plan.oldExe, launchArgs(plan));
    return 1;
  }
  await deps.note(`${plan.version} is in use; starting it`);
  const started = deps.start(plan.newExe, launchArgs(plan));
  if (await waitFor(() => deps.exists(plan.marker), plan.upSeconds, deps)) {
    await deps.note("the new version's window is up");
    await deps.remove(plan.failureDraft).catch(() => undefined);
    if (plan.rollback) await deps.remove(plan.rollback).catch(() => undefined);
    return 0;
  }
  await deps.note("the new version did not say its window was up");
  if (started) await deps.end(started, true).catch(() => undefined);
  await deps.sleep(2000);
  return goBack(plan, pointer, deps);
}

/** Step 4: back to the version before when that is safe for the saved work; otherwise the new version again. */
async function goBack(plan: SwitchPlan, pointer: string, deps: SwitchDeps): Promise<number> {
  const safe = await goingBackIsSafe(plan, deps);
  if (!safe.ok) {
    await deps.note(`not going back: the saved work is in format ${safe.format.version}, which ${plan.kept} cannot read`);
    await note(deps, plan.failure, { kept: plan.version, tried: plan.version, commit: plan.commit, at: deps.now().toISOString(),
      message: `Version ${plan.version} did not open its window in time, but it had already moved your saved work to a newer format that ${plan.kept} cannot read, so Branch stayed on ${plan.version} and started it again instead of going back. Your conversations are kept. If it keeps failing, restore the safety copy taken before the update from Settings, Updates.` });
    await deps.remove(plan.failureDraft).catch(() => undefined);
    deps.start(plan.newExe, launchArgs(plan));
    return 1;
  }
  const back = plan.rollback;
  const moved = await persist(() => (back ? deps.rename(back, pointer) : deps.rename(pointer, `${pointer}.gone`)), deps);
  if (!moved) {
    await deps.note("the version before could not be put back (its pointer file stayed locked); starting the new version again");
    deps.start(plan.newExe, launchArgs(plan));
    return 1;
  }
  if (!back) await deps.remove(`${pointer}.gone`).catch(() => undefined);
  await persist(() => deps.rename(plan.failureDraft, plan.failure), deps, 3);
  await deps.note(`${plan.kept} is back; starting it`);
  deps.start(plan.oldExe, launchArgs(plan));
  return 1;
}

/* ---------- the real system, for the runner ---------- */

const runTaskkill = (pid: number, tree: boolean): Promise<void> => new Promise((resolve, reject) => {
  const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
  execFile(taskkill, ["/PID", String(pid), ...(tree ? ["/T"] : []), "/F"], { windowsHide: true, timeout: 20_000 },
    (error) => (error ? reject(error) : resolve()));
});

async function readFormat(dataDir: string): Promise<StoreFormat | null> {
  const path = join(dataDir, databaseName);
  if (!(await stat(path).then((found) => found.isFile() && found.size > 0, () => false))) return null;
  const { DatabaseSync } = await import("node:sqlite");
  const { formatOf } = await import("../never-break/migrations.js");
  const db = new DatabaseSync(path, { readOnly: true });
  try { return formatOf(db); } finally { db.close(); }
}

export function systemDeps(log: string): SwitchDeps {
  return {
    alive: (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } },
    end: runTaskkill,
    start: (exe, args) => {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(exe, args, { detached: true, stdio: "ignore", env });
      child.on("error", () => undefined);
      child.unref();
      return child.pid ?? null;
    },
    exists: (path) => stat(path).then(() => true, () => false),
    rename, remove: (path) => rm(path, { force: true }), write: (path, text) => writeFile(path, text),
    format: readFormat,
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    note: (line) => appendFile(log, `[${new Date().toISOString()}] ${line}\r\n`).catch(() => undefined),
    now: () => new Date(),
  };
}

/** The runner's entry (hand-over.ts, `runnerMain`): reads the plan and switches. */
export async function runSwitchPlan(planPath: string, deps?: SwitchDeps): Promise<number> {
  const plan = SwitchPlanSchema.parse(JSON.parse(await readFile(planPath, "utf8")));
  return switchVersion(plan, deps ?? systemDeps(plan.log));
}
