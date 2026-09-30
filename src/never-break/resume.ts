import { describeToolCall } from "../activity.js";
import type { FeatureMode } from "../feature-switches.js";
import type { Runtime } from "../runtime.js";
import type { Run } from "../contracts.js";
import { outsideSourceOf } from "../outside-origin.js";
import { runOrigin } from "../key-context.js"; // bucket 19 (integration review)
import { withRecoveryContext } from "./recovery-context.js";
import { recordedRecoveryPerson } from "./recorded-person.js";
import { underProject } from "../project-scope.js";
import { defaultProjectId } from "../projects.js";
import { asPerson, currentPerson } from "../people/context.js"; // bucket 19 (integration review)
import { scopeOf } from "../tool-gate.js";
import type { Store } from "../store.js";
import { checkEvidence, evidenceFor, type OpenStep, type TaskJournal } from "./journal.js";
import { unlinkedTeamParent } from "../team-reconcile.js"; // Q63

/**
 * After a restart: what to do with each task that was cut off. Finished steps are never repeated
 * (when the restart came before their result was saved, the conversation is told they finished). A
 * step the model asked for that never started (its intent is in the journal, nothing more) is done
 * now when the task carries on by itself and the approval policy allows it without asking; otherwise
 * the conversation is told it has not been done, so it is asked for again through the usual approval.
 * Steps are settled in order, and once one is left undecided the ones after it are not run. A task
 * whose calls were never written as intents (from a version before them) is handled as before. A step
 * that was in flight is
 *
 * - done again when it changes nothing, or gives the same result however often it runs;
 * - checked when it left something to check (a file's contents, a repository's commit): if it took
 *   effect the conversation says so, and if it did not it is done now;
 * - otherwise put to the owner, because it may already have reached someone ("this may have already
 *   sent the email — check or send again?").
 *
 * Then the task carries on by itself (switch on), or is offered to the owner (when needed). A task a
 * chat app started is left for that app, which sends the message again. See docs/never-break.md.
 */
export type StepDecision = "redo" | "done" | "not-done" | "ask" | "not-started";
export type RecoveryOutcome = "resumed" | "offered" | "asked" | "left-for-chat" | "left-for-team" | "gone";
export interface RecoveredRun { runId: string; outcome: RecoveryOutcome; steps: { tool: string; decision: StepDecision }[]; resumed?: Promise<unknown> }

export interface RecoveryInput {
  store: Store;
  runtime: Runtime;
  journal: TaskJournal;
  mode: FeatureMode;
  /** True after the gateway saw a crash loop: nothing carries on by itself. */
  askOnly?: boolean;
  /** Steps older than this are not carried on; the owner can still continue the task by hand. */
  maxAgeMs?: number;
  /** Only these tasks (the self-test settles its own made-up task and leaves the owner's alone). */
  only?: ReadonlySet<string>;
}

export async function decideStep(step: OpenStep): Promise<StepDecision> {
  if (step.state === "intent") return "not-started";
  if (step.effects === "none") return "redo";
  const checked = await checkEvidence(step.evidence);
  if (checked === "done") return "done";
  if (checked === "not-done") return "not-done";
  return step.effects === "idempotent" ? "redo" : "ask";
}

/**
 * The result the conversation holds for this call (usually the "unknown" one written at start-up), replaced with what is now known.
 * With `onlyUnknown`, a result that is not the start-up "unknown" one is left as it is.
 */
export function replaceResult(store: Store, sessionId: string, callId: string, content: Record<string, unknown>, onlyUnknown = false): boolean {
  const rows = store.sqlite.prepare("SELECT id, body FROM messages WHERE session_id=? ORDER BY id DESC").all(sessionId);
  for (const row of rows) {
    const body = JSON.parse(String(row.body)) as { role?: string; toolCallId?: string; content?: string };
    if (body.role !== "tool" || body.toolCallId !== callId) continue;
    if (onlyUnknown && !String(body.content ?? "").includes('"outcome":"unknown"')) return false;
    store.sqlite.prepare("UPDATE messages SET body=? WHERE id=?").run(JSON.stringify({ ...body, content: JSON.stringify(content) }), Number(row.id));
    return true;
  }
  return false;
}

