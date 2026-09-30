import { z } from "zod";
import { pathToFileURL } from "node:url";
import type { Store } from "./store.js";
import { markChosen, sentKeys, shippedUnlessChosen } from "./ship-on.js";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import type { WorkspaceFiles } from "./files.js";
import { RequestTable, StdioChannel, checkedProgram } from "./stdio-rpc.js";
import { defaultJobObjects, type JobObjects } from "./integrations/job-object.js";

/**
 * Running a program under a debugger the owner already has. A debug adapter is the small program an
 * editor talks to when it stops your code on a line and shows you what every name holds; Node's own
 * inspector and Python's debugpy are the usual ones. Branch never downloads one, only one adapter
 * runs at a time, and starting one goes through the same question as running any other program. It ships on (the
 * owner's rule): nothing starts until the owner has added an adapter and a task asks for it.
 */
const alias = z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/);
export const DebugSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  adapters: z.record(alias, z.object({
    path: z.string().min(1).max(1000),
    args: z.array(z.string().max(500)).max(20).default([]),
    /** What goes in the "launch" message besides the program; the adapter decides what it means. */
    launch: z.record(z.string().max(60), z.union([z.string().max(500), z.number(), z.boolean()])).default({}),
  }).strict()).default({}),
  maxMemoryMb: z.number().int().min(64).max(16384).default(2048),
  maxCpuSeconds: z.number().int().min(10).max(36000).default(600),
  timeoutMs: z.number().int().min(1000).max(120000).default(20000),
  /**
   * "Keep a program being debugged running between tasks". Off, a program a task started debugging
   * stops when that task ends, the same way a program started in a conversation stops when the
   * conversation does, so nothing is left running that nobody is watching.
   */
  keepRunning: z.boolean().default(false),
}).strict();
export type DebugSettings = z.infer<typeof DebugSettingsSchema>;

export function debugSettings(store: Store, owner: string): DebugSettings {
  const parsed = DebugSettingsSchema.safeParse(store.get("settings", owner, "debug-adapters")?.data ?? {});
  // The owner's rule (2026-09-27): only the adapters the owner adds are ever started, each only while a task uses it, and
  // none is kept running between tasks unless the owner says so; nothing is heavy until used, so this ships on.
  return parsed.success ? shippedUnlessChosen(store, owner, "debug-adapters", parsed.data, { enabled: true }) : DebugSettingsSchema.parse({});
}
export async function saveDebugSettings(store: Store, owner: string, input: unknown): Promise<DebugSettings> {
  const value = DebugSettingsSchema.parse(input ?? {});
  for (const [name, adapter] of Object.entries(value.adapters))
    await checkedProgram(adapter.path).catch((error: Error) => { throw new Error(`${name}: ${error.message}`); });
  store.save("settings", owner, "debug-adapters", { ...value });
  markChosen(store, owner, "debug-adapters", sentKeys(input));
  return value;
}

export interface DebugEvent { event: string; at: string; detail: string }
export interface DebugVariable { name: string; value: string; type: string }

/** One debugging session: the adapter, what it has told us, and the line it is stopped on. */
class Session {
  private seq = 1;
  private readonly table: RequestTable;
  readonly events: DebugEvent[] = [];
  /** The newest part of what the program being debugged printed; the oldest is dropped. */
  private printed = "";
  threadId: number | null = null;
  stopped: { reason: string; line: number; path: string } | null = null;
  exited = false;
  constructor(readonly adapter: string, private readonly channel: StdioChannel, timeoutMs: number, private readonly bufferBytes: number) {
    this.table = new RequestTable(timeoutMs);
    channel.listeners.add((message) => this.receive(message));
  }
  get running(): boolean { return this.channel.running && !this.exited; }
  get output(): string { return this.printed; }

  private receive(message: Record<string, unknown>): void {
    if (message.type === "response") {
      const id = Number(message.request_seq);
      const ok = message.success !== false;
      this.table.settle(id, (message.body ?? {}) as Record<string, unknown>, ok ? undefined : String(message.message ?? "the debugger refused"));
      return;
    }
    if (message.type === "event") this.keepEvent(message);
  }
  private keepEvent(message: Record<string, unknown>): void {
    const event = String(message.event ?? "");
    const body = (message.body ?? {}) as Record<string, unknown>;
    if (event === "output") this.printed = `${this.printed}${String(body.output ?? "")}`.slice(-this.bufferBytes);
    if (event === "stopped") {
      this.threadId = Number(body.threadId ?? this.threadId ?? 1);
      this.stopped = { reason: String(body.reason ?? "stopped"), line: Number(body.line ?? 0), path: String(body.source ?? "") };
    }
    if (event === "continued") this.stopped = null;
    if (event === "terminated" || event === "exited") this.exited = true;
    this.events.push({ event, at: new Date().toISOString(), detail: JSON.stringify(body).slice(0, 300) });
    if (this.events.length > 200) this.events.shift();
  }

