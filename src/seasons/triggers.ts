import type { Run } from "../contracts.js";
import { jaccard, wordsOf } from "../learning-more/curator.js";
import type { Seed, Trigger } from "./garden-book.js";

/**
 * The owner's rule: a skill has to earn its place. A candidate is made only by one of four triggers, and never after
 * a task merely because it used several tools (the Hermes way, which the owner turned down):
 *
 * 1. recurring: the same kind of request, by the similarity of its words, at least three times;
 * 2. lesson: a task that failed, then succeeded in the same conversation after a fix that took real work;
 * 3. asked: the owner says "remember how to do this" (in those words, in their own request);
 * 4. budding: Branch built itself a new capability (src/seasons/budding.ts).
 *
 * Nothing here asks a model; each trigger is decided from the owner's own requests and what the tasks did.
 */
export interface Planting { trigger: Trigger; evidence: string; tasks: { prompt: string; runId: string }[]; sourceRunIds: string[] }
export interface TaskFacts { run: Run; tools: string[] }
export const sameKind = 0.5;
export const recurringAtLeast = 3;
/** The owner's words for trigger 3. */
export const askedWords = /\b(remember|learn|keep)\s+how\s+(to\s+do|you\s+did|we\s+did|i\s+did)\s+(this|that|it)\b/i;

const seen = (seeds: readonly Seed[], runIds: string[]): boolean => seeds.some((seed) => runIds.some((id) => seed.sourceRunIds.includes(id)));
const clip = (text: string, size: number): string => text.replace(/\s+/g, " ").trim().slice(0, size);

/** Trigger 1. `covered` says whether a task already used a skill; a kind that a skill already serves makes no seed. */
export function recurring(tasks: TaskFacts[], seeds: readonly Seed[], covered: (runId: string) => boolean): Planting[] {
  const groups: TaskFacts[][] = [];
  for (const task of tasks.filter((entry) => entry.run.status === "completed")) {
    const words = wordsOf(task.run.prompt);
    const group = groups.find((members) => jaccard(wordsOf(members[0]!.run.prompt), words) >= sameKind);
    if (group) group.push(task); else groups.push([task]);
  }
  return groups.filter((group) => group.length >= recurringAtLeast)
    .filter((group) => group.filter((task) => covered(task.run.id)).length < 2 && !seen(seeds, group.map((task) => task.run.id)))
    .map((group) => ({ trigger: "recurring" as const, sourceRunIds: group.map((task) => task.run.id),
      tasks: group.slice(0, 3).map((task) => ({ prompt: task.run.prompt.slice(0, 4000), runId: task.run.id })),
      evidence: group.slice(0, 6).map((task, i) => `Request ${i + 1}: ${clip(task.run.prompt, 400)}\nTools used: ${task.tools.join(", ") || "none"}\nOutcome: ${clip(task.run.output, 400)}`).join("\n\n") }));
}

/**
 * Trigger 2. A failed task, then a later finished one in the same conversation about the same thing, whose fix took
 * real work: at least two tool steps, or a tool the failed attempt never used.
 */
export function lessons(tasks: TaskFacts[], seeds: readonly Seed[]): Planting[] {
  const found: Planting[] = [];
  const ordered = [...tasks].sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt));
  for (const [i, failed] of ordered.entries()) {
    if (failed.run.status !== "failed") continue;
    const fixed = ordered.slice(i + 1).filter((task) => task.run.sessionId === failed.run.sessionId).slice(0, 3)
      .find((task) => task.run.status === "completed" && (task.tools.length >= 2 || task.tools.some((tool) => !failed.tools.includes(tool))));
    if (!fixed || seen(seeds, [failed.run.id, fixed.run.id]) || found.some((entry) => entry.sourceRunIds.includes(failed.run.id))) continue;
    found.push({ trigger: "lesson", sourceRunIds: [failed.run.id, fixed.run.id], tasks: [{ prompt: failed.run.prompt.slice(0, 4000), runId: failed.run.id }],
      evidence: `What was asked: ${clip(failed.run.prompt, 600)}\nWhat went wrong: ${clip(failed.run.output, 600)}\n`
        + `What fixed it: ${clip(fixed.run.prompt, 600)}\nTools that worked: ${fixed.tools.join(", ")}\nOutcome: ${clip(fixed.run.output, 600)}` });
  }
  return found;
}

/** Trigger 3. The requests before "remember how to do this", in the same conversation, are what the skill is proved on. */
export function asked(tasks: TaskFacts[], seeds: readonly Seed[]): Planting[] {
  const ordered = [...tasks].sort((a, b) => a.run.createdAt.localeCompare(b.run.createdAt));
  return ordered.filter((task) => askedWords.test(task.run.prompt) && !seen(seeds, [task.run.id])).flatMap((ask) => {
    const before = ordered.filter((task) => task.run.sessionId === ask.run.sessionId && task.run.createdAt < ask.run.createdAt
      && task.run.status === "completed").slice(-3);
    if (!before.length) return [];
    return [{ trigger: "asked" as const, sourceRunIds: [ask.run.id, ...before.map((task) => task.run.id)],
      tasks: before.map((task) => ({ prompt: task.run.prompt.slice(0, 4000), runId: task.run.id })),
      evidence: [...before.map((task, i) => `Request ${i + 1}: ${clip(task.run.prompt, 600)}\nTools used: ${task.tools.join(", ") || "none"}\nOutcome: ${clip(task.run.output, 600)}`),
        `The owner then said: ${clip(ask.run.prompt, 400)}`].join("\n\n") }];
  });
}
