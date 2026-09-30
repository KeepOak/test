import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";
import { ProviderStreamError } from "./contracts.js";
import { ProviderHttpError } from "./provider-retry.js";
import type { FeatureMode } from "./feature-switches.js";
import type { Store } from "./store.js";

/**
 * Long work never silently dies. What a task does when the model service, the connection or Branch itself lets it
 * down part-way, and the words it leaves in its record for each (the live step list reads them, src/live-steps.ts):
 *
 * - a plan or rate limit: the connection's next account moves the work on when the owner shares work between
 *   accounts (src/accounts/pool-provider.ts); otherwise, and when no other model is in the fallback order, the task
 *   waits until the limit resets (the service's Retry-After, else the plan meter's reset time) and carries on by itself;
 * - a dropped connection: asked again after 1, 2, 4, 8, 16 and 30 seconds, then the next model or a plain ending;
 * - a restart of Branch: the task is picked up from its last step (src/never-break/resume.ts), whatever the gateway does;
 * - the owner's Pause: the task stops after the step it is on, and Resume carries it on from there.
 *
 * Both switches ship on: waiting spends nothing, and a task picked up after a restart asks again for anything that
 * needs a yes, so neither loosens an approval.
 */
export const LongWorkSettingsSchema = z.object({
  /** A task cut off by a restart carries on by itself from its last step. */
  resumeAfterRestart: z.boolean().default(true),
  /** A task that met a plan or rate limit waits for it to reset and carries on, instead of ending. */
  waitForLimits: z.boolean().default(true),
}).strict();
export type LongWorkSettings = z.infer<typeof LongWorkSettingsSchema>;
const settingKey = "long_work";

export function longWorkSettings(store: Pick<Store, "get">, owner: string): LongWorkSettings {
  const saved = LongWorkSettingsSchema.safeParse(store.get("settings", owner, settingKey)?.data ?? {});
  return saved.success ? saved.data : LongWorkSettingsSchema.parse({});
}
export function saveLongWorkSettings(store: Pick<Store, "get" | "save">, owner: string, input: unknown): LongWorkSettings {
  const value = LongWorkSettingsSchema.parse({ ...longWorkSettings(store, owner), ...LongWorkSettingsSchema.partial().parse(input) });
  store.save("settings", owner, settingKey, value);
  return value;
}

/**
 * How a start settles work a restart cut off: the gateway's own mode when it runs, else "on" while "carry on after a
 * restart" is on (it ships on), so a cut-off task is picked up from its last step without the gateway.
 */
export function resumeMode(gatewayMode: FeatureMode, settings: LongWorkSettings): FeatureMode {
  return gatewayMode !== "off" ? gatewayMode : settings.resumeAfterRestart ? "on" : "off";
}

/** How long one task started from the window may run: a day, the most any task may (src/runtime.ts runDeadline). */
export const longTaskDeadlineMs = 24 * 60 * 60 * 1000;

/* ---------- a dropped connection ---------- */
const networkCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "ENETDOWN",
  "EHOSTUNREACH", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CLOSED"]);
const codeOf = (error: unknown): string => String((error as { code?: unknown } | null)?.code ?? "");

/**
 * True when the model service could not be reached or the connection broke before any of the answer arrived: nothing
 * was charged and nothing was said, so asking again is safe. A refusal from the service is not a dropped connection.
 */
export function isNetworkDrop(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof ProviderStreamError && (current.estimatedOutput > 0 || current.usage !== undefined)) return false;
    if (current instanceof ProviderHttpError) return false;
    if (networkCodes.has(codeOf(current))) return true;
    if (current instanceof TypeError && /fetch failed|network|socket|terminated/i.test(current.message)) return true;
    if (current instanceof Error && /^(socket hang up|other side closed|terminated)$/i.test(current.message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
/** The waits between attempts after a dropped connection; past the last one the task moves on or ends. */
export const networkDelaysMs = [1000, 2000, 4000, 8000, 16000, 30000] as const;

/* ---------- a plan or rate limit ---------- */
/** The longest one wait for a limit may be: a plan window is five hours, a weekly one is not waited out. */
export const maxLimitWaitMs = 6 * 60 * 60 * 1000;
/** How many times one model call waits for a limit before the task ends with the limit's own sentence. */
export const maxLimitWaits = 4;
const limitNames = new Set(["AccountLimitError", "ProgramLimitError"]);

const quotaCodes = new Set(["insufficient_quota", "billing_not_active", "billing_hard_limit_reached", "billing_error", "credit_balance_exhausted",
  "spend_limit_exceeded", "monthly_spend_limit_exceeded", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded"]);

/**
 * When a limit this error reports resets (ms since the epoch), or null when it is not a limit or nobody said when it
 * resets. `until` on a plan limit is the pool's reading: the service's Retry-After, else the plan meter's reset time.
 * A rate limit waits its Retry-After. A spent balance or quota is not waited out: time does not refill it.
 */
export function limitResetsAt(error: unknown, now: number): number | null {
  let current = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (current instanceof ProviderStreamError && (current.estimatedOutput > 0 || current.usage !== undefined)) return null;
    const until = Number((current as { until?: unknown }).until);
    if (current instanceof Error && limitNames.has(current.name)) return Number.isFinite(until) ? Math.max(until, now + 1000) : null;
    if (current instanceof ProviderHttpError) {
      // A refusal whose body could not be read may be a spent quota in disguise: not waited out (provider-retry.ts).
      if (current.status !== 429 || current.retryAfterMs === undefined || !current.classificationAvailable
        || (current.code && quotaCodes.has(current.code))) return null;
      return now + Math.max(1000, current.retryAfterMs);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** Waits, or stops early when the task is stopped or paused (the signal's reason is thrown). */
export async function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  await wait(ms, undefined, { signal });
}

/* ---------- the owner's Pause ---------- */
/** Thrown at the next step once the owner pressed Pause: the task ends as cut off, and Resume carries it on. */
export class PausedError extends Error {
  override name = "PausedError";
  constructor() { super("Paused after this step. Nothing is lost."); }
}
/**
 * hot-update: Branch's engine is being replaced by a newer one while this task works. Like a Pause it takes effect after
 * the step the task is on, so no step is cut off half-way and none is ever done twice; unlike a Pause nobody has to
 * press Resume: the new engine carries the task on by itself (`run.handed_over`, src/hot-update/engine-handover.ts).
 */
export class HandedOverError extends PausedError {
  override name = "HandedOverError";
  constructor() { super(); this.message = "Branch updated its engine after this step; the task carries on in the new one."; }
}
/** True when the owner paused this task (Resume carries it on as a new task, which starts with `run.resumed`). */
export function pausedByOwner(store: Pick<Store, "sqlite">, runId: string): boolean {
  return !!store.sqlite.prepare("SELECT 1 FROM events WHERE run_id=? AND kind='run.paused' LIMIT 1").get(runId);
}
