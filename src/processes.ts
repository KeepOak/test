import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { Store } from "./store.js";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import { WorkspaceFiles } from "./files.js";
import { killProcessGroup, killWindowsTree } from "./integrations/shell-process.js";
import { defaultJobObjects, jobWithin, startedThrough, type Job, type JobObjects } from "./integrations/job-object.js";
import { PosixProcessGroup, type HeldBySystem } from "./integrations/posix-limits.js";
import { fromTheTop, netlessEnvironment } from "./integrations/shell-config.js";
import type { HeldLaunch } from "./integrations/shell.js";
import { sandboxShape, shapeChoice, type SandboxChoice } from "./sandbox.js";
import {
  chooseSandboxBackend, defaultSandboxProbe, sandboxBackendSet, sliceFor,
  SandboxBackendSettingsSchema, type SandboxBackendName, type SandboxProbe, type SandboxStart,
} from "./sandbox-backends.js";

/**
 * Some programs are meant to keep going: a website being built as you edit it, a watcher, a little
 * server. They outlive the tool call that started them. Each one is held under the same Windows job
 * the one-off commands use, so the operating system enforces its memory and processor limits and
 * kills whatever it left behind; what it prints is kept in a small rolling buffer, the newest at the
 * end. Nothing survives the conversation it belongs to, and nothing survives the app closing.
 */
const alias = z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/);
export const BackgroundSettingsSchema = z.object({
  /** Programs the owner is willing to leave running, each under a short name they choose. */
  programs: z.record(alias, z.object({
    path: z.string().min(1).max(1000),
    args: z.array(z.string().max(500)).max(20).default([]),
  }).strict()).default({}),
  /** How many may be running at once across the whole app. */
  maxRunning: z.number().int().min(1).max(8).default(3),
  /** How long one may stay up before it is stopped anyway. */
  maxMinutes: z.number().int().min(1).max(720).default(120),
  maxMemoryMb: z.number().int().min(16).max(16384).default(2048),
  maxCpuSeconds: z.number().int().min(1).max(36000).default(1800),
  /** How much of what it printed is kept; the oldest is dropped first. */
  bufferBytes: z.number().int().min(1024).max(131072).default(16384),
}).strict();
export type BackgroundSettings = z.infer<typeof BackgroundSettingsSchema>;

export function backgroundSettings(store: Store, owner: string): BackgroundSettings {
  const parsed = BackgroundSettingsSchema.safeParse(store.get("settings", owner, "background-processes")?.data ?? {});
  return parsed.success ? parsed.data : BackgroundSettingsSchema.parse({});
}
/** Saves the list, refusing a program that is not there or is a wrapper script. */
export async function saveBackgroundSettings(store: Store, owner: string, input: unknown): Promise<BackgroundSettings> {
  const value = BackgroundSettingsSchema.parse(input ?? {});
  for (const [name, program] of Object.entries(value.programs)) {
    if (!isAbsolute(program.path)) throw new Error(`Give "${name}" in full, ${fromTheTop()}.`);
    if (/\.(cmd|bat)$/i.test(program.path)) throw new Error(`Name the real program for "${name}", not a .cmd or .bat wrapper.`);
    if (!(await stat(program.path).catch(() => null))?.isFile()) throw new Error(`There is no program at the address given for "${name}".`);
  }
  store.save("settings", owner, "background-processes", { ...value });
  return value;
}

export interface ProcessView {
  id: string; name: string; program: string; pid: number | null; sessionId: string; runId: string;
  status: "running" | "finished" | "stopped" | "failed"; startedAt: string; endedAt: string | null;
  exitCode: number | null; isolation: "job-object" | "sampling"; bytes: number; dropped: boolean;
  /** macOS and Linux: what the system itself holds for this program, when it holds anything. */
  heldBySystem?: HeldBySystem;
}

