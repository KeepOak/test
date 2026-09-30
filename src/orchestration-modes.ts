import { z } from "zod";
import { Budget, errorText } from "./contracts.js";
import type { ToolContext } from "./contracts.js";
import type { Knowledge } from "./knowledge.js";
import { pooled } from "./orchestration-tools.js";
import type { ToolRegistry } from "./registry.js";
import type { Runtime } from "./runtime.js";
import type { Store } from "./store.js";

/**
 * Three ways of putting several specialists on one job, over the fan-out engine that already
 * exists. A **supervisor** splits a goal between named workers and writes the answer that comes
 * back. A **swarm** puts several workers on one shared list of things to do, each taking the next
 * one that is free. A **router** decides which one specialist a request belongs to and sends it
 * there. All three are ordinary tools: nothing new runs, and every sub-task goes through the same
 * budget, the same approval rules and the same record as any other delegated task.
 */
const workerName = z.string().trim().min(1).max(200);

export interface Assignment { specialist: string; prompt: string }
const AssignmentsSchema = z.object({
  tasks: z.array(z.object({ specialist: workerName, prompt: z.string().trim().min(1).max(4000) }).strict()).min(1).max(6),
}).strict();

/**
 * Turning one goal into sub-tasks, each addressed to one of the named workers. Kept apart from the
 * supervisor that uses it so it can be read, tested and replaced on its own: given the same words
 * back from a model it always produces the same list, and an assignment to somebody who is not on
 * the team is dropped rather than guessed at.
 */
export function parseAssignments(text: string, workers: readonly string[]): Assignment[] {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The supervisor did not answer with a list of sub-tasks");
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { throw new Error("The supervisor's list of sub-tasks could not be read"); }
  const checked = AssignmentsSchema.safeParse(parsed);
  if (!checked.success) throw new Error("The supervisor's list of sub-tasks was not in the expected shape");
  const known = checked.data.tasks.filter((task) => workers.includes(task.specialist));
  if (!known.length) throw new Error(`The supervisor gave work to nobody on the team (${workers.join(", ")})`);
  return known;
}

const splitInstructions = (goal: string, workers: readonly string[]): string =>
  `You are splitting one job between the people you have. They are: ${workers.join(", ")}. Reply with JSON only: {"tasks":[{"specialist":"one of those names","prompt":"what that person is to do"}]}. Two to six sub-tasks. Give each one to the person best suited to it; the same person may have more than one. No prose.\n\nThe job: ${goal}`;

/** Asks for the split and reads it back. `ask` is whatever will answer — a specialist, or a fake. */
export async function decomposeGoal(
  ask: (prompt: string) => Promise<string>, goal: string, workers: readonly string[],
): Promise<Assignment[]> {
  return parseAssignments(await ask(splitInstructions(goal, workers)), workers);
}

export const SuperviseSchema = z.object({
  /** The specialist that decides who does what and writes the answer that comes back. */
  supervisor: workerName,
  /** The specialists it may give work to. */
  workers: z.array(workerName).min(1).max(6),
  goal: z.string().trim().min(1).max(8000),
}).strict();

/** The supervisor splits the goal, the workers do their parts, the supervisor writes the answer. */
export async function runSupervised(runtime: Runtime, knowledge: Knowledge, context: ToolContext, input: unknown) {
  const { supervisor, workers, goal } = SuperviseSchema.parse(input);
  const ask = async (prompt: string): Promise<string> => {
    const spec = knowledge.activeSpecialist(context.owner, supervisor);
    const { run } = await runtime.delegateChecked(prompt, context, spec.permissions, spec.instructions, { agent: supervisor });
    return run.output;
  };
  const assignments = await decomposeGoal(ask, goal, workers);
  const specs = new Map(assignments.map((task, index) =>
    [`s${index}`, { ...knowledge.activeSpecialist(context.owner, task.specialist), agent: task.specialist }]));
  const outcome = await runtime.fanout(context,
    assignments.map((task, index) => ({ id: `s${index}`, prompt: task.prompt, dependsOn: [] })), (id) => specs.get(id)!);
  const answers = assignments.map((task, index) => ({ specialist: task.specialist, prompt: task.prompt, ...outcome.tasks[`s${index}`]! }));
  const merged = await ask(`You gave this work out and it has come back. Write the one answer for the person, saying plainly where a part failed or where two parts disagree.\n\nThe job: ${goal}\n\n${
    answers.map((answer) => `[${answer.specialist}] ${answer.output || `(nothing: ${answer.status})`}`).join("\n\n")}`);
  if (context.runId)
    runtime.store.event(context.runId, "orchestration.supervised", { supervisor, workers,
      assignments: answers.map((answer) => ({ specialist: answer.specialist, status: answer.status })) });
  return { supervisor, answers, output: merged };
}

