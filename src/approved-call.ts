import type { Event, Message, ToolCall } from "./contracts.js";
import { argumentFingerprint } from "./question-fingerprint.js";

/**
 * QA R1: after the owner's yes, the engine runs the exact call it asked about itself, and the model carries on from the
 * real result. It used to ask the model to make the same call again, and a small local model (qwen2.5:7b) did so in about
 * 2 of 11 tries: the rest answered in words or said the fact was saved when it was not. This module only reads the
 * record and the conversation to say which call that is; the runtime runs it through the same gate as any call
 * (src/runtime.ts runApproved), so the yes is still bound to the exact bytes it was given for.
 */

/** The mark a stored result carries while its call has stopped to ask and has not run (Store.askedCall). */
export const notRunMark = '"outcome":"not_run"';

/** The stored result of a call that stopped to ask the person, until it runs or is refused. */
export const notRunResult = JSON.stringify({ ok: false, status: "interrupted", outcome: "not_run",
  error: "Not run: Branch stopped at this call to ask the person. After a yes, Branch runs this exact call itself and its "
    + "result takes the place of this one; after a no, it does not run." });

/** The inner question a call may ask before anything of it runs (src/owner-folders.ts, `beforeExecution`). */
const preflightTool = "files.ownerFolder";

/** A placeholder written for a call that never got a result of its own (src/transcript.ts, Store.askedCall). */
const placeholder = /"outcome":"(unknown|not_run)"/;

export interface ApprovedWork {
  /** The approved call first, then any later call of the same reply that never started, in the model's order. */
  run: ToolCall[];
  /** The approved call already ran (the engine stopped before its result reached the conversation): its outcome. */
  finished: { call: ToolCall; outcome: unknown } | null;
}

const none: ApprovedWork = { run: [], finished: null };

/**
 * The work the engine does itself once `askedId`'s question is answered yes. Nothing when the question was not about
 * that call's own exact bytes (a step asked from inside a tool after it started, marked `policy.execution_unknown`, or
 * one whose bytes differ), when its stored result is no longer the "not run" one (it ran or was refused), or when the
 * conversation does not hold the call.
 */
export function approvedWork(events: readonly Event[], messages: readonly Message[], askedId: string): ApprovedWork {
  const ask = events.filter((event) => event.kind === "policy.ask" && event.data.id === askedId).at(-1);
  if (!ask || events.some((event) => event.kind === "policy.execution_unknown" && event.data.id === askedId)) return none;
  const reply = messages.find((message) => message.role === "assistant" && message.toolCalls?.some((call) => call.id === askedId));
  const calls = reply?.toolCalls ?? [];
  const at = calls.findIndex((call) => call.id === askedId);
  const call = calls[at];
  if (!call) return none;
  const ownBytes = ask.data.name === call.name && ask.data.fingerprint === argumentFingerprint(call.name, call.arguments);
  if (!ownBytes && ask.data.name !== preflightTool) return none;
  const stored = (id: string): string | null => {
    const found = messages.filter((message) => message.role === "tool" && message.toolCallId === id).at(-1);
    return found ? String(found.content ?? "") : null;
  };
  if (!stored(call.id)?.includes(notRunMark)) return none;
  const ended = events.find((event) => event.id > ask.id && event.data.id === call.id
    && (event.kind === "tool.completed" || event.kind === "tool.failed" || event.kind === "tool.stalled"));
  if (ended) return { run: [], finished: { call, outcome: endedOutcome(ended) } };
  const started = new Set(events.filter((event) => event.kind === "tool.started").map((event) => String(event.data.id)));
  const later = calls.slice(at + 1).filter((next) => !started.has(next.id) && placeholder.test(stored(next.id) ?? ""));
  return { run: [call, ...later], finished: null };
}

function endedOutcome(event: Event): unknown {
  if (event.kind === "tool.completed") return { ok: true, result: event.data.result };
  return { ok: false, error: String(event.data.error ?? "The step did not finish") };
}

/** What a model that makes an approved call again is handed: the result of the one the engine already ran. */
export function alreadyRunResult(outcome: unknown): Record<string, unknown> {
  const base = outcome && typeof outcome === "object" && !Array.isArray(outcome) ? outcome as Record<string, unknown> : { result: outcome };
  return { ...base, alreadyRun: true,
    note: "Branch already ran this exact call after the person's yes, so it was not run again. This is that call's result." };
}