/** What a macOS or Linux process group is holding, as an optional field of a list entry. */
const heldBy = (job: Job | null): { heldBySystem?: HeldBySystem } => {
  const held = job instanceof PosixProcessGroup ? job.held() : null;
  return held ? { heldBySystem: held } : {};
};

/** How long a program's output may keep coming after it exits before it is settled anyway (Codex's TRAILING_OUTPUT_GRACE). */
const trailingOutputMs = 100;

/** One program left running, with what it has printed so far. */
export class Running {
  readonly id = randomUUID();
  readonly startedAt = new Date().toISOString();
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  dropped = false;
  status: ProcessView["status"] = "running";
  endedAt: string | null = null;
  exitCode: number | null = null;
  private timer: NodeJS.Timeout;
  /** Set the moment the owner asks for it to stop, so the kill's own exit code is not read as a failure. */
  private asked = false;
  /** selfdev: the unfinished last line printed so far, for `wakeOnText`. */
  private partial = "";
  /** selfdev: wake-ups left for a matching line. */
  private wakesLeft: number;
  constructor(
    readonly name: string, readonly program: string, readonly sessionId: string, readonly runId: string,
    private readonly child: ChildProcess, private readonly job: Job | null,
    private readonly bufferBytes: number, maxMinutes: number,
    private readonly onSettled: (view: ProcessView) => void = () => {},
    readonly wake: ProcessWake = { onExit: false, onText: [], wakes: 0 },
    private readonly onLine: (view: ProcessView, line: string) => void = () => {},
  ) {
    this.wakesLeft = wake.onText.length ? wake.wakes : 0;
    child.stdout?.on("data", (chunk: Buffer) => this.keep(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.keep(chunk));
    child.once("error", () => { this.settle("failed"); });
    // P0 (self-build): settled once its output is in, not the moment it exits, so the wake-up carries its last lines.
    // A program that leaves something holding its output open is settled a moment later all the same. As Codex's
    // unified exec does (openai/codex, codex-rs/core/src/unified_exec/async_watcher.rs, TRAILING_OUTPUT_GRACE, Apache-2.0).
    child.once("exit", (code) => {
      this.exitCode = code;
      const done = (): void => { clearTimeout(grace); this.settle(code === 0 ? "finished" : "failed"); };
      const grace = setTimeout(done, trailingOutputMs);
      grace.unref();
      child.once("close", done);
    });
    this.timer = setTimeout(() => { void this.stop(); }, maxMinutes * 60000);
    this.timer.unref();
  }
  private keep(chunk: Buffer): void {
    if (this.wakesLeft > 0) this.watch(chunk);
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.bufferBytes && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()!.length;
      this.dropped = true;
    }
  }
  /** selfdev: a whole line that contains one of the words asked for wakes the conversation, up to `wakes` times. */
  private watch(chunk: Buffer): void {
    const lines = (this.partial + chunk.toString("utf8")).split(/\r?\n/);
    this.partial = (lines.pop() ?? "").slice(-4000);
    for (const line of lines) this.match(line);
  }
  private match(line: string): void {
    if (this.wakesLeft <= 0) return;
    const lower = line.toLowerCase();
    if (!this.wake.onText.some((word) => lower.includes(word.toLowerCase()))) return;
    this.wakesLeft--;
    try { this.onLine(this.view(), line.slice(0, 1000)); } catch { /* a wake-up must never break the program */ }
  }
  private settle(status: ProcessView["status"]): void {
    if (this.status !== "running") return;
    // P0 (self-build): a last line printed without a newline still wakes the conversation.
    if (this.partial) { const last = this.partial; this.partial = ""; this.match(last); }
    // A program the owner stopped counts as stopped, whatever exit code the kill itself produced.
    this.status = this.asked ? "stopped" : status;
    this.endedAt = new Date().toISOString();
    clearTimeout(this.timer);
    void this.job?.close().catch(() => undefined);
    try { this.onSettled(this.view()); } catch { /* telling someone must never break a finished program */ }
  }
  /** What it has printed, newest at the end, and whether anything older was dropped. */
  output(limit: number): { text: string; dropped: boolean } {
    const text = Buffer.concat(this.chunks).toString("utf8");
    return { text: text.length > limit ? text.slice(text.length - limit) : text, dropped: this.dropped || text.length > limit };
  }
  view(): ProcessView {
    return { id: this.id, name: this.name, program: this.program, pid: this.child.pid ?? null,
      sessionId: this.sessionId, runId: this.runId, status: this.status, startedAt: this.startedAt,
      endedAt: this.endedAt, exitCode: this.exitCode, isolation: this.job?.kind === "job-object" ? "job-object" : "sampling", ...heldBy(this.job),
      bytes: this.bytes, dropped: this.dropped };
  }
  /** Stops it and everything it started; letting the job go is what really clears the tree. */
  async stop(): Promise<ProcessView> {
    const pid = this.child.pid;
    this.asked = true;
    if (this.status === "running" && pid) {
      try {
        if (process.platform === "win32") await killWindowsTree(pid);
        else await killProcessGroup(pid);
      } catch { /* the job being let go is the real cleanup */ }
    }
    this.settle("stopped");
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    return this.view();
  }
}

