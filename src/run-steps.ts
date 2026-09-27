/**
 * Pass 17 (Timeline and Helpers): one task's steps in the order they happened, in one answer.
 *
 *   GET /api/runs/:id/steps
 *
 * Every model call (with its time and price, from the same rounds "Look inside" reads), every tool
 * step, every question the task stopped on and how it was answered, every helper it started, and
 * every note the owner steered it with. Tool steps and questions carry the hash the activity chain
 * wrote for them, when the chain is on, so the window can show each link and check the whole chain.
 *
 * Helpers are the tasks this one started (their `run.started` names it as the parent): each with the
 * model and provider it ran on, what it is thinking now (held in memory, never recorded) or its last
 * recorded line of reasoning, and the questions it is waiting on, by conversation and fingerprint, so
 * an answer lands on that exact request. Nothing here changes anything.
 */
import type { PendingApproval } from "./approvals.js";
import type { AuditEntry } from "./audit.js";
import type { Event, Run } from "./contracts.js";
import { calls, rounds, type PriceRound } from "./inspect.js";
import type { ChainEntry } from "./safety-extras/activity-chain.js";
import type { Store } from "./store.js";

export type StepKind = "model" | "tool" | "ask" | "helper" | "you";
export type AskState = "waiting" | "allowed" | "refused" | null;
export interface Step {
  kind: StepKind;
  at: string;
  seconds: number | null;
  cost: { amount: number | null; display: string } | null;
  /** model: the model; tool: the tool's own label; ask: the question; helper: its name; you: the note. */
  title: string;
  /** model: the provider; tool: the tool's name; ask: the tool and what it is about; helper: its model. */
  detail: string;
  tokens?: { input: number | null; output: number | null };
  had?: string | null;
  happened?: string | null;
  /** A tool call's id, so the window can find the message that asked for it. */
  callId?: string | null;
  state?: AskState;
  helperRunId?: string;
  hash: string | null;
}
export interface HelperQuestion { sessionId: string; fingerprint: string; tool: string; target: string; label: string; question: string; bytes: string }
export interface Helper {
  runId: string; sessionId: string; name: string | null; job: string; status: Run["status"];
  provider: string | null; model: string | null; thinking: string | null; steps: number;
  cost: { amount: number | null; display: string } | null; waiting: HelperQuestion[];
}
export interface StepsDeps {
  price?: PriceRound;
  /** Every question waiting anywhere (the approval gate's list). */
  waiting: PendingApproval[];
  /** Answers given to questions, newest first (the record's approval.decided rows). */
  decided: AuditEntry[];
  /** This task's entries in the activity chain, oldest first, and whether the chain is on. */
  chain: { mode: string; entries: ChainEntry[] };
  thinkingOf: (runId: string) => string | undefined;
  helperName: (agent: string) => string | null;
  cost: (runId: string) => { amount: number | null; display: string };
}

const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value));
const firstLine = (text: string): string => text.split("\n")[0]!.slice(0, 200);

/** The chain entries of one kind, in order, handed out one at a time as the matching steps are met. */
function chainQueue(entries: ChainEntry[]): (kinds: readonly string[]) => string | null {
  const left = [...entries];
  return (kinds) => {
    const at = left.findIndex((entry) => kinds.includes(entry.kind));
    return at < 0 ? null : left.splice(at, 1)[0]!.hash;
  };
}

function modelSteps(store: Store, runId: string, price: PriceRound | undefined): Step[] {
  return rounds(store, runId, price).map((round) => ({
    kind: "model" as const, at: round.at, seconds: round.seconds, cost: round.cost,
    title: round.model ?? round.preset ?? "", detail: round.provider ?? "", tokens: round.tokens,
    had: null, happened: round.error, hash: null,
  }));
}

function toolSteps(store: Store, run: Run, events: Event[], hashOf: (kinds: readonly string[]) => string | null): Step[] {
  const labels = new Map(events.filter((e) => e.kind === "tool.started").map((e) => [str(e.data.id), str(e.data.label)]));
  const kindOf = { done: "tool.completed", failed: "tool.failed", practice: "tool.simulated", stopped: "tool.stalled" } as const;
  return calls(store, run.id, new Map(), run.sessionId).map((call) => ({
    kind: "tool" as const, at: call.at, seconds: call.seconds, cost: null,
    title: labels.get(call.id ?? "") || call.name, detail: call.name, had: call.input, happened: call.output,
    callId: call.id, hash: hashOf([kindOf[call.status]]),
  }));
}

