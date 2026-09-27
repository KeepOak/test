import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ToolContext } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import type { FollowUpCarry, Runtime } from "../runtime.js";
import type { Store } from "../store.js";
import { runOrigin, startedFromChat } from "../key-context.js";
import type { Trunk, TrunkRecords } from "./record.js";
import { isPass } from "./room-plan.js";
import { requireTrunkPart } from "./settings.js";
import { StartsElsewhereError } from "./starts-in.js"; // Q44

/**
 * R17-010 (T-10): `trunk.message`, a direct message from one Trunk to another.
 *
 * After Hermes Bot Mode's `message_agent` (hermes-agent `bot-mode.md`, "Bot-to-bot messaging", MIT):
 * - it works only in a Trunk's own conversation, never in a room or an ordinary conversation;
 * - the target is checked against the roster (its @name first, so another Trunk's title cannot
 *   take it over, and a name two Trunks share is refused with the roster);
 * - the sender is written on the message by Branch, not by the model;
 * - delivery is fire-and-forget: the message waits in the target's conversation until it is free,
 *   and the answer comes back to the sender's conversation later;
 * - a failed answer is tried once more, and only when trying again can help;
 * - every message has a receipt, so the owner can see what was sent and what came of it.
 * Branch adds a depth limit, so two Trunks cannot keep each other talking for ever.
 */
export const maxMessageDepth = 3;
/**
 * Integrator (R17-A): the depth alone bounds how long a chain gets, not how wide. One task may send
 * only a few messages, and the whole roster only so many an hour, so a fan-out cannot run up a bill.
 */
export const maxMessagesPerTask = 3;
export const maxMessagesPerHour = 30;
const depthEvent = "trunk.message.depth";
const maxReceipts = 100;
const receiptsKey = "trunk-receipts";
const transient = /time(d)? ?out|rate.?limit|\b429\b|\b5\d\d\b|overloaded|temporar|unavailable|ECONN|network|socket/i;

export interface Receipt {
  id: string;
  kind: "message" | "reply" | "failure";
  from: string;
  to: string;
  /** Where it was delivered, and the exact words, so the task that reads it can be matched. */
  sessionId: string;
  prompt: string;
  /**
   * "waiting": the task that read it stopped to ask the owner a question (mac7/residuals). It is carried
   * on only once the owner presses Answer on its card (`armed`); then their next message in that
   * conversation answers it. "Not now" ends it, and the sender is told.
   */
  status: "queued" | "delivered" | "waiting" | "answered" | "failed";
  /** mac7/residuals (integration): the owner said their next message in this conversation answers it. */
  armed?: boolean;
  depth: number;
  attempts: number;
  runId: string | null;
  /**
   * The task that sent it (for the cap per task); for a reply, the task that answered. The task that
   * reads it carries that task on: its origin and no more than its tools (mac7/outside-review).
   */
  fromRunId?: string | null;
  reply: string | null;
  error: string | null;
  at: string;
  updatedAt: string;
}

/** mac7/residuals (integration): a message waiting on the owner, as its card in the window shows it. */
export interface WaitingMessage { id: string; from: string; to: string; sessionId: string; message: string; armed: boolean }
/** What the sender is told when the owner says "Not now". */
export const notNowAnswer = "its owner chose not to answer it now.";

export const MessageSchema = z.object({
  to: z.string().trim().min(1).max(80).describe("The other Trunk's @name, or its name"),
  message: z.string().trim().min(1).max(4000).describe("What you want to say, in your own words"),
}).strict();

/** Q44: `queueGuard` is optional so a test double with only `followUp` still works. */
export type MessageRuntime = Pick<Runtime, "followUp"> & Partial<Pick<Runtime, "queueGuard">>;

export class TrunkMessages {
  private readonly stopListening: () => void;
  constructor(private readonly store: Store, private readonly owner: string, private readonly records: TrunkRecords,
    private readonly runtime: MessageRuntime) {
    this.stopListening = store.onEvent((runId, kind, data) => this.observe(runId, kind, data));
  }
  close(): void { this.stopListening(); }