/** True when the conversation holds the model's request for this call. */
function inConversation(store: Store, sessionId: string, callId: string): boolean {
  const rows = store.sqlite.prepare("SELECT body FROM messages WHERE session_id=? ORDER BY id DESC").all(sessionId);
  return rows.some((row) => {
    const body = JSON.parse(String(row.body)) as { role?: string; toolCalls?: { id?: string }[] };
    return body.role === "assistant" && (body.toolCalls ?? []).some((call) => call.id === callId);
  });
}
const unknownOutcome = { ok: false, status: "interrupted", outcome: "unknown",
  error: "Branch was restarted while this step ran and it may already have taken effect. The owner has been asked; check the actual state before doing it again." };

async function redo(input: RecoveryInput, runId: string, step: OpenStep): Promise<boolean> {
  // bucket 19 (integration review): a household person's step is done again as that person, held to their role.
  const person = runOrigin(input.store, runId).personProfileId;
  if (person && !currentPerson()) return asPerson({ profileId: person, keyId: "resumed" }, () => redoStep(input, runId, step));
  return redoStep(input, runId, step);
}

async function redoStep(input: RecoveryInput, runId: string, step: OpenStep): Promise<boolean> {
  // Arguments with something secret hidden in them are not the ones the model asked for.
  if (step.redacted) return false;
  let args: unknown;
  try { args = JSON.parse(step.arguments); } catch { return false; }
  try {
    return await withRecoveryContext(input, runId, async (context) => {
      context.signal.throwIfAborted();
      const check = input.runtime.checkPolicy(step.tool, args, context);
      if (check.decision !== "allow") return false;
      // Q63: the call done again is recorded like any other call, under the run it is done for, so what
      // that run did can be read back (a team task settles from these records, src/team-reconcile.ts).
      const recorded = { name: step.tool, id: step.callId, redone: true };
      input.store.event(runId, "tool.started", { ...recorded, label: label(step) });
      try {
        // mac5/manual-actions: redone where the rule and the owner's wall say, as the first attempt was.
        const result = await input.runtime.registry.execute(step.tool, args, { ...context, ...scopeOf(input.runtime, step.tool, args, context, check) });
        context.signal.throwIfAborted();
        const shown = input.runtime.hideSecrets(result);
        const receipt = await input.store.receipts.sign(runId, step.callId, step.tool, shown);
        context.signal.throwIfAborted();
        input.store.event(runId, "tool.completed", { ...recorded, result: shown, receipt });
        return replaceResult(input.store, step.sessionId, step.callId, { ok: true, result, status: "redone",
          note: "Branch was restarted while this step ran; it changes nothing or gives the same result every time, so it was simply done again." });
      } catch (error) {
        input.store.event(runId, "tool.failed", { ...recorded, error: input.runtime.hideSecrets(error instanceof Error ? error.message : String(error)) });
        return false;
      }
    });
  } catch (error) {
    const reason = input.runtime.hideSecrets(error instanceof Error ? error.message : String(error));
    input.store.event(runId, "recovery.context_unavailable", { callId: step.callId, reason });
    input.store.finish(runId, "needs_input", reason);
    input.store.event(runId, "attention.needed", { question: reason, afterRestart: true });
    input.runtime.notifyEvent("approval.needed", { runId, question: reason });
    return false;
  }
}

function checkRecovery(input: RecoveryInput, runId: string): void {
  const signal = input.runtime.activeRunSignal(runId);
  if (!signal) throw new Error("The interrupted recovery was stopped or paused.");
  signal.throwIfAborted();
}

const label = (step: OpenStep): string => {
  try { return describeToolCall(step.tool, JSON.parse(step.arguments)); } catch { return step.tool; }
};