  request(command: string, args: unknown, timeoutMs?: number): Promise<Record<string, unknown>> {
    const id = this.seq++;
    const waiting = this.table.expect(id, timeoutMs);
    this.channel.send({ seq: id, type: "request", command, arguments: args ?? {} });
    return waiting;
  }
  /** Waits until the program stops on a line, or until the wait runs out. */
  async waitForStop(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until && !this.stopped && !this.exited)
      await new Promise((resolve) => setTimeout(resolve, 25));
  }
  async stop(): Promise<void> {
    this.table.abandon("The debugger was stopped");
    try { await this.request("disconnect", { terminateDebuggee: true }, 2000); } catch { /* it may already be gone */ }
    await this.channel.stop();
    this.exited = true;
  }
}

export const DebugStartSchema = z.object({
  adapter: alias,
  /** The file to run, inside the workspace. */
  program: z.string().min(1).max(500),
  args: z.array(z.string().max(500)).max(20).default([]),
  /** Lines to stop on, as { path, lines: [12, 40] }. */
  breakpoints: z.array(z.object({
    path: z.string().min(1).max(500),
    lines: z.array(z.number().int().min(1).max(1000000)).min(1).max(50),
  }).strict()).max(10).default([]),
  /** How long to wait for it to stop on the first line before answering. */
  waitMs: z.number().int().min(0).max(30000).default(5000),
}).strict();

export class DebugAdapters {
  private session: Session | null = null;
  /** The task that started what is being debugged, so it stops again when that task is over. */
  private startedByRun = "";
  constructor(
    private readonly store: Store, private readonly owner: string,
    private readonly files: WorkspaceFiles, private readonly jobs: JobObjects = defaultJobObjects(),
  ) {}
  settings(): DebugSettings { return debugSettings(this.store, this.owner); }

