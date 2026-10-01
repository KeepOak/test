import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openWall, type WallDeps } from '../sandbox-backends.js';
import { accountHome, bwrapMissing, namespacesOff } from '../sandbox-bwrap.js';
import { confinedWall } from './shell.js';
import { pluginScratchWall } from '../plugin-scratch-wall.js';
import { heldCover, venvPrograms, wslHeldPrograms, wslNoBubblewrap, wslNoNamespaces, wslNoNode, wslNoProgram, type WslHeldPlan } from './wsl-held.js';

/**
 * Runs inside WSL, started by `wsl.exe --exec node <this file> <plan file>` (see wsl-held.ts). It
 * builds the held wall itself, as a held command gets on Linux: no network (the npm registry only
 * for `npm ci`), writes only in the worktree, and `/mnt` and `/run/WSL` shown empty, so neither the
 * Windows drives nor a way to start a Windows program is reachable from inside.
 */

const linuxPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/** How much of the program's error output is kept for the wall to explain a refusal. */
const keptErrorBytes = 64 * 1024;

/** Where a held program is looked for: the system's folders, then the user's own (uv and pipx install there). */
const systemFolders = ['/usr/local/bin', '/usr/bin', '/bin'];
function locate(program: string): string | null {
  for (const dir of [...systemFolders, join(homedir(), '.local', 'bin')]) if (existsSync(join(dir, program))) return join(dir, program);
  return null;
}

const insideOf = (path: string, folder: string): boolean => path === folder || path.startsWith(`${folder}/`);

/**
 * SELF-015: the program a held command runs. python3, pip and pip3 are the worktree's own `.venv/bin/<name>` when one
 * sits directly under the command's folder or the held folder's top: Ubuntu's own Python is externally managed, so a
 * package goes into the worktree through its venv. The link is followed first. It must stay inside the held folder,
 * except that a venv's python3 is itself a link to the system's interpreter (`/usr/bin/python3.12`), and only that
 * is allowed out. A link planted anywhere else is refused, so it can't swap in another program.
 */
export async function heldProgram(plan: Pick<WslHeldPlan, 'program' | 'cwd' | 'workspace'>,
  look: { exists: (path: string) => boolean; real: (path: string) => Promise<string>; find: (program: string) => string | null } =
  { exists: existsSync, real: (path) => realpath(path), find: locate }): Promise<{ path: string } | { refusal: string }> {
  if (venvPrograms.includes(plan.program)) {
    const top = await look.real(plan.workspace).catch(() => plan.workspace);
    for (const dir of [...new Set([plan.cwd, plan.workspace])]) {
      const candidate = posix.join(dir, '.venv', 'bin', plan.program);
      if (!look.exists(candidate)) continue;
      const real = await look.real(candidate).catch(() => '');
      if (real && insideOf(real, top)) return { path: candidate };
      if (real && plan.program === 'python3' && systemFolders.includes(posix.dirname(real)) && /^python3(\.\d+)?$/.test(posix.basename(real)))
        return { path: candidate };
      return { refusal: `${candidate} leads outside the folder this command is held to${real ? ` (to ${real})` : ''}, so it did not run. Make the venv again inside the folder with \`python3 -m venv .venv\`.` };
    }
  }
  const found = look.find(plan.program);
  return found ? { path: found } : { refusal: wslNoProgram(plan.program) };
}

function parsePlan(text: string): WslHeldPlan {
  const plan = JSON.parse(text) as WslHeldPlan;
  if (!wslHeldPrograms.includes(plan.program) || !Array.isArray(plan.args) || !plan.workspace.startsWith('/mnt/') || !plan.cwd.startsWith('/mnt/'))
    throw new Error('The plan for this held command is not one Branch wrote, so it did not run.');
  return plan;
}

/** The sentence the owner is shown when bubblewrap is missing or cannot run here. */
function plainly(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === bwrapMissing) return wslNoBubblewrap;
  if (message === namespacesOff) return wslNoNamespaces;
  return message;
}