/** How each question ended: still waiting, or the answer the record holds for this task, in the order asked. */
function askSteps(run: Run, events: Event[], deps: StepsDeps, hashOf: (kinds: readonly string[]) => string | null): Step[] {
  const answers = deps.decided.filter((entry) => entry.runId === run.id).reverse();
  return events.filter((e) => e.kind === "policy.ask").map((event) => {
    const fingerprint = str(event.data.fingerprint);
    const waiting = deps.waiting.some((q) => q.runId === run.id && (q.fingerprint ?? "") === fingerprint);
    const answer = waiting ? undefined : answers.shift();
    const state: AskState = waiting ? "waiting" : answer ? (answer.outcome === "allowed" ? "allowed" : "refused") : null;
    const target = str(event.data.target);
    return {
      kind: "ask" as const, at: event.createdAt, seconds: null, cost: null,
      title: str(event.data.question) || str(event.data.label), detail: [str(event.data.name), target].filter(Boolean).join(" · "),
      had: str(event.data.bytes) || null, happened: null, state, hash: hashOf(["policy.ask"]),
    };
  });
}

const steerSteps = (events: Event[]): Step[] => events.filter((e) => e.kind === "run.steered").map((event) => ({
  kind: "you" as const, at: event.createdAt, seconds: null, cost: null, title: str(event.data.note), detail: "", hash: null,
}));

/** The model a task ran on: the one it chose (or fell back to), else the last one that answered. */
function modelOf(events: Event[]): { provider: string | null; model: string | null } {
  const chosen = events.filter((e) => e.kind === "model.selected" || e.kind === "model.fallback").at(-1)
    ?? events.filter((e) => e.kind === "model.completed").at(-1);
  if (!chosen) return { provider: null, model: null };
  const name = chosen.kind === "model.selected" ? chosen.data.presetName ?? chosen.data.model : chosen.data.model;
  return { provider: chosen.data.provider === undefined ? null : str(chosen.data.provider), model: name === undefined ? null : str(name) };
}

/** The tasks this one started, oldest first: each names it as its parent when it starts. */
export function helpersOf(store: Store, run: Run, deps: StepsDeps): Helper[] {
  const children = store.runs(run.owner).filter((child) => child.id !== run.id && child.createdAt >= run.createdAt)
    .map((child) => ({ child, events: store.events(child.id) }))
    .filter(({ events }) => str(events.find((e) => e.kind === "run.started")?.data.parentRunId) === run.id)
    .reverse();
  return children.map(({ child, events }) => {
    const started = events.find((e) => e.kind === "run.started")!;
    const scratch = events.filter((e) => e.kind === "react.scratch").at(-1);
    const waiting = deps.waiting.filter((q) => q.runId === child.id).map((q) => ({
      sessionId: q.sessionId, fingerprint: q.fingerprint ?? "", tool: q.tool, target: q.target, label: q.label, question: q.question, bytes: q.bytes ?? "",
    }));
    return {
      runId: child.id, sessionId: child.sessionId, name: started.data.agent ? deps.helperName(str(started.data.agent)) : null,
      job: child.prompt.slice(0, 600), status: child.status, ...modelOf(events),
      thinking: deps.thinkingOf(child.id) ?? (scratch ? str(scratch.data.text) : null),
      steps: events.filter((e) => e.kind === "tool.completed" || e.kind === "tool.failed").length, cost: deps.cost(child.id), waiting,
    };
  });
}

const helperSteps = (helpers: Helper[], store: Store): Step[] => helpers.map((helper) => ({
  kind: "helper" as const, at: store.run(helper.runId)?.createdAt ?? "", seconds: null, cost: null,
  title: helper.name ?? "", detail: [helper.model, helper.provider].filter(Boolean).join(" · "), had: helper.job, happened: null,
  helperRunId: helper.runId, hash: null,
}));

/** Everything the Timeline and the Helpers section show about one task. */
export function runSteps(store: Store, runId: string, deps: StepsDeps) {
  const run = store.run(runId);
  if (!run) throw new Error("Run not found");
  const events = store.events(run.id), hashOf = chainQueue(deps.chain.entries);
  const helpers = helpersOf(store, run, deps);
  // Tools and questions take their chain hashes in the order the chain wrote them.
  const byTime = [...toolSteps(store, run, events, hashOf), ...askSteps(run, events, deps, hashOf)];
  const steps = [...modelSteps(store, run.id, deps.price), ...byTime, ...helperSteps(helpers, store), ...steerSteps(events)]
    .map((step, order) => ({ step, order }))
    .sort((a, b) => a.step.at.localeCompare(b.step.at) || a.order - b.order)
    .map(({ step }) => step);
  const tip = deps.chain.entries.at(-1)?.hash ?? null;
  return {
    runId: run.id, sessionId: run.sessionId, title: firstLine(run.prompt), status: run.status,
    seconds: Math.max(0, Math.round((Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 100) / 10),
    cost: deps.cost(run.id), steps, helpers,
    chain: { mode: deps.chain.mode, entries: deps.chain.entries.length, tip },
  };
}
