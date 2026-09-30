/** Masked frames already observed by the owner, held briefly in memory for plan-step replay. */
import { z } from 'zod';
import type { Store } from './store.js';
import type { StoredPlan } from './orchestration.js';
import type { LiveBrowser } from './live-stage.js';
import { recordingSettings } from './run-recording.js';

export type ReplayPlan = Pick<StoredPlan, 'runId' | 'createdAt' | 'steps'>;
export const ReplayRequestSchema = z.object({ step: z.string().regex(/^\d{1,3}$/).transform(Number),
  runId: z.string().uuid(), planAt: z.string().min(1).max(80) }).strict();
export interface ReplayStep { step: number; runId: string; planAt: string; at: string }
interface Entry { signature: string; planAt: string; runId: string; touched: number; frames: Map<number, LiveBrowser> }
const signature = (plan: ReplayPlan): string => JSON.stringify(plan.steps.map(step => step.title));
const caches = new WeakMap<Store, Map<string, Entry>>();
const BYTES = 2 * 1024 * 1024, STEPS = 12, CONVERSATIONS = 8, TTL = 10 * 60_000;

function cache(store: Store): Map<string, Entry> {
  let found = caches.get(store);
  if (!found) { found = new Map(); caches.set(store, found); }
  for (const [key, entry] of found) if (Date.now() - entry.touched > TTL) found.delete(key);
  return found;
}
/** A plan changes during capture: that image belongs to neither step and is discarded. */
export function sameReplayStep(before: ReplayPlan | undefined, after: ReplayPlan | undefined): number | null {
  if (!before || !after || before.runId !== after.runId || before.createdAt !== after.createdAt) return null;
  const step = before.steps.findIndex(one => one.status === 'working');
  return step >= 0 && after.steps.findIndex(one => one.status === 'working') === step
    && before.steps[step]?.title === after.steps[step]?.title ? step : null;
}
export function rememberReplay(store: Store, owner: string, key: string, plan: ReplayPlan | undefined,
  step: number | null, frame: LiveBrowser | null): void {
  const kept = cache(store);
  if (recordingSettings(store, owner).mode === 'off') { kept.delete(key); return; }
  if (!plan || step === null || !frame?.frame || frame.preview !== 'ready' || frame.runId !== plan.runId || frame.frame.length > BYTES) return;
  let entry = kept.get(key);
  if (!entry || entry.runId !== plan.runId || entry.planAt !== plan.createdAt || entry.signature !== signature(plan))
    entry = { signature: signature(plan), runId: plan.runId, planAt: plan.createdAt, touched: Date.now(), frames: new Map() };
  entry.touched = Date.now(); entry.frames.delete(step); entry.frames.set(step, { ...frame, live: false });
  let bytes = [...entry.frames.values()].reduce((sum, one) => sum + (one.frame?.length ?? 0), 0);
  while (entry.frames.size > STEPS || bytes > BYTES) {
    const first = entry.frames.keys().next().value!;
    bytes -= entry.frames.get(first)?.frame?.length ?? 0; entry.frames.delete(first);
  }
  kept.delete(key); kept.set(key, entry);
  while (kept.size > CONVERSATIONS) kept.delete(kept.keys().next().value!);
}
export function readReplay(store: Store, owner: string, key: string, newest: string | undefined, plan: ReplayPlan | undefined,
  request?: unknown): { replaySteps: ReplayStep[]; replay?: LiveBrowser | null } {
  const kept = cache(store);
  if (recordingSettings(store, owner).mode === 'off') kept.delete(key);
  const entry = kept.get(key), valid = !!entry && !!plan && entry.runId === newest && entry.runId === plan.runId && entry.planAt === plan.createdAt && entry.signature === signature(plan);
  const replaySteps = valid ? [...entry.frames].map(([step, frame]) => ({ step, runId: entry.runId, planAt: entry.planAt, at: frame.at })) : [];
  if (request === undefined) return { replaySteps };
  const input = ReplayRequestSchema.parse(request);
  const replay = valid && input.runId === entry.runId && input.planAt === entry.planAt ? entry.frames.get(input.step) ?? null : null;
  return { replaySteps, replay };
}