/** One held command, from the plan to its exit code. `deps` is for tests and hand-run checks only. */
export async function runHeld(plan: WslHeldPlan, deps: WallDeps = {}): Promise<number> {
  if (process.platform !== 'linux') { process.stderr.write(`${wslNoNode}\n`); return 1; }
  const chosen = await heldProgram(plan);
  if ('refusal' in chosen) { process.stderr.write(`${chosen.refusal}\n`); return 1; }
  const program = chosen.path;
  const systemHome = accountHome();
  const temp = await mkdtemp(join(tmpdir(), 'branch-held-'));
  // Built from the plan alone: this process's own environment carries WSL's way back out to Windows.
  const env: NodeJS.ProcessEnv = { ...plan.env, PATH: linuxPath, HOME: homedir(), TMPDIR: temp, TMP: temp, TEMP: temp,
    npm_config_cache: join(temp, '.npm'), npm_config_update_notifier: 'false',
    // SELF-015: Python's installers keep their caches in the command's own scratch folder, never the (covered) home.
    PIP_CACHE_DIR: join(temp, '.pip'), PIP_DISABLE_PIP_VERSION_CHECK: '1', UV_CACHE_DIR: join(temp, '.uv'),
    PIPX_HOME: join(temp, '.pipx'), PIPX_BIN_DIR: join(temp, '.pipx', 'bin'),
    // selfdev: the browsers shown read-only by heldCover, where Playwright looks for them.
    ...(existsSync(join(homedir(), '.cache', 'ms-playwright')) ? { PLAYWRIGHT_BROWSERS_PATH: join(homedir(), '.cache', 'ms-playwright') } : {}) };
  for (const name of ['WSL_INTEROP', 'WSLENV', 'WSL_DISTRO_NAME']) delete env[name];
  // The held view hides /mnt, /run and the home folder, and binds each held program's install folder
  // back read-only (heldView). The workspace, under /mnt, is bound after so it still shows through;
  // /var/run is a link to /run, so it is covered too. So no Windows drive, no WSL link back to
  // Windows, no per-user or system socket (dbus, snapd, the container daemon) and no other agent's
  // control socket or saved sign-in under the home is reachable from inside.
  const { covered, restored, refusal } = await heldCover({ home: homedir(), systemHome, programs: [program], args: plan.args, searchPath: linuxPath, workspace: plan.workspace });
  if (refusal) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    process.stderr.write(`${refusal}\n`);
    return 1;
  }
  let wall;
  try {
    wall = await openWall({ ...confinedWall(undefined, { registry: plan.registry, open: plan.open === true }), readOnly: restored,
      unreadable: plan.unreadable ?? [] },
      { executable: program, args: plan.args, cwd: plan.cwd, env },
      { workspace: plan.workspace, temp, held: true, covered, secrets: Object.fromEntries(plan.secrets.map((name) => [name, ''])) },
      { ...deps, platform: 'linux' });
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    process.stderr.write(`${plainly(error)}\n`);
    return 1;
  }
  try {
    const start = plan.scratchOnly ? await pluginScratchWall(wall.start, program, plan.workspace, 'linux') : wall.start;
    const result = await forward(start, plan.timeoutMs, plan.interactive === true);
    const note = await wall.finish(result).catch((error: unknown) => plainly(error));
    if (note) process.stderr.write(`${result.stderr && !result.stderr.endsWith('\n') ? '\n' : ''}${note}\n`);
    return result.exitCode ?? 1;
  } finally {
    await wall.close();
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Starts the walled program, passes its output straight through and keeps the tail of its errors.
 * It ends the program at the time limit, and when WSL's link back to Windows goes away.
 */
function forward(start: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }, timeoutMs: number, interactive: boolean) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(start.executable, start.args, { cwd: start.cwd, env: start.env, stdio: [interactive ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout!.on('data', (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr!.on('data', (chunk: Buffer) => { process.stderr.write(chunk); stderr = (stderr + chunk.toString('utf8')).slice(-keptErrorBytes); });
    const parent = process.ppid;
    const stop = () => { child.kill('SIGKILL'); };
    if (interactive && child.stdin) {
      child.stdin.on('error', () => undefined);
      process.stdin.pipe(child.stdin);
      process.stdin.on('end', stop);
    }
    const timer = setTimeout(stop, timeoutMs);
    const watch = setInterval(() => { if (process.ppid !== parent) stop(); }, 500);
    process.stdout.on('error', stop);
    child.on('error', () => undefined);
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearInterval(watch);
      process.stdout.removeListener('error', stop);
      process.stdin.removeListener('end', stop);
      if (child.stdin) process.stdin.unpipe(child.stdin);
      process.stdin.pause();
      done({ exitCode: code ?? (signal ? 128 : 1), stdout: '', stderr });
    });
  });
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) { process.stderr.write('No plan was given to this held command, so it did not run.\n'); process.exitCode = 2; return; }
  let plan: WslHeldPlan;
  try { plan = parsePlan(await readFile(file, 'utf8')); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; return;
  } finally { await rm(file, { force: true }).catch(() => undefined); }
  process.exitCode = await runHeld(plan);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
