import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join, win32 } from "node:path";
import { folderContains, realFolder } from "../folder-trust.js";
import { startCall } from "../windows-command.js";
import type { ShellConfig } from "./shell-config.js";

/**
 * Branch builds Branch (dogfood A2): with no command settings file, the desktop app had no way at all to run a
 * command on its own computer, so asked to fix its own code it could not even look at it. It now starts with the
 * everyday developer programs already installed here, each by its full address, so nothing that is not on this
 * computer is ever run. The owner's rules still decide whether each command is asked about; a settings file, when
 * there is one, replaces this list entirely.
 */
export const defaultPrograms = ["git", "node", "npm", "npx", "python", "gh"] as const;

const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };
const runnable = (path: string): boolean => { try { accessSync(path, constants.X_OK); return isFile(path); } catch { return false; } };

/**
 * The workspace or a folder inside it, as written or with links followed: the rule a launch settings file in the
 * workspace is judged by (`integrationsFileTrusted`, src/folder-trust.ts).
 */
export const inWorkspace = (workspace: string, folder: string, platform: NodeJS.Platform): boolean =>
  folderContains(workspace, folder, platform)
  || folderContains(realFolder(workspace, platform), realFolder(folder, platform), platform);

/**
 * The PATH folders a default program may come from. A folder that is not a full address (`./node_modules/.bin`) is
 * left out: it names a different place from each folder, and command settings take only full addresses. So is the
 * workspace and every folder in it: the assistant can write there, so a program found there could be one it put there.
 */
export function programFolders(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, workspaces: readonly string[]): string[] {
  const absolute = platform === "win32" ? win32.isAbsolute : isAbsolute;
  return ((platform === "win32" ? env.PATH ?? env.Path : env.PATH) ?? "").split(delimiter).filter(Boolean)
    .filter((folder) => absolute(folder))
    .filter((folder) => !workspaces.some((workspace) => inWorkspace(workspace, folder, platform)));
}

/** A program's full address and the arguments that must come first, or null when it is not installed here. */
export function locateProgram(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): { path: string; args: string[] } | null {
  if (platform === "win32") {
    const start = startCall(name, [], env, platform);
    if (isAbsolute(start.command)) return { path: start.command, args: start.args };
    // An npm launcher is started as Node running its script; Node itself then needs its own full address.
    if (name === "node" || start.command !== "node" || !start.args.length) return null;
    const node = locateProgram("node", env, platform);
    return node ? { path: node.path, args: start.args } : null;
  }
  for (const folder of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(folder, name);
    if (runnable(candidate)) return { path: candidate, args: [] };
  }
  return null;
}

/**
 * The command settings Branch starts with when it has none, or null when none of the programs is installed. The
 * programs are looked for only in the PATH folders `programFolders` keeps, never in the given workspaces.
 */
export function defaultShellConfig(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform,
  workspaces: readonly string[] = []): ShellConfig | null {
  // PATH is set outright, so a Windows `Path` with the left-out folders still in it is never read instead.
  const lookIn = { ...env, PATH: programFolders(env, platform, workspaces).join(delimiter) };
  const executables: ShellConfig["executables"] = {};
  for (const name of defaultPrograms) {
    const found = locateProgram(name, lookIn, platform);
    if (found) executables[name] = found;
  }
  // Ubuntu and macOS install Python 3 as `python3` alone. It is offered under that name, the program that runs, so
  // the owner's rules name it too: a yes for `python …` never covers `python3 …`, nor the reverse.
  const python3 = executables.python ? null : locateProgram("python3", lookIn, platform);
  if (python3) executables.python3 = python3;
  if (!Object.keys(executables).length) return null;
  const home = env.HOME ?? env.USERPROFILE;
  return {
    executables,
    inheritEnv: ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USER", "LANG", "TZ"],
    // Git and npm find their settings from the home folder, which Windows names USERPROFILE.
    env: home && !env.HOME ? { HOME: home } : {},
    timeoutMs: 120_000, maxMemoryMb: 4096, maxCpuSeconds: 600, maxOutputBytes: 8192, netless: false, useJobObject: true,
  };
}
