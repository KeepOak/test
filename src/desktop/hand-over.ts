import { execFile, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { win32 } from "node:path";
import { portableFolder, portableMarker } from "../install/layout.js";

/**
 * Starts the update hand-over script so that it outlives the app and stays invisible. A child started
 * with spawn dies with the app when the app runs inside a Windows job (launchers, test harnesses and
 * some shells put it in one), so the Task Scheduler runs it instead: a scheduled task is created, run at
 * once and deleted again; deleting the task does not stop the command it started. The task runs a tiny
 * Windows Script Host launcher so that no console window flashes while files are swapped. When the
 * scheduler is unavailable that same launcher is started directly, for the same reason: it is the only
 * shape measured to leave the screen alone.
 */
export type Exec = (file: string, args: string[], options: { windowsHide: boolean; timeout: number }, callback: (error: Error | null) => void) => unknown;
export type Spawn = (command: string, args: string[], options: Record<string, unknown>) => { unref(): void };
export type Write = (file: string, content: string) => void;

/** Windows Script Host text that runs any command with window style 0 (hidden) and does not wait. */
export function hiddenRunner(command: string): string {
  return `CreateObject("WScript.Shell").Run "${command.replace(/"/g, '""')}", 0, False\r\n`;
}
/** The launcher text: runs the script through cmd with window style 0 (hidden) and does not wait. */
export function hiddenLauncher(script: string, pid: number): string {
  return hiddenRunner(`cmd.exe /d /c ""${script}" ${pid}"`);
}

export async function launchHandOver(script: string, pid: number, deps: { exec?: Exec; spawn?: Spawn; write?: Write; systemRoot?: string; platform?: NodeJS.Platform } = {}): Promise<"task" | "spawn"> {
  if ((deps.platform ?? process.platform) !== "win32") return launchPosixHandOver(script, pid, deps.spawn);
  const exec = deps.exec ?? (execFile as unknown as Exec), start = deps.spawn ?? (spawn as unknown as Spawn);
  const write = deps.write ?? ((file: string, content: string) => writeFileSync(file, content, "utf8"));
  const root = deps.systemRoot ?? process.env.SystemRoot ?? "C:\\Windows";
  const schtasks = win32.join(root, "System32", "schtasks.exe"), wscript = win32.join(root, "System32", "wscript.exe");
  const name = `BranchAgentUpdate-${pid}`, launcher = `${script}.launch.vbs`;
  const run = (args: string[]) => new Promise<void>((resolve, reject) =>
    exec(schtasks, args, { windowsHide: true, timeout: 15000 }, (error) => (error ? reject(error) : resolve())));
  // Written before the scheduler is asked, because the fallback below needs it too.
  write(launcher, hiddenLauncher(script, pid));
  try {
    await run(["/Create", "/F", "/TN", name, "/SC", "ONCE", "/ST", "00:00", "/TR", `"${wscript}" //B //Nologo "${launcher}"`]);
    await run(["/Run", "/TN", name]);
    await run(["/Delete", "/F", "/TN", name]).catch(() => undefined);
    return "task";
  } catch {
    // CBQ-001: this used to start `cmd.exe` itself, with `windowsHide: true` and `detached: true`.
    // Those two cannot both apply on Windows - a detached child is given no console to hide, so it
    // opens its own - and a console window really appeared on the owner's screen every time the
    // scheduler was unavailable. The flag was there and had no effect, which is why a test that read
    // the flag passed while the window was on screen. The same hidden launcher the scheduler route
    // uses is started instead: Windows Script Host is a windowless program, so there is nothing to
    // open. Measured on Windows: the old line opens one console window, this one opens none, and the
    // script runs either way.
    start(wscript, ["//B", "//Nologo", launcher], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return "spawn";
  }
}

// ------------------------------------------------------------------------------ macOS and Linux

/**
 * On macOS and Linux the hand-over is a small shell script started in its own session with nothing
 * attached, so it outlives the app and no terminal window appears.
 */
export function launchPosixHandOver(script: string, pid: number, spawner?: Spawn): "spawn" {
  const start = spawner ?? (spawn as unknown as Spawn);
  start("/bin/sh", [script, String(pid)], { detached: true, stdio: "ignore" }).unref();
  return "spawn";
}

export interface PosixHandOverPlan {
  platform: "darwin" | "linux";
  /** What is replaced: the `.app` bundle on macOS, the unpacked folder on Linux. */
  target: string;
  /** The new version, unpacked in the scratch folder. */
  staged: string;
  log: string;
  /** The program file inside the Linux folder. */
  executableName: string;
  /** The engine working in the background, waited for as well when there is one. */
  daemonPid: number | null;
  /** How long the new version must stay up before the update counts as done (20 seconds). */
  settleSeconds?: number;
  /** The downloaded archive, removed with the unpacked copy once the new version is up. */
  archive?: string;
  /** Linux: whose sandbox helper counts as set up by an administrator (root, 0); tests hand in their own. */
  sandboxOwner?: number;
  /**
   * selfdev (Beta): the file the new version writes once its engine is up (`startedMarker`). With it, the new
   * version counts as up only when that file appears within `startedSeconds` and it is still running then;
   * otherwise the previous version is put back, whatever the never-break switch says.
   */
  started?: string;
  startedSeconds?: number;
}

/** Quotes one word for sh; nothing inside single quotes is interpreted. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

/** Waits about a minute, then asks the process to stop, then ends it. */
const posixWait = [
  "wait_for() {",
  "  n=0",
  '  while kill -0 "$1" 2>/dev/null && [ "$n" -lt 60 ]; do n=$((n+1)); sleep 1; done',
  '  if kill -0 "$1" 2>/dev/null; then',
  '    log "$2 still open after $n waits; asking it to stop"',
  '    kill -TERM "$1" 2>/dev/null; n=0',
  '    while kill -0 "$1" 2>/dev/null && [ "$n" -lt 10 ]; do n=$((n+1)); sleep 1; done',
  '    if kill -0 "$1" 2>/dev/null; then log "$2 still open; ending it"; kill -KILL "$1" 2>/dev/null; sleep 1; fi',
  "  fi",
  '  log "$2 closed"',
  "}",
];

/** macOS copies a bundle with ditto, which keeps everything a signed app needs; Linux uses cp. */
function posixCopy(plan: PosixHandOverPlan, from: string, to: string): string {
  return plan.platform === "darwin" ? `/usr/bin/ditto "${from}" "${to}"` : `cp -Rp "${from}" "${to}"`;
}

function posixLaunch(plan: PosixHandOverPlan, watch: boolean): string {
  if (plan.platform === "darwin") return `/usr/bin/open -n${watch ? " -W" : ""} "$TARGET" >/dev/null 2>&1 &`;
  return `"$TARGET"/${shellQuote(plan.executableName)} >/dev/null 2>&1 &`;
}

/**
 * The script text: wait for the app (and the background engine), copy the new version in beside the
 * old one, keep the old one as `<name>.previous`, swap, start the new version, and put the previous
 * one back if the new one does not stay up.
 */
export function posixHandOverScript(plan: PosixHandOverPlan): string {
  const q = shellQuote;
  if (plan.daemonPid !== null && !Number.isSafeInteger(plan.daemonPid)) throw new Error("The background engine's process id is not a number.");
  return [
    "#!/bin/sh", 'PID="$1"',
    `TARGET=${q(plan.target)}`, `STAGED=${q(plan.staged)}`, `LOG=${q(plan.log)}`,
    'PREVIOUS="$TARGET.previous"', 'INCOMING="$TARGET.incoming"', 'FAILED="$TARGET.failed"',
    'log() { printf \'[%s] %s\\n\' "$(date \'+%Y-%m-%d %H:%M:%S\')" "$1" >>"$LOG"; }',
    ...posixWait, ...posixCarry(plan),
    'log "update started for pid $PID"',
    'wait_for "$PID" app',
    ...(plan.daemonPid ? [`wait_for ${plan.daemonPid} "background engine"`] : []),
    'log "copying new version beside the old one"',
    'rm -rf "$INCOMING"',
    `${posixCopy(plan, "$STAGED", "$INCOMING")} || { log "copy failed; nothing was changed"; rm -rf "$INCOMING"; exit 1; }`,
    // mac3/never-break: the last two versions are kept, so a rollback still has one to spare.
    'log "keeping previous version"', 'drop "$PREVIOUS-2"', 'if [ -e "$PREVIOUS" ]; then mv "$PREVIOUS" "$PREVIOUS-2"; fi', 'drop "$PREVIOUS"',
    'if [ -e "$TARGET" ] && ! mv "$TARGET" "$PREVIOUS"; then log "old version could not be moved; nothing was changed"; rm -rf "$INCOMING"; exit 1; fi',
    'if ! mv "$INCOMING" "$TARGET"; then log "new version could not be moved in; restoring previous"; mv "$PREVIOUS" "$TARGET"; exit 1; fi',
    'carry_person "$PREVIOUS" "$TARGET"',
    'if [ "$2" = stay ]; then exit 0; fi',
    ...(plan.started ? [`rm -f ${shellQuote(plan.started)}`] : []),
    'log "starting new version"', posixLaunch(plan, true), "STARTED=$!", `sleep ${plan.settleSeconds ?? 20}`,
    ...(plan.started ? [`WAITED=0; while [ ! -e ${shellQuote(plan.started)} ] && [ "$WAITED" -lt ${plan.startedSeconds ?? 90} ]; do sleep 1; WAITED=$((WAITED+1)); done`,
      `if [ ! -e ${shellQuote(plan.started)} ]; then log "new version did not say it was up"; kill "$STARTED" 2>/dev/null; sleep 2; fi`] : []),
    `if ${plan.started ? `[ -e ${shellQuote(plan.started)} ] && ` : ""}kill -0 "$STARTED" 2>/dev/null; then log "new version is running"; rm -rf "$STAGED"${plan.archive ? ` ${q(plan.archive)}` : ""}; exit 0; fi`,
    // mac7/real-update: the previous version is moved back whole, not copied, so what an administrator
    // set up in it (Linux's sandbox helper, owned by root) still works; the new one is kept aside.
    'log "new version did not start; restoring previous"', "carry_person \"$TARGET\" \"$PREVIOUS\"",
    'drop "$FAILED"', 'if mv "$TARGET" "$FAILED" && mv "$PREVIOUS" "$TARGET"; then log "previous version is back"; else log "previous version could not be moved back; copying it"; drop "$TARGET"; ' + posixCopy(plan, "$PREVIOUS", "$TARGET") + "; fi",
    posixLaunch(plan, false), "exit 1", "",
  ].join("\n");
}

/**
 * mac7/real-update. What belongs to the person rather than to a version, moved from one copy of the
 * program to the other when they swap: a portable copy's marker and its `Branch Data` folder (which
 * live beside the program), and on Linux a sandbox helper an administrator made root's (see
 * docs/configuration.md). Moving keeps the helper's owner, which a copy cannot. The helper is only
 * exchanged with the new version's own when both are plain files (no links), the old one is root's
 * with the setuid bit and no other name, the new one is not setuid, and the two are byte for byte the
 * same; the new version's unprivileged copy goes into the old folder, so going back can exchange them
 * again. A user cannot rewrite a root-owned file or hard-link one (protected_hardlinks), so what is
 * moved after the check is the file that was compared. `Branch Data` is never replaced: when the
 * other copy already has one, both are left where they are.
 *
 * `drop` removes an old copy, but first moves any `Branch Data` left inside it out beside the
 * program; when that cannot be done, the copy is kept instead.
 */
function posixCarry(plan: { platform: "darwin" | "linux"; sandboxOwner?: number }): string[] {
  const beside = plan.platform === "darwin" ? "Contents/MacOS/" : "";
  const owner = plan.sandboxOwner ?? 0;
  if (!Number.isSafeInteger(owner)) throw new Error("The sandbox helper's owner is not a number.");
  return [
    "carry_person() {",
    `  for KEEP in ${portableMarker} ${shellQuote(portableFolder)}; do`,
    `    if [ -e "$1/${beside}$KEEP" ]; then`,
    `      if [ -e "$2/${beside}$KEEP" ]; then log "$KEEP is in both copies; each is left where it is"; else mv "$1/${beside}$KEEP" "$2/${beside}$KEEP" && log "moved $KEEP to the version in use"; fi`,
    "    fi",
    "  done",
    ...(plan.platform === "linux" ? [
      '  S1="$1/chrome-sandbox"; S2="$2/chrome-sandbox"; SW="$1/chrome-sandbox.swap"',
      `  if [ -f "$S1" ] && [ ! -h "$S1" ] && [ -u "$S1" ] && [ "$(stat -c %u:%h "$S1" 2>/dev/null)" = ${owner}:1 ] && [ -f "$S2" ] && [ ! -h "$S2" ] && [ ! -u "$S2" ] && cmp -s "$S1" "$S2"; then`,
      '    if mv "$S2" "$SW" && mv "$S1" "$S2"; then mv "$SW" "$S1"; log "kept the sandbox helper an administrator set up"',
      '    elif [ -e "$SW" ] && [ ! -e "$S2" ]; then mv "$SW" "$S2"; fi',
      "  fi",
    ] : []),
    "}",
    "drop() {",
    '  if [ ! -e "$1" ] && [ ! -h "$1" ]; then return 0; fi',
    `  if [ -e "$1/${beside}${portableFolder}" ]; then`,
    `    SAVED="$TARGET - saved ${portableFolder} $(date +%Y%m%d-%H%M%S)"`,
    `    if mv "$1/${beside}${portableFolder}" "$SAVED"; then log "moved the ${portableFolder} left in $1 to $SAVED"; else log "kept $1 because it holds ${portableFolder}"; return 1; fi`,
    "  fi",
    '  rm -rf "$1"',
    "}",
  ];
}

// ------------------------------------------------------------------------------ rolling back (mac3/never-break)

export interface RollbackPlan {
  platform: "darwin" | "linux";
  target: string;
  log: string;
  executableName: string;
  /** See PosixHandOverPlan.sandboxOwner. */
  sandboxOwner?: number;
}

/**
 * The way back when a new version does not stay up after an update: wait for the gateway to close,
 * move the new version aside as `<name>.failed`, put the previous one back, promote the one before
 * that to "previous", and start it. With no previous version it changes nothing.
 */
export function posixRollbackScript(plan: RollbackPlan): string {
  const q = shellQuote;
  return [
    "#!/bin/sh", 'PID="$1"',
    `TARGET=${q(plan.target)}`, `LOG=${q(plan.log)}`,
    'PREVIOUS="$TARGET.previous"', 'FAILED="$TARGET.failed"',
    'log() { printf \'[%s] %s\\n\' "$(date \'+%Y-%m-%d %H:%M:%S\')" "$1" >>"$LOG"; }',
    ...posixWait, ...posixCarry(plan),
    'log "going back to the previous version for pid $PID"',
    'wait_for "$PID" gateway',
    'if [ ! -e "$PREVIOUS" ]; then log "there is no previous version to go back to; nothing was changed"; exit 1; fi',
    'drop "$FAILED"',
    'if [ -e "$TARGET" ] && ! mv "$TARGET" "$FAILED"; then log "the new version could not be moved aside; nothing was changed"; exit 1; fi',
    'if ! mv "$PREVIOUS" "$TARGET"; then log "the previous version could not be put back; restoring the new one"; mv "$FAILED" "$TARGET"; exit 1; fi',
    'carry_person "$FAILED" "$TARGET"', // mac7/real-update
    'if [ -e "$PREVIOUS-2" ]; then mv "$PREVIOUS-2" "$PREVIOUS"; fi',
    'log "previous version is back"',
    'if [ "$2" = stay ]; then exit 0; fi',
    posixLaunch({ ...plan, staged: plan.target, daemonPid: null }, false), "exit 0", "",
  ].join("\n");
}

/**
 * mac7/real-update. What belongs to the person or to the installer rather than to a version, carried
 * from one copy of the program to the other when they swap, and never removed by a mirror: the
 * uninstaller the installer wrote (Add or remove programs runs it), and a portable copy's marker and
 * its `Branch Data` folder, which hold the person's work.
 */
export const windowsKeep = { files: ["Uninstall Branch Agent.cmd", portableMarker], folder: portableFolder } as const;
/** robocopy switches that leave what is kept alone on both sides of a mirror. */
export const windowsKeepOut = ` /XF ${windowsKeep.files.map((f) => `"${f}"`).join(" ")} /XD "${windowsKeep.folder}"`;

/** Windows: the same way back, as a batch file run through the hidden launcher (no console window). */
export function windowsRollbackScript(plan: { install: string; exe: string; log: string }): string {
  const sys = "%SystemRoot%\\System32\\";
  const previous = `${plan.install}.previous`, failed = `${plan.install}.failed`;
  const mirror = (from: string, to: string, extra = "") => `${sys}robocopy.exe "${from}" "${to}" /MIR${extra} /R:10 /W:1 /NP /NFL /NDL >>"${plan.log}" 2>&1`;
  return [
    "@echo off", "setlocal", 'set "PID=%~1"', "set WAITED=0",
    `echo [%date% %time%] going back to the previous version for pid %PID% >>"${plan.log}"`,
    ":wait", `${sys}tasklist.exe /FI "PID eq %PID%" /NH /FO CSV 2>NUL | ${sys}find.exe ",""%PID%""," >NUL`,
    `if not errorlevel 1 if %WAITED% lss 60 ( set /a WAITED+=1 & ${sys}ping.exe -n 2 127.0.0.1 >NUL & goto wait )`,
    `if not exist "${previous}\\" ( echo [%time%] there is no previous version to go back to >>"${plan.log}" & exit /b 1 )`,
    // mac7/real-update review: since the swap moves Branch Data and the uninstaller into the version in
    // use, the previous copy no longer has them, and a plain mirror would delete them from the program folder.
    mirror(plan.install, failed, windowsKeepOut), mirror(previous, plan.install, windowsKeepOut), "if errorlevel 8 exit /b 1",
    `echo [%time%] previous version is back >>"${plan.log}"`,
    'if "%~2"=="stay" exit /b 0', `start "" "${plan.exe}"`, "exit /b 0", "",
  ].join("\r\n");
}