/**
 * One list of things to do, shared by several workers. A worker takes the next free item, and if it
 * cannot finish it the item goes back on the list for somebody else rather than being lost. The
 * list is held for the length of the one tool call, so nothing outlives the task.
 */
export class SharedWorkList {
  private readonly held = new Map<number, string>();
  private readonly finished = new Set<number>();
  private next = 0;
  constructor(private readonly items: readonly string[]) {}
  /** The next item nobody is holding, or null when there is nothing left to take. */
  claim(worker: string): { index: number; item: string } | null {
    while (this.next < this.items.length && (this.held.has(this.next) || this.finished.has(this.next))) this.next++;
    if (this.next >= this.items.length) return null;
    const index = this.next++;
    this.held.set(index, worker);
    return { index, item: this.items[index]! };
  }
  /** Puts an item back for somebody else; the worker that had it keeps nothing. */
  release(index: number): void {
    this.held.delete(index);
    this.next = Math.min(this.next, index);
  }
  done(index: number): void {
    this.held.delete(index);
    this.finished.add(index);
  }
  get state(): { total: number; done: number; held: number } {
    return { total: this.items.length, done: this.finished.size, held: this.held.size };
  }
}

export const SwarmSchema = z.object({
  specialists: z.array(workerName).min(1).max(4),
  items: z.array(z.string().trim().min(1).max(2000)).min(1).max(20),
}).strict();
export interface SwarmResult { index: number; item: string; specialist: string; status: string; output: string; error?: string }

/** Several specialists working down one list together, each taking the next item that is free. */
export async function runSwarm(runtime: Runtime, knowledge: Knowledge, context: ToolContext, input: unknown) {
  const { specialists, items } = SwarmSchema.parse(input);
  const list = new SharedWorkList(items);
  const results: SwarmResult[] = [];
  const shares = context.budget.share(Math.max(items.length, 1), 8), share = shares.maxTokens;
  // Each item works from a share of what is left, and the total comes off this task's budget at the
  // end, the same way a fan-out does. Without that, a swarm would cost this task nothing and could
  // be asked for again and again on the same budget.
  const budgets: Budget[] = [];
  await pooled(specialists, specialists.length, async (specialist) => {
    for (let taken = list.claim(specialist); taken; taken = list.claim(specialist)) {
      if (context.runId) runtime.store.event(context.runId, "swarm.claimed", { specialist, index: taken.index });
      const budget = new Budget(shares);
      budgets.push(budget);
      const branch: ToolContext = { ...context, budget };
      try {
        const spec = knowledge.activeSpecialist(context.owner, specialist);
        const { run } = await runtime.delegateChecked(taken.item, branch, spec.permissions, spec.instructions, { agent: specialist });
        list.done(taken.index);
        results.push({ index: taken.index, item: taken.item, specialist, status: run.status, output: run.output.slice(0, 4000) });
      } catch (error) {
        // Nobody loses an item because one worker could not manage it: it goes back on the list.
        list.release(taken.index);
        if (context.runId) runtime.store.event(context.runId, "swarm.released", { specialist, index: taken.index });
        results.push({ index: taken.index, item: taken.item, specialist, status: "failed", output: "", error: errorText(error) });
        return;
      }
    }
  });
  const spent = budgets.reduce((total, budget) => total + Math.min(budget.tokens, share), 0);
  if (context.runId) runtime.store.event(context.runId, "swarm.finished", { specialists, spent, ...list.state });
  context.budget.charge(spent);
  return { results: results.sort((a, b) => a.index - b.index), spent, ...list.state };
}

