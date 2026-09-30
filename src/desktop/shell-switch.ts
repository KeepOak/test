import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * The shell's own update with versioned app folders (app-folders.ts): the new version is already whole in its own
 * folder and has passed its checks, so all that is left is to switch `current.json` to it and start it in place of
 * this one. The gateway and its engine keep running through it (they belong to the detached gateway, not to this
 * window), and the window comes back where it was, with the draft, caret and scroll the owner left (`HandOver`).
 *
 * The switch is done by a small hidden script (started the way every hand-over is, see hand-over.ts), because it has to
 * outlive this process: it waits for this process to end, renames the new pointer into place, starts the new version
 * and watches for it to say its window is up (`shellUpMarker`). If it does not say so in time, the script ends it by
 * its exact program path (never by name: other Electron programs on this computer are left alone), renames the old
 * pointer back, leaves the reason where the old version finds it (`SwitchFailure`), and starts the old version again,
 * in the same place. So a missing window after an update is always noticed and a window always comes back.
 */

/** Written by a shell once its window has drawn (or, started hidden, once its page is ready), for the script to see. */
export const shellUpMarker = (scratchDir: string, version: string): string =>
  join(scratchDir, `shell-up-${version.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80)}`);
export async function markShellUp(scratchDir: string, version: string, pid = process.pid, restored: boolean | null = null): Promise<void> {
  await mkdir(scratchDir, { recursive: true });
  // `restored`: after a switch, whether the page confirmed it put back what the old window had open (null: nothing kept).
  await writeFile(shellUpMarker(scratchDir, version), JSON.stringify({ pid, at: new Date().toISOString(), restored }));
}

/** What the old version reads when the new one did not come up, so it can say so (never silently). */
export const FailureSchema = z.object({ kept: z.string().max(100), tried: z.string().max(100), commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  at: z.iso.datetime(), message: z.string().max(600) }).strict();
export type SwitchFailure = z.infer<typeof FailureSchema>;
export const failureName = "shell-switch-failed.json";

export async function readSwitchFailure(scratchDir: string, runningVersion: string): Promise<SwitchFailure | null> {
  const path = join(scratchDir, failureName);
  let failure: SwitchFailure;
  try { failure = FailureSchema.parse(JSON.parse(await readFile(path, "utf8"))); } catch { return null; }
  await rm(path, { force: true });
  // Only the version it went back to reports it, once, and only while it is news (the last day).
  return failure.kept === runningVersion && Date.now() - Date.parse(failure.at) < 24 * 3600_000 ? failure : null;
}

/** The window as the owner left it, for the new version to open the same way (in userData, private, short-lived). */
export const HandOverSchema = z.object({ version: z.string().max(100), visible: z.boolean(), at: z.iso.datetime(),
  /** The page's own record of what was open (public/app/shell/liveupdate.js keepForShell), or null. */
  kept: z.string().max(2_000_000).nullable() }).strict();
export type HandOver = z.infer<typeof HandOverSchema>;
export const handOverName = "shell-handover.json";

export async function writeHandOver(userData: string, handOver: HandOver): Promise<void> {
  await writeFile(join(userData, handOverName), JSON.stringify(HandOverSchema.parse(handOver)), { mode: 0o600 });
}
/** Taken once by the version it was written for, within ten minutes; anything else is removed and ignored. */
export async function takeHandOver(userData: string, version: string, now = Date.now()): Promise<HandOver | null> {
  const path = join(userData, handOverName);
  let found: HandOver | null = null;
  try { found = HandOverSchema.parse(JSON.parse(await readFile(path, "utf8"))); } catch { found = null; }
  await rm(path, { force: true }).catch(() => undefined);
  return found && found.version === version && now - Date.parse(found.at) < 10 * 60_000 ? found : null;
}

/**
 * The invisible moment for a shell switch: the window is not on screen (hidden in the tray or minimised), the screen is
 * locked, or the owner has stepped away from it (no input for two minutes and another window in front). Never while it
 * is in front of them, even untouched: the old window goes before the new one comes, and they would see the gap.
 */
export function invisibleMoment(state: { visible: boolean; minimized: boolean; focused?: boolean; idle: "active" | "idle" | "locked" | "unknown" }): boolean {
  return !state.visible || state.minimized || state.idle === "locked" || (state.idle === "idle" && state.focused === false);
}
export const invisibleWaitWords = "The new version is ready. It takes over the moment Branch is minimised or in the tray, or when you step away; your conversations and chat apps keep running.";

