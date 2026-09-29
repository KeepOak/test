import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { errorText, type Run } from "./contracts.js";
import type { Runtime } from "./runtime.js";
import { carryable } from "./carry-on.js"; // QA R1 follow-up
import type { Store } from "./store.js";
import { conversationBegunBy, notYourConversation } from "./outside-origin.js";

/**
 * ACP, the protocol code editors use to talk to an assistant they start themselves. Branch speaks it
 * on standard input and output, so an editor such as Zed can open a conversation, send a request and
 * watch the answer arrive word by word. When a step needs the person's yes, the editor is asked and
 * its answer is given to the approval rules, so the same question a person would see in Branch is
 * the one the editor shows. Everything meant for a person goes to standard error; standard output
 * carries the protocol only.
 */
export const ACP_PROTOCOL_VERSION = 1;
const MAX_APPROVALS = 8;

const MessageSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().min(1).max(200).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number(), message: z.string() }).partial().optional(),
}).passthrough();
const PromptSchema = z.object({
  sessionId: z.string().min(1).max(200),
  prompt: z.array(z.record(z.string(), z.unknown())).min(1).max(50),
}).passthrough();
const SessionIdSchema = z.object({ sessionId: z.string().min(1).max(200) }).passthrough();
const OutcomeSchema = z.object({
  outcome: z.union([
    z.object({ outcome: z.literal("selected"), optionId: z.string().max(100) }),
    z.object({ outcome: z.literal("cancelled") }),
  ]),
}).passthrough();

/** Only written words come in from the editor; an attached file or image is refused in plain words. */
export function promptText(parts: Record<string, unknown>[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.type !== "text") throw new Error("Branch takes written instructions only; attachments are not read");
    texts.push(String(part.text ?? ""));
  }
  const text = texts.join("\n").trim();
  if (!text) throw new Error("The request was empty");
  return text;
}

export interface AcpIo { input: Readable; output: Writable; log: (message: string) => void }

export class AcpConnection {
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly runs = new Map<string, string>();
  private nextId = 1;
  private initialized = false;
  constructor(private readonly runtime: Runtime, private readonly store: Store, private readonly io: AcpIo) {}

  private write(message: Record<string, unknown>): void { this.io.output.write(`${JSON.stringify(message)}\n`); }
  notify(method: string, params: Record<string, unknown>): void { this.write({ jsonrpc: "2.0", method, params }); }

  /** Asks the editor something and waits for its reply, keyed by the id we sent it with. */
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Reads until the editor closes the connection; each message is handled without holding the loop. */
  async serve(): Promise<void> {
    this.io.log("Branch is ready for a code editor on standard input. Close it or press Ctrl+C to stop.");
    const lines = createInterface({ input: this.io.input, crlfDelay: Infinity });
    // A line Branch cannot make sense of is reported and skipped; it never stops the connection.
    for await (const line of lines)
      if (line.trim()) void this.accept(line).catch((error: unknown) => this.io.log(errorText(error)));
    for (const waiting of this.pending.values()) waiting.reject(new Error("The editor disconnected"));
    this.pending.clear();
    this.io.log("The editor disconnected. Branch is stopping.");
  }

