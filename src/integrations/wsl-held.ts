import { realpath } from 'node:fs/promises';
import { isAbsolute, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ShellProcess } from './shell-process.js';
import { wslPath, type SandboxProbe, type SandboxStart } from '../sandbox-backends.js';

/**
 * Self-development on Windows: a command held to the worktree runs inside WSL, behind the same Linux
 * wall (bubblewrap) a held command gets on Linux, with writes held to the worktree. This side builds
 * what `wsl.exe` is started with; `wsl-held-runner.ts` builds the wall on the Linux side.
 */

/** The programs a held command may run under WSL, matched by the alias's file name alone. */
export const wslHeldPrograms = ['node', 'npm', 'npx', 'git'] as const;
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
  timeoutMs: number;
}

/** The Linux program an alias stands for, by its file name; anything else is refused. */
export function wslProgram(windowsPath: string): WslHeldProgram {
  const name = windowsPath.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '');
  const found = wslHeldPrograms.find((program) => program === name);
  if (!found) throw new Error(`On Windows a command held to its folder runs inside WSL, where only node, npm, npx and git are available, so ${name} did not run.`);
  return found;
}

/** Names never carried into WSL: the Windows paths, and anything that reaches back out of WSL. */
const droppedNames = new Set(['PATH', 'HOME', 'TMP', 'TEMP', 'TMPDIR', 'WSL_INTEROP', 'WSLENV', 'WSL_DISTRO_NAME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']);

export function wslHeldPlan(input: {
  executable: { path: string; args: readonly string[] }; args: readonly string[]; cwd: string; workspace: string;
  env: NodeJS.ProcessEnv; secrets: readonly string[]; registry: boolean; timeoutMs: number;
}): WslHeldPlan {
  const program = wslProgram(input.executable.path);
  const workspace = wslPath(input.workspace), cwd = wslPath(input.cwd);
  if (!workspace.startsWith('/mnt/') || !cwd.startsWith('/mnt/'))
    throw new Error('On Windows a command held to its folder runs inside WSL, which cannot reach this folder, so it did not run.');
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.env))
    if (typeof value === 'string' && !droppedNames.has(name.toUpperCase()) && !input.secrets.includes(name)) env[name] = value;
  return { program, args: [...input.executable.args, ...input.args], cwd, workspace, env, secrets: [...input.secrets],
    registry: input.registry, timeoutMs: input.timeoutMs };
}

/**
 * What the held wall shows empty inside WSL, and what is bound back read-only so the command can
 * still run. Covering `/mnt` and `/run` hides the Windows drives and WSL's link back to Windows,
 * the per-user runtime folder and the system daemons' sockets; covering the home folder hides
 * another agent's control socket, the saved Git and package sign-ins and the caches. The one thing
 * inside the home that the command needs is the interpreter itself (node, npm and npx often live
 * under the home, installed by a version manager), so the install folder of each held program found
 * there is bound back read-only. A tool outside the home (system git) needs nothing bound back.
 *
 * Pure path work on the Linux side (POSIX): `home` and `realpaths` are the resolved home folder and
 * the real paths of the held programs that were found.
 */
export function heldView(home: string, realpaths: readonly string[]): { covered: string[]; restored: string[] } {
  const under = (path: string): boolean => path === home || path.startsWith(`${home}/`);
  const restored = new Set<string>();
  for (const real of realpaths) {
    if (!under(real)) continue;
    // The install prefix two folders up from `<prefix>/bin/node` holds bin and lib together; never
    // the home itself, which would defeat the cover, so fall back to the program's own folder.
    let prefix = posix.dirname(posix.dirname(real));
    if (!under(prefix) || prefix === home) prefix = posix.dirname(real);
    if (under(prefix) && prefix !== home) restored.add(prefix);
  }
  return { covered: ['/mnt', '/run', home], restored: [...restored] };
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
