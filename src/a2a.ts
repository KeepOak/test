import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { errorText, type Run, type RunStatus } from "./contracts.js";
import { RateLimiter } from "./approvals.js";
import type { McpServer, McpSharing } from "./mcp-server.js";
import type { ToolRegistry } from "./registry.js";
import type { Runtime } from "./runtime.js";
import type { Store } from "./store.js";
import { conversationBegunBy, notYourConversation } from "./outside-origin.js";
import { shortLivedKeyMark, startedWithShortLivedKey } from "./key-context.js";

/**
 * Who is calling, by the key it came with (a pairing key or another short-lived key), not by the name it gives itself:
 * a task is found, and stopped, only by the key that started it. The app's own key is the owner's.
 */
function callerKey(): string {
  return startedWithShortLivedKey() ? `key:${shortLivedKeyMark().keyId ?? "unnamed"}` : "owner";
}
const unknownTask = (id: string) => new A2aError(-32001, `Task ${id} is not known to this assistant`);

/**
 * A2A, the agent-to-agent protocol: how an assistant made by someone else asks this one to do a
 * piece of work. Branch publishes a card saying who it is and what it can be asked for, then takes
 * tasks over JSON-RPC. Every task becomes an ordinary Branch task, so it appears in Activity with
 * the same signed receipts, and it never gets more freedom than the "Ask before changes" rules,
 * because the owner did not start it. Nothing is answered until the owner switches A2A on.
 */
export type A2aState = "submitted" | "working" | "completed" | "failed" | "canceled" | "input-required";

export const stateOf = (status: RunStatus): A2aState =>
  status === "running" ? "working"
    : status === "completed" ? "completed"
    : status === "cancelled" ? "canceled"
    : status === "needs_input" ? "input-required"
    : "failed";

const TextPartSchema = z.object({ type: z.literal("text"), text: z.string().max(16000) }).passthrough();
const MessageSchema = z.object({
  role: z.enum(["user", "agent"]).default("user"),
  parts: z.array(z.record(z.string(), z.unknown())).min(1).max(20),
}).passthrough();
export const SendParamsSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  sessionId: z.string().min(1).max(200).optional(),
  message: MessageSchema,
}).passthrough();
export const TaskIdParamsSchema = z.object({ id: z.string().min(1).max(200) }).passthrough();
export type SendParams = z.infer<typeof SendParamsSchema>;

/** Only written words cross the boundary: a file or a blob from outside is refused, not unpacked. */
export function taskText(message: z.infer<typeof MessageSchema>): string {
  const texts: string[] = [];
  for (const part of message.parts) {
    if (part.type !== "text")
      throw new A2aError(-32602, "Branch takes written instructions only; attached files are not read");
    texts.push(TextPartSchema.parse(part).text);
  }
  const text = texts.join("\n").trim();
  if (!text) throw new A2aError(-32602, "The task message was empty");
  return text;
}

export class A2aError extends Error {
  override name = "A2aError";
  constructor(readonly code: number, message: string) { super(message); }
}
export interface A2aOptions {
  /** How many tasks one calling agent may start in a minute. */
  tasksPerMinute: number;
  /** How long a task may run before it is stopped. */
  taskTimeoutMs: number;
}
export interface A2aTaskRecord { id: string; runId: string; sessionId: string; agent: string; createdAt: string; caller?: string; interrupted?: boolean }

/** How many tasks stay findable by `tasks/get` before the oldest are forgotten. */
const maxRememberedTasks = 500;
const taskIndexKey = "a2a-task-index";
const TaskRecordSchema = z.object({
  id: z.string().min(1).max(200), runId: z.string().max(200), sessionId: z.string().max(200),
  agent: z.string().max(60), createdAt: z.string().datetime(), caller: z.string().min(1).max(200),
  interrupted: z.boolean().optional(),
}).strict();
const TaskIndexSchema = z.object({ tasks: z.array(TaskRecordSchema).max(maxRememberedTasks) }).strict();
const nowIso = () => new Date().toISOString();
const textMessage = (text: string) => ({ role: "agent", parts: [{ type: "text", text }] });

