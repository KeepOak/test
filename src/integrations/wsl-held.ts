import { existsSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShellProcess } from './shell-process.js';
import { wslPath, type SandboxProbe, type SandboxStart } from '../sandbox-backends.js';

/**
 * Self-development on Windows: a command held to the worktree runs inside WSL, behind the same Linux
 * wall (bubblewrap) a held command gets on Linux, with writes held to the worktree. This side builds
 * what `wsl.exe` is started with; `wsl-held-runner.ts` builds the wall on the Linux side.
 */

/**
 * The programs a held command may run under WSL, matched by the alias's file name alone. SELF-015: besides Node and
 * Git, the ones that download into the worktree: Python and its installers, and curl and wget. They reach the network
 * only in the owner's selected Full Access (`open`), and their writes are held to the worktree like any held command's.
 */
export const wslHeldPrograms = ['node', 'npm', 'npx', 'git', 'python3', 'pip', 'pip3', 'pipx', 'uv', 'curl', 'wget'] as const;
/** SELF-015: the programs a worktree's own `.venv/bin` stands in for (wsl-held-runner.ts `heldProgram`). */
export const venvPrograms: readonly string[] = ['python3', 'pip', 'pip3'];
/** Windows names that are one of the programs above under another name. */
const sameProgram: Record<string, WslHeldProgram> = { python: 'python3' };
export type WslHeldProgram = (typeof wslHeldPrograms)[number];

export const wslNotSetUp = 'This command runs inside WSL (the Linux in Windows) so Branch can hold it to its folder, and WSL is not set up on this computer, so it did not run. Ask the owner; with their yes, WSL is turned on with `wsl --install` in Windows.';
export const wslNoNode = 'This command runs inside WSL (the Linux in Windows) so Branch can hold it to its folder, and WSL here has no Node.js, so it did not run. Ask the owner; with their yes, it is set up with `sudo apt-get install nodejs npm` in Ubuntu.';
export const wslNoBubblewrap = 'This command runs inside WSL (the Linux in Windows) behind bubblewrap, which holds it to its folder, and WSL here has no bubblewrap, so it did not run. Ask the owner; with their yes, it is set up with `sudo apt-get install bubblewrap` in Ubuntu.';
export const wslNoNamespaces = 'This command runs inside WSL (the Linux in Windows) behind bubblewrap, and WSL here has switched off the private namespaces bubblewrap needs, so it did not run. Ask the owner; with their yes, the WSL kernel setting that allows them is turned back on.';

/** What the runner inside WSL is given, as a file it reads once and deletes. */
export interface WslHeldPlan {
  program: WslHeldProgram;
  args: string[];
  /** Linux paths (`/mnt/c/...`). */
  cwd: string;
  workspace: string;
  /** The allowlisted environment only: never the Windows one wholesale, never a WSL name. */
  env: Record<string, string>;
  /** Names of saved keys the call asked for; the program only ever gets a stand-in for each. */
  secrets: string[];
  /** `npm ci`: the npm registry, and nothing else, is reachable. */
  registry: boolean;
  /** selfdev: the owner's selected Full Access: any site is reachable (writes stay held to the worktree). */
  open?: boolean;
  timeoutMs: number;
  /** Tool scripts use stdin replies and framed stdout requests, never Windows descriptor 3. */
  interactive?: boolean;
  /** Untrusted plugin evaluations may read only scratch and interpreter/runtime files. */
  scratchOnly?: boolean;
  unreadable?: string[];
}

/**
 * selfdev: Windows has no native npm program, so its npm alias is node.exe with npm's own `npm-cli.js` (or
 * `npx-cli.js`) as the first argument (src/integrations/shell-config.ts). That pair is npm (or npx) by name.
 */
export function npmScript(argument: string | undefined): 'npm' | 'npx' | null {
  const found = /[\\/]node_modules[\\/]npm[\\/]bin[\\/](npm|npx)-cli\.js$/i.exec(argument ?? '');
  return found ? found[1]!.toLowerCase() as 'npm' | 'npx' : null;
}

/** The Linux program an alias stands for, by its file name; anything else is refused. */
export function wslProgram(windowsPath: string, args: readonly string[] = []): WslHeldProgram {
  const name = programName(windowsPath);
  const found = sameProgram[name] ?? wslHeldPrograms.find((program) => program === name);
  if (found) return found;
  if (/^apt(-get)?$/.test(name)) throw new Error(aptRefusal(args));
  throw new Error(`On Windows a command held to its folder runs inside WSL, where only ${wslHeldPrograms.join(', ')} (python for python3) are available, so ${name} did not run.`);
}

