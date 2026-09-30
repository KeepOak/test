import type { Message, ToolCall } from "../contracts.js";

/**
 * mac7/r17-g (R17-067): the copy of a conversation that is about to be sent, tidied so a model
 * service does not refuse it. The kept conversation is never changed; only what is sent.
 *
 * Always, when the part is not off (the problems services refuse outright):
 *  - a tool result with no call before it, or arriving after the next answer, is dropped;
 *  - a second result for the same call is dropped;
 *  - a call made twice under the same id in one message keeps its first copy;
 *  - a call with no result gets a stand-in result saying the outcome is unknown;
 *  - a note that landed between two results is moved after them.
 * Only with the part "on" (tidier, but not needed by most services):
 *  - an empty answer with no calls is dropped;
 *  - two messages in a row from the person, or two plain answers in a row, are joined.
 *
 * The idea follows OpenFang's `session_repair.rs` (MIT or Apache-2.0); the code is written here.
 */
export type RepairLevel = "needed" | "full";
export interface Repaired { messages: Message[]; fixes: string[] }

const standIn = (call: ToolCall): Message => ({
  role: "tool", toolCallId: call.id,
  content: JSON.stringify({ ok: false, status: "interrupted", outcome: "unknown",
    error: "No result was kept for this step. It may or may not have happened; check before trying again." }),
});

/** One assistant message's calls with repeated ids taken out. */
function uniqueCalls(message: Message, fixes: string[]): Message {
  if (!message.toolCalls?.length) return message;
  const seen = new Set<string>();
  const calls = message.toolCalls.filter((call) => (seen.has(call.id) ? false : (seen.add(call.id), true)));
  if (calls.length === message.toolCalls.length) return message;
  fixes.push(`dropped ${message.toolCalls.length - calls.length} repeated call(s)`);
  return { ...message, toolCalls: calls };
}

/**
 * Pairs every call with exactly one result, straight after the message that made it. A note from
 * the person or the app that landed between two results (a picture a tool showed) is moved to just
 * after the last of them, because services want the results together.
 *
 * A call id belongs to the message that made it. Local models (Ollama, LM Studio and others) number their calls afresh in
 * every answer ("call_0" each time), so the same id in a later answer is a new call with its own real result; which ids
 * were answered is kept per answer, never for the whole conversation, or that real result would be dropped as a second one.
 */
function pairResults(messages: readonly Message[], fixes: string[]): Message[] {
  const out: Message[] = [];
  let open = new Map<string, ToolCall>();
  let held: Message[] = [];
  const answered = new Set<string>();
  /** `moved` when a result came after the held messages, so they really change place. */
  const flush = (moved: boolean) => {
    if (held.length && moved) fixes.push(`moved ${held.length} message(s) after the results they interrupted`);
    out.push(...held); held = [];
  };
  let movedAny = false;
  const close = () => {
    for (const call of open.values()) { out.push(standIn(call)); fixes.push(`added a stand-in result for ${call.name}`); }
    open = new Map();
    flush(movedAny);
    movedAny = false;
  };
  for (const original of messages) {
    if (original.role === "tool") {
      const id = original.toolCallId ?? "";
      if (open.delete(id)) {
        answered.add(id); out.push(original);
        movedAny ||= held.length > 0;
        if (!open.size) { flush(movedAny); movedAny = false; }
      }
      else fixes.push(answered.has(id) ? "dropped a second result for one call" : "dropped a result with no call before it");
      continue;
    }
    if (original.role !== "assistant" && open.size) { held.push(original); continue; }
    close();
    const message = original.role === "assistant" ? uniqueCalls(original, fixes) : original;
    if (message.role === "assistant") answered.clear(); // a new answer: its ids are its own
    for (const call of message.toolCalls ?? []) open.set(call.id, call);
    out.push(message);
  }
  close();
  return out;
}

const plainAnswer = (message: Message): boolean => message.role === "assistant" && !message.toolCalls?.length;

/** Drops empty answers and joins two in a row from the same side. */
function joinRuns(messages: readonly Message[], fixes: string[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    if (plainAnswer(message) && !message.content.trim()) { fixes.push("dropped an empty answer"); continue; }
    const last = out[out.length - 1];
    const sameSide = last && ((last.role === "user" && message.role === "user") || (plainAnswer(last) && plainAnswer(message)));
    if (!last || !sameSide) { out.push(message); continue; }
    const images = [...(last.images ?? []), ...(message.images ?? [])];
    out[out.length - 1] = { ...last, content: `${last.content}\n\n${message.content}`, ...(images.length ? { images } : {}) };
    fixes.push(`joined two ${message.role === "user" ? "messages from you" : "answers"} in a row`);
  }
  return out;
}

export function repairHistory(messages: readonly Message[], level: RepairLevel): Repaired {
  const fixes: string[] = [];
  const paired = pairResults(messages, fixes);
  const result = level === "full" ? joinRuns(paired, fixes) : paired;
  return { messages: fixes.length ? result : [...messages], fixes };
}
