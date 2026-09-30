import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { errorText, type Run } from "../contracts.js";
import type { Runtime } from "../runtime.js";
import { carryable } from "../carry-on.js"; // QA R1 follow-up
import { askMode } from "./settings.js";
import { conversationBegunBy, notYourConversation } from "../outside-origin.js";

/**
 * A0032: the app-server protocol — the JSON-RPC shape Codex's own editor extensions and desktop app
 * use to drive an agent over standard input and output — spoken by Branch, so a program written for
 * it can drive Branch instead. One JSON message per line, without the "jsonrpc" field (a message that
 * carries one is accepted too). The part of the protocol spoken here:
 *
 *   initialize → initialized          the handshake, which must come first
 *   thread/start                       a new Branch conversation; `thread/started` follows
 *   turn/start                         one request; `turn/started`, `item/agentMessage/delta` as the
 *                                      answer is written, `item/completed`, then `turn/completed`
 *   turn/interrupt                     stops the turn
 *
 * When a step needs a yes, the client is asked with `item/commandExecution/requestApproval` and its
 * decision goes to Branch's approval rules, bound to the exact request shown. Anything meant for a
 * person goes to standard error; standard output carries the protocol only. The whole thing refuses
 * to start while its switch is off.
 */
const MessageSchema = z.object({
  jsonrpc: z.literal("2.0").optional(),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1).max(200).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).partial().optional(),
}).passthrough();
const TurnStartSchema = z.object({
  threadId: z.string().min(1).max(200),
  input: z.array(z.object({ type: z.string(), text: z.string().max(16000).optional() }).passthrough()).min(1).max(50),
}).passthrough();
const InterruptSchema = z.object({ threadId: z.string().min(1).max(200), turnId: z.string().min(1).max(200) }).passthrough();
const DecisionSchema = z.object({ decision: z.unknown() }).passthrough();
const maxApprovals = 8;

export interface AppServerIo { input: Readable; output: Writable; log: (message: string) => void }

/** Only written words are taken; a picture, file or skill mention is refused in plain words. */
export function inputText(input: z.infer<typeof TurnStartSchema>["input"]): string {
  const texts = input.map((part) => {
    if (part.type !== "text") throw new Error("Branch takes written instructions only over the app-server protocol");
    return part.text ?? "";
  });
  const text = texts.join("\n").trim();
  if (!text) throw new Error("The request was empty");
  return text;
}

const turnView = (id: string, status: string, error: string | null) =>
  ({ id, items: [], itemsView: "notLoaded", status, error: error ? { message: error } : null });

export class AppServerConnection {
  private readonly pending = new Map<number, (message: z.infer<typeof MessageSchema>) => void>();
  private readonly turns = new Map<string, string>();
  private nextId = 1;
  private initialized = false;
  constructor(private readonly runtime: Runtime, private readonly io: AppServerIo, private readonly version: string) {}

  private write(message: Record<string, unknown>): void { this.io.output.write(`${JSON.stringify(message)}\n`); }
  private notify(method: string, params: Record<string, unknown>): void { this.write({ method, params }); }
  private request(method: string, params: Record<string, unknown>): Promise<z.infer<typeof MessageSchema>> {
    const id = this.nextId++;
    return new Promise((resolve) => { this.pending.set(id, resolve); this.write({ id, method, params }); });
  }

  async serve(): Promise<void> {
    this.io.log("Branch is ready for an app-server client on standard input.");
    const lines = createInterface({ input: this.io.input, crlfDelay: Infinity });
    for await (const line of lines)
      if (line.trim()) void this.accept(line).catch((error: unknown) => this.io.log(errorText(error)));
    for (const waiting of this.pending.values()) waiting({ error: { code: -1, message: "disconnected" } });
    this.pending.clear();
  }

  async accept(line: string): Promise<void> {
    let message: z.infer<typeof MessageSchema>;
    try { message = MessageSchema.parse(JSON.parse(line)); }
    catch { this.write({ id: null, error: { code: -32700, message: "Parse error" } }); return; }
    if (!message.method) {
      const waiting = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
      if (waiting) { this.pending.delete(message.id as number); waiting(message); }
      return;
    }
    if (message.id === undefined) return; // "initialized" and other notifications need no answer
    try {
      this.write({ id: message.id, result: await this.onRequest(message.method, message.params ?? {}) });
    } catch (error) {
      const unknown = error instanceof UnknownMethod;
      this.write({ id: message.id, error: { code: unknown ? -32601 : -32600, message: errorText(error) } });
    }
  }

