import { z } from "zod";
import { Budget, errorText } from "./contracts.js";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import type { Runtime } from "./runtime.js";
import type { Knowledge } from "./knowledge.js";
import { HelperSelectionSchema, helperRouteTarget, type HelperSelection } from "./delegation.js";

/**
 * Tools for working with several specialists at once: a parallel fan-out that splits this task's
 * token budget between branches, a handoff to a named specialist, and the shared scratch area
 * every sub-task of the same task can read and write.
 */
/** Most children one task may run at the same time; the delegation limit in the runtime. */
const parallelConcurrency = 4;
/** A share of tokens as the model and the event log read it: a figure, or "no limit". */
const shown = (tokens: number): number | string => (tokens === Infinity ? "no limit" : tokens);
const ParallelTaskSchema = z.object({
  ...HelperSelectionSchema.shape,
  specialist: z.string().min(1).max(200),
  prompt: z.string().min(1).max(8000),
}).strict();
export const ParallelSchema = z.object({
  tasks: z.array(ParallelTaskSchema).min(1).max(6),
  /** Stop the other branches as soon as one fails; off by default. */
  failFast: z.boolean().default(false),
}).strict();
export interface BranchOutcome {
  id: string; specialist: string; status: string; output: string; runId?: string; error?: string;
}

/** Runs `work` over the items with at most `limit` of them in flight, keeping the input order. */
export async function pooled<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let index = next++; index < items.length; index = next++) results[index] = await work(items[index]!, index);
  });
  await Promise.all(workers);
  return results;
}

/**
 * Runs up to six specialist branches together, each with its own share of what is left of this
 * task's token budget. One branch failing leaves the others running unless failFast was asked for;
 * the branches' spend is added back to this task afterwards.
 */
export async function runParallel(runtime: Runtime, knowledge: Knowledge, context: ToolContext, input: unknown) {
  const { tasks, failFast } = ParallelSchema.parse(input);
  const shares = context.budget.share(tasks.length), share = shares.maxTokens;
  const stop = new AbortController();
  const budgets: Budget[] = [];
  const branches = await pooled(tasks, Math.min(tasks.length, parallelConcurrency), async (task, index) => {
    const budget = new Budget(shares);
    budgets.push(budget);
    const branch: ToolContext = { ...context, budget, signal: AbortSignal.any([context.signal, stop.signal]) };
    const outcome = await oneBranch(runtime, knowledge, branch, task, index);
    if (outcome.status !== "completed" && failFast) stop.abort(new Error(`Branch ${outcome.id} did not finish and failFast was asked for`));
    return outcome;
  });
  // A branch never costs this task more than its share, whatever its own last call charged it.
  const spent = budgets.reduce((total, budget) => total + Math.min(budget.tokens, share), 0);
  if (context.runId)
    runtime.store.event(context.runId, "delegation.parallel", {
      share: shown(share), spent, failFast,
      branches: branches.map((b) => ({ id: b.id, specialist: b.specialist, status: b.status, ...(b.runId ? { runId: b.runId } : {}) })),
    });
  // The branches spent from their own share; the total comes off this task's budget afterwards,
  // once every result is recorded, so a budget that runs out never loses work already paid for.
  context.budget.charge(spent);
  return {
    branches, spent, tokensEach: shown(share),
    synthesise: "Combine these branch answers into one answer for the person, and say plainly where a branch failed or where two disagree.",
  };
}

async function oneBranch(
  runtime: Runtime, knowledge: Knowledge, branch: ToolContext,
  task: z.infer<typeof ParallelTaskSchema>, index: number,
): Promise<BranchOutcome> {
  const id = `b${index + 1}`;
  try {
    const spec = knowledge.activeSpecialist(branch.owner, task.specialist);
    const { run } = await runtime.delegateChecked(task.prompt, branch, spec.permissions, spec.instructions, { agent: task.specialist, ...(task.model ? { model: task.model } : {}), ...(task.accountRef ? { accountRef: task.accountRef } : {}) });
    return { id, specialist: task.specialist, runId: run.id, status: run.status, output: run.output.slice(0, 4000) };
  } catch (error) {
    return { id, specialist: task.specialist, status: "failed", output: "", error: errorText(error) };
  }
}

