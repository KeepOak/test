import type { RateLimitReading } from "../rate-limit-headers.js";

/**
 * Settings › Models › "Slow down near a rate limit": spreads a connection's requests out once the service says little
 * of its allowance is left, instead of spending the rest at full speed and then waiting out a refusal.
 *
 * It reads only what the service already said in the headers of its last answer (src/rate-limit-headers.ts); it never
 * asks a service anything to find out. A window with a tenth or more left is not slowed at all. Below that:
 * - requests: the time until the allowance refills, shared out over the requests that are left;
 * - tokens: a pause that grows from nothing at a tenth left to the whole wait at none left.
 * A window whose refill time has passed, or that the service did not date, is never waited on, and a plan's share
 * (ChatGPT's plan windows, counted as "plan") is left alone: those refill over hours or days, and the plan meter and
 * the account order already handle them.
 *
 * One wait is never longer than `maxWaitMs`, and a queue of them never reaches past `maxQueueMs`, well under the silence
 * the runtime allows a model before it calls the connection stuck (reliability.modelStallMs, 60 s as shipped), so
 * slowing down never looks like a dead connection.
 */
export const paceBelow = 0.1;
export const maxWaitMs = 15_000;
/**
 * Requests that leave together (sub-tasks at once) are queued one wait apart, each keeping its own start, for at most
 * this long ahead, still under the silence the runtime allows a model (60 s). Past it, the rest leave at its end and the
 * service's own refusal (and the next key) handles them.
 */
export const maxQueueMs = 40_000;

export function paceDelay(reading: RateLimitReading | null, now: number): number {
  if (!reading) return 0;
  let wait = 0;
  for (const window of reading.windows) {
    if (window.counts === "plan" || window.limit === null || window.limit <= 0 || window.remaining === null || window.resetAt === null) continue;
    const untilReset = Date.parse(window.resetAt) - now;
    if (!Number.isFinite(untilReset) || untilReset <= 0) continue;
    const left = Math.max(0, window.remaining) / window.limit;
    if (left >= paceBelow) continue;
    const share = window.counts === "requests" ? untilReset / (Math.max(0, window.remaining) + 1) : untilReset * (1 - left / paceBelow);
    wait = Math.max(wait, share);
  }
  return Math.min(maxWaitMs, Math.round(wait));
}

/** A wait that ends early, with the request's own reason, when the request is stopped. */
export function pause(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const done = () => { signal?.removeEventListener("abort", stop); resolve(); };
    const timer = setTimeout(done, ms);
    const stop = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener("abort", stop, { once: true });
  });
}