  private async onRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "initialize") { this.initialized = true; return { userAgent: `branch-agent/${this.version}` }; }
    if (!this.initialized) throw new Error("Say hello with initialize first");
    if (method === "thread/start") return this.startThread();
    if (method === "turn/start") return this.startTurn(TurnStartSchema.parse(params));
    if (method === "turn/interrupt") {
      const { turnId } = InterruptSchema.parse(params);
      const runId = this.turns.get(turnId);
      if (runId) this.runtime.cancel(runId);
      return {};
    }
    throw new UnknownMethod(`Branch does not know the request "${method}"`);
  }

  private startThread(): unknown {
    const store = this.runtime.store, owner = this.runtime.owner;
    const opened = store.createRun(owner, "App-server conversation opened", undefined, false, "acp");
    store.finish(opened.id, "completed", "Conversation opened");
    const choice = this.runtime.models.plan(owner, opened.sessionId).choice;
    const thread = { id: opened.sessionId, preview: "", ephemeral: false, modelProvider: choice.provider,
      createdAt: Math.floor(Date.now() / 1000), cwd: this.runtime.workspace, status: { type: "idle" } };
    this.notify("thread/started", { thread });
    return { thread, model: choice.model, modelProvider: choice.provider, cwd: this.runtime.workspace, approvalPolicy: "on-request" };
  }

  private startTurn(params: z.infer<typeof TurnStartSchema>): unknown {
    const { threadId } = params;
    if (!this.runtime.store.ownsSession(this.runtime.owner, threadId)) throw new Error("That thread is not one of Branch's");
    // mac7/residuals: only a thread a program opened here (thread/start); never the owner's own conversation.
    if (conversationBegunBy(this.runtime.store, threadId) !== "acp") throw new Error(notYourConversation);
    const prompt = inputText(params.input);
    const turnId = randomUUID();
    void this.runTurn(threadId, turnId, prompt).catch((error: unknown) =>
      this.notify("turn/completed", { threadId, turn: turnView(turnId, "failed", errorText(error)) }));
    return { turn: turnView(turnId, "inProgress", null) };
  }

  private async runTurn(threadId: string, turnId: string, first: string): Promise<void> {
    this.notify("turn/started", { threadId, turn: turnView(turnId, "inProgress", null) });
    const itemId = randomUUID();
    let text = "", prompt = first, run: Run | undefined, carry: string | null = null;
    const hooks = {
      onStarted: (started: Run) => { this.turns.set(turnId, started.id); },
      onTextDelta: (delta: string) => { if (!delta) return; text += delta; this.notify("item/agentMessage/delta", { threadId, turnId, itemId, delta }); },
    };
    for (let round = 0; round <= maxApprovals; round++) {
      // QA R1 follow-up: after the client's yes, the task that asked carries on and the engine runs the approved call.
      run = carry ? await this.runtime.continueAsked(carry, hooks) : await this.runtime.run({ prompt, sessionId: threadId, source: "acp", ...hooks });
      if (run.status !== "needs_input" || !(await this.askApproval(threadId, turnId))) break;
      carry = carryable(this.runtime, run.id, "acp")?.id ?? null;
      if (!carry) prompt = "Go ahead with the step you were waiting on."; // a task that can no longer be carried on
    }
    this.notify("item/completed", { threadId, turnId, item: { type: "agentMessage", id: itemId, text: text || run?.output || "" } });
    const status = run?.status === "completed" || run?.status === "needs_input" ? "completed" : run?.status === "cancelled" ? "interrupted" : "failed";
    this.notify("turn/completed", { threadId, turn: turnView(turnId, status, status === "failed" ? String(run?.output ?? "The turn failed") : null) });
  }

  /** Puts the waiting question to the client; true when it said yes and the turn should go on. */
  private async askApproval(threadId: string, turnId: string): Promise<boolean> {
    const waiting = this.runtime.approvals.waiting(threadId).at(-1);
    if (!waiting) return false;
    const reply = await this.request("item/commandExecution/requestApproval", {
      threadId, turnId, itemId: `${waiting.tool}:${waiting.askedAt}`, reason: waiting.label, command: waiting.tool,
    });
    const decision = DecisionSchema.safeParse(reply.result);
    const allowed = decision.success && (decision.data.decision === "accept" || decision.data.decision === "acceptForSession");
    this.runtime.approve(threadId, allowed ? "allow" : "deny", "session", waiting.fingerprint);
    return allowed;
  }
}

class UnknownMethod extends Error {}

/** `branch app-server`: the protocol over this process's own input and output, while switched on. */
export async function serveAppServerStdio(runtime: Runtime, version: string, options: Partial<AppServerIo> = {}): Promise<void> {
  const log = options.log ?? ((message: string) => void process.stderr.write(`${message}\n`));
  if (askMode(runtime.store, runtime.owner, "app-server") === "off")
    throw new Error("Letting an editor drive Branch over the app-server protocol is switched off. Switch it on in Branch first.");
  await new AppServerConnection(runtime, { input: options.input ?? process.stdin, output: options.output ?? process.stdout, log }, version).serve();
}