  /** One line in: a reply to something we asked, a notification to act on, or a request to answer. */
  async accept(line: string): Promise<void> {
    let parsed: z.infer<typeof MessageSchema>;
    try { parsed = MessageSchema.parse(JSON.parse(line)); }
    catch { this.write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    if (!parsed.method) { this.settle(parsed); return; }
    if (parsed.id === undefined) { await this.onNotification(parsed.method, parsed.params ?? {}); return; }
    try {
      this.write({ jsonrpc: "2.0", id: parsed.id, result: await this.onRequest(parsed.method, parsed.params ?? {}) });
    } catch (error) {
      this.write({ jsonrpc: "2.0", id: parsed.id, error: { code: -32000, message: errorText(error) } });
    }
  }

  private settle(message: z.infer<typeof MessageSchema>): void {
    const waiting = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
    if (!waiting || typeof message.id !== "number") return;
    this.pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error.message ?? "The editor refused"));
    else waiting.resolve(message.result);
  }

  private async onNotification(method: string, params: Record<string, unknown>): Promise<void> {
    if (method !== "session/cancel") return;
    const { sessionId } = SessionIdSchema.parse(params);
    const runId = this.runs.get(sessionId);
    if (runId) this.runtime.cancel(runId);
  }

  private async onRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "initialize") return this.initialize();
    if (method === "authenticate") return {};
    if (!this.initialized) throw new Error("Say hello with initialize first");
    if (method === "session/new") return { sessionId: this.newSession() };
    if (method === "session/prompt") return this.prompt(PromptSchema.parse(params));
    if (method === "session/cancel") { await this.onNotification(method, params); return {}; }
    throw new Error(`Branch does not know the request "${method}"`);
  }

  private initialize(): unknown {
    this.initialized = true;
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: false, audio: false, embeddedContext: false } },
      authMethods: [],
    };
  }

  /** A conversation the editor can come back to, made the same way the app makes one. */
  private newSession(): string {
    const opened = this.store.createRun(this.runtime.owner, "Code editor session opened", undefined, false, "acp");
    this.store.finish(opened.id, "completed", "Session opened");
    return opened.sessionId;
  }

  /**
   * One turn: the answer streams to the editor as it is written. If a step needs the person's yes,
   * the editor is asked, its answer goes to the approval rules, and the turn carries on.
   */
  private async prompt(params: z.infer<typeof PromptSchema>): Promise<{ stopReason: string }> {
    const { sessionId } = params;
    if (!this.store.ownsSession(this.runtime.owner, sessionId)) throw new Error("That conversation is not one of Branch's");
    // mac7/residuals: only a conversation an editor opened here (session/new); never the owner's own.
    if (conversationBegunBy(this.store, sessionId) !== "acp") throw new Error(notYourConversation);
    let prompt = promptText(params.prompt);
    let carry: string | null = null;
    for (let round = 0; round <= MAX_APPROVALS; round++) {
      // QA R1 follow-up: after the editor's yes, the task that asked carries on and the engine runs the approved call.
      const run: Run = carry ? await this.carried(sessionId, carry) : await this.turn(sessionId, prompt);
      if (run.status === "cancelled") return { stopReason: "cancelled" };
      if (run.status !== "needs_input") return { stopReason: run.status === "completed" ? "end_turn" : "refusal" };
      const allowed = await this.askPermission(sessionId);
      if (allowed === null) return { stopReason: "end_turn" };
      if (!allowed) return { stopReason: "refusal" };
      carry = carryable(this.runtime, run.id, "acp")?.id ?? null;
      if (!carry) prompt = "Go ahead with the step you were waiting on."; // a task that can no longer be carried on
    }
    return { stopReason: "max_turn_requests" };
  }

  private async carried(sessionId: string, runId: string): Promise<Run> {
    return this.runtime.continueAsked(runId, {
      onStarted: (run) => { this.runs.set(sessionId, run.id); },
      onTextDelta: (text) => { if (text) this.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } }); },
    });
  }
  private async turn(sessionId: string, prompt: string): Promise<Run> {
    return this.runtime.run({
      prompt, sessionId, source: "acp",
      onStarted: (run) => { this.runs.set(sessionId, run.id); },
      onTextDelta: (text) => { if (text) this.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } }); },
    });
  }

  /**
   * Puts the question the task stopped on to the editor. `null` means it was not a question about
   * permission at all — the assistant asked the person something, and that is the turn's answer.
   */
  private async askPermission(sessionId: string): Promise<boolean | null> {
    const waiting = this.runtime.approvals.waiting(sessionId).at(-1);
    if (!waiting) return null;
    const answer = OutcomeSchema.parse(await this.request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: `${waiting.tool}:${waiting.askedAt}`, title: waiting.label, kind: "other", status: "pending" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Do not allow", kind: "reject_once" },
      ],
    }));
    const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId === "allow";
    // Bound to the exact request the editor was shown, the same as every other answer route.
    this.runtime.approve(sessionId, allowed ? "allow" : "deny", "session", waiting.fingerprint);
    return allowed;
  }
}

/** Runs ACP over this process's own standard input and output, for `branch acp-serve`. */
export async function serveAcpStdio(
  runtime: Runtime,
  store: Store,
  options: Partial<AcpIo> = {},
): Promise<void> {
  const io: AcpIo = {
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
    log: options.log ?? ((message: string) => void process.stderr.write(`${message}\n`)),
  };
  await new AcpConnection(runtime, store, io).serve();
}
