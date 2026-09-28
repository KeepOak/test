import type { createBranch } from "./index.js";
import { mayAnswerHere } from "./household-approvals.js";
import { startedWithShortLivedKey } from "./key-context.js";

type Branch = Awaited<ReturnType<typeof createBranch>>;

/**
 * Pass 17 (Helpers): a helper's question (a task another task started, "run.started" parentRunId) names the task that
 * started it. It is answered in that task's Activity › Helpers, so the window keeps it out of the Inbox's counts and list.
 * Only a task that exists counts: the learning passes mark their own rows "learning".
 */
export function helperMark(app: Branch, runId: string): { parentRunId?: string } {
  const parent = app.store.events(runId).find((event) => event.kind === "run.started")?.data.parentRunId;
  return typeof parent === "string" && app.store.run(parent) ? { parentRunId: parent } : {};
}

/**
 * Q050: how many things wait for the person at the window, counted once each. The one number the sidebar's Inbox, the
 * Inbox's Needs you, Overview's "Answer N waiting" and Health all read (GET /api/state needsYou, src/health.ts):
 * each conversation's newest task waiting on them (store.waitingRuns, as the attention list reads it), every approval
 * question still open, and the Trunk messages waiting on the owner. A task and its own open question are one thing,
 * a helper's question is answered inside its task, and a task another has overtaken in its conversation is not counted.
 */
export function needsYou(app: Branch): number {
  const owner = app.store.profiles.isOwner();
  const runs = owner ? app.store.waitingRuns(app.runtime.owner)
    : app.store.waitingRuns(app.store.profiles.scope()).filter((run) => mayAnswerHere(app.store, { runId: run.id, sessionId: run.sessionId }));
  const counted = new Set<string>(), sessions = new Set<string>();
  const count = (key: string, sessionId: string) => { counted.add(key); sessions.add(sessionId); };
  for (const run of runs) if (!helperMark(app, run.id).parentRunId) count(run.id, run.sessionId);
  for (const asked of app.runtime.approvals.waiting()) {
    if (!mayAnswerHere(app.store, asked) || helperMark(app, asked.runId).parentRunId) continue;
    count(asked.runId || `${asked.sessionId}\u0000${asked.fingerprint}`, asked.sessionId);
  }
  // A Trunk's message waits because the task reading it stopped to ask: counted once, with that task.
  const messages = owner && !startedWithShortLivedKey()
    ? app.trunks.messages.waiting().filter((message) => !sessions.has(message.sessionId)).length : 0;
  const autonomy = owner && !startedWithShortLivedKey() ? app.autonomy.ledger.pendingCount() : 0;
  return counted.size + messages + autonomy;
}