/**
 * Hands the rest of a task to a named specialist with a brief, and brings its answer back. Where
 * the owner has written down who this specialist may hand work on to, anybody else is refused; and
 * the reason for the handover goes into the conversation, so a person reading the transcript
 * afterwards can see the work change hands and why.
 */
export async function handOff(
  runtime: Runtime, knowledge: Knowledge, context: ToolContext,
  input: { specialist: string; brief: string; reason?: string } & HelperSelection,
) {
  const from = context.agent ?? "the main task";
  const refusal = runtime.handoffs.refusal(context.agent, input.specialist);
  if (refusal) throw new Error(refusal);
  const spec = knowledge.activeSpecialist(context.owner, input.specialist);
  const reason = (input.reason ?? "").trim();
  if (context.runId) {
    runtime.store.event(context.runId, "delegation.handoff", {
      to: input.specialist, from, brief: input.brief.slice(0, 500), reason: reason.slice(0, 300),
    });
    const sessionId = runtime.store.run(context.runId)?.sessionId;
    if (sessionId)
      runtime.store.message(sessionId, { role: "system",
        content: `Handed over from ${from} to ${input.specialist}${reason ? `: ${reason}` : "."}` });
  }
  const { run, result } = await runtime.delegateChecked(input.brief, context, spec.permissions, spec.instructions, { agent: input.specialist, ...(input.model ? { model: input.model } : {}), ...(input.accountRef ? { accountRef: input.accountRef } : {}) });
  return { specialist: input.specialist, runId: run.id, status: run.status, output: run.output.slice(0, 4000), resolved: result.status === "resolved" };
}

export function registerOrchestration(registry: ToolRegistry, runtime: Runtime, knowledge: Knowledge): void {
  registry.register({
    name: "delegate.parallel",
    description: "Run up to six specialists at once, each on a share of this task's budget. One failure leaves the rest running unless failFast. Combine their answers yourself.",
    permission: "specialists.use",
    parameters: ParallelSchema,
    target: (a) => helperRouteTarget(a.tasks),
    execute: async (a, c) => runParallel(runtime, knowledge, c, a),
  });
  registry.register({
    name: "delegate.handoff",
    description: "Hand the rest of this work to a named specialist, briefed in full, saying why.",
    permission: "specialists.use",
    parameters: z.object({
      specialist: z.string().min(1).max(200),
      ...HelperSelectionSchema.shape,
      brief: z.string().trim().min(1).max(4000),
      /** Why this belongs to them rather than you. It is shown in the conversation. */
      reason: z.string().trim().max(300).default(""),
    }).strict(),
    target: (a) => helperRouteTarget([a]),
    execute: async (a, c) => handOff(runtime, knowledge, c, a),
  });
  registerScratch(registry, runtime);
}

/** The shared notepad: everything a task and its sub-tasks write is gone when the task finishes. */
function registerScratch(registry: ToolRegistry, runtime: Runtime): void {
  const root = (context: ToolContext): string => context.scratchRoot ?? context.runId;
  registry.register({
    name: "scratch.set",
    description: "Leave a note everyone on this task can read. Cleared when the task ends.",
    permission: "scratch.write",
    parameters: z.object({ key: z.string().trim().min(1).max(100), value: z.string().max(4000) }).strict(),
    execute: async (a, c) => runtime.orchestration.scratchSet(root(c), c.runId, a.key, a.value),
  });
  registry.register({
    name: "scratch.read",
    description: "Read this task's shared notes: one by key, or all of them.",
    permission: "scratch.read",
    parameters: z.object({ key: z.string().trim().min(1).max(100).optional() }).strict(),
    execute: async (a, c) => {
      const entries = runtime.orchestration.scratchRead(root(c));
      // A small model reaches for these notes to read a file; a key that looks like a file name says where files are read.
      if (a.key) return entries[a.key] ? { key: a.key, ...entries[a.key]! } : { key: a.key, value: null,
        ...(/\.[a-z0-9]{1,6}$/i.test(a.key) ? { note: `There is no shared note called ${a.key}. To read a file in the workspace, use files.read with that path.` } : {}) };
      return { notes: Object.entries(entries).map(([key, entry]) => ({ key, ...entry })).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)) };
    },
  });
}