export const RouteSchema = z.object({
  destinations: z.array(z.object({ specialist: workerName, when: z.string().trim().min(1).max(300) }).strict()).min(2).max(8),
  request: z.string().trim().min(1).max(8000),
}).strict();

/** Which one destination a request belongs to. The first name that appears in the answer wins. */
export function chooseDestination(answer: string, destinations: readonly { specialist: string }[]): string | null {
  const said = answer.toLowerCase();
  const found = destinations
    .map((destination) => ({ name: destination.specialist, at: said.indexOf(destination.specialist.toLowerCase()) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at)[0];
  return found?.name ?? null;
}

/** Sorts a request into one of several specialists, then hands it straight to that one. */
export async function runRouted(runtime: Runtime, knowledge: Knowledge, context: ToolContext, input: unknown) {
  const { destinations, request } = RouteSchema.parse(input);
  const question = `Say which one of these this belongs to. Reply with the name and nothing else.\n${
    destinations.map((destination) => `- ${destination.specialist}: ${destination.when}`).join("\n")}\n\nThe request: ${request}`;
  const { run: sorted } = await runtime.delegateChecked(question, context, [], "You sort requests. Answer with one name and nothing else.");
  const chosen = chooseDestination(sorted.output, destinations) ?? destinations[0]!.specialist;
  if (context.runId) runtime.store.event(context.runId, "orchestration.routed", { to: chosen, said: sorted.output.slice(0, 200) });
  const spec = knowledge.activeSpecialist(context.owner, chosen);
  const { run } = await runtime.delegateChecked(request, context, spec.permissions, spec.instructions, { agent: chosen });
  return { specialist: chosen, status: run.status, output: run.output.slice(0, 4000), runId: run.id };
}

/**
 * Who each specialist is allowed to hand work on to. Without a list, a specialist may hand to
 * anybody, which is how handing over behaved before this existed. With one, a handover to anybody
 * else is refused in plain words, so the way work travels between specialists is something the
 * owner writes down rather than something the model decides in the moment.
 */
export class Handoffs {
  constructor(private readonly store: Store, private readonly owner: string) {}
  private key(from: string): string { return `handoffs:${from}`; }
  allowed(from: string): string[] {
    const saved = this.store.get("settings", this.owner, this.key(from))?.data as { to?: unknown } | undefined;
    return Array.isArray(saved?.to) ? saved.to.map(String) : [];
  }
  save(from: string, to: string[]): { from: string; to: string[] } {
    const list = z.array(workerName).max(8).parse(to);
    this.store.save("settings", this.owner, this.key(from), { to: list });
    return { from, to: list };
  }
  /** Why this handover is not allowed, or null when it is. */
  refusal(from: string | undefined, to: string): string | null {
    if (!from) return null;
    const list = this.allowed(from);
    if (!list.length || list.includes(to)) return null;
    return `"${from}" is only set up to hand work on to ${list.join(", ")}, so it cannot hand this to "${to}".`;
  }
}

export function registerOrchestrationModes(registry: ToolRegistry, runtime: Runtime, knowledge: Knowledge): void {
  registry.register({
    name: "delegate.supervise",
    description: "One specialist splits the job between the workers you name and writes the answer.",
    permission: "specialists.use",
    parameters: SuperviseSchema,
    execute: async (a, c) => runSupervised(runtime, knowledge, c, a),
  });
  registry.register({
    name: "delegate.swarm",
    description: "Several specialists work down one list, each taking the next free item.",
    permission: "specialists.use",
    parameters: SwarmSchema,
    execute: async (a, c) => runSwarm(runtime, knowledge, c, a),
  });
  registry.register({
    name: "delegate.route",
    description: "Send a request to whichever specialist it belongs to.",
    permission: "specialists.use",
    parameters: RouteSchema,
    execute: async (a, c) => runRouted(runtime, knowledge, c, a),
  });
}