/** A program's name from its path or alias, without a Windows ending. */
export const programName = (path: string): string => path.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '');

/**
 * SELF-015: whether a name a held command gives with no alias of its own on Windows is one WSL runs (or apt, which is
 * refused with the owner's line). Such a command never runs a Windows program, so it needs no Windows alias.
 */
export function wslOnlyName(name: string): boolean {
  const program = programName(name);
  return Object.hasOwn(sameProgram, program) || (wslHeldPrograms as readonly string[]).includes(program) || /^apt(-get)?$/.test(program);
}

/**
 * SELF-015: apt installs for the whole system and needs root, which a command held to its folder never has, so it is
 * never run. The owner is given the exact line to run themselves.
 */
export function aptRefusal(args: readonly string[]): string {
  const at = args.indexOf('install');
  const packages = at < 0 ? [] : args.slice(at + 1).filter((arg) => !arg.startsWith('-') && /^[a-z0-9][a-z0-9+.:=~-]*$/i.test(arg));
  const line = packages.length ? `sudo apt-get install ${packages.join(' ')}` : 'sudo apt-get install <the packages>';
  return 'apt installs for the whole system and needs root, which a command held to its folder never has, so it did not run. '
    + `The owner can install it by running this in Ubuntu (WSL) themselves: ${line}`;
}

/** SELF-015: the sentence for a program WSL does not have, with how the owner could add it. */
export function wslNoProgram(program: string): string {
  const setUp: Record<string, string> = { python3: 'sudo apt-get install python3 python3-venv', pip: 'sudo apt-get install python3-pip',
    pip3: 'sudo apt-get install python3-pip', pipx: 'sudo apt-get install pipx', curl: 'sudo apt-get install curl', wget: 'sudo apt-get install wget',
    git: 'sudo apt-get install git', node: 'sudo apt-get install nodejs npm', npm: 'sudo apt-get install nodejs npm', npx: 'sudo apt-get install nodejs npm' };
  const how = Object.hasOwn(setUp, program) ? `it is set up with \`${setUp[program]}\` in Ubuntu` : `it is installed by ${program}'s own instructions`;
  return `This command runs inside WSL (the Linux in Windows) so Branch can hold it to its folder, and WSL here has no ${program}, so it did not run. Ask the owner; with their yes, ${how}.`;
}

/** Names never carried into WSL: the Windows paths, and anything that reaches back out of WSL. */
const droppedNames = new Set(['PATH', 'HOME', 'TMP', 'TEMP', 'TMPDIR', 'WSL_INTEROP', 'WSLENV', 'WSL_DISTRO_NAME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']);

export function wslHeldPlan(input: {
  executable: { path: string; args: readonly string[] }; args: readonly string[]; cwd: string; workspace: string;
  env: NodeJS.ProcessEnv; secrets: readonly string[]; registry: boolean; open?: boolean; timeoutMs: number;
}): WslHeldPlan {
  const all = [...input.executable.args, ...input.args], named = wslProgram(input.executable.path, all);
  // Windows' npm alias (node.exe npm-cli.js) is Linux's npm: the Windows script path never goes into WSL.
  const script = named === 'node' ? npmScript(all[0]) : null;
  const program: WslHeldProgram = script ?? named, args = script ? all.slice(1) : all;
  const workspace = wslPath(input.workspace), cwd = wslPath(input.cwd);
  if (!workspace.startsWith('/mnt/') || !cwd.startsWith('/mnt/'))
    throw new Error('On Windows a command held to its folder runs inside WSL, which cannot reach this folder, so it did not run.');
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.env))
    if (typeof value === 'string' && !droppedNames.has(name.toUpperCase()) && !input.secrets.includes(name)) env[name] = value;
  return { program, args, cwd, workspace, env, secrets: [...input.secrets],
    registry: input.registry, ...(input.open ? { open: true } : {}), timeoutMs: input.timeoutMs };
}