export const StartInputSchema = z.object({
  program: alias.describe("The short name of a program the owner allows to be left running, or of one shell.execute may run (such as npm, node or git)."),
  args: z.array(z.string().max(500).refine((value) => !value.includes("\0"), "NUL is not permitted")).max(40).default([]),
  cwd: z.string().min(1).max(500).default("."),
  /** A name the owner will see in the list, such as "website preview". */
  name: z.string().trim().min(1).max(60).default("a program"),
  /** selfdev: wake this conversation when the program ends, with how it ended and its last lines, so nothing polls. */
  wakeOnExit: z.boolean().default(false),
  /** selfdev: wake this conversation when a line it prints contains one of these words (any case). */
  wakeOnText: z.array(z.string().trim().min(1).max(200)).max(5).default([]),
  /** selfdev: how many times a matching line may wake it. */
  wakes: z.number().int().min(1).max(20).default(3),
}).strict();
/** selfdev: when a program left running wakes its conversation. */
export interface ProcessWake { onExit: boolean; onText: string[]; wakes: number }
/** selfdev: what wakes a conversation: its session, the task that started the program, and what to say. */
export type ProcessWaker = (wake: { sessionId: string; runId: string; text: string }) => void;

export class BackgroundProcesses {
  private readonly running = new Map<string, Running>();
  /** Told once when a program left running finishes, fails or is stopped (the check-in wakes on it). */
  readonly finished = new Set<(view: ProcessView) => void>();
  /** selfdev: wakes a conversation with a follow-up message (Runtime.followUp); set by createBranch. */
  waker: ProcessWaker | null = null;
  /** workbench (SELF-304): the programs `shell.execute` may run (src/own-clis.ts commandPrograms); set by createBranch. */
  commandPrograms: () => Record<string, { path: string; args: string[] }> = () => ({});
  /** SELF-304: how a program held to one folder is walled before it starts (BranchShell.launchHeld); set once commands exist. */
  heldLauncher: ((input: { executable: string; args: string[]; cwd: string }, context: ToolContext, timeoutMs: number) => Promise<HeldLaunch>) | null = null;
  /**
   * A program by its short name: the owner's list of programs to leave running first, then, for a task that may run
   * commands (shell.execute), the ones commands may run. Without a context (a command rule reading the line), both.
   */
  private program(name: string, context?: Pick<ToolContext, "permissions" | "writesConfinedTo">): { path: string; args: string[] } | undefined {
    const own = this.settings().programs;
    if (Object.hasOwn(own, name)) return own[name];
    // A task whose writes are held to one folder runs only what it was held with (shell.execute behind the sandbox).
    if (context && (!context.permissions.has("shell.execute") || context.writesConfinedTo)) return undefined;
    const commands = this.commandPrograms();
    return Object.hasOwn(commands, name) ? commands[name] : undefined;
  }
  constructor(
    private readonly store: Store, private readonly owner: string, private readonly workspace: string,
    private readonly jobs: JobObjects = defaultJobObjects(),
    /** How a backend is looked for. Replaced in tests, so no container is ever started. */
    private readonly probe: SandboxProbe = defaultSandboxProbe(),
  ) {}
  settings(): BackgroundSettings { return backgroundSettings(this.store, this.owner); }
  /**
   * mac7/residuals: the command a start would run, for command rules: the listed program by its own
   * name (no folder, no .exe/.cmd, so "never npm install" holds whatever the owner called it), its
   * listed arguments, then the call's. Null for a short name that is not on the list (refused anyway).
   */
  commandLine(input: { program: string; args: readonly string[] }): string | null {
    const program = this.program(input.program);
    if (!program) return null;
    const name = program.path.replace(/^.*[\\/]/, "").replace(/\.(exe|cmd|bat|com)$/i, "");
    return [name, ...program.args, ...input.args].join(" ").trim();
  }
  /** Starts a program and leaves it running; the tool call is over long before the program is. */
  async start(input: z.infer<typeof StartInputSchema>, context: ToolContext): Promise<ProcessView & { sandbox: SandboxChoice; backend: SandboxBackendName; heldTo?: string }> {
    // A helper's own conversation is not where anyone listens; it reads the program's output or tells its lead.
    if ((input.wakeOnExit || input.wakeOnText?.length) && context.depth > 0)
      throw new Error("A helper cannot be woken by a program. Read its output with process.read, or tell your lead with helpers.tell_lead.");
    const settings = this.settings();
    // SELF-304: while Branch's own source is checked out, a program is left running held to one folder, as a held
    // shell.execute is (the contract guard sets writesConfinedTo); the owner's own list is not what runs then.
    const held = !!context.writesConfinedTo;
    const program = held ? null : this.program(input.program, context);
    if (!held && !program) throw new Error(`"${input.program}" is not one of the programs allowed to be left running or run as a command. The owner adds those in Settings.`);
    // Only a task that may run commands may leave one running, held or not.
    if (held && !context.permissions.has("shell.execute"))
      throw new Error(`"${input.program}" is not one of the programs allowed to be left running or run as a command. The owner adds those in Settings.`);
    if (held && !this.heldLauncher) throw new Error("A program held to one folder cannot be left running here: there are no commands in this launch.");
    if (this.list({ active: true }).length >= settings.maxRunning)
      throw new Error(`${settings.maxRunning} programs are already running; stop one before starting another.`);
    // An approval rule may say how tightly a program left running is held. Without one it is held
    // to its limits and left able to reach the internet, exactly as it was before.
    const shape = sandboxShape(context.sandbox, { job: true, netless: false });
    const cwd = held ? "" : await new WorkspaceFiles(this.workspace).checked(input.cwd, true);
    const launch = held
      ? await this.heldLauncher!({ executable: input.program, args: input.args, cwd: input.cwd }, context, settings.maxMinutes * 60_000)
      : null;
    const job = shape.job || held
      ? await jobWithin(this.jobs, { maxMemoryMb: settings.maxMemoryMb, maxCpuSeconds: settings.maxCpuSeconds }, 1500)
      : null;
    // A rule may also say where it runs. The backend wraps the command — a container run, a call
    // into the Linux side — and the program left running is that wrapper, so stopping it stops
    // what it started. A backend that is not on this computer refuses here, before anything starts.
    const start = launch ? { ...launch.start, cwd: launch.cwd }
      : await this.wrapped(context, cwd, { executable: program!.path, args: [...program!.args, ...input.args] }, shape, settings);
    // On macOS and Linux the limits are set as the program starts, so the job may change how it starts.
    const argv = startedThrough(job, { executable: start.executable, args: start.args });
    let child: ChildProcess;
    try {
      child = spawn(argv.executable, argv.args, { cwd: start.cwd, shell: false, windowsHide: true,
        detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], env: start.env });
    } catch (error) {
      await launch?.cleanup();
      await job?.close().catch(() => undefined);
      throw error;
    }
    if (job && child.pid) await job.assign(child.pid).catch(() => false);
    const wake: ProcessWake = { onExit: input.wakeOnExit ?? false, onText: input.wakeOnText ?? [], wakes: input.wakes ?? 3 };
    const entry: Running = new Running(input.name, input.program, this.sessionOf(context), context.runId, child, job,
      settings.bufferBytes, settings.maxMinutes, (view) => {
        // SELF-304: a held program's wall, scratch folder and any .git it planted go when it does.
        if (launch) void launch.cleanup().then((swept) => {
          if (swept.length) this.store.event(view.runId, "process.swept", { id: view.id, removed: swept });
        });
        for (const listener of this.finished) listener(view);
        if (wake.onExit && view.status !== "stopped") this.wakeWith(view, `The program you left running, "${view.name}", ${view.status === "finished" ? "finished" : "failed"}`
          + ` (exit code ${view.exitCode ?? "none"}). Its last lines:\n${entry.output(1500).text.trim() || "(nothing printed)"}`);
      }, wake, (view, line) => this.wakeWith(view, `The program you left running, "${view.name}", printed a line you asked to be woken for:\n${line}`));
    this.running.set(entry.id, entry);
    if (context.runId) this.store.event(context.runId, "process.started", { id: entry.id, name: entry.name, program: entry.program, pid: child.pid ?? null, sandbox: shapeChoice(shape), backend: context.sandboxBackend ?? "job-object", ...(launch ? { heldTo: context.writesConfinedTo } : {}) });
    return { ...entry.view(), sandbox: shapeChoice(shape), backend: context.sandboxBackend ?? "job-object", ...(launch ? { heldTo: context.writesConfinedTo! } : {}) };
  }

  /**
   * The command as the chosen backend would start it. With no rule naming one this is the command
   * itself, unchanged, which is what a program left running has always been.
   */
  private async wrapped(
    context: ToolContext, cwd: string, command: { executable: string; args: string[] },
    shape: { job: boolean; netless: boolean }, settings: BackgroundSettings,
  ): Promise<SandboxStart> {
    const chosen = SandboxBackendSettingsSchema.parse(this.store.get("settings", this.owner, "sandbox-backends")?.data ?? {});
    const backend = await chooseSandboxBackend(sandboxBackendSet({ settings: chosen, probe: this.probe }), context.sandboxBackend);
    const handle = await backend.prepare(await sliceFor(cwd, context.sandboxPaths ?? []));
    const start = await handle.argvFor(command, { timeoutMs: settings.maxMinutes * 60_000,
      maxMemoryMb: settings.maxMemoryMb, maxCpuSeconds: settings.maxCpuSeconds,
      maxOutputBytes: settings.bufferBytes, network: !shape.netless, job: shape.job,
      // wave mac3 (os-sandbox): a program left running goes behind the wall too.
      ...(context.osSandbox ? { wall: shape.netless ? { ...context.osSandbox, network: "none" as const } : context.osSandbox } : {}) });
    return start;
  }
  /** selfdev: a wake-up goes to the conversation that started the program, as that task's follow-up. */
  private wakeWith(view: ProcessView, text: string): void {
    this.store.event(view.runId, "process.woke", { id: view.id, name: view.name, status: view.status });
    try { this.waker?.({ sessionId: view.sessionId, runId: view.runId, text }); } catch { /* the program is unaffected */ }
  }
  /** The conversation a task belongs to: what a program is filed under and read back by. */
  sessionOf(context: ToolContext): string {
    return this.store.run(context.runId)?.sessionId ?? context.runId;
  }
  list(options: { active?: boolean; sessionId?: string } = {}): ProcessView[] {
    return [...this.running.values()].map((entry) => entry.view())
      .filter((view) => (!options.active || view.status === "running") && (!options.sessionId || view.sessionId === options.sessionId))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
  /**
   * What one program has printed so far, the newest at the end. When a conversation is named, a
   * program another conversation started is simply not there — the same words as a wrong number,
   * so one conversation cannot find out what another one is running.
   */
  read(id: string, limit = 4000, sessionId?: string): ProcessView & { output: string } {
    const entry = this.running.get(id);
    if (!entry || (sessionId !== undefined && entry.sessionId !== sessionId))
      throw new Error("There is no program with that number");
    const { text, dropped } = entry.output(limit);
    return { ...entry.view(), dropped, output: text };
  }
  /** Stopping is scoped the same way reading is, so one conversation cannot stop another's work. */
  async stop(id: string, context?: ToolContext, sessionId?: string): Promise<ProcessView> {
    const entry = this.running.get(id);
    if (!entry || (sessionId !== undefined && entry.sessionId !== sessionId))
      throw new Error("There is no program with that number");
    const view = await entry.stop();
    if (context?.runId) this.store.event(context.runId, "process.stopped", { id: view.id, name: view.name, exitCode: view.exitCode });
    return view;
  }
  /** Everything started in one conversation goes when that conversation does. */
  async closeSession(sessionId: string): Promise<number> {
    const mine = [...this.running.values()].filter((entry) => entry.sessionId === sessionId && entry.status === "running");
    await Promise.allSettled(mine.map((entry) => entry.stop()));
    return mine.length;
  }
  /** Closing the app stops everything; nothing is left behind for the next launch to find. */
  async stopAll(): Promise<void> {
    await Promise.allSettled([...this.running.values()].map((entry) => entry.stop()));
    this.running.clear();
  }
}