/** A call that was asked for but never started: done now if allowed, otherwise the conversation says it has not been done. */
async function settleNotStarted(input: RecoveryInput, runId: string, step: OpenStep, runNow: boolean): Promise<boolean> {
  // Cut off before the conversation held the request: the model is asked again when the task goes on.
  if (!inConversation(input.store, step.sessionId, step.callId)) { input.journal.finish(step.id, "not-started"); return true; }
  if (runNow) {
    let args: unknown = null;
    try { args = JSON.parse(step.arguments); } catch { /* redo refuses it */ }
    const evidence = step.effects === "none" ? null : await withRecoveryContext(input, runId, (context) => evidenceFor(step.tool, args, context.workspace)).catch(() => null);
    const signal = input.runtime.activeRunSignal(runId);
    if (!signal) throw new Error("Recovery was stopped before its journal retry.");
    signal.throwIfAborted();
    let started = false;
    try { input.journal.start(step.id, evidence); started = true; } catch { /* not written down, so not done */ }
    if (started && await redo(input, runId, { ...step, evidence, state: "started" })) {
      input.journal.finish(step.id, "redone");
      return true;
    }
    // Started in the journal but not run: it is closed here, since nothing happened.
  }
  replaceResult(input.store, step.sessionId, step.callId, { ok: false, status: "not-done",
    note: "Branch was restarted before this step started. It has not been done; ask for it again if it is still needed." });
  input.journal.finish(step.id, "not-started");
  return false;
}

/** Settles one step; `settled` is false when it was left for the model or the owner, so later steps wait. */
async function settleStep(input: RecoveryInput, runId: string, step: OpenStep, carryOn: boolean): Promise<{ decision: StepDecision; settled: boolean }> {
  const decision = await decideStep(step);
  if (carryOn) checkRecovery(input, runId);
  if (decision === "not-started") return { decision, settled: await settleNotStarted(input, runId, step, carryOn) };
  if (decision === "done") {
    replaceResult(input.store, step.sessionId, step.callId, { ok: true, status: "verified",
      note: "Branch was restarted while this step ran. It had already taken effect (checked), so it was not done again." });
    input.journal.finish(step.id, "verified");
    return { decision, settled: true };
  }
  if (decision === "not-done" || decision === "redo") {
    const done = carryOn && await redo(input, runId, step);
    if (carryOn) checkRecovery(input, runId);
    if (done) input.journal.finish(step.id, "redone");
    else if (decision === "redo") input.journal.finish(step.id, "abandoned");
    else {
      replaceResult(input.store, step.sessionId, step.callId, { ok: false, status: "not-done",
        note: "Branch was restarted before this step took effect (checked). It is safe to do it again." });
      input.journal.finish(step.id, "verified");
    }
    return { decision, settled: done };
  }
  replaceResult(input.store, step.sessionId, step.callId, unknownOutcome);
  input.journal.finish(step.id, "asked");
  return { decision, settled: false };
}

/** Steps that finished before the restart but whose result never reached the conversation: it is told they finished. */
function noteFinishedWithoutResult(input: RecoveryInput, run: { id: string; sessionId: string }): void {
  for (const step of input.journal.steps(run.id)) {
    if (step.kind !== "tool" || step.state !== "finished" || !step.callId) continue;
    replaceResult(input.store, run.sessionId, step.callId, { ok: true, status: "finished",
      note: "This step finished just before Branch was restarted, so its result was not kept. It was not done again." }, true);
  }
}

function askOwner(input: RecoveryInput, runId: string, steps: OpenStep[]): void {
  const what = steps.map(label).join("; ");
  const question = `Branch was stopped while it was ${what.charAt(0).toLowerCase()}${what.slice(1)}. That may already have happened. Should I check first and carry on, or do it again? Reply "check and carry on" or "do it again".`;
  input.store.finish(runId, "needs_input", question);
  input.store.event(runId, "attention.needed", { question, afterRestart: true });
  input.runtime.notifyEvent("approval.needed", { runId, question });
}

