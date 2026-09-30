import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { daemonCommand, daemonLauncherName } from "./daemon.js";
import { headlessUpdate, type HeadlessUpdateDeps } from "./headless-update.js";
import { rollbackCommand, type RollbackCliDeps } from "./rollback-cli.js";
import { quitRunning, runningNow, type QuitDeps } from "./quit.js";
import { fetchedFolders, performUnixUninstall, unixLayout, type UnixLayout, type UnixUninstallReport } from "./unix-install.js";
import type { RunTool } from "./windows.js";
import { managementDataDir } from "./manage-location.js";
import { quitShellAndEngine, runningShell } from "./quit-shell.js";

/**
 * The commands a script uses to manage an installed Branch without clicking (bucket 22, issue #106):
 *
 *   branch --version --json      what is installed, where, and whether it is running
 *   branch quit                  close the running Branch and wait until it has gone
 *   branch update [--yes]        check for, and with --yes install, the newest release
 *   branch uninstall [--delete-data]   remove Branch and everything it downloaded; conversations
 *                                      and files stay unless asked
 *   branch rollback [--yes]      go back to the version before the last update, or say why it cannot
 *
 * Each answers with an exit code: 0 only when it did what it says.
 */
export interface ManageContext {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  version: string;
  /** The folder holding this copy's package.json (a Git checkout has `.git` beside it). */
  packageRoot: string;
  print: (line: string) => void;
  deps?: { quit?: QuitDeps; update?: HeadlessUpdateDeps; run?: RunTool; layout?: UnixLayout; rollback?: RollbackCliDeps };
}

export interface VersionInfo { version: string; path: string; dataDir: string; running: boolean; installed: boolean }

const dataDirOf = (env: NodeJS.ProcessEnv): string => resolve(env.BRANCH_DATA_DIR ?? ".branch");

export async function versionInfo(context: ManageContext): Promise<VersionInfo> {
  const dataDir = await managementDataDir(context);
  const installRoot = context.env.BRANCH_INSTALL_ROOT;
  return {
    version: context.version, path: installRoot || context.packageRoot, dataDir,
    running: (await runningNow(dataDir, context.deps?.quit?.alive)) !== null
      || (await runningShell(dataDir, context.deps?.quit?.alive)) !== null, installed: Boolean(installRoot),
  };
}

async function quit(context: ManageContext): Promise<number> {
  const report = await quitShellAndEngine(await managementDataDir(context), context.deps?.quit);
  context.print(report.message);
  return report.stopped ? 0 : 1;
}

export const windowsRemoveNote =
  "On Windows, remove Branch under Add or remove programs, or run `Uninstall Branch Agent.cmd /quiet` from its folder (add --delete-data to remove conversations and files too).";

export interface UninstallOutcome { ok: boolean; lines: string[]; report: UnixUninstallReport | null }

/**
 * The one remover (mac7/clean-uninstall). The command line and the danger zone in Settings both
 * come through here, so there is never a second path that removes a different set of things.
 */
export async function runUninstall(context: ManageContext, options: { deleteData: boolean }): Promise<UninstallOutcome> {
  if (context.platform === "win32") return { ok: false, lines: [windowsRemoveNote], report: null };
  if (context.platform !== "darwin" && context.platform !== "linux")
    return { ok: false, lines: ["Removing Branch is not available on this kind of computer."], report: null };
  const layout = context.deps?.layout ?? unixLayout(context.platform, context.env);
  const report = await performUnixUninstall({
    layout, deleteData: options.deleteData,
    stop: async () => {
      const closed = await quitRunning(layout.dataDir, context.deps?.quit);
      if (!closed.stopped) throw new Error(closed.message);
    },
    removeService: async () => {
      await daemonCommand("uninstall", {
        executable: "", script: "", dataDir: layout.dataDir, workspace: layout.workspace, port: 0,
        launcherPath: join(layout.dataDir, daemonLauncherName), platform: context.platform,
        plistPath: layout.serviceFile, unitPath: layout.serviceFile,
      }, context.deps?.run ? { run: context.deps.run } : {});
    },
  });
  const lines = [report.removed.length ? `Branch Agent has been removed (${report.removed.length} places).` : "Branch Agent was not installed here; nothing needed removing."];
  for (const copy of report.left) lines.push(`${copy} was not put there by this installer, so it was left; remove it yourself if you want it gone.`);
  // mac7/clean-uninstall: say what went from inside the folder that was kept, so "kept" is not read
  // as "nothing in there was touched" when gigabytes of models have just gone.
  const fetched = report.removed.filter((path) => fetchedFolders(layout).includes(path));
  if (fetched.length) lines.push(`The programs Branch downloaded to run models, and their models, were removed with it: ${fetched.join(", ")}.`);
  lines.push(report.dataKept ? `Your conversations and files are kept in ${report.dataKept}.` : "Your conversations and files were removed too.");
  return { ok: true, lines, report };
}

async function uninstall(context: ManageContext, args: string[]): Promise<number> {
  const outcome = await runUninstall(context, { deleteData: args.includes("--delete-data") });
  for (const line of outcome.lines) context.print(line);
  return outcome.ok ? 0 : 1;
}

/** Answers with an exit code, or null when the command is not one of these (or `update` belongs to a Git checkout). */
export async function manageCommand(args: string[], context: ManageContext): Promise<number | null> {
  const [command = "", ...rest] = args;
  if (command === "version" && rest.includes("--json")) {
    context.print(JSON.stringify(await versionInfo(context)));
    return 0;
  }
  if (command === "quit") return quit(context);
  // mac7/safe-rollback: undoing the last update, or refusing to in words the person can act on.
  if (command === "rollback")
    return rollbackCommand({ dataDir: dataDirOf(context.env), version: context.version,
      platform: context.platform, yes: rest.includes("--yes") || rest.includes("-y"), print: context.print,
      ...(context.deps?.rollback ? { deps: context.deps.rollback } : {}) });
  if (command === "uninstall") return uninstall(context, rest);
  if (command !== "update") return null;
  const installRoot = context.env.BRANCH_INSTALL_ROOT;
  if (!installRoot || existsSync(join(context.packageRoot, ".git"))) return null;
  return headlessUpdate({
    installRoot, dataDir: dataDirOf(context.env), version: context.version, platform: context.platform,
    yes: rest.includes("--yes") || rest.includes("-y"), print: context.print, ...(context.deps?.update ? { deps: context.deps.update } : {}),
  });
}
