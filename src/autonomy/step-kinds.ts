import { z } from "zod";
import { StartSchema } from "./timing.js";

/**
 * The kinds of step a procedure runs (the flow editor's "When", "Ask a Trunk", "If it says", "Ask me", "Wait", "Repeat",
 * "Split and gather" and "Run a flow"). "Ask a Trunk" is a step with no kind (every procedure saved before kinds existed);
 * "Ask me" is such a step marked `confirm`.
 *
 *   when   waits, mid-procedure, until a start comes round: a time of day, every so often, or a task of the owner's finishing
 *   if     reads what the step before said: when it says the words, the "yes" request goes to the Trunk, otherwise "no"
 *   wait   waits so many minutes
 *   loop   asks the same thing up to `times` times, stopping early once the answer says `until`
 *   fan    asks once for each line the step before gave (at most `maxFanItems`), and gathers the answers
 *   sub    runs another procedure's steps, as that procedure was when the owner said yes to running it from here
 *
 * "Repeat", "Split and gather" and "Run a flow" make requests nobody watches one by one, so a procedure holding any of them
 * runs only after the owner's own yes to exactly what they could do (`unattendedPlan`), with a hard cap on how many
 * requests one run may make in all. That yes is asked separately from the yes to the procedure itself.
 */
export const stepKinds = ["when", "if", "wait", "loop", "fan", "sub"] as const;
export type StepKind = (typeof stepKinds)[number] | "do";
/** The most times one "Repeat" may ask. */
export const maxRepeat = 10;
/** The most lines one "Split and gather" works through. */
export const maxFanItems = 8;
/** The most requests to a Trunk one run of a procedure may make, whatever its steps. */
export const maxUnattendedTurns = 30;

const words = z.string().trim().min(1).max(200);
export const StepSchema = z.object({
  kind: z.enum(stepKinds).optional(),
  title: z.string().trim().min(1).max(120),
  prompt: z.string().trim().max(2000).default(""),
  confirm: z.boolean().default(false),
  /** when: the start it waits for (a clock, or a task finishing; never "only when you start it"). */
  at: StartSchema.optional(),
  /** wait: how many minutes. */
  minutes: z.number().int().min(1).max(10080).optional(),
  /** if: the words to look for in what the step before said, and the request for each way. */
  contains: words.optional(),
  yes: z.string().trim().max(2000).optional(),
  no: z.string().trim().max(2000).optional(),
  /** loop: at most this many times, stopping early once the answer says `until`. */
  times: z.number().int().min(1).max(maxRepeat).optional(),
  until: words.optional(),
  /** sub: the procedure it runs, and the version of it the owner said yes to (set by the engine, never by a caller). */
  flowId: z.string().uuid().optional(),
  version: z.number().int().min(1).optional(),
}).strict().superRefine((step, context) => {
  const problem = stepProblem(step);
  if (problem) context.addIssue({ code: "custom", message: problem });
});
export type Step = z.infer<typeof StepSchema>;
export const kindOf = (step: Pick<Step, "kind">): StepKind => step.kind ?? "do";

/** What a step of its kind is missing, in plain words, or null. */
function stepProblem(step: z.infer<typeof StepSchema>): string | null {
  const kind = kindOf(step), named = `The step "${step.title}"`;
  const fields: Record<StepKind, (keyof Step)[]> = {
    do: [], when: ["at"], if: ["contains", "yes", "no"], wait: ["minutes"], loop: ["times", "until"], fan: [], sub: ["flowId", "version"],
  };
  const extra = (["at", "minutes", "contains", "yes", "no", "times", "until", "flowId", "version"] as const).find((f) => step[f] !== undefined && !fields[kind].includes(f));
  if (extra) return `${named} is not a step that takes "${extra}".`;
  if (["do", "loop", "fan"].includes(kind) && !step.prompt) return `${named} needs the request to send to the Trunk.`;
  if (kind === "when" && (!step.at || step.at.kind === "manual")) return `${named} needs a time of day, every so often, or a task finishing to wait for.`;
  if (kind === "wait" && !step.minutes) return `${named} needs how many minutes to wait.`;
  if (kind === "if" && (!step.contains || !(step.yes || step.no))) return `${named} needs the words to look for and what to ask for when it does or does not say them.`;
  if (kind === "loop" && !step.times) return `${named} needs how many times, at most, to ask.`;
  if (kind === "sub" && !step.flowId) return `${named} needs the procedure to run.`;
  if (["when", "wait", "if", "sub"].includes(kind) && step.prompt) return `${named} sends no request of its own.`;
  return null;
}