async function recoverRun(input: RecoveryInput, runId: string, steps: OpenStep[]): Promise<RecoveredRun> {
  const run = input.store.run(runId);
  const tooOld = steps.length > 0 && steps.every((step) => Date.now() - Date.parse(step.startedAt) > (input.maxAgeMs ?? 86_400_000));
  if (!run || run.status !== "interrupted" || tooOld) {
    for (const step of steps) input.journal.finish(step.id, "abandoned");
    return { runId, outcome: "gone", steps: [] };
  }
  // Q63: a team task's own turn that the task never named is ended, not carried on: nothing could trace it.
  if (unlinkedTeamParent(input.store, run.sessionId)) {
    for (const step of steps) input.journal.finish(step.id, "abandoned");
    input.store.finish(runId, "cancelled", "Branch stopped before this team turn was linked to its task, so it was not carried on. Send the request again with a new request id.");
    return { runId, outcome: "left-for-team", steps: [] };
  }
  const inbound = input.store.events(runId).find((event) => event.kind === "channel.inbound");
  const reached = inbound ? mayHaveReachedOutside(input.journal, runId) : false;
  if (inbound && !reached) {
    for (const step of steps) input.journal.finish(step.id, "abandoned");
    input.store.event(runId, "run.left_for_channel", { note: "The chat app sends this message again, and it is answered then." });
    return { runId, outcome: "left-for-chat", steps: [] };
  }
  // A chat task that may already have sent, paid or pushed something is not started afresh when the
  // chat app sends the message again: that message is held, and the owner decides in the app.
  if (inbound) holdReplay(input, inbound.data as Record<string, unknown>, runId);
  const carryOn = input.mode === "on" && !input.askOnly && !inbound;
  const decided: { tool: string; decision: StepDecision }[] = [];
  const asks: OpenStep[] = [];
  const checkProject = () => {
    if (!run.project || input.store.sessionProject(run.sessionId) !== run.project
      || !input.store.projects.list(run.owner).some((project) => project.id === run.project))
      throw new Error("The interrupted task's original project is unknown, deleted or differs from its conversation. Reconcile it before continuing.");
  };
  let recovery: ReturnType<Runtime["beginInterruptedRecovery"]> | null = null;
  try {
    if (carryOn) {
      const person = recordedRecoveryPerson(input.store, runId, input.runtime.owner);
      if (person && !currentPerson()) return asPerson({ profileId: person, keyId: "resumed" }, () => recoverRun(input, runId, steps));
    }
    if (carryOn) recovery = input.runtime.beginInterruptedRecovery(runId);
    // Reconcile the saved role and workspace before any journal retry or automatic model continuation.
    if (carryOn) {
      try { checkProject(); await withRecoveryContext(input, runId, async () => undefined); checkProject(); }
      catch (error) {
        recovery?.signal.throwIfAborted();
        const reason = input.runtime.hideSecrets(error instanceof Error ? error.message : String(error));
        input.store.finish(runId, "needs_input", reason);
        input.store.event(runId, "recovery.context_unavailable", { reason });
        input.store.event(runId, "attention.needed", { question: reason, afterRestart: true });
        input.runtime.notifyEvent("approval.needed", { runId, question: reason });
        return { runId, outcome: "asked", steps: [] };
      }
    }
    recovery?.signal.throwIfAborted();
    noteFinishedWithoutResult(input, run);
    let clear = true;
    for (const step of steps) {
      // Once a step is left undecided, the ones the model asked for after it are not run ahead of it.
      recovery?.signal.throwIfAborted();
      if (carryOn) checkProject();
      const { decision, settled } = await settleStep(input, runId, step, carryOn && clear);
      recovery?.signal.throwIfAborted();
      clear &&= settled;
      decided.push({ tool: step.tool, decision });
      if (decision === "ask") asks.push(step);
    }
    if (input.store.run(runId)?.status === "needs_input") return { runId, outcome: "asked", steps: decided };
    if (asks.length) { askOwner(input, runId, asks); return { runId, outcome: "asked", steps: decided }; }
    if (!carryOn) {
      input.store.event(runId, "run.can_continue", { note: "Branch was restarted while this task was working. Continue it when you are ready." });
      return { runId, outcome: "offered", steps: decided };
    }
    recovery?.signal.throwIfAborted();
    checkProject();
    // Journal reconciliation has a saved context; normal resume must independently preserve that authority.
    const restriction = await withRecoveryContext(input, runId, async (context, copy) => input.runtime.recoveryHandoff(runId, context, copy));
    recovery?.signal.throwIfAborted();
    checkProject();
    // Each step keeps its call id, so a team task can tell which of them it has a record of (src/team-reconcile.ts).
    // Record success only after normal resume has admitted its new run, not before its
    // asynchronous authority checks. Rejection remains actionable on the original task.
    let accept!: () => void, reject!: (error: unknown) => void;
    const admission = new Promise<void>((resolve, fail) => { accept = resolve; reject = fail; });
    let admitted = false;
    recovery?.release();
    const resumed = underProject(run.project ?? defaultProjectId, () => input.runtime.resume(runId, restriction, (next) => {
      input.store.event(runId, "run.auto_resumed", { resumedRunId: next.id,
        steps: steps.map((step, index) => ({ ...decided[index], callId: step.callId })) });
      admitted = true;
      accept();
    })).then((result) => {
      if (!admitted) reject(new Error("The continuation finished without a recorded admission receipt."));
      return result;
    }).catch((error: unknown) => {
      if (!admitted) reject(error);
      else {
        const reason = input.runtime.hideSecrets(error instanceof Error ? error.message : String(error));
        input.store.event(runId, "recovery.continuation_failed", { reason });
        input.store.finish(runId, "needs_input", reason);
        input.store.event(runId, "attention.needed", { question: reason, afterRestart: true });
        input.runtime.notifyEvent("approval.needed", { runId, question: reason });
      }
      return undefined;
    });
    await admission;
    return { runId, outcome: "resumed", steps: decided, resumed };
  } catch (error) {
    const reason = input.runtime.hideSecrets(error instanceof Error ? error.message : String(error));
    if (recovery?.signal.aborted) {
      const stopped = recovery.signal.reason instanceof Error ? recovery.signal.reason.message : reason;
      input.store.event(runId, "run.recovery_stopped", { reason: input.runtime.hideSecrets(stopped) });
      if (recovery.cancelled()) {
        // Registered recovery Stop returns through runtime.cancel, bypassing the server's
        // waiting-task cleanup. Abandon only this task's plan, never a newer session plan.
        if (input.runtime.orchestration.plan(run.sessionId)?.runId === runId)
          input.runtime.orchestration.clearPlan(run.sessionId);
        input.store.finish(runId, "cancelled", "Stopped during interrupted recovery. No automatic continuation was started.");
        return { runId, outcome: "gone", steps: decided };
      }
      input.store.finish(runId, "needs_input", reason);
      input.store.event(runId, "recovery.context_unavailable", { reason });
      input.store.event(runId, "attention.needed", { question: reason, afterRestart: true });
      input.runtime.notifyEvent("approval.needed", { runId, question: reason });
      return { runId, outcome: "asked", steps: decided };
    }
    if (recovery) {
      input.store.finish(runId, "needs_input", reason);
      input.store.event(runId, "recovery.context_unavailable", { reason });
      input.store.event(runId, "attention.needed", { question: reason, afterRestart: true });
      input.runtime.notifyEvent("approval.needed", { runId, question: reason });
      return { runId, outcome: "asked", steps: decided };
    }
    input.store.event(runId, "run.can_continue", { note: reason });
    return { runId, outcome: "offered", steps: decided };
  } finally { recovery?.release(); }
}