/** The public description of this assistant: who it is, where to send work, and what it does. */
export function agentCard(base: string, version: string, sharing: McpSharing, registry: ToolRegistry): unknown {
  const shared = new Set(sharing.enabled ? sharing.exposedTools : []);
  const skills = [{
    id: "branch.ask",
    name: "Ask Branch to do something",
    description: "Describe a piece of work in plain words. Branch uses its own tools, memory and skills, within the limits its owner has set.",
    tags: ["general"],
    examples: ["Summarise the notes in my workspace"],
  }];
  for (const tool of registry.inventory())
    if (shared.has(tool.name))
      skills.push({ id: tool.name, name: tool.name, description: tool.description, tags: [tool.permission], examples: [] });
  return {
    name: "Branch Agent",
    description: "A personal assistant that works on one person's computer, with their files, memory and saved ways of working.",
    url: `${base}/a2a`,
    version,
    provider: { organization: "Branch Agent" },
    capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
    authentication: { schemes: ["bearer"] },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    skills,
  };
}

export class A2aServer {
  /** Bounded task ids retain their caller and Branch run across a restart. Work is never replayed here. */
  private readonly tasks = new Map<string, A2aTaskRecord>();
  private readonly rates = new RateLimiter();
  constructor(
    readonly store: Store,
    readonly runtime: Runtime,
    readonly registry: ToolRegistry,
    readonly mcp: McpServer,
    readonly version: string,
    readonly options: A2aOptions = { tasksPerMinute: 20, taskTimeoutMs: 120000 },
  ) {
    const saved = TaskIndexSchema.safeParse(this.store.get("settings", this.runtime.owner, taskIndexKey)?.data);
    if (!saved.success) return;
    for (const record of saved.data.tasks) {
      const run = record.runId ? this.store.run(record.runId) : undefined;
      this.tasks.set(record.id, { ...record, interrupted: record.interrupted || !run || run.status === "running" });
    }
  }

  private remember(): void {
    this.store.save("settings", this.runtime.owner, taskIndexKey, { tasks: [...this.tasks.values()] });
  }

  /** Whether the owner has switched on answering other agents. Read fresh, so a change is immediate. */
  enabled(): boolean { return this.mcp.sharing().a2a; }
  card(base: string): unknown { return agentCard(base, this.version, this.mcp.sharing(), this.registry); }

  /** Keeps one calling agent inside its per-minute allowance; over it, the task is refused outright. */
  private checkRate(agent: string): void {
    const caller = callerKey();
    if (this.rates.waitMs(caller, this.options.tasksPerMinute) > 0)
      throw new A2aError(-32003, `Too many tasks: ${agent} may start ${this.options.tasksPerMinute} a minute.`);
    this.rates.record(caller);
  }

  /**
   * The caller's conversation to carry on, or none for a fresh one. mac7/residuals: only one that an
   * agent began over A2A; naming any other (the owner's own, or one that does not exist) is refused.
   */
  private sessionFor(sessionId: string | undefined): string | undefined {
    if (!sessionId) return undefined;
    const caller = callerKey();
    const mine = [...this.tasks.values()].some((record) => record.sessionId === sessionId && record.caller === caller);
    if (!mine || !this.store.ownsSession(this.runtime.owner, sessionId) || conversationBegunBy(this.store, sessionId) !== "a2a")
      throw new A2aError(-32602, notYourConversation);
    return sessionId;
  }