  receipts(trunkId?: string): Receipt[] {
    const all = ((this.store.get("settings", this.owner, receiptsKey)?.data as { items?: Receipt[] } | undefined)?.items ?? []);
    return (trunkId ? all.filter((r) => r.from === trunkId || r.to === trunkId) : all).slice().reverse();
  }
  private save(items: Receipt[]): void {
    this.store.save("settings", this.owner, receiptsKey, { items: items.slice(-maxReceipts) });
  }
  private update(id: string, change: Partial<Receipt>): Receipt | undefined {
    const items = this.receipts().reverse();
    const index = items.findIndex((r) => r.id === id);
    if (index < 0) return undefined;
    items[index] = { ...items[index]!, ...change, updatedAt: new Date().toISOString() };
    this.save(items);
    return items[index];
  }

  /** The tool's work: check who is sending and to whom, write the sender on it, and queue it. */
  send(context: ToolContext, input: z.infer<typeof MessageSchema>): { queued: true; receipt: string; to: string; note: string } {
    requireTrunkPart(this.store, this.owner, "messages");
    const sender = this.senderOf(context);
    const target = this.records.resolve(input.to);
    if (target.id === sender.id) throw new Error("A Trunk cannot send a message to itself");
    this.runtime.queueGuard?.(target.chatSessionId); // Q44: refused up front, before any receipt, when it starts elsewhere
    const depth = this.depthOf(context.runId);
    if (depth >= maxMessageDepth)
      throw new Error(`These Trunks have already passed messages ${maxMessageDepth} deep. Answer in your own words instead of sending another.`);
    this.checkRate(context.runId);
    const prompt = `Message from ${sender.name} (@${sender.handle}):\n${input.message}`;
    const receipt = this.deliver("message", sender, target, prompt, depth + 1, context.runId);
    return { queued: true, receipt: receipt.id, to: `@${target.handle}`,
      note: `Sent. @${target.handle} will read it when it is free, and its answer will arrive in this conversation later. Do not wait for it.` };
  }
  /** Only a Trunk's own conversation may send: not a room, not an ordinary conversation. */
  private senderOf(context: ToolContext): Trunk {
    const id = context.agent?.startsWith("trunk:") ? context.agent.slice(6) : "";
    const sender = id ? this.records.find(id) : undefined;
    const run = context.runId ? this.store.run(context.runId) : undefined;
    if (!sender || !run || run.sessionId !== sender.chatSessionId)
      throw new Error("trunk.message works only in a Trunk's own conversation");
    // mac7/chat-source: a chat may be linked to a Trunk's conversation, but whoever is typing there is
    // not the owner, so they cannot set the owner's Trunks talking to each other.
    if (startedFromChat(context, this.store))
      throw new Error("A message from a chat app cannot send between the owner's Trunks. Ask the owner to do it in Branch.");
    return sender;
  }
  private checkRate(runId: string): void {
    const sent = this.receipts().filter((r) => r.kind === "message");
    if (sent.filter((r) => r.fromRunId === runId).length >= maxMessagesPerTask)
      throw new Error(`A Trunk may send at most ${maxMessagesPerTask} messages in one task. Answer with what you have.`);
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    if (sent.filter((r) => r.at >= hourAgo).length >= maxMessagesPerHour)
      throw new Error(`The Trunks have sent ${maxMessagesPerHour} messages to each other in the last hour, which is the most allowed. Answer in your own words instead.`);
  }
  /** The receipt says how deep the task that read it is; the task's own record keeps it once the receipt is gone. */
  private depthOf(runId: string): number {
    const kept = this.store.events(runId).find((event) => event.kind === depthEvent)?.data.depth;
    return this.receipts().find((r) => r.runId === runId)?.depth ?? (typeof kept === "number" ? kept : 0);
  }
  private deliver(kind: Receipt["kind"], from: Trunk, to: Trunk, prompt: string, depth: number, fromRunId: string | null = null): Receipt {
    const now = new Date().toISOString();
    const receipt: Receipt = { id: randomUUID(), kind, from: from.id, to: to.id, sessionId: to.chatSessionId, prompt, status: "queued",
      depth, attempts: 1, runId: null, fromRunId, reply: null, error: null, at: now, updatedAt: now };
    this.save([...this.receipts().reverse(), receipt]);
    try {
      this.runtime.followUp(to.chatSessionId, prompt, null, this.carryFrom(fromRunId));
    } catch (error) {
      // Q44: refused (its Trunk starts on another computer), so the receipt says so instead of waiting for ever.
      this.update(receipt.id, { status: "failed", error: errorText(error).slice(0, 500) });
      throw error;
    }
    return receipt;
  }
  /**
   * mac7/outside-review: a message one Trunk queues for another starts as the task that queued it, not
   * as the owner's own. A task from outside (a schedule, another program, a chat) stays held as that,
   * and a Trunk kept to fewer tools cannot reach more through another Trunk. A task with no record of
   * its tools passes on none.
   */
  private carryFrom(runId: string | null | undefined): FollowUpCarry {
    if (!runId) return {};
    return { originFrom: runId, permissions: runOrigin(this.store, runId).permissions ?? [] };
  }