/** True when a step of this task that could reach the outside world was started, whatever became of it. */
function mayHaveReachedOutside(journal: TaskJournal, runId: string): boolean {
  return journal.steps(runId).some((step) => step.kind === "tool" && step.effects !== "none" && step.effects !== "idempotent"
    && step.state !== "intent" && step.state !== "not-started");
}

const replayKey = (channel: unknown, chatId: unknown, messageId: unknown): string =>
  `channel-replay:${String(channel)}:${String(chatId)}:${String(messageId)}`;

function holdReplay(input: RecoveryInput, inbound: Record<string, unknown>, runId: string): void {
  input.store.save("settings", input.runtime.owner, replayKey(inbound.channel, inbound.chatId, inbound.messageId),
    { runId, heldAt: new Date().toISOString() });
}

/**
 * Asked by the chat router before it starts a task: a message whose earlier task was cut off after
 * it may have reached the outside world is answered with a sentence instead of being done again.
 * The hold is used once.
 */
export function heldReplay(store: Pick<Store, "get" | "delete">, owner: string, message: { channel: string; chatId: string; messageId: string }): string | null {
  const key = replayKey(message.channel, message.chatId, message.messageId);
  if (!store.get("settings", owner, key)) return null;
  store.delete("settings", owner, key);
  return "Branch was restarted while it was working on this, and part of it may already have been done (a message sent, for example). So it was not started again. The owner can check and carry it on in the app.";
}

/** Held chat messages the chat app never sent again are forgotten after a week. */
function pruneHeldReplays(store: Store, owner: string): void {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  try {
    store.sqlite.prepare("DELETE FROM settings WHERE owner=? AND id LIKE 'channel-replay:%' AND json_extract(data,'$.heldAt') < ?").run(owner, weekAgo);
  } catch { /* tidying never matters enough to fail over */ }
}

