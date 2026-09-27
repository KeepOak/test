import type { Store } from "./store.js";
import { ProviderHttpError } from "./provider-retry.js";
import { overflowWordsIn, statedIn } from "./context-words.js";

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

const reportedKey = "model-context-published";

function reported(store: Reader, owner: string): Record<string, number> {
  const data = store.get("settings", owner, reportedKey)?.data as { windows?: unknown } | undefined;
  const windows = data?.windows && typeof data.windows === "object" ? data.windows as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(windows).filter((entry): entry is [string, number] =>
    typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= smallestLearned));
}
/** What a connection's own model list says its model's window is (src/model-info.ts), kept per connection. */
export function rememberPublished(store: Writer, owner: string, presetId: string, window: number): void {
  const windows = reported(store, owner);
  if (windows[presetId] === window || window < smallestLearned) return;
  store.save("settings", owner, reportedKey, { windows: { ...windows, [presetId]: Math.floor(window) } });
}

/**
 * The room a connection has, in estimated tokens, before the owner's own figure is applied: what its service refused
 * (the lowest wins), else what its model list publishes, else what the connection reports, else where it runs.
 */
export function modelWindow(store: Reader, owner: string, preset: { id: string; contextWindow?: number | undefined } | undefined, local: boolean): number {
  const taught = preset ? learned(store, owner)[preset.id] : undefined;
  const published = preset ? reported(store, owner)[preset.id] : undefined;
  if (taught) return published ? Math.min(taught, published) : taught;
  if (published) return published;
  if (preset?.contextWindow && preset.contextWindow > 0) return preset.contextWindow;
  return local ? localWindowDefault : hostedWindowDefault;
}

/**
 * A request of `sent` estimated tokens was refused as too long by this connection: its window is below that, so the
 * room kept is a fifth under what was sent, or a tenth under the maximum the service stated when that is lower
 * (Branch's counts are estimates). Only ever lowered.
 */
export function learnWindow(store: Writer, owner: string, presetId: string, sent: number, current: number, stated?: number | null): number {
  // What was sent was too much, so the room is a fifth under it; a stated maximum can only bring it lower still.
  const basis = Math.min(Math.min(current, sent) * 0.8, stated && stated >= smallestLearned ? stated * 0.9 : Infinity);
  const next = Math.max(smallestLearned, Math.floor(basis));
  const windows = learned(store, owner);
  if (windows[presetId] !== undefined && windows[presetId]! <= next) return windows[presetId]!;
  store.save("settings", owner, learnedKey, { windows: { ...windows, [presetId]: next } });
  return next;
}

/** What an error says about the model's window: whether it was an overflow, and the maximum it stated, if any. */
export function overflowOf(error: unknown): { overflow: boolean; stated: number | null } {
  let at: unknown = error;
  for (let depth = 0; at && depth < 5; depth++) {
    if (at instanceof ProviderHttpError && at.code === "context_length_exceeded") return { overflow: true, stated: at.contextLimit ?? null };
    const words = at instanceof Error ? at.message : typeof at === "string" ? at : "";
    if (words && !(at instanceof ProviderHttpError) && overflowWordsIn(words)) return { overflow: true, stated: statedIn(words) };
    at = (at as { cause?: unknown })?.cause;
  }
  return { overflow: false, stated: null };
}
/** Whether a model service refused a request for being longer than its context window. */
export function contextOverflow(error: unknown): boolean {
  return overflowOf(error).overflow;
}
