import { z } from "zod";
import { checkResult, type ResultCheck } from "./delegation.js";

/**
 * Asking for an answer in a shape the rest of the app can rely on.
 *
 * A task says what it wants back the same way a tool declares its arguments — a zod object — and
 * zod's own `toJSONSchema` turns that into the small JSON-Schema subset the existing answer check
 * in `delegation.ts` already understands. Nothing new checks answers here: `checkResult` stays the
 * one path, and this adds only the asking and the single re-ask around it.
 *
 * A reply that does not fit is shown its own validation error and asked once more. A second reply
 * that still does not fit is refused in a plain sentence naming what was wrong, because a
 * half-parsed answer the app then builds on is worse than no answer at all.
 */
export interface AnswerShape {
  /** A short name for the shape. Providers that have a setting for this want a name for it. */
  name: string;
  schema: Record<string, unknown>;
}
export type ShapedAnswer =
  | { status: "resolved"; value: unknown; reasked: boolean }
  | { status: "refused"; reason: string; reasked: boolean;
      /** qa-fixes-3 (Q047): the model gave no reply at all on the last try; what the call failed with. */
      callError?: unknown };

const shapeName = z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/i, "A shape name is letters, digits and underscores");

/**
 * A zod declaration turned into the shape the model is asked for and the answer is checked against.
 * A zod piece that has no JSON-Schema form — a function, a promise — throws here in plain words
 * rather than quietly becoming a shape that matches anything.
 */
export function declareShape(name: string, schema: z.ZodType): AnswerShape {
  let json: Record<string, unknown>;
  try { json = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>; }
  catch (error) { throw new Error(`That shape cannot be asked for: ${error instanceof Error ? error.message : String(error)}`); }
  const { $schema: _ignored, ...rest } = json;
  return { name: shapeName.parse(name), schema: rest };
}

/** The words that tell a model what it must reply with, for connections that have no setting for it. */
export function shapeInstructions(shape: AnswerShape): string {
  return `Reply with JSON only, and nothing else — no prose, no code fence. It must match this shape exactly:\n${JSON.stringify(shape.schema)}`;
}

/** What to say when a second reply still does not fit. Names the shape and what was wrong with it. */
export function shapeRefusal(shape: AnswerShape, reason: string): string {
  return `The answer was asked for as ${shape.name} and came back in the wrong shape twice: ${reason}. Nothing was guessed at, so there is no answer to give.`;
}

/**
 * One ask, one re-ask, then a refusal. `ask` is whatever will answer — a model call, or a fake. It
 * is handed the shape as well as the words, so a connection with a setting of its own can use it;
 * the words are added either way, because a connection without that setting still has to be told.
 */
export async function askInShape(
  ask: (question: string, shape: AnswerShape) => Promise<string>,
  question: string,
  shape: AnswerShape,
): Promise<ShapedAnswer> {
  const first = await attempt(ask, question, shape);
  if (first.status === "resolved") return { status: "resolved", value: first.value, reasked: false };
  const again = `${question}\n\nYour last answer did not fit the shape that was asked for: ${first.reason}. Send the whole answer again, correctly this time.`;
  const second = await attempt(ask, again, shape);
  if (second.status === "resolved") return { status: "resolved", value: second.value, reasked: true };
  return { status: "refused", reason: shapeRefusal(shape, second.reason), reasked: true,
    ...("callError" in second ? { callError: second.callError } : {}) };
}

/** One try: ask, then put the reply through the same check every delegated answer goes through. */
async function attempt(
  ask: (question: string, shape: AnswerShape) => Promise<string>,
  question: string,
  shape: AnswerShape,
): Promise<ResultCheck | { status: "unresolved"; reason: string; callError: unknown }> {
  let raw: string;
  try { raw = await ask(`${question}\n\n${shapeInstructions(shape)}`, shape); }
  catch (error) { return { status: "unresolved", reason: error instanceof Error ? error.message : String(error), callError: error }; }
  return checkResult(raw, shape.schema);
}
