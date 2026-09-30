import type { ToolContext } from "../contracts.js";
import { checkResult } from "../delegation.js";
import type { ModelPreset } from "../models.js";
import type { Runtime } from "../runtime.js";
import { learningTask } from "../skill-authoring.js";
import type { Store } from "../store.js";
import type { Proof, ProofSide, ProofTask } from "./garden-book.js";

/**
 * The Gardener's proof: a skill change is replayed on its matching tasks with it and without it, as practice runs
 * (every tool that would change something only says what it would have done), on the same free model the night
 * chose, and each answer is graded 0 to 10 by that model with no tools. Adoption is decided by the numbers, never by
 * extra reasoning. A replay where a side produced no result at all cannot be read, so it is refused rather than
 * counted as a loss for that side (the same rule the skill trials keep, src/skill-revisions.ts).
 */
export const judgeInstructions = "You grade how well an answer does what a person asked, from 0 (not at all) to 10 (fully and correctly). "
  + "Judge only the answer against the request. Reply with JSON only: {\"score\": 7}.";
/** Tools a model-written skill is never tried with, even as practice (as trialNewSkill keeps). */
const reachesOut = new Set(["shell.execute", "remote.execute", "git.remote", "github.manage", "gitlab.manage"]);

export type Replayer = (task: ProofTask, instructions: string, context: ToolContext) => Promise<{ answer: string; finished: boolean; tokens: number } | null>;
export type Grader = (task: ProofTask, answer: string) => Promise<number | null>;

/** The real replay and grading, through the runtime, on the chosen connection. */
export function runtimeProof(store: Store, runtime: Runtime, preset: ModelPreset): ProofParts {
  const replay: Replayer = async (task, instructions, context) => {
    const permissions = [...context.permissions].filter((permission) => !reachesOut.has(permission));
    const run = await runtime.delegate(task.prompt, context, permissions, instructions, { timeoutMs: 120000, model: preset.id }).catch(() => null);
    if (!run) return null;
    const usage = store.usage(run.id) as { estimatedInput?: number; estimatedOutput?: number };
    return { answer: run.output, finished: run.status === "completed", tokens: (usage.estimatedInput ?? 0) + (usage.estimatedOutput ?? 0) };
  };
  const grade = (parent: { id: string }, context: ToolContext): Grader => async (task, answer) => {
    const run = store.run(parent.id);
    if (!run) return null;
    const reply = await runtime.completeAside(run, context, preset, `${judgeInstructions}\n\nThe request:\n${task.prompt.slice(0, 3000)}\n\nThe answer:\n${answer.slice(0, 6000)}`).catch(() => null);
    const checked = reply === null ? null : checkResult(reply, { type: "object", properties: { score: { type: "number" } } });
    const score = checked?.status === "resolved" ? (checked.value as { score?: unknown }).score : null;
    return typeof score === "number" && Number.isFinite(score) ? Math.min(10, Math.max(0, score)) / 10 : null;
  };
  return { replay, grade };
}

const side = (): ProofSide => ({ scores: [], mean: 0, errors: 0, tokens: 0 });
const noSkill = "No skill is being tried. Do the task as you normally would.";

export interface ProofRequest {
  tasks: ProofTask[];
  /** The skill file being proved. */
  withDocument: string;
  /** What it is compared with: no skill for a new one, or the files it would replace for a merge. */
  baseline: string | null;
  label: string;
}
export type ProofParts = { replay: Replayer; grade: (parent: { id: string }, context: ToolContext) => Grader };
/** Replays each task on the baseline and with the skill, and grades both answers. */
export async function prove(store: Store, runtime: Runtime, preset: ModelPreset, request: ProofRequest,
  parts: ProofParts = runtimeProof(store, runtime, preset)): Promise<Proof> {
  const { tasks, withDocument, baseline, label } = request;
  const { parent, context } = learningTask(store, runtime.owner, `Seasons: prove ${label} on ${tasks.length} task(s)`, runtime, true);
  const grade = parts.grade(parent, { ...context, permissions: new Set() });
  const sides = { without: side(), with: side() };
  try {
    const sidesToRun = [["without", baseline ? `The skill being tried:\n${baseline}` : noSkill], ["with", `The skill being tried:\n${withDocument}`]] as const;
    for (const task of tasks) for (const [name, instructions] of sidesToRun) {
      const done = await parts.replay(task, instructions, context);
      const score = done ? (done.finished ? await grade(task, done.answer) : 0) : null;
      if (score === null) { sides[name].errors++; continue; }
      sides[name].scores.push(score);
      sides[name].tokens += done?.tokens ?? 0;
    }
    store.finish(parent.id, "completed", `Proved ${label}`);
  } catch (error) {
    store.finish(parent.id, "failed", error instanceof Error ? error.message : String(error));
    throw error;
  }
  for (const entry of Object.values(sides)) entry.mean = entry.scores.length ? entry.scores.reduce((a, b) => a + b, 0) / entry.scores.length : 0;
  const unreadable = !tasks.length ? "no-tasks" : sides.with.errors || sides.without.errors ? "no-result" : null;
  return { tasks: tasks.length, without: sides.without, with: sides.with, gain: Math.round((sides.with.mean - sides.without.mean) * 1000) / 1000,
    unreadable, model: preset.name, ranAt: new Date().toISOString() };
}