/**
 * What a held command's wall shows empty on Linux (under WSL and on Linux itself), and what is bound
 * back read-only so the command can still run. Covering `/mnt` and `/run` hides other drives (the
 * Windows ones under WSL), WSL's link back to Windows, the per-user runtime folder and the system
 * daemons' sockets; covering the home folder hides other programs' sockets, the saved sign-ins and
 * the caches. The workspace is bound after, so it still shows even inside a covered folder. What the
 * command needs from inside the home is the interpreter itself (node, npm and npx often live under
 * the home, installed by a version manager), so for each held program found there only its own
 * folder (`<prefix>/bin`) and the `lib` beside it (`<prefix>/lib`) are bound back, never the rest of
 * the prefix (a `~/.local/bin/node` never brings `~/.local/share` with it) and never the home itself.
 * A tool outside the home (system git) needs nothing bound back.
 *
 * Pure path work (POSIX): `home` and `realpaths` are the resolved home folder and the real paths of
 * the held programs that were found.
 */
export function heldView(home: string, realpaths: readonly string[]): { covered: string[]; restored: string[] } {
  const under = (path: string): boolean => path === home || path.startsWith(`${home}/`);
  const restored = new Set<string>();
  for (const real of realpaths) {
    if (!under(real)) continue;
    const bin = posix.dirname(real);
    // A program sitting straight in the home cannot be bound back without the whole home.
    if (bin === home) continue;
    restored.add(bin);
    const lib = posix.join(posix.dirname(bin), 'lib');
    if (under(lib) && lib !== home) restored.add(lib);
  }
  return { covered: ['/mnt', '/run', home], restored: [...restored] };
}

/**
 * The Git folder a worktree reads from, when it is somewhere else (a worktree's `.git` is a file
 * naming it): the repository's common folder, found by walking up from `folder`. Null when there is
 * none, or it names a place that is not there (under WSL, a Windows path).
 */
export async function gitCommonDir(folder: string): Promise<string | null> {
  for (let dir = folder, steps = 0; steps < 64; dir = posix.dirname(dir), steps++) {
    const dotGit = posix.join(dir, '.git');
    const kind = await stat(dotGit).catch(() => null);
    if (kind?.isDirectory()) return null; // the repository is inside the folder: nothing lives elsewhere
    if (kind?.isFile()) {
      const named = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8').catch(() => ''))?.[1]?.trim();
      if (!named) return null;
      const gitdir = posix.resolve(dir, named);
      const common = (await readFile(posix.join(gitdir, 'commondir'), 'utf8').catch(() => '')).trim();
      const found = common ? posix.resolve(gitdir, common) : gitdir;
      return realpath(found).catch(() => null);
    }
    if (dir === posix.dirname(dir)) return null;
  }
  return null;
}

/**
 * The held view for this computer: `programs` (the held command's own program first) and node, npm,
 * npx and git as found on `searchPath`, each by its real path, then heldView; and the workspace's Git
 * folder, bound back read-only when a cover would hide it, so Git keeps working in a worktree. Only
 * places that exist are returned (bwrap cannot cover or bind a missing one). `refusal` says, before
 * anything runs, why a command could not work behind this view and what does instead.
 */
export async function heldCover(input: { home: string; programs: readonly string[]; args?: readonly string[]; searchPath: string; workspace: string }):
  Promise<{ covered: string[]; restored: string[]; refusal: string | null }> {
  const dirs = input.searchPath.split(':').filter((dir) => dir.startsWith('/'));
  const onPath = (name: string): string | undefined => dirs.map((dir) => posix.join(dir, name)).find((path) => existsSync(path));
  const own = input.programs.map((program) => (program.startsWith('/') ? program : onPath(program)));
  const found = [...own, ...wslHeldPrograms.map(onPath)].filter((path): path is string => !!path);
  const reals = await Promise.all(found.map((path) => realpath(path).catch(() => path)));
  const view = heldView(input.home, reals);
  const git = await gitCommonDir(input.workspace);
  const hidden = git && view.covered.some((folder) => git === folder || git.startsWith(`${folder}/`));
  const covered = view.covered.filter((path) => existsSync(path));
  // selfdev: the browsers Playwright installed for this Linux user are programs too; they are shown read-only so a
  // held test run (scripts/review.mjs's window gates) can start one. Nothing else under the home is shown.
  const browsers = posix.join(input.home, '.cache', 'ms-playwright');
  const restored = [...new Set([...view.restored, ...(hidden ? [git] : []), browsers])].filter((path) => existsSync(path));
  const program = own[0] ? await realpath(own[0]).catch(() => own[0]!) : null;
  return { covered, restored, refusal: await heldRefusal({ home: input.home, program, args: input.args ?? [], workspace: input.workspace, covered, restored }) };
}

