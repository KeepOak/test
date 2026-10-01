import { randomUUID } from "node:crypto";
import { estimateTokens, type Message, type Run, type ToolCall, type ToolDescription } from "./contracts.js";
import type { Store } from "./store.js";

const OMITTED = "[This read-tool result was left out of future model context by the owner. The original receipt remains in the conversation.]";
// Never omit command, write, policy, approval, memory/instruction or audit-tool evidence.
const removableReads = new Set(["files.read", "files.list", "files.search", "files.grep", "files.glob", "web.search", "web.fetch", "knowledge.search"]);
const protectedEvidence = /\b(policy|approval|approved|audit|governance|instructions|standing rules|security|agents\.md|claude\.md|system\.md)\b/i;
interface Item { callId: string; name: string; tokens: number; removable: boolean; excluded: boolean }
interface Snapshot {
  requestId: string; runId: string; sessionId: string; owner: string; at: string; model: string;
  limit: number; estimated: number; reported: number | null; categories: { name: string; tokens: number }[];
  definitions: { name: string; tokens: number }[]; items: Item[]; exclusions: string[]; totalItems: number; totalDefinitions: number;
}
const key = (sessionId: string) => `context-result-exclusions:${sessionId}`;
function exclusions(store: Store, owner: string, sessionId: string): Set<string> {
  const values = store.get("settings", owner, key(sessionId))?.data.callIds;
  return new Set(Array.isArray(values) ? values.filter((v): v is string => typeof v === "string").slice(0, 1000) : []);
}
function calls(messages: Message[]): Map<string, ToolCall | null> {
  const result = new Map<string, ToolCall | null>();
  for (const message of messages) for (const call of message.toolCalls ?? [])
    result.set(call.id, result.has(call.id) ? null : call);
  return result;
}
function mayOmit(message: Message, call: ToolCall | null | undefined): boolean {
  return message.role === "tool" && !!call && removableReads.has(call.name)
    && !protectedEvidence.test(call.arguments) && !protectedEvidence.test(message.content);
}

/** Metadata only, bounded per-process snapshots of actual final request copies; no transcript edits. */
export class ContextAudit {
  private readonly latest = new Map<string, Snapshot>();
  clear(sessionId: string): void { this.latest.delete(sessionId); }
  prepare(store: Store, run: Run, messages: Message[]): Message[] {
    const out = exclusions(store, run.owner, run.sessionId), names = calls(messages);
    return messages.map((m) => out.has(m.toolCallId ?? "") && mayOmit(m, names.get(m.toolCallId ?? ""))
      ? { ...m, content: OMITTED } : m);
  }
  capture(store: Store, run: Run, messages: Message[], tools: ToolDescription[], model: string, limit: number): string {
    const names = calls(messages), out = exclusions(store, run.owner, run.sessionId);
    const categories = ["system", "user", "assistant", "tool"].map((role) => {
      const items = messages.filter((m) => m.role === role);
      return { name: role, tokens: items.length ? estimateTokens(items) : 0 };
    });
    categories.push({ name: "tool definitions", tokens: tools.length ? estimateTokens(tools) : 0 });
    const results = messages.filter((m) => m.role === "tool" && m.toolCallId);
    const snapshot: Snapshot = {
      requestId: randomUUID(), runId: run.id, sessionId: run.sessionId, owner: run.owner, at: new Date().toISOString(), model,
      limit, estimated: estimateTokens({ messages, tools }), reported: null, categories,
      definitions: tools.slice(0, 1024).map((tool) => ({ name: tool.name, tokens: estimateTokens(tool) })),
      items: results.slice(0, 512).map((m) => {
        const call = names.get(m.toolCallId!);
        return { callId: m.toolCallId!, name: call?.name ?? "Unknown or ambiguous tool", tokens: estimateTokens(m),
          removable: mayOmit(m, call), excluded: out.has(m.toolCallId!) };
      }), exclusions: [...out], totalItems: results.length, totalDefinitions: tools.length,
    };
    this.latest.delete(run.sessionId); this.latest.set(run.sessionId, snapshot);
    if (this.latest.size > 128) this.latest.delete(this.latest.keys().next().value!);
    return snapshot.requestId;
  }
  reported(sessionId: string, requestId: string, input: number | undefined): void {
    const snapshot = this.latest.get(sessionId);
    if (snapshot?.requestId === requestId && input !== undefined && Number.isFinite(input) && input >= 0) snapshot.reported = input;
  }
  read(store: Store, owner: string, sessionId: string) {
    const snapshot = this.latest.get(sessionId);
    const run = store.runs(owner).find((r) => r.sessionId === sessionId);
    if (!snapshot || snapshot.owner !== owner || run?.id !== snapshot.runId) return { available: false as const };
    const out = exclusions(store, owner, sessionId);
    return { available: true as const, ...snapshot, owner: undefined,
      pending: [...out].sort().join("\n") !== [...snapshot.exclusions].sort().join("\n"),
      items: snapshot.items.map((item) => ({ ...item, excluded: out.has(item.callId) })),
      compactions: store.events(snapshot.runId).filter((e) => e.kind === "context.compacted").length,
      basis: snapshot.reported === null ? "estimated final request; engine estimator" : "provider-reported input of this request",
      limitBasis: "engine effective request budget; may be lower than the model's full window" };
  }
  change(store: Store, owner: string, sessionId: string, runId: string, requestId: string, callId: string, out: boolean): void {
    const view = this.read(store, owner, sessionId);
    if (!view.available || view.runId !== runId || view.requestId !== requestId) throw new Error("The model request changed. Refresh the context audit.");
    const item = view.items.find((entry) => entry.callId === callId);
    if (!item?.removable) throw new Error("Policy, approval, audit and other protected evidence cannot be left out.");
    const ids = exclusions(store, owner, sessionId);
    if (out) ids.add(callId); else ids.delete(callId);
    if (ids.size > 1000) throw new Error("This conversation already has 1000 exclusions.");
    store.save("settings", owner, key(sessionId), { callIds: [...ids] });
    store.event(runId, "context.result_exclusion", { callId, tool: item.name, out, requestId, historyRetained: true });
  }
}
