import { z } from "zod";
import type { Store } from "./store.js";
import { demoProviderName } from "./demo.js";
import { noModelProviderName } from "./no-model.js";

/**
 * The owner's setup record (settings/onboarding): whether setup is over (`done`), and how far "Set up Branch" got, so
 * leaving it halfway and opening it again from the Guide menu starts where it was left, with nothing reset:
 *
 *   step        the step the window was last on (the window's own short step names)
 *   completed   the steps continued past or chosen in; only ever added to
 *   trust       the "I understand" box on Welcome; once ticked it stays ticked, and `trustAt` says when
 *   where       where Branch runs, as picked in setup ("this", "remote" or "later"), which has no other home
 *   finishedAt  when setup was finished with its last step
 *   popups      "Show tips and pop-ups": false keeps the first-run setup, the New to Branch? card and achievement
 *               pop-ups away (approvals, questions and errors always show)
 *   welcomed    "Don't show again" on the New to Branch? card
 *   skipped     setup was left with "Skip for now" (or closed) and not opened again since: a reload does not bring it back
 *
 * Every write merges into what is saved, so no caller can wipe the rest by saving one part. Only the owner has one: a
 * household person's window reads the defaults (GET /api/state) and can neither read nor write this record (setting up
 * is the owner's, for the whole install).
 */
const StepId = z.string().regex(/^[a-z][a-z-]{0,23}$/);
const Where = z.enum(["this", "remote", "later"]);
const ParsedRecord = z.object({
  done: z.boolean().catch(false),
  completedAt: z.string().optional().catch(undefined),
  step: StepId.optional().catch(undefined),
  completed: z.array(StepId).max(32).catch([]),
  trust: z.boolean().catch(false),
  trustAt: z.string().optional().catch(undefined),
  where: Where.optional().catch(undefined),
  finishedAt: z.string().optional().catch(undefined),
  popups: z.boolean().catch(true),
  welcomed: z.boolean().catch(false),
  skipped: z.boolean().catch(false),
});
export type OnboardingRecord = z.infer<typeof ParsedRecord>;
/** What POST /api/onboarding takes: any of these, each merged. `{ done: true }` alone is what tests and older windows send. */
export const OnboardingPatchSchema = z.object({
  done: z.boolean().optional(),
  step: StepId.optional(),
  completed: z.array(StepId).max(32).optional(),
  trust: z.boolean().optional(),
  where: Where.optional(),
  finished: z.literal(true).optional(),
  popups: z.boolean().optional(),
  welcomed: z.boolean().optional(),
  skipped: z.boolean().optional(),
}).strict();

export function onboardingRecord(store: Pick<Store, "get">, owner: string): OnboardingRecord {
  const saved = ParsedRecord.safeParse(store.get("settings", owner, "onboarding")?.data ?? {});
  return saved.success ? saved.data : ParsedRecord.parse({});
}

/** Merges one change into the saved record: `completed` is only added to, and a ticked trust box stays ticked. */
export function saveOnboarding(store: Pick<Store, "get" | "save">, owner: string, patch: unknown): OnboardingRecord {
  const change = OnboardingPatchSchema.parse(patch ?? {});
  const next = onboardingRecord(store, owner), now = new Date().toISOString();
  if (change.done !== undefined) { next.done = change.done; next.completedAt = now; }
  if (change.step !== undefined) next.step = change.step;
  if (change.completed) next.completed = [...new Set([...next.completed, ...change.completed])].slice(0, 32);
  if (change.trust === true && !next.trust) { next.trust = true; next.trustAt = now; }
  if (change.where !== undefined) next.where = change.where;
  if (change.finished && !next.finishedAt) next.finishedAt = now;
  if (change.popups !== undefined) next.popups = change.popups;
  if (change.welcomed !== undefined) next.welcomed = change.welcomed;
  if (change.skipped !== undefined) next.skipped = change.skipped;
  store.save("settings", owner, "onboarding", next);
  return next;
}

/** Whether pop-ups (achievement celebrations among them) may show for the owner. */
export const popupsOn = (store: Pick<Store, "get">, owner: string): boolean => onboardingRecord(store, owner).popups;

/**
 * Dogfood B7: "How should Branch think?" is shown once, and never again once a model works. The owner's "Done" ends
 * it, and so does the first answer from a real model, so the card cannot come back over a conversation with a model
 * that is plainly answering. Neither the stand-in that refuses while no model is set up nor the tests' scripted
 * fixture is a real model, so neither ends it. How far setup got is kept.
 */
export function finishSetupOnFirstAnswer(store: Pick<Store, "get" | "save">, owner: string, provider: string): boolean {
  if (provider === demoProviderName || provider === noModelProviderName) return false;
  if (onboardingRecord(store, owner).done) return true;
  try { saveOnboarding(store, owner, { done: true }); return true; }
  catch { return false; } // a refused write leaves the card to the owner's own Done; the answer still stands
}