export function registerProcesses(registry: ToolRegistry, processes: BackgroundProcesses): void {
  registry.register({
    name: "process.start", permission: "process.manage", group: "code",
    description: "Start one of the programs the owner allows to be left running (a preview server, a watcher, a long build or test run) and leave it going after this step is over. What it prints is kept in a rolling buffer you can read later. Set wakeOnExit to be woken in this conversation when it ends, and wakeOnText to be woken when a line contains one of your words, instead of checking on it. It stops when this conversation ends or the app closes.",
    parameters: StartInputSchema,
    target: (args) => `${args.program} ${args.args.join(" ")}`.trim().slice(0, 300),
    command: (args) => processes.commandLine(args),
    execute: (args, context) => processes.start(args, context),
  });
  registry.register({
    name: "process.list", permission: "process.read", group: "code",
    description: "What this conversation has left running, what each one is, and whether it is still going. Programs other conversations started are not listed here; the owner sees all of them in the Activity screen.",
    parameters: z.object({}).strict(),
    execute: async (_args, context) => ({ processes: processes.list({ sessionId: processes.sessionOf(context) }) }),
  });
  registry.register({
    name: "process.read", permission: "process.read", group: "code",
    description: "Read what a running program has printed so far. Only the most recent part is kept; the answer says when older output was dropped.",
    parameters: z.object({ id: z.string().uuid(), characters: z.number().int().min(100).max(8000).default(4000) }).strict(),
    execute: async (args, context) => processes.read(args.id, args.characters, processes.sessionOf(context)),
  });
  registry.register({
    name: "process.stop", permission: "process.manage", group: "code",
    description: "Stop a running program and everything it started.",
    parameters: z.object({ id: z.string().uuid() }).strict(),
    execute: (args, context) => processes.stop(args.id, context, processes.sessionOf(context)),
  });
}