  /**
   * Q44: a queued message that could not start when its turn came (its Trunk moved to another computer
   * after it was queued). Its receipt fails instead of waiting for ever, and the sender is told why.
   */
  notSent(sessionId: string, prompt: string, reason: string): void {
    const receipt = this.receipts().reverse().find((r) => r.status === "queued" && r.sessionId === sessionId && r.prompt === prompt);
    if (!receipt) return;
    this.update(receipt.id, { status: "failed", error: reason.slice(0, 500) });
    if (receipt.kind === "message") this.answerBack(receipt, "failure", reason);
  }
  /** Follows the task that reads each message, and sends its answer back. */
  private observe(runId: string, kind: string, data: Record<string, unknown>): void {
    if (kind !== "run.started" && kind !== "run.finished" && kind !== "run.continued") return;
    const run = this.store.run(runId);
    if (!run) return;
    // Q050: the task that read a message carries on under its own id once its question is answered, so the message it
    // was waiting on is its again, and its answer goes back when it finishes.
    if (kind === "run.continued") {
      const held = this.receipts().find((r) => r.runId === runId && r.status === "waiting");
      if (held) this.update(held.id, { status: "delivered", armed: false });
      return;
    }
    if (kind === "run.started") {
      const waiting = this.receipts().reverse().find((r) => r.status === "queued" && r.sessionId === run.sessionId && r.prompt === run.prompt)
        ?? this.armedFor(run.sessionId, runId, data); // mac7/residuals (integration)
      if (!waiting) return;
      this.update(waiting.id, { status: "delivered", runId });
      this.store.event(runId, depthEvent, { depth: waiting.depth });
      return;
    }
    const receipt = this.receipts().find((r) => r.runId === runId && r.status === "delivered");
    if (receipt) this.finished(receipt, String(data.status ?? run.status), String(data.output ?? run.output ?? ""));
  }
  /**
   * mac7/residuals (integration): the waiting message the owner pressed Answer on, for the next task in
   * its conversation. Never taken by a chat app's message or a short-lived key's: only the owner answers.
   */
  private armedFor(sessionId: string, runId: string, started: Record<string, unknown>): Receipt | undefined {
    if (started.source === "channel" || started.shortLivedKey === true) return undefined;
    return this.receipts().reverse().find((r) => r.status === "waiting" && r.kind === "message" && r.armed === true
      && r.sessionId === sessionId && r.runId !== runId);
  }
  /** mac7/residuals (integration): messages whose task stopped to ask the owner, oldest first, for their cards. */
  waiting(): WaitingMessage[] {
    const name = (id: string) => this.records.find(id)?.name ?? "A Trunk";
    return this.receipts().reverse().filter((r) => r.status === "waiting" && r.kind === "message").map((r) => ({
      id: r.id, from: name(r.from), to: name(r.to), sessionId: r.sessionId, armed: r.armed === true,
      message: r.prompt.replace(/^Message from [^\n]*\n/, "").slice(0, 300) }));
  }
  /** Answer: the owner's next message in that conversation answers this one (and no other waiting there). */
  answer(id: string): WaitingMessage {
    const receipt = this.waitingReceipt(id);
    for (const other of this.receipts().filter((r) => r.armed && r.sessionId === receipt.sessionId && r.id !== id))
      this.update(other.id, { armed: false });
    this.update(id, { armed: true });
    return this.waiting().find((item) => item.id === id)!;
  }
  /** Not now: the message ends unanswered and its sender is told so, in plain words. */
  decline(id: string): { declined: true } {
    const receipt = this.waitingReceipt(id);
    this.update(id, { status: "failed", armed: false, error: notNowAnswer });
    this.answerBack(receipt, "failure", notNowAnswer);
    return { declined: true };
  }
  private waitingReceipt(id: string): Receipt {
    const receipt = this.receipts().find((r) => r.id === id && r.kind === "message" && r.status === "waiting");
    if (!receipt) throw Object.assign(new Error("That message is not waiting for your answer any more."), { status: 404 });
    return receipt;
  }
  private finished(receipt: Receipt, status: string, output: string): void {
    // mac7/residuals: a task that stopped to ask the owner has not failed. It waits for a yes; its card
    // in the window offers Answer (the owner's next message there carries it on) and Not now.
    if (status === "needs_input") {
      this.update(receipt.id, { status: "waiting" });
      return;
    }
    if (status === "completed") {
      this.update(receipt.id, { status: "answered", reply: output.slice(0, 4000) });
      if (receipt.kind === "message" && !isPass(output)) this.answerBack(receipt, "reply", output);
      return;
    }
    if (receipt.attempts < 2 && transient.test(output)) {
      this.update(receipt.id, { status: "queued", attempts: receipt.attempts + 1, runId: null, error: output.slice(0, 500) });
      try {
        this.runtime.followUp(receipt.sessionId, receipt.prompt, null, this.carryFrom(receipt.fromRunId)); // mac7/outside-review
        return;
      } catch (error) {
        output = errorText(error); // Q44: the retry was refused, so it fails below and the sender is told why
      }
    }
    this.update(receipt.id, { status: "failed", error: output.slice(0, 500) });
    if (receipt.kind === "message") this.answerBack(receipt, "failure", output);
  }
  private answerBack(receipt: Receipt, kind: "reply" | "failure", output: string): void {
    const from = this.records.find(receipt.to), to = this.records.find(receipt.from);
    if (!from || !to || receipt.depth >= maxMessageDepth) return;
    const prompt = kind === "reply"
      ? `Reply from ${from.name} (@${from.handle}) to your message:\n${output.slice(0, 4000)}`
      : `Your message to @${from.handle} could not be answered: ${output.slice(0, 300)}`;
    // mac7/outside-review: sent as the task that answered. Q44: this runs as a task finishes, so an answer
    // refused because the sender now starts on another computer stays a failed receipt and is never thrown.
    try { this.deliver(kind, from, to, prompt, receipt.depth, receipt.runId); } catch (error) {
      if (!(error instanceof StartsElsewhereError)) throw error; // deliver marked it failed; anything else is not ours to hide
    }
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function registerTrunkMessage(registry: ToolRegistry, messages: TrunkMessages): void {
  registry.register({
    name: "trunk.message", permission: "trunks.message", group: "trunks", parameters: MessageSchema,
    description: "Send a message to another of the owner's Trunks by its @name. Only in a Trunk's own conversation. The answer arrives later in this conversation; do not wait for it.",
    target: (args) => `@${args.to.replace(/^@/, "")}`,
    execute: async (args, context) => messages.send(context, args),
  });
}
