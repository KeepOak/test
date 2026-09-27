/**
 * eng-connectors review 2: the owner's yes to a server of their own is bound to its launch line (command, arguments,
 * folder, secret names), not to the bytes of the program that line runs. Anything inside the workspace can be rewritten
 * by a task that may write there, so a program there could be swapped after the yes and run, unsandboxed, as Branch
 * starts. The same rule own-clis and default-shell hold to: a server is refused when
 * - it would start in a folder inside the workspace (a bare name is then found there first: Windows looks in the
 *   folder before PATH, and `npx` looks in its node_modules/.bin), or a runner is told to move into one: npm/npx
 *   -C/--prefix/-w/--workspace, pnpm -C/--dir, yarn/bun --cwd, uv/uvx --directory/--project, PowerShell
 *   -WorkingDirectory, wsl --cd; or deno is told to read its settings file from there (--config/-c);
 * - its program is inside the workspace (written as a path, or the first match on PATH);
 * - any argument, or the value of a `--name=value` argument, is an existing file inside the workspace; a `file:` URL is
 *   read as the path it names (`node --import file:///…/srv.mjs`), a leading `~` as the home folder, and on Windows a
 *   WSL `/mnt/<drive>/…` path as the drive path;
 * - a program that runs a folder (node, python, npx…) is given a workspace folder as the thing to run, found past the
 *   options that take a value first (`node -r x <folder>`, `python -X opt <folder>`);
 * - it runs inline code that names a place inside the workspace: node's -e/--eval/-p/--print, python's -c, deno's
 *   eval, npx's -c, a `data:` URL (`node --import data:text/javascript,…`), or the command string a shell is given
 *   (bash/sh/zsh -c, PowerShell -Command or -EncodedCommand, `cmd /c "…"`);
 * - a package runner (npx, npm, uvx, uv, pip, and `python -m pip|uv|pipx`) is told to take its package from inside
 *   the workspace: --package/-p, --prefix, --from, --with/-w, --with-editable, --spec, and -e/--editable for pip and uv.
 * Every option counts as `--opt=value` or `--opt value`. A program started by another (`cmd /c`, a shell's -c,
 * PowerShell, wsl, `python -m`) is judged by all of these rules too (src/mcp-launch-shapes.ts reads the line). A command
 * string is read as written, with its escapes read (cmd's `^`, PowerShell's backtick), and as its shell splits it into
 * words, so a name split by quotes (`work"sp"ace`) or escapes (`w^ork`) reads whole.
 * Paths are compared with links followed (realpathSync.native), which on Windows also expands 8.3 short names.
 * The code, package and folder-option checks read text, not files: they refuse a written mention of the workspace,
 * whether or not it exists yet. Code that builds the path at run time (joined pieces of it, an environment variable,
 * text it decodes itself) is not caught. A shell command string that names the workspace is refused even as data:
 * give a filesystem server its folder as an argument of its own instead.
 * Any other folder argument stays allowed, so a server pointed at the workspace (a filesystem server) still works.
 * Checked when a server is added and again before every start.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inWorkspace } from "./integrations/default-shell.js";
import { realFolder } from "./folder-trust.js";
import { denoConfig, entryOf, folderValues, inlineCode, launches, nameOf, packageSources, valueOf, type Launch } from "./mcp-launch-shapes.js";
import type { McpTransportConfig } from "./integrations/mcp-config.js";

export const workspaceFolderRefusal = "That server would start in a folder inside the workspace, where the assistant can write, "
  + "so a program found there could be one it put there. Branch does not start it. Choose a folder outside the workspace.";
export const workspaceProgramRefusal = "That program is inside the workspace, where the assistant can write, so Branch does not "
  + "start it. Give the full address of a program outside the workspace.";
export const workspaceFileRefusal = (name: string): string => `That server would run ${name}, a file inside the workspace, `
  + "where the assistant can write, so Branch does not start it. Keep the file outside the workspace.";
export const workspaceEntryRefusal = (name: string): string => `That server would run the folder ${name}, inside the workspace, `
  + "where the assistant can write, so Branch does not start it. Keep its program outside the workspace.";
export const workspaceCodeRefusal = "That server would run code that names a place inside the workspace, where the assistant "
  + "can write, so Branch does not start it. Keep what it runs outside the workspace.";
export const workspacePackageRefusal = "That server would take its package from inside the workspace, where the assistant can "
  + "write, so Branch does not start it. Keep the package outside the workspace.";

const isFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };
const isFolder = (path: string): boolean => { try { return statSync(path).isDirectory(); } catch { return false; } };
const windows = process.platform === "win32";
const pathLike = (text: string): boolean => isAbsolute(text) || /[\\/]/.test(text);
/** On Windows, WSL's `/mnt/c/…` is `C:\…`. */
const fromWsl = (text: string): string | null => {
  const found = windows ? /^\/mnt\/([a-z])(\/.*)?$/i.exec(text) : null;
  return found ? `${found[1]}:${found[2] ?? "/"}` : null;
};

/** A leading `~/` or `~\` is the home folder, the way a shell (and many programs) read it. */
const fromHome = (text: string): string | null => (/^~(?=$|[\\/])/.test(text) ? join(homedir(), text.slice(1)) : null);