  /** Starts the Branch task behind an A2A task and remembers the pairing, without waiting for it. */
  begin(params: SendParams, agent: string): { record: A2aTaskRecord; prompt: string; sessionId: string | undefined } {
    if (!this.enabled()) throw new A2aError(-32001, "This assistant is not answering other agents. Its owner can switch that on in Settings.");
    const sessionId = this.sessionFor(params.sessionId);
    this.checkRate(agent);
    const prompt = taskText(params.message);
    const id = params.id ?? randomUUID(), caller = callerKey();
    // An id already in use is never taken over: another caller's is refused as unknown would be, and one of this
    // caller's own that is still going is refused plainly, so a task cannot be overwritten mid-way.
    const earlier = this.tasks.get(id);
    if (earlier && earlier.caller !== caller) throw new A2aError(-32002, `The task id ${id} is already in use. Send a new id.`);
    if (earlier && !earlier.interrupted && (!earlier.runId || this.store.run(earlier.runId)?.status === "running"))
      throw new A2aError(-32002, `Task ${id} is still going. Wait for it, or send a new id.`);
    const record: A2aTaskRecord = { id, runId: "", sessionId: "", agent, createdAt: nowIso(), caller };
    this.tasks.delete(id);
    this.tasks.set(id, record);
    // Only the most recent tasks stay findable, so a long-running install does not grow without end.
    for (const oldest of [...this.tasks.keys()].slice(0, this.tasks.size - maxRememberedTasks))
      this.tasks.delete(oldest);
    this.remember();
    return { record, prompt, sessionId };
  }

  /** Runs one task to the end and answers with it. The caller waits; `sendSubscribe` streams instead. */
  async send(params: SendParams, agent: string, traceparent?: string | null): Promise<unknown> {
    const { record, prompt, sessionId } = this.begin(params, agent);
    const run = await this.execute(record, prompt, sessionId, traceparent);
    return this.taskView(record, run);
  }

  /** The shared way of running a task: held to the rules for work the owner did not start. */
  private async execute(record: A2aTaskRecord, prompt: string, sessionId: string | undefined, traceparent?: string | null): Promise<Run> {
    const run = await this.runtime.run({
      prompt, source: "a2a", ...(sessionId ? { sessionId } : {}),
      // An assistant that already had a trace open passes it on, so its work and ours are one trace.
      ...(traceparent ? { traceparent } : {}),
      signal: AbortSignal.timeout(this.options.taskTimeoutMs),
      onStarted: (started) => {
        record.runId = started.id; record.sessionId = started.sessionId;
        this.remember();
        this.announce(record, prompt);
      },
    }).catch((error: unknown) => {
      record.interrupted = true;
      this.remember();
      throw error;
    });
    record.runId = run.id;
    record.sessionId = run.sessionId;
    this.remember();
    return run;
  }

  /** Notes in the task's own timeline which outside agent asked for it, so Activity can show it. */
  private announce(record: A2aTaskRecord, prompt: string): void {
    this.store.event(record.runId, "a2a.task", {
      taskId: record.id, agent: record.agent, source: "a2a",
      label: `${record.agent} asked: ${prompt.slice(0, 80)}`,
    });
  }

  /** What a caller sees: the state of the work and, once there is one, the answer as an artifact. */
  taskView(record: A2aTaskRecord, run: Run): unknown {
    const state = record.interrupted ? "failed" : stateOf(run.status);
    const done = state === "completed";
    const message = record.interrupted ? "This task stopped before it finished. Start a new task to continue."
      : run.output;
    return {
      id: record.id,
      sessionId: record.sessionId,
      status: { state, timestamp: nowIso(), ...(message ? { message: textMessage(message) } : {}) },
      artifacts: done ? [{ name: "answer", index: 0, parts: [{ type: "text", text: run.output }] }] : [],
      metadata: { runId: run.id, agent: record.agent },
    };
  }

  /** A retained task, including after a restart, visible only to the caller that started it. */
  get(params: unknown): unknown {
    const { id } = TaskIdParamsSchema.parse(params);
    const record = this.mine(id);
    const run = record && this.store.run(record.runId);
    if (!record) throw unknownTask(id);
    if (!run && !record.interrupted) throw unknownTask(id);
    return this.taskView(record, run ?? blankRun(record, this.runtime.owner));
  }

