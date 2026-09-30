import { writeFile, rm } from "node:fs/promises";
import { runTool, systemTool, type RunTool } from "./windows.js";
import { launchdCommand, launchdPlistPath } from "./launchd.js";
import { systemdCommand, systemdUnitPath } from "./systemd.js";

/**
 * Windows Script Host text that runs a command with window style 0 (hidden) and does not wait. Used only to start the
 * background engine at sign-in and on request (UP-PLATFORM-006a moves these off VBScript too); the update hand-over
 * no longer uses it (src/desktop/hand-over.ts).
 */
export function hiddenRunner(command: string): string {
  return `CreateObject("WScript.Shell").Run "${command.replace(/"/g, '""')}", 0, False\r\n`;
}

/**
 * Keeping Branch working with the window closed. A Windows scheduled task starts the assistant's
 * engine when the person signs in, with no window at all, so timed jobs, chat channels and triggers
 * keep running. The app window, when it is opened later, joins that running engine instead of
 * starting a second one.
 */
export const daemonTaskName = "Branch Agent daemon";
export const daemonLauncherName = "branch-daemon.vbs";

export interface DaemonOptions {
  /** The app's own executable; it carries the runtime the engine needs. */
  executable: string;
  /** The engine's start script inside the installed app. */
  script: string;
  dataDir: string;
  workspace: string;
  port: number;
  /** Where the tiny no-window launcher is written. */
  launcherPath: string;
  taskName?: string;
  systemRoot?: string;
  /** Which system to set up for; defaults to this computer's. */
  platform?: NodeJS.Platform;
  /** macOS: where the sign-in file goes (defaults to the person's LaunchAgents folder). */
  plistPath?: string;
  /** Linux: where the sign-in file goes (defaults to the person's systemd user folder). */
  unitPath?: string;
  /** macOS: the signed-in person's user id. */
  uid?: number;
}
export interface DaemonDeps { run?: RunTool; write?: (path: string, content: string) => Promise<void> }
export type DaemonAction = "install" | "uninstall" | "status";
export interface DaemonReport {
  action: DaemonAction;
  taskName: string;
  installed: boolean;
  command?: string;
  message: string;
}

/** The command the task runs: the engine, with its folders and port, through the app's own runtime. */
export function daemonCommandLine(options: DaemonOptions): string {
  const settings = [
    ["ELECTRON_RUN_AS_NODE", "1"],
    ["BRANCH_DATA_DIR", options.dataDir],
    ["BRANCH_WORKSPACE", options.workspace],
    ["BRANCH_PORT", String(options.port)],
  ].map(([name, value]) => `set "${name}=${value}"`).join(" & ");
  return `${systemTool("cmd.exe", options.systemRoot)} /d /c ${settings} & "${options.executable}" "${options.script}" start`;
}

export function daemonInstallArgs(options: DaemonOptions): string[] {
  const wscript = systemTool("wscript.exe", options.systemRoot);
  return ["/Create", "/F", "/RL", "LIMITED", "/SC", "ONLOGON", "/TN", options.taskName ?? daemonTaskName,
    "/TR", `"${wscript}" //B //Nologo "${options.launcherPath}"`];
}
export function daemonUninstallArgs(taskName = daemonTaskName): string[] {
  return ["/Delete", "/F", "/TN", taskName];
}
export function daemonStatusArgs(taskName = daemonTaskName): string[] {
  return ["/Query", "/TN", taskName];
}

async function install(options: DaemonOptions, deps: DaemonDeps): Promise<DaemonReport> {
  const run = deps.run ?? runTool;
  const write = deps.write ?? ((path: string, content: string) => writeFile(path, content, "utf8"));
  const command = daemonCommandLine(options);
  await write(options.launcherPath, hiddenRunner(command));
  await run(systemTool("schtasks.exe", options.systemRoot), daemonInstallArgs(options));
  return {
    action: "install", taskName: options.taskName ?? daemonTaskName, installed: true, command,
    message: "Branch now starts by itself when you sign in to Windows, with no window. Timed jobs and chat replies keep working when the window is closed.",
  };
}

async function uninstall(options: DaemonOptions, deps: DaemonDeps): Promise<DaemonReport> {
  const run = deps.run ?? runTool, taskName = options.taskName ?? daemonTaskName;
  await run(systemTool("schtasks.exe", options.systemRoot), daemonUninstallArgs(taskName)).catch(() => undefined);
  await rm(options.launcherPath, { force: true }).catch(() => undefined);
  return { action: "uninstall", taskName, installed: false, message: "Branch will no longer start by itself. Open the app when you want it." };
}

async function status(options: DaemonOptions, deps: DaemonDeps): Promise<DaemonReport> {
  const run = deps.run ?? runTool, taskName = options.taskName ?? daemonTaskName;
  const installed = await run(systemTool("schtasks.exe", options.systemRoot), daemonStatusArgs(taskName))
    .then(() => true, () => false);
  return {
    action: "status", taskName, installed,
    message: installed
      ? "Branch starts by itself when you sign in to Windows."
      : "Branch does not start by itself. Run `branch daemon install` to switch that on.",
  };
}

/**
 * macOS and Linux use their own sign-in systems; Windows keeps its scheduled task. Any other system
 * gets an honest answer instead of an attempt.
 */
export async function daemonCommand(
  action: DaemonAction, options: DaemonOptions, deps: DaemonDeps = {},
): Promise<DaemonReport> {
  const platform = options.platform ?? process.platform;
  if (platform === "darwin")
    return launchdCommand(action, options, { path: options.plistPath ?? launchdPlistPath(), ...(options.uid === undefined ? {} : { uid: options.uid }) }, deps);
  if (platform === "linux")
    return systemdCommand(action, options, { path: options.unitPath ?? systemdUnitPath() }, deps);
  if (platform !== "win32")
    return { action, taskName: daemonTaskName, installed: false, message: "Starting by itself is not available on this kind of computer yet. Open Branch when you want it." };
  if (action === "install") return install(options, deps);
  if (action === "uninstall") return uninstall(options, deps);
  return status(options, deps);
}
