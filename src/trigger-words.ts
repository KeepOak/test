import { z } from "zod";
import { declareShape, type AnswerShape, type ShapedAnswer } from "./answer-shape.js";
import { startWords } from "./autonomy/timing.js";
import { providerRefusal } from "./provider-retry.js";

/**
 * finish-soon-a: words to a trigger, confirmed (Automations › Triggers "Describe it"). The model reads the owner's words
 * and says which starting event they describe:
 *
 *   task   one of the owner's own tasks finishes, optionally one about certain words: proposed as a procedure that
 *          starts after a task (POST /api/autonomy/procedures, start after-task), which asks before it starts
 *   app    another app or service sends Branch a message. The engine has inbound triggers for that, but the app has to
 *          be given the trigger's address and secret, and no screen shows them yet, so this is refused in words
 *   none   anything else (a file appearing in a folder, an email arriving, a meeting ending) has no event source in
 *          the engine, so it is refused in words
 *
 * Nothing is made here: the window shows the proposal and saves nothing until the owner confirms it.
 */
export const ProposeTriggerSchema = z.object({ text: z.string().trim().min(1).max(500) }).strict();

/** An app's message: the trigger exists in the engine, but nothing shows the owner the address and secret to give the app. */
export const appNeedsAddress = "Work that starts when another app sends Branch a message needs that app to be given a trigger address and its secret, " +
  "and no screen shows them yet, so nothing was made. Branch can start work when one of your own tasks finishes.";

export const notATrigger = "Branch can start work when one of your own tasks finishes. It cannot watch for what these words describe yet, " +
  "so nothing was made.";

/**
 * qa-fixes-3 (Q047): the model failing is not the words describing something unsupported. Its reason in plain words,
 * with one next step.
 */
export const unreadableAnswer = "The model answered, but not in a way Branch could read, so nothing was made. " +
  "Try again, or choose another model in Settings, under Models.";
export function modelFailure(answer: Extract<ShapedAnswer, { status: "refused" }>): string {
  if (!("callError" in answer)) return unreadableAnswer;
  const error = answer.callError, plain = providerRefusal(error);
  if (plain) return `The model did not answer, so nothing was made. ${plain}`;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "The model took too long to answer, so nothing was made. Try again in a moment.";
  return "Branch could not reach the model, so nothing was made. Check the connection in Settings, under Models, then try again.";
}

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
  kind: "task";
  /** The event in the engine's words. */
  when: string;
  /** What the work does, in the owner's words. */
  what: string;
  name: string;
  /** The words the finished task's request must contain ("" is any task). */
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
  if (answer.status !== "resolved") throw new Error(modelFailure(answer));
  const reading = TriggerReadingSchema.safeParse(answer.value);
  if (!reading.success) throw new Error(unreadableAnswer);
  if (reading.data.kind === "none" || !reading.data.what.trim()) throw new Error(notATrigger);
  if (reading.data.kind === "app") throw new Error(appNeedsAddress);
  const what = reading.data.what.trim(), words = reading.data.words.trim();
  const name = (reading.data.name.trim() || what).slice(0, 60);
  return { kind: "task", when: startWords({ kind: "after-task", words }), what, name, words };
}
