import type { Run } from "./contracts.js";
import type { Runtime } from "./runtime.js";
import type { Store } from "./store.js";

/**
 * "Do this again": run a finished task a second time, from the same words, with the same tools it
 * had and the same model that answered it, in a conversation of its own so nothing it did the first
 * time is carried over. The two are then put side by side on the screen that already compares two
 * tasks — what each cost, how long it took, how many rounds and tools each used, and the difference
 * between the two answers, line by line.
 *
 * This is how a change to a prompt, a model or a set of rules is judged: by running the same thing
 * twice and reading the difference, rather than by remembering what it did last week.
 */
export interface ReplayPlan {
  prompt: string;
  /** The tools the first run had, as recorded when it started; empty when it recorded none. */
  permissions: string[];
  /** The preset that answered the first time, so the same model answers again. */
  model: string | null;
}

/** What a task was, read back off its own record. Throws in plain words when it cannot be. */
export function replayPlan(store: Store, runId: string): ReplayPlan {
  const run = store.run(runId);
  if (!run) throw new Error("There is no task with that number");
  if (!run.prompt.trim()) throw new Error("That task has no words of its own to run again");
  const events = store.events(runId);
  const started = events.find((event) => event.kind === "run.started")?.data;
  const chosen = events.find((event) => event.kind === "model.selected")?.data;
  const permissions = Array.isArray(started?.permissions) ? started.permissions.map(String) : [];
  const preset = typeof chosen?.presetId === "string" ? chosen.presetId : null;
  return { prompt: run.prompt, permissions, model: preset };
}

export interface Replayed { original: string; replay: string; plan: ReplayPlan; run: Run }

/**
 * Runs the plan. The task is given a conversation of its own — deliberately not the original's, so
 * the second answer is not shaped by the first — and comes back with both numbers, which is what
 * the screen needs to show them beside each other.
 */
export async function replayRun(runtime: Pick<Runtime, "run">, store: Store, runId: string): Promise<Replayed> {
  const plan = replayPlan(store, runId);
  const run = await runtime.run({
    prompt: plan.prompt,
    ...(plan.permissions.length ? { permissions: plan.permissions } : {}),
    ...(plan.model ? { model: plan.model } : {}),
    // mac7/outside-resume: a task that came from outside is done again as that, never as the owner's own.
    originFrom: runId,
  });
  store.event(run.id, "run.replayed", { of: runId, permissions: plan.permissions.length, model: plan.model });
  return { original: runId, replay: run.id, plan, run };
}