/**
 * The path a launch argument names: a `file:` URL is read as its path (a relative one against the folder, the way Node
 * and npm read `file:../pkg`), a leading `~` as the home folder, anything else is resolved against the folder. Null for a
 * `file:` URL that names no path.
 */
function asPath(text: string, cwd: string): string | null {
  if (!/^file:/i.test(text)) return resolve(cwd, fromWsl(text) ?? fromHome(text) ?? text);
  try { return fileURLToPath(new URL(text, pathToFileURL(cwd + sep))); } catch { return null; }
}

/** The file a bare program name starts, the way the program starter finds it: the folder first on Windows, then PATH. */
function firstOnPath(name: string, env: NodeJS.ProcessEnv, cwd: string): string | null {
  const folders = ((windows ? env.PATH ?? env.Path : env.PATH) ?? "").split(delimiter).filter(Boolean);
  const endings = windows ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  for (const folder of windows ? [cwd, ...folders] : folders)
    for (const ending of endings) {
      const candidate = resolve(cwd, folder, `${name}${ending}`);
      if (isFile(candidate)) return candidate;
    }
  return null;
}

/** Text as compared for a mention: on Windows, `\\` (as written in a code string) and `\` read as `/`, in any case. */
const folded = (text: string): string => (windows ? text.replace(/\\\\/g, "\\").replace(/\\/g, "/").toLowerCase() : text);
/** The ways the workspace's address is written: as a path, with links followed, as a file: URL, and as WSL sees it. */
function addresses(workspace: string): string[] {
  const paths = [resolve(workspace), realFolder(workspace)];
  const wsl = windows ? paths.map((path) => `/mnt/${path[0]}${path.slice(2)}`) : [];
  return [...new Set([...paths, ...wsl, pathToFileURL(resolve(workspace)).href].map((form) => folded(form).replace(/[\\/]+$/, "")))]
    .filter(Boolean);
}

/**
 * Whether text (code, a command string, a package source or a folder option) names the workspace or a place in it: the
 * workspace's address written out, followed by anything that cannot carry on a folder name, or a word in it that, read
 * as a path from the folder the server starts in, lands inside the workspace (`../ws/srv.mjs`, `file:../ws/pkg`).
 */
function namesWorkspace(text: string, cwd: string, workspace: string, inside: (path: string) => boolean): boolean {
  const said = folded(text);
  for (const form of addresses(workspace))
    for (let at = said.indexOf(form); at >= 0; at = said.indexOf(form, at + 1))
      if (!/[\p{L}\p{N}_.-]/u.test(said[at + form.length] ?? "")) return true;
  const words = new Set(text.split(/[\s'"`()[\]{},;+=@|&<>]+/).filter((word) => word && word.length <= 4096));
  for (const word of words) {
    const path = asPath(word, cwd);
    if (path && inside(path)) return true;
  }
  return false;
}

interface Judge { cwd: string; env: NodeJS.ProcessEnv; inside: (path: string) => boolean; names: (text: string) => boolean }

/** The rules for one program in the launch line, in plain words, or null when it passes them all. */
function launchRefusal(launch: Launch, judge: Judge): string | null {
  const { cwd, inside, names } = judge, name = nameOf(launch), args = launch.args;
  if (!launch.module) {
    const program = pathLike(launch.command) || fromWsl(launch.command) ? asPath(launch.command, cwd) : firstOnPath(launch.command, judge.env, cwd);
    if (program && inside(program)) return workspaceProgramRefusal;
  }
  const first = entryOf(name, args), entry = first === undefined ? null : asPath(first, cwd);
  if (entry && isFolder(entry) && inside(entry)) return workspaceEntryRefusal(basename(entry));
  for (const arg of args)
    for (const text of [arg, valueOf(arg)]) {
      if (!text || text.length > 1000) continue;
      const path = asPath(text, cwd);
      if (path && isFile(path) && inside(path)) return workspaceFileRefusal(basename(path));
    }
  if ([...inlineCode(name, args), ...launch.texts].some(names)) return workspaceCodeRefusal;
  if (packageSources(name, args).some(names)) return workspacePackageRefusal;
  if ([...folderValues(name, args), ...launch.folders].some(names)) return workspaceFolderRefusal;
  const settings = denoConfig(name, args).find(names);
  if (settings !== undefined) return workspaceFileRefusal(basename(asPath(settings, cwd) ?? settings));
  return null;
}

/** Why a server of the owner's may not be started from where it is, in plain words, or null when it may. */
export function workspaceRefusal(server: McpTransportConfig, workspace: string, env: NodeJS.ProcessEnv): string | null {
  if (server.transport !== "stdio") return null;
  const inside = (path: string): boolean => inWorkspace(workspace, path, process.platform);
  // With no folder of its own, a server starts in Branch's own folder, which is judged the same way.
  const cwd = resolve(server.cwd ?? process.cwd());
  if (inside(cwd)) return workspaceFolderRefusal;
  const judge: Judge = { cwd, env, inside, names: (text) => namesWorkspace(text, cwd, workspace, inside) };
  for (const launch of launches(server.command, server.args)) {
    const refusal = launchRefusal(launch, judge);
    if (refusal) return refusal;
  }
  return null;
}
