import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { posix } from "node:path";

// These files only ever exist on macOS or Linux, so their paths use forward slashes wherever they are composed.
const { dirname, join } = posix;
import type { DaemonAction, DaemonReport } from "./daemon.js";
import { serviceEnvironment, serviceLogFiles, type ServiceDeps, type ServiceProgram, type ServiceTarget } from "./launchd.js";
import { runTool } from "./windows.js";

/**
 * Keeping Branch working with the window closed, on Linux. A small file in the person's own settings
 * folder asks the system to start the engine when they sign in, with no window, and to start it
 * again whenever it stops, except when it was stopped on purpose. Nothing needs administrator rights.
 */
export const systemdUnitName = "branch-agent.service";
export const systemctl = "systemctl";
/**
 * UP-PLATFORM-002: the exit code of an engine stopped on purpose (`branch quit`, or closed for an update, which
 * starts it again itself). `RestartPreventExitStatus=` keeps systemd from starting it again then. 78 is EX_CONFIG,
 * the code OpenClaw's unit reserves for the same purpose (`src/daemon/systemd-unit.ts`, MIT).
 */
export const stoppedOnPurposeCode = 78;
/** Set in the unit, so the engine knows systemd is the one that would start it again. */
export const serviceManagerVariable = "BRANCH_SERVICE_MANAGER";

/**
 * An engine systemd runs is about to stop on purpose: it exits with `stoppedOnPurposeCode`, so it stays stopped.
 * An exit code already chosen is kept (the dashboard's Restart sets 75 so that it is started again, src/dashboard-api.ts).
 * Anywhere else nothing changes (launchd's KeepAlive would restart any non-zero exit).
 */
export function markStoppedOnPurpose(env: NodeJS.ProcessEnv = process.env, target: { exitCode?: number | string | null | undefined } = process): void {
  if (env[serviceManagerVariable] === "systemd" && !target.exitCode) target.exitCode = stoppedOnPurposeCode;
}

export function systemdUnitPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user", systemdUnitName);
}

/** A line break in a path would start a new setting in the file, so such a path is refused. */
function plain(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error("A folder name with a line break in it cannot be used here.");
  return value.replace(/%/g, "%%");
}
/**
 * One quoted word for ExecStart= (where `$` would be expanded, so it is doubled) or, with
 * `expands` false, for Environment=. Backslash, quote and % are always escaped.
 */
export function systemdQuote(value: string, expands = true): string {
  const escaped = plain(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${expands ? escaped.replace(/\$/g, "$$$$") : escaped}"`;
}

/**
 * The sign-in file: starts at sign-in and again whenever it stops unless it was stopped on purpose, never opens a
 * window. The start limit (five starts in ten minutes) keeps a gateway that dies at once from being restarted forever;
 * the restart storm is also said in Settings › Gateway (src/never-break/gateway-state.ts).
 */
export function systemdUnit(program: ServiceProgram): string {
  const logs = serviceLogFiles(program.dataDir);
  return [
    "[Unit]",
    "Description=Branch Agent, working with the window closed",
    "StartLimitIntervalSec=600",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${[program.executable, program.script, "start"].map((word) => systemdQuote(word)).join(" ")}`,
    ...[...serviceEnvironment(program), [serviceManagerVariable, "systemd"]]
      .map(([name, value]) => `Environment=${systemdQuote(`${name}=${value}`, false)}`),
    `WorkingDirectory=${plain(program.dataDir)}`,
    "Restart=always",
    "RestartSec=10",
    `RestartPreventExitStatus=${stoppedOnPurposeCode}`,
    // ...and counts as a clean end, so `branch quit` leaves the unit inactive rather than failed.
    `SuccessExitStatus=${stoppedOnPurposeCode}`,
    `StandardOutput=append:${plain(logs.out)}`,
    `StandardError=append:${plain(logs.err)}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

export const systemdReloadArgs = () => ["--user", "daemon-reload"];
export const systemdEnableArgs = () => ["--user", "enable", "--now", systemdUnitName];
export const systemdDisableArgs = () => ["--user", "disable", "--now", systemdUnitName];
export const systemdIsEnabledArgs = () => ["--user", "is-enabled", systemdUnitName];

async function install(program: ServiceProgram, target: ServiceTarget, deps: ServiceDeps): Promise<DaemonReport> {
  const run = deps.run ?? runTool;
  const write = deps.write ?? ((path: string, content: string) => writeFile(path, content, "utf8"));
  const unit = systemdUnit(program);
  await mkdir(dirname(target.path), { recursive: true });
  await mkdir(dirname(serviceLogFiles(program.dataDir).out), { recursive: true });
  await write(target.path, unit);
  await run(systemctl, systemdReloadArgs());
  await run(systemctl, systemdEnableArgs());
  return {
    action: "install", taskName: systemdUnitName, installed: true, command: `${program.executable} ${program.script} start`,
    message: "Branch now starts by itself when you sign in, with no window. Timed jobs and chat replies keep working when the window is closed.",
  };
}

async function uninstall(target: ServiceTarget, deps: ServiceDeps): Promise<DaemonReport> {
  const run = deps.run ?? runTool;
  await run(systemctl, systemdDisableArgs()).catch(() => undefined);
  await rm(target.path, { force: true }).catch(() => undefined);
  await run(systemctl, systemdReloadArgs()).catch(() => undefined);
  return { action: "uninstall", taskName: systemdUnitName, installed: false, message: "Branch will no longer start by itself. Open the app when you want it." };
}

async function status(deps: ServiceDeps): Promise<DaemonReport> {
  const run = deps.run ?? runTool;
  const installed = await run(systemctl, systemdIsEnabledArgs()).then(() => true, () => false);
  return {
    action: "status", taskName: systemdUnitName, installed,
    message: installed
      ? "Branch starts by itself when you sign in."
      : "Branch does not start by itself. Run `branch daemon install` to switch that on.",
  };
}

export async function systemdCommand(
  action: DaemonAction, program: ServiceProgram, target: ServiceTarget, deps: ServiceDeps = {},
): Promise<DaemonReport> {
  if (action === "install") return install(program, target, deps);
  if (action === "uninstall") return uninstall(target, deps);
  return status(deps);
}
