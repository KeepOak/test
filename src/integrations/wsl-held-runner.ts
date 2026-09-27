import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openWall, type WallDeps } from '../sandbox-backends.js';
import { bwrapMissing, namespacesOff } from '../sandbox-bwrap.js';
import { confinedWall } from './shell.js';
import { wslHeldPrograms, wslNoBubblewrap, wslNoNamespaces, wslNoNode, type WslHeldPlan } from './wsl-held.js';

/**
 * Runs inside WSL, started by `wsl.exe --exec node <this file> <plan file>` (see wsl-held.ts). It
 * builds the held wall itself, as a held command gets on Linux: no network (the npm registry only
 * for `npm ci`), writes only in the worktree, and `/mnt` and `/run/WSL` shown empty, so neither the
 * Windows drives nor a way to start a Windows program is reachable from inside.
 */

const linuxPath = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
/** How much of the program's error output is kept for the wall to explain a refusal. */
const keptErrorBytes = 64 * 1024;

function locate(program: string): string | null {
  for (const dir of ['/usr/local/bin', '/usr/bin', '/bin']) if (existsSync(join(dir, program))) return join(dir, program);
  return null;
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
  const program = locate(plan.program);
  if (!program) { process.stderr.write(`${wslNoNode}\n`); return 1; }
  const temp = await mkdtemp(join(tmpdir(), 'branch-held-'));
  // Built from the plan alone: this process's own environment carries WSL's way back out to Windows.
  const env: NodeJS.ProcessEnv = { ...plan.env, PATH: linuxPath, HOME: homedir(), TMPDIR: temp, TMP: temp, TEMP: temp,
    npm_config_cache: join(temp, '.npm'), npm_config_update_notifier: 'false' };
  for (const name of ['WSL_INTEROP', 'WSLENV', 'WSL_DISTRO_NAME']) delete env[name];
  const covered = ['/mnt', '/run/WSL'].filter((path) => existsSync(path));
  let wall;
  try {
    wall = await openWall(confinedWall(undefined, { registry: plan.registry }), { executable: program, args: plan.args, cwd: plan.cwd, env },
      { workspace: plan.workspace, temp, held: true, covered, secrets: Object.fromEntries(plan.secrets.map((name) => [name, ''])) },
      { ...deps, platform: 'linux' });
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    process.stderr.write(`${plainly(error)}\n`);
    return 1;
  }
  try {
    const result = await forward(wall.start, plan.timeoutMs);
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
function forward(start: { executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv }, timeoutMs: number) {
  return new Promise<{ exitCode: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(start.executable, start.args, { cwd: start.cwd, env: start.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk: Buffer) => { process.stderr.write(chunk); stderr = (stderr + chunk.toString('utf8')).slice(-keptErrorBytes); });
    const parent = process.ppid;
    const stop = () => { child.kill('SIGKILL'); };
    const timer = setTimeout(stop, timeoutMs);
    const watch = setInterval(() => { if (process.ppid !== parent) stop(); }, 500);
    process.stdout.on('error', stop);
    child.on('error', () => undefined);
    child.on('close', (code, signal) => {
      clearTimeout(timer); clearInterval(watch);
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