// long-work: a task the owner paused waits for their Resume, a restart or not.
// hot-update: a task handed to a newer engine is carried on by `resumeHandedOver`, whatever the switches say.
const settledKinds = new Set(["run.auto_resumed", "run.can_continue", "run.left_for_channel", "attention.needed", "run.paused", "run.handed_over"]);

/**
 * hot-update: tasks an engine stopped after a whole step so a newer engine could take over (`run.handed_over`). Whichever
 * engine starts next (the new one, or the old one again when the new one failed its check) carries each on once: the
 * carry-on is written down (`run.auto_resumed`) when the replacement task is admitted. No step
 * was cut off, so nothing is checked or done again; a chat app's task is carried on too, since that app sends nothing again.
 */
type HandedOverContinuation = { runId: string; resumed: Promise<Run | undefined>; admission: Promise<boolean> };
const pendingHandovers = new WeakMap<Runtime, Map<string, HandedOverContinuation>>();
export function resumeHandedOver(input: Pick<RecoveryInput, "store" | "runtime" | "maxAgeMs">): HandedOverContinuation[] {
  const since = new Date(Date.now() - (input.maxAgeMs ?? 86_400_000)).toISOString();
  const rows = input.store.sqlite.prepare(`SELECT DISTINCT t.id AS id FROM tasks t JOIN events e ON e.run_id=t.id AND e.kind='run.handed_over'
    WHERE t.status='interrupted' AND t.updated_at >= ? AND NOT EXISTS (SELECT 1 FROM events x WHERE x.run_id=t.id AND x.kind='run.auto_resumed')
    ORDER BY t.created_at`).all(since) as { id: unknown }[];
  let pending = pendingHandovers.get(input.runtime);
  if (!pending) { pending = new Map(); pendingHandovers.set(input.runtime, pending); }
  const active = pending;
  return rows.map((row) => {
    const runId = String(row.id);
    const existing = active.get(runId);
    if (existing) return existing;
    let admitted = false;
    let receipt!: (accepted: boolean) => void;
    const admission = new Promise<boolean>((resolve) => { receipt = resolve; });
    const resumed = input.runtime.resume(runId, undefined, (next) => {
      admitted = true;
      input.store.event(runId, "run.auto_resumed", { steps: [], handedOver: true, resumedRunId: next.id });
      receipt(true);
    }).then((result) => {
      if (!admitted) throw new Error("The handed-over continuation finished without a recorded admission receipt.");
      return result;
    }).catch((error: unknown) => {
      receipt(false);
      const reason = input.runtime.hideSecrets(error instanceof Error ? error.message : String(error));
      input.store.event(runId, "recovery.continuation_failed", { reason, handedOver: true, admitted });
      input.store.finish(runId, "needs_input", reason);
      input.store.event(runId, "attention.needed", { question: reason, afterRestart: true });
      input.runtime.notifyEvent("approval.needed", { runId, question: reason });
      return undefined;
    }).finally(() => { active.delete(runId); });
    const continuation = { runId, resumed, admission };
    active.set(runId, continuation);
    return continuation;
  });
}

/**
 * Every task the last run of Branch left interrupted: those with a step still open in the journal,
 * and those cut off between steps (while the model was thinking). A task already settled once, or
 * interrupted longer ago than `maxAgeMs`, is left for the owner.
 */
function interruptedRuns(input: RecoveryInput): Map<string, OpenStep[]> {
  const byRun = new Map<string, OpenStep[]>();
  // NAS 5653d17: asked of the database by kind, never by reading a task's events, which stops at the first 2000: a
  // task a restore brought back (`run.restored`) is only ever offered, and a settled one is left for the owner.
  const has = (runId: string, kinds: readonly string[]): boolean => !!input.store.sqlite
    .prepare(`SELECT 1 FROM events WHERE run_id=? AND kind IN (${kinds.map(() => "?").join(",")}) LIMIT 1`).get(runId, ...kinds);
  for (const step of input.journal.open()) {
    if (input.only && !input.only.has(step.runId)) continue;
    if (has(step.runId, ["run.restored"])) continue; // a restore's task, even with a step open in this computer's journal
    byRun.set(step.runId, [...(byRun.get(step.runId) ?? []), step]);
  }
  const since = new Date(Date.now() - (input.maxAgeMs ?? 86_400_000)).toISOString();
  const rows = input.store.sqlite.prepare("SELECT id FROM tasks WHERE status='interrupted' AND updated_at >= ? ORDER BY created_at").all(since);
  for (const row of rows) {
    const id = String(row.id);
    if ((input.only && !input.only.has(id)) || byRun.has(id) || has(id, [...settledKinds, "run.restored"])) continue;
    byRun.set(id, []);
  }
  return byRun;
}