const inside = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);

/**
 * Why a held command cannot work behind its view, in plain words with what works instead, or null.
 * A program sitting straight in the home cannot be shown without the whole home; a file the command
 * is given by its full path is not there when it sits in a covered folder outside the worktree and
 * the programs' own folders.
 */
export async function heldRefusal(input: { home: string; program: string | null; args: readonly string[]; workspace: string;
  covered: readonly string[]; restored: readonly string[] }): Promise<string | null> {
  if (input.program && posix.dirname(input.program) === input.home)
    return `${input.program} sits straight in your home folder, which a command held to its folder cannot see (only the folders a program is installed in are shown there), so it did not run. Install it under a folder of its own, such as ~/.local/bin (its bin and lib folders are then shown to the command), or use one installed outside your home.`;
  const workspace = await realpath(input.workspace).catch(() => input.workspace);
  for (const arg of input.args) {
    if (!arg.startsWith('/')) continue;
    const real = await realpath(arg).catch(() => null);
    if (!real || !(await stat(real).then((found) => found.isFile(), () => false))) continue;
    // /tmp too: the command gets a fresh, empty one of its own.
    const folder = [...input.covered, '/tmp'].find((each) => inside(real, each));
    if (!folder || inside(real, workspace) || input.restored.some((each) => inside(real, each))) continue;
    return `${arg} is in ${folder}, which a command held to its folder cannot see (only its worktree and the folders of the programs it runs are shown there), so it did not run. Move the file into the worktree and run it from there.`;
  }
  return null;
}

/** `wsl.exe` itself, by full path, so no search path decides which program starts. */
export function wslExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'wsl.exe');
}

/** The runner that ships beside this file, in the running app; never one from the folder the command may change. */
export function wslHeldRunner(): string {
  return fileURLToPath(new URL('./wsl-held-runner.js', import.meta.url));
}

/** What is started on Windows: `wsl.exe --exec node <runner> <plan file>`, with nothing of Windows' environment crossing. */
export function wslHeldStart(options: { runner: string; planFile: string; cwd: string; env?: NodeJS.ProcessEnv }): SandboxStart {
  const env = options.env ?? process.env;
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  return { executable: wslExecutable(env), cwd: options.cwd,
    args: ['--exec', 'node', wslPath(options.runner), wslPath(options.planFile)],
    env: { SystemRoot: systemRoot, WSLENV: '' } };
}

/** Refuses a runner inside the folder the command may change, which would let it rewrite its own wall. */
export async function checkRunner(runner: string, folder: string): Promise<void> {
  const [from, inside] = await Promise.all([realpath(runner), realpath(folder)]);
  const rest = relative(inside, from);
  if (!rest.startsWith('..') && !isAbsolute(rest))
    throw new Error('The program that holds this command sits inside the folder the command may change, so it did not run.');
}

/**
 * Whether WSL can hold a command: Linux's own Node (never Windows' node.exe reached through WSL's
 * search path) and bubblewrap. Null when ready, or the plain sentence saying what is missing.
 */
export async function wslReadiness(probe: SandboxProbe, wsl = wslExecutable()): Promise<string | null> {
  const node = await probe(wsl, ['--exec', 'node', '-p', 'process.platform']);
  if (node.missing) return wslNotSetUp;
  if (node.code !== 0 || node.stdout.trim() !== 'linux') return wslNoNode;
  const bwrap = await probe(wsl, ['--exec', '/bin/sh', '-c', 'for d in /usr/bin /usr/local/bin /bin; do [ -x "$d/bwrap" ] && exit 0; done; exit 1']);
  if (bwrap.code !== 0) return wslNoBubblewrap;
  return null;
}

/** The real probe: WSL can take several seconds to wake, so it is given longer than the other probes. */
export const wslProbe: SandboxProbe = async (executable, args) => {
  try {
    const out = await new ShellProcess({ executable, args, cwd: process.cwd(), env: { SystemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', WSLENV: '' },
      signal: AbortSignal.timeout(30_000), timeoutMs: 25_000, maxOutputBytes: 4096 }).run();
    return { code: out.exitCode, stdout: out.stdout, stderr: out.stderr, missing: out.status === 'failed' && out.exitCode === null };
  } catch {
    return { code: null, stdout: '', stderr: '', missing: true };
  }
};
