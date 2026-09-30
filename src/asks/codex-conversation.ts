import { createHash } from "node:crypto";
import { currentAccountCall } from "../accounts/context.js";
import type { CompletionRequest } from "../contracts.js";
import { agentPromptFrom } from "../providers/cli-agent.js";

interface ConversationTurn { key: string; signature: string; history: string[]; answer: string; threadId: string | null; busy: boolean }
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** In-memory only, inside one account's app-server; exact transcript growth is required to reuse its thread. */
export class CodexConversations {
  private readonly kept = new Map<string, ConversationTurn>();
  acquire(request: CompletionRequest, model?: string, cwd?: string): { turn: ConversationTurn | null; text: string } {
    const call = currentAccountCall(), full = agentPromptFrom(request);
    if (!call?.owner || !call.sessionId || full.length >= 100_000) return { turn: null, text: full };
    const key = JSON.stringify([call.owner, call.sessionId]);
    const previous = this.kept.get(key);
    // A parallel call never borrows an in-flight thread, even if its transcript matches.
    if (previous?.busy) return { turn: null, text: full };
    const signature = digest([model, cwd, request.tools, request.reasoning, request.programTools]);
    const assistant = previous ? request.messages[previous.history.length] : undefined;
    const continuation = previous?.threadId && previous.signature === signature && request.messages.length > previous.history.length + 1
      && previous.history.every((hash, i) => hash === digest(request.messages[i]))
      && assistant?.role === "assistant" && assistant.content.trim() === previous.answer
      && !assistant.toolCalls?.length ? previous : null;
    const text = continuation ? agentPromptFrom({ ...request, messages: request.messages.slice(continuation.history.length + 1) }) : full;
    if (!previous && this.kept.size >= 64) {
      const idle = [...this.kept].find(([, value]) => !value.busy);
      if (!idle) return { turn: null, text: full };
      this.kept.delete(idle[0]);
    }
    const turn: ConversationTurn = continuation ?? { key, signature, history: [], answer: "", threadId: null, busy: false };
    turn.busy = true;
    this.kept.delete(key); this.kept.set(key, turn);
    return { turn, text };
  }
  finish(turn: ConversationTurn | null, request: CompletionRequest, threadId: string, answer: string): void {
    if (!turn || this.kept.get(turn.key) !== turn) return;
    turn.history = request.messages.map(digest); turn.answer = answer.trim(); turn.threadId = threadId; turn.busy = false;
  }
  discard(turn: ConversationTurn | null): void { if (turn && this.kept.get(turn.key) === turn) this.kept.delete(turn.key); }
  clear(): void { this.kept.clear(); }
}

/** Adapted from Hermes Agent's _notification_scope_ids / _notification_belongs_to_turn (MIT).
 * https://github.com/NousResearch/hermes-agent/blob/a4c31d592b9d8916ffed9ab80ebee48ba428c172/agent/transports/codex_app_server_session.py
 * The upstream checks top-level and nested thread/turn identities before accepting a multiplexed notification.
 */
export function codexNotificationScope(message: Record<string, unknown>): { threadId: string | null; turnId: string | null } {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
  const params = record(message.params), turn = record(params.turn), item = record(params.item);
  const first = (...values: unknown[]): string | null => values.find((value): value is string => typeof value === "string" && !!value) ?? null;
  return { threadId: first(params.threadId, params.thread_id, turn.threadId, turn.thread_id, item.threadId, item.thread_id),
    turnId: first(params.turnId, params.turn_id, turn.id, turn.turnId, item.turnId, item.turn_id) };
}
export function codexNotificationMatches(message: Record<string, unknown>, threadId: string, turnId: string | null): boolean {
  const seen = codexNotificationScope(message);
  return (seen.threadId === null || seen.threadId === threadId) && (seen.turnId === null || turnId === null || seen.turnId === turnId);
}
