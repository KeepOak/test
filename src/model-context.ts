import type { Store } from "./store.js";
import { ProviderHttpError } from "./provider-retry.js";

/**
 * Dogfood D1/D22 (qa/DOGFOOD-0005, 0110): every conversation was held to 20,000 tokens of context, whatever model
 * answered, so two turns of web reading filled it ("Room left 0%") and the task stopped with no reply. How much room
 * there is now comes from the model that answers:
 *
 *   1. what the service itself refused: a request it turned down for being too long teaches the limit for that
 *      connection (kept per connection, only ever lowered), and the round is fitted again and retried;
 *   2. what the connection reports: a model on this computer says how much context it was loaded with;
 *   3. otherwise where it runs: a model on this computer keeps the old 20,000, and a hosted model gets 128,000, the
 *      smallest window of the hosted model families Branch connects to, which (1) lowers the first time it is wrong.
 *
 * The owner's own figure in Settings (the compaction knob) still wins over all of these.
 */
export const localWindowDefault = 20_000;
export const hostedWindowDefault = 128_000;
/** Never learned below this: a refusal for some other reason must not shrink a connection to nothing. */
const smallestLearned = 4_000;
const learnedKey = "model-context-windows";

type Reader = Pick<Store, "get">;
type Writer = Pick<Store, "get" | "save">;

function learned(store: Reader, owner: string): Record<string, number> {
  const data = store.get("settings", owner, learnedKey)?.data as { windows?: unknown } | undefined;
  const windows = data?.windows && typeof data.windows === "object" ? data.windows as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(windows).filter((entry): entry is [string, number] =>
    typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= smallestLearned));
}

/** The room a connection has, in estimated tokens, before the owner's own figure is applied. */
export function modelWindow(store: Reader, owner: string, preset: { id: string; contextWindow?: number | undefined } | undefined, local: boolean): number {
  const taught = preset ? learned(store, owner)[preset.id] : undefined;
  if (taught) return taught;
  if (preset?.contextWindow && preset.contextWindow > 0) return preset.contextWindow;
  return local ? localWindowDefault : hostedWindowDefault;
}

/**
 * A request of `sent` estimated tokens was refused as too long by this connection: its window is below that. The
 * figure kept is a fifth under what was sent, and only ever lowered.
 */
export function learnWindow(store: Writer, owner: string, presetId: string, sent: number, current: number): number {
  const next = Math.max(smallestLearned, Math.floor(Math.min(current, sent) * 0.8));
  const windows = learned(store, owner);
  if (windows[presetId] !== undefined && windows[presetId]! <= next) return windows[presetId]!;
  store.save("settings", owner, learnedKey, { windows: { ...windows, [presetId]: next } });
  return next;
}

/** Whether a model service refused a request for being longer than its context window. */
export function contextOverflow(error: unknown): boolean {
  const refusal = error instanceof ProviderHttpError ? error
    : (error as { cause?: unknown })?.cause instanceof ProviderHttpError ? (error as { cause: ProviderHttpError }).cause : null;
  return refusal?.code === "context_length_exceeded";
}
