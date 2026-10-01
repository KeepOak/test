import { mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { WorkspaceFiles } from '../files.js';
import type { ToolContext } from '../contracts.js';
import type { ToolRegistry } from '../registry.js';
import { commandFolder, ShellConfigSchema, ShellInputSchema, shellEnvironment, netlessEnvironment, validateExecutables, type ShellConfig, type ShellInput } from './shell-config.js';
import { ShellProcess, type ProcessResult } from './shell-process.js';
import { CommandTurns, maxParallelCommands, projectRoot, queueGraceMs } from './command-turns.js'; // SELF-302
import { defaultJobObjects, type Job, type JobObjects } from './job-object.js';
import { scrubSecrets } from '../locker.js';
import { sandboxShape, shapeChoice, type WallContext } from '../sandbox.js';
import { openWall } from '../sandbox-backends.js'; // wave mac3 (os-sandbox)
import { accountHome } from '../sandbox-bwrap.js';
import { withPassedEnvironment } from '../knobs/environment.js'; // R17-S10
import { checkRunner, heldCover, npmScript, wslHeldPlan, wslHeldRunner, wslHeldStart, wslOnlyName, wslProbe, wslReadiness } from './wsl-held.js';

/** Longest a command waits for its Windows job object before running with sampled limits. */
const jobStartupMs = 1000;

export type SecretResolver = (context: ToolContext, names: string[]) => Promise<Record<string, string>>;
export interface ShellTarget {
  alias: string; executable: string; cwd: string; secrets: string[];
  /** Whether this command was pointed at a dead address instead of the internet. */
  netless: boolean;
  isolation: 'job-object' | 'sampling';
}

/** SELF-304: a held command ready to be left running, and what to do once it ends (BranchShell.launchHeld). */
export interface HeldLaunch {
  start: { executable: string; args: string[]; env: NodeJS.ProcessEnv };
  cwd: string;
  /** Closes the wall, sweeps any `.git` it planted (named in the answer) and removes its scratch folder. */
  cleanup: () => Promise<string[]>;
}

interface Operation { controller: AbortController; owner: string; runId: string; done: Promise<unknown>; cleared: Promise<unknown> }
export class BranchShell {
  private readonly config: ShellConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly pending = new Set<Operation>();
  /**
   * SELF-302: whose turn it is to run a command. There used to be one command at a time for the whole engine, so a
   * second one from any helper or conversation was refused at once, and helpers started together could not build or
   * test in their own copies. Now each folder takes one command at a time (so two never write the same folder or sweep
   * each other's `.git`), the rest wait their turn, and the engine as a whole runs a bounded number at once, since each
   * holds its own memory and processor limits.
   */
  private readonly turns = new CommandTurns(maxParallelCommands);
  private closed = false;
  private spare: Job | null = null;
  /**
   * R17-S10: the owner's command timeout and extra environment names, read fresh for each command
   * (src/knobs/commands.ts). The launch connects it; left alone, the file's settings are all there is.
   */
  tuning: () => { timeoutMs: number | null; env: Record<string, string> } = () => ({ timeoutMs: null, env: {} });
  /**
   * The programs the owner allowed from Customize › Tools (src/own-clis.ts), read fresh for each command. The launch
   * file's own list comes first; an alias it names is never replaced from here.
   */
  extra: () => Record<string, { path: string; args: string[] }> = () => ({});
  constructor(input: unknown, env = process.env, private readonly secrets?: SecretResolver,
    private readonly jobs: JobObjects = defaultJobObjects()) {
    this.config = ShellConfigSchema.parse(input);
    this.env = shellEnvironment(this.config, env);
  }
  async ready(): Promise<void> { await validateExecutables(this.config); }
  execute(input: ShellInput, context: ToolContext): Promise<ProcessResult & { target: ShellTarget }> {
    if (this.closed) return Promise.reject(new Error('Host command execution is closed'));
    if (!context.owner || !context.runId) return Promise.reject(new Error('Host commands require an owner and run ID'));
    const parsed = ShellInputSchema.parse(input);
    const operation: Operation = { controller: new AbortController(), owner: context.owner, runId: context.runId, done: Promise.resolve(), cleared: Promise.resolve() };
    // A command waiting for its turn is pending too, so a run finishing or the shell closing stops it as well.
    this.pending.add(operation);
    const done = this.perform(parsed, context, operation.controller.signal);
    operation.done = done;
    operation.cleared = done.finally(() => this.pending.delete(operation)).catch(() => undefined);
    return done;
  }
  /**
   * The program an alias names: the launch file's first, then the owner's own. SELF-015: on Windows a command held to
   * one folder runs inside WSL and never starts a Windows program, so a program WSL runs (curl, wget, pip, uv, python3)
   * needs no Windows alias of its own; it is named as it is, and wsl-held.ts decides whether it runs (apt never does).
   */
  private executableFor(name: string, context: Pick<ToolContext, 'writesConfinedTo'>): { path: string; args: string[] } | undefined {
    const own = this.extra();
    if (Object.hasOwn(this.config.executables, name)) return this.config.executables[name];
    if (Object.hasOwn(own, name)) return own[name];
    return context.writesConfinedTo && process.platform === 'win32' && wslOnlyName(name) ? { path: name, args: [] } : undefined;
  }
  /** Resolves once no host command is running, so a caller can take its turn instead of guessing. */
  async whenIdle(signal?: AbortSignal): Promise<void> {
    const stopped = signal ? new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) : null;
    while (this.pending.size && !signal?.aborted) {
      const settled = Promise.allSettled([...this.pending].map(operation => operation.cleared));
      await (stopped ? Promise.race([settled, stopped]) : settled);
    }
    signal?.throwIfAborted();
  }
  private async perform(input: ShellInput, context: ToolContext, stopping: AbortSignal) {
    const executable = this.executableFor(input.executable, context);
    if (!executable) throw new Error('Executable alias is not configured');
    const signal = AbortSignal.any([context.signal, stopping]);
    signal.throwIfAborted();
    // Q12: the same folder the self-development contract judged (commandFolder), checked as a workspace path.
    const cwd = await new WorkspaceFiles(context.workspace).checked(input.cwd, true);
    if (cwd !== commandFolder(context.workspace, input.cwd)) throw new Error('Command cwd must be a workspace directory');
    if (!(await stat(cwd)).isDirectory()) throw new Error('Command cwd must be a workspace directory');
    const confined = context.writesConfinedTo ? await confinedFolder(context.writesConfinedTo, cwd) : null;
    const tuned = this.tuning(); // R17-S10
    const limitMs = tuned.timeoutMs ?? this.config.timeoutMs;
    if (input.timeoutMs && input.timeoutMs > limitMs) throw new Error('Command timeout exceeds configured maximum');
    signal.throwIfAborted();
    // SELF-302: one command at a time per folder, the rest wait their turn (src/integrations/command-turns.ts).
    const release = await this.turns.take(confined ?? await projectRoot(cwd, context.workspace), signal, limitMs + queueGraceMs);
    try { return await this.performInTurn(input, context, signal, { executable, cwd, confined, tuned, limitMs }); }
    finally { release(); }
  }
  private async performInTurn(input: ShellInput, context: ToolContext, signal: AbortSignal, at: { executable: { path: string; args: string[] };
    cwd: string; confined: string | null; tuned: ReturnType<BranchShell['tuning']>; limitMs: number }) {
    const { executable, cwd, confined, tuned, limitMs } = at;
    signal.throwIfAborted();
    const injected = await this.injected(input.secrets, context);
    // An approval rule may say how tightly this command is held; without one the shell settings and
    // the call's own `netless` decide, exactly as they did before rules could say anything about it.
    const shape = sandboxShape(context.sandbox,
      { job: this.config.useJobObject, netless: input.netless ?? this.config.netless });
    const netless = shape.netless;
    const job = shape.job ? await this.job() : null;
    // selfdev: `npm ci` in Branch's own source reaches the npm registry, and with no package's scripts run, so only npm
    // itself ever has that network: nothing the copy wrote (a script in package.json) runs while it is open.
    const held = confined ? heldCommand(executable, input.args) : { args: input.args, registry: false };
    const result = await this.spawn({ executable, args: held.args, cwd, injected, netless, job,
      timeoutMs: input.timeoutMs ?? limitMs, signal, passed: tuned.env,
      // wave mac3 (os-sandbox): a command pointed at the dead address gets no network behind the wall either.
      wall: confined ? confinedWall(context.osSandbox, { registry: held.registry, open: context.ownerFullAccess === true })
        : context.osSandbox && netless ? { ...context.osSandbox, network: 'none' as const } : context.osSandbox,
      // Q12: a command held to one folder gets that folder as the only place in the workspace it may write.
      workspace: confined ?? context.workspace, confined: !!confined });
    const scrubbed = { ...result, stdout: scrubSecrets(result.stdout, injected), stderr: scrubSecrets(result.stderr, injected) };
    return { ...scrubbed, target: { alias: input.executable, executable: executable.path, cwd,
      secrets: Object.keys(injected), netless, isolation: result.isolation, sandbox: shapeChoice(shape) } };
  }
  /** A Windows job to hold this command, where the computer offers one; null means sampled limits. */
  private async job(): Promise<Job | null> {
    if (!this.config.useJobObject) return null;
    // A supervisor that came ready after an earlier command had already started serves the next one.
    if (this.spare) { const ready = this.spare; this.spare = null; return ready; }
    const pending = this.jobs.create({ maxMemoryMb: this.config.maxMemoryMb, maxCpuSeconds: this.config.maxCpuSeconds }).catch(() => null);
    // The supervisor compiles a little C# on start; on a cold computer that can take many seconds.
    // A command never waits longer than this for it: the limits fall back to sampling instead.
    const job = await Promise.race([pending, new Promise<null>((resolve) => setTimeout(() => resolve(null), jobStartupMs).unref())]);
    if (job === null) void pending.then((late) => { if (!late) return; if (this.closed || this.spare) void late.close().catch(() => undefined); else this.spare = late; });
    return job;
  }
  private async spawn(run: { executable: { path: string; args: string[] }; args: string[]; cwd: string;
    injected: Record<string, string>; netless: boolean; job: Job | null; timeoutMs: number; signal: AbortSignal;
    wall?: WallContext | undefined; workspace: string; passed?: Record<string, string>; confined?: boolean }): Promise<ProcessResult> {
    // Q12: a command held to one folder gets a private, empty temporary folder: the shared ones are
    // writable by design, and Branch's source could sit inside one of them.
    const scratch = run.confined ? await mkdtemp(join(tmpdir(), 'branch-held-')) : null;
    const before = run.confined ? await gitFoldersUnder(run.workspace) : null;
    let swept: string[] = [];
    try {
      const result = await this.spawnIn(run, scratch);
      swept = before ? await sweepNewGitFolders(run.workspace, before) : [];
      return swept.length ? { ...result, stderr: `${result.stderr}${result.stderr && !result.stderr.endsWith('\n') ? '\n' : ''}Branch removed the .git this command made (${swept.join(', ')}): Git is never run from a repository a held command planted.` } : result;
    } catch (error) {
      // A command refused before it started (WSL not ready, a program WSL does not run, apt) never reached its job, and
      // the job's supervisor would outlive it; closing twice is harmless.
      await run.job?.close().catch(() => undefined);
      throw error;
    } finally {
      // However the command ended, what it planted does not outlive it.
      if (before && !swept.length) await sweepNewGitFolders(run.workspace, before).catch(() => undefined);
      if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  private async spawnIn(run: Parameters<BranchShell['spawn']>[0], scratch: string | null): Promise<ProcessResult> {
    const { start, wall } = await this.startFor(run, scratch);
    try {
      const result = await new ShellProcess({ executable: start.executable, args: start.args,
        cwd: run.cwd, env: start.env, signal: run.signal, timeoutMs: run.timeoutMs, maxOutputBytes: this.config.maxOutputBytes,
        maxMemoryMb: this.config.maxMemoryMb, maxCpuSeconds: this.config.maxCpuSeconds, job: run.job ?? undefined }).run();
      const note = wall ? await wall.finish(result) : null;
      return note ? { ...result, stderr: `${result.stderr}${result.stderr && !result.stderr.endsWith('\n') ? '\n' : ''}${note}` } : result;
    } catch (error) {
      await run.job?.close().catch(() => undefined);
      throw error;
    } finally {
      await wall?.close();
    }
  }
  /** How a command starts: as it is, behind the wall, or (held, on Windows) inside WSL; and the wall to close after. */
  private async startFor(run: Parameters<BranchShell['spawn']>[0], scratch: string | null) {
    // The environment is built from an allowlist only, then the owner's extra names (R17-S10, never a
    // secret, never replacing a name already set), then the dead-address proxy, then secrets.
    const env = { ...withPassedEnvironment(this.env, run.passed ?? {}), ...(run.netless ? netlessEnvironment() : {}), ...run.injected,
      ...(scratch ? { TMPDIR: scratch, TMP: scratch, TEMP: scratch } : {}) };
    // wave mac3 (os-sandbox): behind the wall when the owner's switch says so. A saved key the owner
    // tied to a site reaches the program only as a stand-in; the wall's door swaps the real one in.
    const plain = { executable: run.executable.path, args: [...run.executable.args, ...run.args], cwd: run.cwd, env };
    // On Windows a command held to one folder runs inside WSL, behind the Linux wall (wsl-held.ts).
    const held = scratch && process.platform === 'win32' ? await this.wslStart(run, env, scratch) : null;
    // On Linux itself a held command gets the same view as under WSL: /mnt, /run and the home shown
    // empty, with only its own programs' folders and the worktree's Git folder bound back read-only.
    const cover = scratch && run.wall && !held && process.platform === 'linux'
      ? await heldCover({ home: homedir(), systemHome: accountHome(), programs: [run.executable.path], args: [...run.executable.args, ...run.args],
        searchPath: (env as NodeJS.ProcessEnv).PATH ?? '', workspace: run.workspace }) : null;
    if (cover?.refusal) throw new Error(cover.refusal);
    const walled = run.wall && cover ? { ...run.wall, readOnly: [...(run.wall.readOnly ?? []), ...cover.restored] } : run.wall;
    const wall = walled && !held ? await openWall(walled, plain, { workspace: run.workspace, secrets: run.injected,
      ...(scratch ? { temp: scratch, held: true } : {}), ...(cover ? { covered: cover.covered } : {}) }) : null;
    return { start: held ?? wall?.start ?? plain, wall };
  }
  /**
   * SELF-304: a command held to one folder and left running (process.start while Branch's own source is checked out).
   * It is resolved, checked and walled exactly as a held `shell.execute` is: its own scratch folder, the wall (inside
   * WSL on Windows), no network but the owner's Full Access or `npm ci`'s registry, no secrets. It comes back unstarted,
   * with the clean-up to run once it ends: the wall closed, any `.git` it planted swept away, its scratch folder removed.
   */
  async launchHeld(input: { executable: string; args: string[]; cwd: string }, context: ToolContext, timeoutMs: number): Promise<HeldLaunch> {
    if (this.closed) throw new Error('Host command execution is closed');
    if (!context.writesConfinedTo) throw new Error('Only a command held to one folder is started this way');
    const own = this.extra();
    const executable = Object.hasOwn(this.config.executables, input.executable) ? this.config.executables[input.executable]
      : Object.hasOwn(own, input.executable) ? own[input.executable] : undefined;
    if (!executable) throw new Error('Executable alias is not configured');
    const cwd = await new WorkspaceFiles(context.workspace).checked(input.cwd, true);
    if (cwd !== commandFolder(context.workspace, input.cwd) || !(await stat(cwd)).isDirectory()) throw new Error('Command cwd must be a workspace directory');
    const confined = await confinedFolder(context.writesConfinedTo, cwd);
    const held = heldCommand(executable, input.args);
    const before = await gitFoldersUnder(confined);
    const scratch = await mkdtemp(join(tmpdir(), 'branch-held-'));
    const run = { executable, args: held.args, cwd, injected: {}, netless: false, job: null, timeoutMs, signal: context.signal,
      passed: this.tuning().env, wall: confinedWall(context.osSandbox, { registry: held.registry, open: context.ownerFullAccess === true }),
      workspace: confined, confined: true };
    try {
      const { start, wall } = await this.startFor(run, scratch);
      const cleanup = async (): Promise<string[]> => {
        await wall?.close().catch(() => undefined);
        const swept = await sweepNewGitFolders(confined, before).catch(() => []);
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
        return swept;
      };
      return { start, cwd, cleanup };
    } catch (error) {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
  /** How WSL is asked whether it can hold a command; replaced in tests. */
  wslProbe = wslProbe;
  /**
   * The `wsl.exe` start for a held command. The plan goes in a file in the command's private scratch
   * folder, never on the command line; saved keys cross only by name, and the program gets a stand-in.
   */
  private async wslStart(run: Parameters<BranchShell['spawn']>[0], env: NodeJS.ProcessEnv, scratch: string) {
    const plan = wslHeldPlan({ executable: run.executable, args: run.args, cwd: run.cwd, workspace: run.workspace, env,
      secrets: Object.keys(run.injected), registry: installsPackages(run.executable, run.args), open: run.wall?.network === 'open', timeoutMs: run.timeoutMs });
    const runner = wslHeldRunner();
    await checkRunner(runner, run.workspace);
    const missing = await wslReadiness(this.wslProbe);
    if (missing) throw new Error(missing);
    const planFile = join(scratch, 'held-plan.json');
    await writeFile(planFile, JSON.stringify(plan), { mode: 0o600 });
    return wslHeldStart({ runner, planFile, cwd: run.cwd });
  }
  /** Secret values exist only in the child's environment; the model sees names and scrubbed output. */
  private async injected(names: string[], context: ToolContext): Promise<Record<string, string>> {
    if (!names.length) return {};
    if (!this.secrets) throw new Error('Secrets are not available to host commands in this launch');
    return this.secrets(context, names);
  }
  async closeRun(context: Pick<ToolContext, 'owner' | 'runId'>): Promise<void> {
    const operations = [...this.pending].filter(operation => operation.owner === context.owner && operation.runId === context.runId);
    for (const operation of operations) operation.controller.abort(new Error('Run finished'));
    await Promise.allSettled(operations.map(operation => operation.done));
  }
  async close(): Promise<void> {
    this.closed = true;
    const spare = this.spare; this.spare = null;
    if (spare) await spare.close().catch(() => undefined);
    const operations = [...this.pending];
    for (const operation of operations) operation.controller.abort(new Error('Host command execution closed'));
    await Promise.allSettled(operations.map(operation => operation.done));
  }
}

/**
 * Q12: the folder a command held by the self-development contract may write to, once its own folder
 * is confirmed to be inside it. On Windows the command then runs inside WSL (wsl-held.ts).
 */
async function confinedFolder(folder: string, cwd: string): Promise<string> {
  const [inside, from] = await Promise.all([realpath(folder), realpath(cwd)]);
  const rest = relative(inside, from);
  if (rest.startsWith('..') || isAbsolute(rest)) throw new Error('The command would run outside the only folder it may change, so it did not run.');
  return inside;
}

/** Q12: the most entries looked through for `.git` folders under a held command's folder. */
const gitSweepLimit = 100_000;

/**
 * Q12: every `.git` (folder or file) under a folder, links not followed. On macOS the sandbox itself
 * refuses to make one; Linux's has no way to say "no .git at any depth", so Branch looks before and
 * after a held command runs. Past the limit it refuses to run the command at all.
 */
export async function gitFoldersUnder(folder: string, limit = gitSweepLimit): Promise<Set<string>> {
  const found = new Set<string>(), queue = [folder];
  let seen = 0;
  while (queue.length) {
    const here = queue.shift()!;
    for (const entry of await readdir(here, { withFileTypes: true }).catch(() => [])) {
      if (++seen > limit) throw new Error('The folder this command is held to holds too many files for Branch to check, so it did not run.');
      const path = join(here, entry.name);
      // Any case: where the disk ignores it, `.GIT` is a repository as surely as `.git`.
      if (entry.name.toLowerCase() === '.git') found.add(path);
      else if (entry.isDirectory() && !entry.isSymbolicLink()) queue.push(path);
    }
  }
  return found;
}

/** Q12: removes each `.git` under the folder that was not there before, and names them. */
export async function sweepNewGitFolders(folder: string, before: ReadonlySet<string>): Promise<string[]> {
  const made = [...(await gitFoldersUnder(folder, Number.MAX_SAFE_INTEGER))].filter((path) => !before.has(path));
  for (const path of made) await rm(path, { recursive: true, force: true });
  return made.map((path) => relative(folder, path));
}

/** The one site a command held to Branch's own source may reach, and only while it installs packages: the npm registry, which serves the packages too. */
export const npmRegistryHost = 'registry.npmjs.org';

/** Whether a held command is `npm ci`: the alias is npm itself, its first word is `ci`, and nothing turns scripts on. */
export function installsPackages(executable: { path: string; args: readonly string[] }, args: readonly string[]): boolean {
  const program = executable.path.split(/[\\/]/).pop()!.toLowerCase().replace(/\.(cmd|exe|bat|ps1)$/, '');
  // Windows' npm alias is node.exe with npm's own script first (src/integrations/wsl-held.ts npmScript).
  const all = [...executable.args, ...args], script = program === 'node' ? npmScript(all[0]) : null;
  const name = script ?? program;
  const [first, ...rest] = script ? all.slice(1) : all;
  // Nothing after `--` (npm would take a flag there as a name), and no word about scripts but `--ignore-scripts` itself,
  // so no package's scripts can be turned back on while the registry is open.
  return name === 'npm' && first === 'ci' && rest.every((arg) => arg !== '--' && (!/scripts/i.test(arg) || arg === '--ignore-scripts'));
}

/** selfdev: a held command as it runs: `npm ci` gets the registry and `--ignore-scripts`; anything else as it is. */
export function heldCommand(executable: { path: string; args: readonly string[] }, args: string[]): { args: string[]; registry: boolean } {
  return installsPackages(executable, args) ? { args: [...args, '--ignore-scripts'], registry: true } : { args, registry: false };
}

/**
 * Q12: the OS sandbox for a command held to one folder. It never gets a standing or one-time yes
 * to write anywhere else, so a blocked write is reported, never offered as a question.
 */
export function confinedWall(wall: WallContext | undefined, how: { registry?: boolean; open?: boolean } = {}): WallContext {
  const base: WallContext = wall ?? { network: 'none', keySites: {}, unreadable: [], readOnly: [],
    answer: () => undefined, granted: () => [], spend: () => undefined };
  // selfdev: a held command gets no network, whatever the owner's wall allows elsewhere, so nothing it runs (gh, git, a
  // script) can reach GitHub with this computer's sign-in. The one exception is `npm ci`, which reaches the npm registry
  // and nothing else, through the wall's door; no saved key is ever swapped in for it, so it cannot sign in there.
  // selfdev: in the owner's selected Full Access (`open`) it may reach any site (downloads, installs); still no saved key,
  // and its writes are still held to the worktree.
  const registry = how.registry === true, open = how.open === true;
  return { ...base, network: open ? 'open' as const : registry ? 'per-site' as const : 'none' as const, keySites: {},
    granted: (kind) => (kind === 'sandbox.write' || kind === 'network.site' ? [] : base.granted(kind)),
    answer: (kind, target) => (kind === 'sandbox.write' ? 'deny'
      : kind === 'network.site' ? (open || (registry && target.toLowerCase() === npmRegistryHost) ? 'allow' : 'deny') : base.answer(kind, target)) };
}

export function registerShell(registry: ToolRegistry, shell: BranchShell): void {
  registry.onRunFinished(context => shell.closeRun(context));
  registry.register({ name: 'shell.execute', permission: 'shell.execute', parameters: ShellInputSchema,
    description: 'Run a command-line program in a workspace folder: one of the configured aliases (such as git, node or npm) with its arguments as a list, for builds, tests (node --test with the test file), installs and git commands. Run a configured trusted host executable alias with argument arrays in a workspace directory. Name secrets from the active project in `secrets` to expose them to the program as environment variables; their values never appear in results. Set `netless` to point the command at a dead local address so tools that respect proxy settings cannot reach the internet (best effort, not a firewall). On Windows the command is placed in a job object so the system enforces the memory and processor limits and kills the whole tree afterwards; where that is unavailable the limits are sampled instead. This is still host execution, not OS isolation: programs can read the host filesystem and launch other programs.',
    execute: (input, context) => shell.execute(input, context) });
}
