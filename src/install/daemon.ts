import { rm } from "node:fs/promises";
import { systemTool, type RunTool } from "./windows.js";
import { forgetGatewayTask, gatewayFlag, gatewaySupervision, gatewayTaskName, registerGatewayTask, removeGatewayTask, taskUser,
  type GatewayTaskDeps, type WriteShortcut } from "./gateway-task.js";
import { launchdCommand, launchdPlistPath } from "./launchd.js";
import { systemdCommand, systemdUnitPath } from "./systemd.js";

/**
 * Windows Script Host text that runs a command with window style 0 (hidden) and does not wait. The sign-in task no
 * longer uses it (src/install/gateway-task.ts), nor does the update hand-over (src/desktop/hand-over.ts); only the fresh
 * engine an update starts does (src/install/old-engine.ts).
 */
export function hiddenRunner(command: string): string {
  return `CreateObject("WScript.Shell").Run "${command.replace(/"/g, '""')}", 0, False\r\n`;
}

/**
 * Keeping Branch working with the window closed. The operating system starts Branch's background gateway when the
 * person signs in, with no window at all, and starts it again if it stops by accident, so timed jobs, chat channels
 * and triggers keep running. The app window, when it is opened later, joins that running gateway instead of starting
 * a second one.
 */
export const daemonTaskName = gatewayTaskName;
/** The script-host launcher earlier versions wrote for the Windows task; installing or removing now deletes it. */
export const daemonLauncherName = "branch-daemon.vbs";

export interface DaemonOptions {
  /** The app's own executable; it carries the runtime the engine needs. */
  executable: string;
  /** The engine's start script inside the installed app. */
  script: string;
  dataDir: string;
  workspace: string;
  port: number;
  /** Where earlier versions wrote their Windows launcher, which is removed now. */
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
export interface DaemonDeps {
  run?: RunTool;
  write?: (path: string, content: string) => Promise<void>;
  /** Windows: how a Startup shortcut is written where schtasks is refused (tests hand in a stand-in). */
  writeShortcut?: WriteShortcut;
  /** Windows: where this account's Startup folder is (APPDATA). */
  env?: NodeJS.ProcessEnv;
}
export type DaemonAction = "install" | "uninstall" | "status";
export interface DaemonReport {
  action: DaemonAction;
  taskName: string;
  installed: boolean;
  command?: string;
  message: string;
}

/** The engine, with its folders and port, through the app's own runtime (src/install/old-engine.ts starts it so). */
export function daemonCommandLine(options: DaemonOptions): string {
  const settings = [
    ["ELECTRON_RUN_AS_NODE", "1"],
    ["BRANCH_DATA_DIR", options.dataDir],
    ["BRANCH_WORKSPACE", options.workspace],
    ["BRANCH_PORT", String(options.port)],
  ].map(([name, value]) => `set "${name}=${value}"`).join(" & ");
  return `${systemTool("cmd.exe", options.systemRoot)} /d /c ${settings} & "${options.executable}" "${options.script}" start`;
}

/**
 * Windows (UP-PLATFORM-002): the installed app's own gateway, `"Branch Agent.exe" --branch-gateway`, registered as a
 * scheduled task that starts it at sign-in and again after a crash, or a Startup shortcut where schtasks is refused
 * (src/install/gateway-task.ts). The script-host launcher earlier versions wrote is removed.
 */
async function install(options: DaemonOptions, deps: DaemonDeps): Promise<DaemonReport> {
  const kind = await registerGatewayTask({ executable: options.executable, atSignIn: true, user: taskUser(), dataDir: options.dataDir },
    windowsDeps(options, deps));
  await rm(options.launcherPath, { force: true }).catch(() => undefined);
  return {
    action: "install", taskName: options.taskName ?? daemonTaskName, installed: true, command: `"${options.executable}" ${gatewayFlag}`,
    message: kind === "task"
      ? "Branch now starts by itself when you sign in to Windows, with no window, and starts again if it stops by accident. Timed jobs and chat replies keep working when the window is closed."
      : "Windows would not let Branch add a scheduled task, so it starts from your Startup folder when you sign in instead. It will not be started again by itself if it stops; open Branch then.",
  };
}

async function uninstall(options: DaemonOptions, deps: DaemonDeps): Promise<DaemonReport> {
  const taskName = options.taskName ?? daemonTaskName;
  await removeGatewayTask(windowsDeps(options, deps));
  await forgetGatewayTask(options.dataDir);
  await rm(options.launcherPath, { force: true }).catch(() => undefined);
  return { action: "uninstall", taskName, installed: false, message: "Branch will no longer start by itself. Open the app when you want it." };
}

async function status(options: DaemonOptions, deps: DaemonDeps): Promise<DaemonReport> {
  const taskName = options.taskName ?? daemonTaskName;
  const kind = await gatewaySupervision(windowsDeps(options, deps));
  return {
    action: "status", taskName, installed: kind !== "none",
    message: kind === "task" ? "Branch starts by itself when you sign in to Windows, and again if it stops by accident."
      : kind === "startup" ? "Branch starts from your Startup folder when you sign in to Windows."
        : "Branch does not start by itself. Run `branch daemon install` to switch that on.",
  };
}

const windowsDeps = (options: DaemonOptions, deps: DaemonDeps): GatewayTaskDeps => ({
  ...(deps.run ? { run: deps.run } : {}), ...(deps.writeShortcut ? { writeShortcut: deps.writeShortcut } : {}),
  ...(deps.env ? { env: deps.env } : {}), ...(options.systemRoot ? { systemRoot: options.systemRoot } : {}),
});

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
