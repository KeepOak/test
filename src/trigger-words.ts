import { z } from "zod";
import { declareShape, type AnswerShape, type ShapedAnswer } from "./answer-shape.js";
import { startWords } from "./autonomy/timing.js";

/**
 * finish-soon-a: words to a trigger, confirmed (Automations › Triggers "Describe it"). The model reads the owner's words
 * and says which of the engine's two real starting events they describe, or neither:
 *
 *   app    another app or service sends Branch a message: an inbound trigger (POST /api/triggers {name, prompt})
 *   task   one of the owner's own tasks finishes, optionally one about certain words: a procedure that starts after a
 *          task (POST /api/autonomy/procedures, start after-task), which asks before it starts
 *
 * Anything else (a file appearing in a folder, an email arriving, a meeting ending) has no event source in the engine,
 * so it is refused in words and nothing is made. This only proposes: the window shows the proposal and saves nothing
 * until the owner confirms it through the ordinary routes above.
 */
export const ProposeTriggerSchema = z.object({ text: z.string().trim().min(1).max(500) }).strict();

export const notATrigger = "Branch can start work when another app sends it a message, or when one of your own tasks finishes. " +
  "It cannot watch for what these words describe yet, so nothing was made.";

/** Flat on purpose: which event, the owner's words for it, and what to do. No address, secret or permission comes back. */
export const TriggerReadingSchema = z.object({
  kind: z.enum(["app", "task", "none"]),
  when: z.string().max(200),
  what: z.string().max(2000),
  name: z.string().max(60),
  words: z.string().max(80),
}).strict();
const readingShape = declareShape("trigger_reading", TriggerReadingSchema);

export interface TriggerProposal {
  kind: "app" | "task";
  /** The event in words: the owner's own for an app, the engine's for a task. */
  when: string;
  /** What the work does, in the owner's words. */
  what: string;
  name: string;
  /** For a task: the words the finished task's request must contain ("" is any task). */
  words: string;
}

export type AskModel = (question: string, shape: AnswerShape) => Promise<ShapedAnswer>;

function modelQuestion(text: string): string {
  return [
    "The owner describes work that should start when something happens. Say which event starts it.",
    "kind app: another app or online service sends a message to Branch (for example a form submission, a new issue on GitHub, a payment notice sent by a service).",
    "kind task: one of the owner's own tasks in Branch finishes (for example 'when a task about invoices finishes'). words is the topic that task must be about, or empty for any task.",
    "kind none: anything else, such as a file appearing in a folder, an email arriving, a calendar meeting ending, or a time of day.",
    "when is the event in the owner's own words. what is what the work should do, in the owner's own words, without the part that says when. name is a short title for it.",
    "",
    `The owner's words: ${JSON.stringify(text)}`,
  ].join("\n");
}

/** The owner's words read into a trigger proposal, or the refusal in words. Nothing is saved here. */
export async function proposeTrigger(input: unknown, askModel: AskModel): Promise<TriggerProposal> {
  const { text } = ProposeTriggerSchema.parse(input);
  const answer = await askModel(modelQuestion(text), readingShape);
  if (answer.status !== "resolved") throw new Error(notATrigger);
  const reading = TriggerReadingSchema.safeParse(answer.value);
  if (!reading.success || reading.data.kind === "none" || !reading.data.what.trim()) throw new Error(notATrigger);
  const { kind, what } = reading.data;
  const words = kind === "task" ? reading.data.words.trim() : "";
  const name = (reading.data.name.trim() || what.trim()).slice(0, 60);
  const when = kind === "task" ? startWords({ kind: "after-task", words }) : reading.data.when.trim() || text;
  return { kind, when, what: what.trim(), name, words };
}