/** The most requests to a Trunk one step can make; `sub` is the steps of the procedure it runs. */
export function stepTurns(step: Step, subSteps: (flowId: string) => readonly Step[] | null): number {
  const kind = kindOf(step);
  if (kind === "when" || kind === "wait") return 0;
  if (kind === "loop") return step.times ?? 1;
  if (kind === "fan") return maxFanItems;
  if (kind === "sub") return (subSteps(step.flowId ?? "") ?? []).reduce((sum, inner) => sum + stepTurns(inner, () => null), 0);
  return 1;
}
export const unattendedKinds: ReadonlySet<StepKind> = new Set(["loop", "fan", "sub"]);
export const needsUnattendedYes = (steps: readonly Step[]): boolean => steps.some((s) => unattendedKinds.has(kindOf(s)));

/** A procedure that is run from another may only ask Trunks and read what they said: nothing that waits, asks or nests. */
export function subProblem(name: string, steps: readonly Step[]): string | null {
  const bad = steps.find((s) => ["when", "wait", "sub"].includes(kindOf(s)) || s.confirm);
  return bad ? `"${name}" cannot be run from another procedure: its step "${bad.title}" waits, asks you or runs a procedure itself.` : null;
}

/** "5 minutes", "2 hours", "1 day" for a Wait step. */
export function parseWait(text: string): number {
  const match = /^\s*(\d{1,5})\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)\s*$/i.exec(text);
  if (!match) throw new Error("Say how long to wait in minutes, hours or days, like 30 minutes or 2 hours.");
  const unit = match[2]!.toLowerCase()[0], n = Number(match[1]);
  const minutes = unit === "m" ? n : unit === "h" ? n * 60 : n * 1440;
  if (minutes < 1 || minutes > 10080) throw new Error("A wait is at least a minute and at most a week.");
  return minutes;
}
/** "5:00 PM", "17:30", "every 2 hours", "after the invoice task" for a When step. */
export function parseWhen(text: string, timezone: string): z.infer<typeof StartSchema> {
  const clean = text.trim().replace(/^when\s*:?\s*/i, "");
  const clock = /^(?:at\s+|each day at\s+|every day at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(clean);
  if (clock && (clock[2] || clock[3])) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0), half = clock[3]?.toLowerCase();
    if (half) { if (hour < 1 || hour > 12) throw new Error("That is not a time of day."); hour = (hour % 12) + (half === "pm" ? 12 : 0); }
    if (hour > 23 || minute > 59) throw new Error("That is not a time of day.");
    return { kind: "daily", time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`, timezone };
  }
  const every = /^every\s+(\d{1,4})\s*(m|mins?|minutes?|h|hrs?|hours?)$/i.exec(clean);
  if (every) {
    const minutes = Number(every[1]) * (every[2]!.toLowerCase()[0] === "h" ? 60 : 1);
    return StartSchema.parse({ kind: "every", minutes });
  }
  const after = /^after\s+(?:a\s+|the\s+|any\s+)?(?:task\s*)?(?:about\s+)?(.*)$/i.exec(clean);
  if (after) return { kind: "after-task", words: after[1]!.trim().replace(/\s+task$/i, "").slice(0, 80) };
  throw new Error("Say when to carry on: a time of day (5:00 PM), every so often (every 2 hours), or after a task (after the invoice task).");
}

/** The lines the step before gave, as the items a "Split and gather" works through (bullets and numbers taken off). */
export function fanItems(said: string): string[] {
  return said.split(/\r?\n/).map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean).slice(0, maxFanItems);
}
/** Whether what was said has the words, however it is capitalised. */
export const says = (said: string, words: string): boolean => said.toLowerCase().includes(words.toLowerCase());