  /** Starts the adapter, sets the lines to stop on, and launches the program. */
  async start(input: z.infer<typeof DebugStartSchema>, context: ToolContext): Promise<unknown> {
    const settings = this.settings();
    if (!settings.enabled) throw new Error("Debugging is switched off. The owner turns it on in Settings, under Developer.");
    const adapter = Object.hasOwn(settings.adapters, input.adapter) ? settings.adapters[input.adapter]! : undefined;
    if (!adapter) throw new Error(`"${input.adapter}" is not one of the debuggers the owner set up.`);
    if (this.session?.running) throw new Error("A debugging session is already going; stop that one first.");
    const program = await this.files.checked(input.program);
    const channel = await StdioChannel.start({
      executable: adapter.path, args: adapter.args, cwd: this.files.base,
      limits: { maxMemoryMb: settings.maxMemoryMb, maxCpuSeconds: settings.maxCpuSeconds },
    }, this.jobs);
    const session = new Session(input.adapter, channel, settings.timeoutMs, 16384);
    this.session = session;
    this.startedByRun = context.runId;
    await this.handshake(session, adapter.launch, program, input);
    if (context.runId)
      this.store.event(context.runId, "debug.started", { adapter: input.adapter, program: input.program, breakpoints: input.breakpoints.length });
    await session.waitForStop(input.waitMs);
    return this.view("started");
  }
  /** initialize, breakpoints, launch, configurationDone: the order every adapter expects. */
  private async handshake(session: Session, launch: Record<string, unknown>, program: string, input: z.infer<typeof DebugStartSchema>): Promise<void> {
    await session.request("initialize", { adapterID: "branch", clientID: "branch", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" })
      .catch((error: Error) => { void session.stop(); throw new Error(`The debugger did not start: ${error.message}`); });
    for (const group of input.breakpoints) {
      const absolute = await this.files.checked(group.path);
      await session.request("setBreakpoints", {
        source: { path: absolute, name: group.path },
        breakpoints: group.lines.map((line) => ({ line })),
      });
    }
    await session.request("launch", { ...launch, program, args: input.args, cwd: this.files.base, noDebug: false });
    await session.request("configurationDone", {}).catch(() => undefined);
  }

  private current(): Session {
    if (!this.session?.running) throw new Error("Nothing is being debugged right now.");
    return this.session;
  }
  /** One step: over the next line, into a call, out of this call, or on to the next stop. */
  async step(input: { kind: "over" | "into" | "out" | "continue"; waitMs: number }): Promise<unknown> {
    const session = this.current();
    const commands = { over: "next", into: "stepIn", out: "stepOut", continue: "continue" } as const;
    session.stopped = null;
    await session.request(commands[input.kind], { threadId: session.threadId ?? 1 });
    await session.waitForStop(input.waitMs);
    return this.view(`stepped ${input.kind}`);
  }
  /** What every name holds at the line it is stopped on. */
  async variables(input: { limit: number }): Promise<unknown> {
    const session = this.current();
    if (!session.stopped) throw new Error("The program is still running; it has not stopped on a line yet.");
    const frames = await session.request("stackTrace", { threadId: session.threadId ?? 1, levels: 1 });
    const frame = (frames.stackFrames as Record<string, unknown>[] | undefined)?.[0];
    if (!frame) return { variables: [], note: "The debugger did not report where it is." };
    const scopes = await session.request("scopes", { frameId: frame.id });
    const first = (scopes.scopes as Record<string, unknown>[] | undefined)?.[0];
    if (!first) return { variables: [], note: "The debugger reported no names in view." };
    const answer = await session.request("variables", { variablesReference: first.variablesReference });
    const list = (answer.variables as Record<string, unknown>[] | undefined) ?? [];
    return {
      frame: String(frame.name ?? "").slice(0, 200), line: Number(frame.line ?? 0),
      variables: list.slice(0, input.limit).map((entry): DebugVariable => ({
        name: String(entry.name ?? "").slice(0, 120), value: String(entry.value ?? "").slice(0, 400), type: String(entry.type ?? ""),
      })),
    };
  }
  async stop(context: ToolContext): Promise<unknown> {
    const session = this.session;
    if (!session) throw new Error("Nothing is being debugged right now.");
    const view = this.view("stopped");
    await session.stop();
    this.session = null;
    if (context.runId) this.store.event(context.runId, "debug.stopped", { adapter: session.adapter });
    return view;
  }
  /** Stops whatever is left running; called when the app closes. */
  async stopAll(): Promise<void> {
    const session = this.session;
    this.session = null;
    await session?.stop().catch(() => undefined);
  }
  /**
   * A program a task started debugging stops when that task is over, unless the owner asked for it
   * to be kept running with "Keep a program being debugged running between tasks" in Settings.
   */
  async closeRun(runId: string): Promise<number> {
    if (!runId || this.startedByRun !== runId || !this.session || this.settings().keepRunning) return 0;
    const session = this.session;
    this.session = null;
    this.startedByRun = "";
    await session.stop().catch(() => undefined);
    return 1;
  }
  private view(action: string): unknown {
    const session = this.session!;
    return {
      action, adapter: session.adapter, running: session.running,
      stopped: session.stopped, output: session.output.slice(-2000),
      events: session.events.slice(-10).map((entry) => entry.event),
    };
  }
}

export function registerDebug(registry: ToolRegistry, debug: DebugAdapters): void {
  registry.register({
    name: "debug.start", permission: "code.execute", group: "code",
    description: "Run a program in the workspace under a debugger the owner set up, stopping on the lines you name. The person is asked first, as with any other program that runs on this computer.",
    parameters: DebugStartSchema,
    target: (args) => `${args.adapter}: ${args.program}`.slice(0, 300),
    execute: (args, context) => debug.start(args, context),
  });
  registry.register({
    name: "debug.step", permission: "code.execute", group: "code",
    description: "Move the stopped program on: over the next line, into a call, out of this call, or on to the next place it stops.",
    parameters: z.object({
      kind: z.enum(["over", "into", "out", "continue"]).default("over"),
      waitMs: z.number().int().min(0).max(30000).default(5000),
    }).strict(),
    execute: (args) => debug.step(args),
  });
  registry.register({
    name: "debug.variables", permission: "files.read", group: "code",
    description: "What every name holds at the line the program is stopped on.",
    parameters: z.object({ limit: z.number().int().min(1).max(100).default(40) }).strict(),
    execute: (args) => debug.variables(args),
  });
  registry.register({
    name: "debug.stop", permission: "code.execute", group: "code",
    description: "Stop debugging and end the program being debugged.",
    parameters: z.object({}).strict(),
    execute: (_args, context) => debug.stop(context),
  });
}

/** Where a file sits, as an address, for an adapter that asks for one. */
export const fileAddress = (path: string): string => pathToFileURL(path).href;