  /** The task with this id if the caller asking is the one that started it; another caller's is not known to them. */
  private mine(id: string): A2aTaskRecord | undefined {
    const record = this.tasks.get(id);
    return record && (record.caller ?? "owner") === callerKey() ? record : undefined;
  }
  /** Stops a task that is still running; one that already finished comes back as it ended. */
  cancel(params: unknown): unknown {
    const { id } = TaskIdParamsSchema.parse(params);
    const record = this.mine(id);
    if (!record) throw unknownTask(id);
    if (record.interrupted) return this.taskView(record, this.store.run(record.runId) ?? blankRun(record, this.runtime.owner));
    if (record.runId) this.runtime.cancel(record.runId);
    const run = this.store.run(record.runId);
    // A task cancelled before its run had even begun still answers as cancelled, with no answer.
    if (!run) return this.taskView(record, blankRun(record, this.runtime.owner));
    return this.taskView(record, { ...run, status: run.status === "running" ? "cancelled" : run.status });
  }

  /**
   * Streams one task as it happens: a state update for every step Branch records, then the answer
   * as an artifact and a last update marked final. The run's own event log is the source.
   */
  async sendSubscribe(params: SendParams, agent: string, id: string | number, response: ServerResponse): Promise<void> {
    const { record, prompt, sessionId } = this.begin(params, agent);
    const write = (result: unknown) => response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`);
    sseHead(response);
    write({ id: record.id, status: { state: "submitted", timestamp: nowIso() }, final: false });
    // A task that never starts is told to the caller below. The stream is already open, so there is
    // no error reply left to send, and a failure nobody is watching would take the whole app down.
    let settled = false, failure: unknown;
    const finished = this.execute(record, prompt, sessionId).then(
      (run) => { settled = true; return run; },
      (error: unknown) => { settled = true; failure = error; return undefined; },
    );
    await this.pump(record, write, response, () => settled);
    const run = await finished;
    if (!run) {
      write({ id: record.id, status: { state: "failed", timestamp: nowIso(), message: textMessage(errorText(failure)) }, final: true });
      response.end();
      return;
    }
    const view = this.taskView(record, run) as { status: unknown; artifacts: unknown[] };
    for (const artifact of view.artifacts) write({ id: record.id, artifact });
    write({ id: record.id, status: view.status, final: true });
    response.end();
  }

  /** Every stored step of the task, in order, turned into a state update, until the task settles. */
  private async pump(record: A2aTaskRecord, write: (result: unknown) => void, response: ServerResponse, settled: () => boolean): Promise<void> {
    const deadline = Date.now() + this.options.taskTimeoutMs;
    let last = 0, closed = false;
    response.on("close", () => { closed = true; });
    while (!closed && !settled() && Date.now() < deadline) {
      if (record.runId)
        for (const event of this.store.events(record.runId).filter((e) => e.id > last)) {
          last = event.id;
          write({ id: record.id, status: { state: "working", timestamp: event.createdAt, message: textMessage(stepText(event.kind, event.data)) }, final: false });
        }
      const run = record.runId ? this.store.run(record.runId) : undefined;
      if (run && run.status !== "running") return;
      await delay(100);
    }
  }
}

/** A task stopped before any work began: there is nothing recorded, and nothing to hand back. */
const blankRun = (record: A2aTaskRecord, owner: string): Run => ({
  id: record.runId, sessionId: record.sessionId, owner, prompt: "", status: "cancelled",
  output: "", createdAt: record.createdAt, updatedAt: record.createdAt,
});

/** One recorded step, in words a person or another agent can read. */
export function stepText(kind: string, data: Record<string, unknown>): string {
  const label = typeof data.label === "string" ? data.label : "";
  if (kind === "tool.failed" || kind === "tool.stalled") return `Step failed: ${String(data.error ?? "unknown problem")}`;
  if (kind === "policy.ask") return `Waiting for the owner to allow: ${label || String(data.name ?? "a step")}`;
  if (kind === "policy.denied") return `The owner's settings do not allow: ${label || String(data.name ?? "a step")}`;
  return label || kind;
}

function sseHead(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store",
    connection: "keep-alive", "x-content-type-options": "nosniff",
  });
  response.flushHeaders();
}

/** Turns anything thrown while answering a caller into a JSON-RPC error body. */
export const a2aError = (id: string | number | null, error: unknown) => ({
  jsonrpc: "2.0" as const, id,
  error: { code: error instanceof A2aError ? error.code : -32603, message: errorText(error) },
});
