import { runOrigin } from "./key-context.js";
import type { Run } from "./contracts.js";
import type { CarryOnHooks, Runtime } from "./runtime.js";

/**
 * QA R1 follow-up: after a yes given anywhere but the window's card (a chat app's button, reaction or /approve, the
 * terminal, an editor over ACP or the app-server protocol, a room), the task that asked is carried on as itself, so the
 * engine runs the approved call (src/runtime.ts runApproved) rather than asking the model to make it again in a new turn.
 * The window's own card goes through src/server.ts settleAsked, which keeps its owner-only rules.
 */

/**
 * The waiting task a yes (or a No) may carry on: still waiting, with nothing else waiting in its conversation, the newest
 * task there, and started from `source` (a chat's yes never carries on the owner's own task, nor an editor's a chat's).
 * The window's own guards hold here too (src/server.ts carryOnAllowed): never a helper's task, never while a plan waits
 * on the owner's answer (carrying on would read as agreeing to it), and never after words were written in the
 * conversation since the task stopped (a routine's note would be read as the answer).
 */
export function carryable(runtime: Runtime, runId: string | undefined, source: string): Run | null {
  if (!runId) return null;
  const run = runtime.store.run(runId);
  if (!run || run.status !== "needs_input" || run.owner !== runtime.owner) return null;
  if (runtime.approvals.waiting(run.sessionId).length) return null;
  if (runtime.store.newestIn(run.owner, run.sessionId)?.id !== run.id) return null;
  const origin = runOrigin(runtime.store, run.id);
  if (origin.source !== source || origin.parentRunId) return null;
  const plan = runtime.orchestration.plan(run.sessionId);
  if (plan && (!plan.approved || (plan.waitingOnOwner && plan.runId !== run.id))) return null;
  const stopped = runtime.store.events(run.id).filter((event) => event.kind === "run.stopped_to_ask").at(-1)?.data.lastMessageId;
  return typeof stopped === "number" && runtime.store.lastMessageId(run.sessionId) === stopped ? run : null;
}

/** Carries the answered task on: after a yes the engine runs the approved call; after a No the task is told so (D5). */
export function carryOn(runtime: Runtime, run: Run, answer: { decision: "allow" | "deny"; fingerprint: string }, hooks: CarryOnHooks = {}): Promise<Run> {
  return answer.decision === "allow" ? runtime.continueAsked(run.id, hooks) : runtime.continueRefused(run.id, answer.fingerprint, hooks);
}