/** Looks at every task the last run of Branch cut off and settles each one. */
export async function recoverAfterRestart(input: RecoveryInput): Promise<RecoveredRun[]> {
  if (input.mode === "off") return [];
  const report: RecoveredRun[] = [];
  for (const [runId, steps] of interruptedRuns(input)) report.push(await recoverRun(input, runId, steps));
  input.journal.prune();
  pruneHeldReplays(input.store, input.runtime.owner);
  return report;
}

/** A sentence for a scheduled job that runs later than it was due, or null when it is on time. */
export function lateNote(dueAt: unknown, now: Date, graceMs = 120_000): string | null {
  const due = typeof dueAt === "string" ? Date.parse(dueAt) : Number.NaN;
  if (!Number.isFinite(due) || now.getTime() - due <= graceMs) return null;
  const minutes = Math.round((now.getTime() - due) / 60_000);
  const when = minutes >= 120 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`;
  return `This was due ${when} ago, while Branch was not running, so it ran once now instead of once for every turn it missed.`;
}

/**
 * A repeating job whose turn was cut off by the restart goes back on the list for its next turn,
 * instead of staying stuck as "interrupted" for ever. The cut-off turn itself is settled with its task.
 */
export function releaseInterruptedSchedules(store: Store, nextTurn: (data: Record<string, unknown>, now: Date) => string, now = new Date()): number {
  const rows = store.sqlite.prepare("SELECT id, owner, data FROM schedules WHERE json_extract(data,'$.status')='interrupted'").all();
  let released = 0;
  for (const row of rows) {
    const data = JSON.parse(String(row.data)) as Record<string, unknown>;
    if (typeof data.intervalMs !== "number" && typeof data.dailyAt !== "string" && typeof data.cron !== "string") continue;
    store.save("schedules", String(row.owner), String(row.id), { ...data, status: "pending", dueAt: nextTurn(data, now),
      lastInterruption: { at: now.toISOString(), note: "Branch was restarted during this job's turn. That turn is settled with its task; the job carries on at its next turn." } });
    released++;
  }
  return released;
}

/**
 * What a real start (the app window, the background engine, or an engine run by the gateway) does
 * once it is listening: settle interrupted tasks and put cut-off repeating jobs back on the list.
 * With the switch off it does nothing, which is how Branch behaved before.
 */
export async function recoverOnStart(input: RecoveryInput & { nextTurn: (data: Record<string, unknown>, now: Date) => string }): Promise<RecoveredRun[]> {
  // hot-update: a newer engine carries them on only once it has passed its check (main asks it to, `carryOnHandedOver`).
  const handedOver = process.env.BRANCH_HOLD_HANDED_OVER === "1" ? [] : resumeHandedOver(input);
  const handoverReport: RecoveredRun[] = await Promise.all(handedOver.map(async ({ runId, resumed, admission }) => ({
    runId, outcome: await admission ? "resumed" as const : "asked" as const, steps: [], resumed,
  })));
  if (handoverReport.length) console.log(`Engine handover reconciled: ${handoverReport.filter((run) => run.outcome === "resumed").length} admitted, ${handoverReport.filter((run) => run.outcome === "asked").length} held.`);
  if (input.mode === "off") return handoverReport;
  const released = releaseInterruptedSchedules(input.store, input.nextTurn);
  const report = [...handoverReport, ...await recoverAfterRestart({ ...input, askOnly: input.askOnly || process.env.BRANCH_RESUME === "ask" })];
  const counts = report.reduce<Record<string, number>>((all, run) => ({ ...all, [run.outcome]: (all[run.outcome] ?? 0) + 1 }), {});
  if (report.length || released)
    console.log(`Picked up after a restart: ${JSON.stringify(counts)}; repeating jobs put back: ${released}.`);
  return report;
}