export interface SwitchScriptPlan {
  root: string;
  /** current.next.json: renamed onto current.json to switch. */
  next: string;
  /** current.rollback.json: renamed back to go back; null when the old version is a flat copy (then current.json goes). */
  rollback: string | null;
  newExe: string; oldExe: string;
  marker: string;
  /** The note the old version reads on failure, pre-written, and where it goes. */
  failureDraft: string; failure: string;
  log: string;
  /** Start the new (or old) version in the tray, as the window was. */
  minimized: boolean;
  /** How long the new version has to say its window is up (default 120 s). */
  upSeconds?: number;
  /** More arguments for the program started, each quoted as given (a test's own inspector port; none in the app). */
  args?: string[];
}

/**
 * The switch script's text (Windows batch, run hidden). `%1` is this process's id. Paths are quoted; `%` is doubled so
 * the batch parser keeps it. System tools by full path, as every hand-over script here does.
 */
export function windowsSwitchScript(plan: SwitchScriptPlan): string {
  const text = (value: string) => value.replaceAll("%", "%%");
  const q = (value: string) => `"${text(value)}"`;
  const sys = "%SystemRoot%\\System32\\";
  const note = (words: string) => `echo [%date% %time%] ${words} >>${q(plan.log)}`;
  const sleep = (seconds: number) => `${sys}ping.exe -n ${seconds + 1} 127.0.0.1 >NUL`;
  const flag = `${plan.minimized ? " --start-minimized" : ""}${(plan.args ?? []).map((arg) => ` ${q(arg)}`).join("")}`;
  const pointer = join(plan.root, "current.json");
  const powershell = `${sys}WindowsPowerShell\\v1.0\\powershell.exe`;
  // By exact program path, through the system's own process list: never by name.
  const endNew = `${powershell} -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:BRANCH_NEW_EXE } | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }" >NUL 2>&1`;
  // Started only when the program is really there: `start` on a missing file opens an error box on the owner's screen.
  const launch = (exe: string) => `if exist ${q(exe)} start "" ${q(exe)}${flag}`;
  const back = plan.rollback ? `move /y ${q(plan.rollback)} ${q(pointer)} >NUL` : `del /q ${q(pointer)} >NUL 2>&1`;
  return [
    "@echo off", "setlocal DisableDelayedExpansion", 'set "PID=%~1"', `set "BRANCH_NEW_EXE=${text(plan.newExe)}"`,
    note("switching to the new version for pid %PID%"),
    "set WAITED=0", ":wait",
    `${sys}tasklist.exe /FI "PID eq %PID%" /NH /FO CSV 2>NUL | ${sys}find.exe ",""%PID%""," >NUL`,
    `if not errorlevel 1 if %WAITED% lss 60 ( set /a WAITED+=1 & ${sleep(1)} & goto wait )`,
    `if not errorlevel 1 ( ${note("the window was still open after a minute; ending that one process")} & ${sys}taskkill.exe /PID %PID% /F >NUL 2>&1 & ${sleep(2)} )`,
    `del /q ${q(plan.marker)} >NUL 2>&1`,
    `move /y ${q(plan.next)} ${q(pointer)} >NUL`,
    `if errorlevel 1 ( ${note("the new version could not be put in use; starting the one there was")} & ${launch(plan.oldExe)} & exit /b 1 )`,
    note("new version in use; starting it"), launch(plan.newExe),
    "set UP=0", ":up", `if exist ${q(plan.marker)} goto done`,
    `if %UP% lss ${plan.upSeconds ?? 120} ( set /a UP+=1 & ${sleep(1)} & goto up )`,
    note("the new version did not say its window was up; going back"), endNew, sleep(2),
    back, `move /y ${q(plan.failureDraft)} ${q(plan.failure)} >NUL`,
    note("the version there was is back; starting it"), launch(plan.oldExe), "exit /b 1",
    ":done", note("the new version's window is up"), `del /q ${q(plan.failureDraft)} >NUL 2>&1`,
    ...(plan.rollback ? [`del /q ${q(plan.rollback)} >NUL 2>&1`] : []), "exit /b 0", "",
  ].join("\r\n");
}
