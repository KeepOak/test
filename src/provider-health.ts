import { errorText } from "./contracts.js";
import { readRateLimit, type RateLimitReading } from "./rate-limit-headers.js";
import { maxQueueMs, paceDelay, pause } from "./model-savings/pacing.js";

/**
 * How each model connection has actually been behaving: when it last answered, how long it took,
 * what it last complained about, and how close it is to the limit the service imposes. Everything
 * here is recorded from real calls, never guessed, so the screen can say "this one is struggling"
 * with something behind it.
 *
 * mac7/usage-bar: the allowance reading itself moved to src/rate-limit-headers.ts, where it grew
 * from one unnamed window to every named window a service reports — the token side included, and
 * Anthropic's `anthropic-ratelimit-*` family, which was read as nothing at all before.
 */
export { readRateLimit, type RateLimitReading, type RateLimitWindow } from "./rate-limit-headers.js";

export interface ConnectionHealth {
  id: string;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  lastStatus: number | null;
  /** How long the last answer took, in milliseconds. */
  latencyMs: number | null;
  consecutiveFailures: number;
  rateLimit: RateLimitReading | null;
  /** "Slow down near a rate limit": the last wait before a request, in milliseconds, and when (src/model-savings/pacing.ts). */
  pacedMs: number | null;
  pacedAt: string | null;
  /** One sentence for the Settings card. */
  summary: string;
}

const empty = (id: string): ConnectionHealth => ({
  id, lastOkAt: null, lastErrorAt: null, lastError: null, lastStatus: null,
  latencyMs: null, consecutiveFailures: 0, rateLimit: null, pacedMs: null, pacedAt: null,
  summary: "Not used yet, so there is nothing to report.",
});

export class ProviderHealth {
  private readonly records = new Map<string, ConnectionHealth>();
  /** Connections whose own fetch already reports every call, so nothing counts a failure twice. */
  private readonly watched = new Set<string>();
  constructor(private readonly now: () => number = Date.now, private readonly limit = 64,
    private readonly sleep: (ms: number, signal?: AbortSignal | null) => Promise<void> = pause) {}
  /** Told the headers of every answer a watched connection received (the plan windows are read from them). */
  onHeaders: ((id: string, headers: Headers) => void) | null = null;
  /** True while the owner has "Slow down near a rate limit" on (src/index.ts reads the model-savings card). */
  pacing: (() => boolean) | null = null;
  /** Per key (one per account of a connection): the allowance its last answer reported, and when its last request left. */
  private readonly allowance = new Map<string, RateLimitReading>();
  private readonly lastStart = new Map<string, number>();

  /** True when this connection's own fetch is already writing down what happens to every call. */
  reportsForItself(id: string): boolean {
    return this.watched.has(id);
  }

  get(id: string): ConnectionHealth {
    return this.records.get(id) ?? empty(id);
  }
  list(): ConnectionHealth[] {
    return [...this.records.values()];
  }
  /** True when the last few calls all failed, which is what "this one is struggling" means. */
  failing(id: string): boolean {
    return this.get(id).consecutiveFailures > 0;
  }
  private put(record: ConnectionHealth): ConnectionHealth {
    if (!this.records.has(record.id) && this.records.size >= this.limit)
      this.records.delete(this.records.keys().next().value as string);
    this.records.set(record.id, record);
    return record;
  }
  recordSuccess(id: string, latencyMs: number, headers?: Headers): ConnectionHealth {
    const previous = this.get(id);
    return this.put({
      ...previous, id, latencyMs, consecutiveFailures: 0,
      lastOkAt: new Date(this.now()).toISOString(), lastStatus: 200,
      rateLimit: headers ? readRateLimit(headers, this.now()) ?? previous.rateLimit : previous.rateLimit,
      summary: describe({ ...previous, latencyMs, consecutiveFailures: 0 }, true),
    });
  }
  recordFailure(id: string, error: unknown, latencyMs?: number, headers?: Headers): ConnectionHealth {
    const previous = this.get(id);
    const status = (error as { status?: number }).status ?? null;
    const record: ConnectionHealth = {
      ...previous, id,
      lastErrorAt: new Date(this.now()).toISOString(),
      lastError: errorText(error).slice(0, 200),
      lastStatus: typeof status === "number" ? status : null,
      latencyMs: latencyMs ?? previous.latencyMs,
      consecutiveFailures: previous.consecutiveFailures + 1,
      rateLimit: headers ? readRateLimit(headers, this.now()) ?? previous.rateLimit : previous.rateLimit,
      summary: "",
    };
    return this.put({ ...record, summary: describe(record, false) });
  }
  /**
   * "Slow down near a rate limit": waits before a request when the allowance this key last heard of is nearly spent,
   * spacing requests that leave together (sub-tasks at once) one wait apart. Stopping the request ends the wait.
   */
  private async paceFor(id: string, key: string, signal?: AbortSignal | null): Promise<void> {
    const now = this.now(), delay = this.pacing?.() ? paceDelay(this.allowance.get(key) ?? null, now) : 0;
    if (delay <= 0) { this.lastStart.set(key, now); return; }
    // Each keeps its own start, one wait after the one before it, so requests leaving together never leave together.
    const start = Math.min(now + maxQueueMs, Math.max(now, (this.lastStart.get(key) ?? 0) + delay));
    this.lastStart.set(key, start);
    if (start <= now) return;
    await this.sleep(start - now, signal);
    this.put({ ...this.get(id), pacedMs: start - now, pacedAt: new Date(now).toISOString() });
  }
  /** A key that was replaced or removed starts with no allowance heard and no queue: the old key's never slows it. */
  forgetPacing(key: string): void {
    this.allowance.delete(key);
    this.lastStart.delete(key);
  }
  /**
   * A fetch that writes down what happened on every call made through it. The connection's own
   * fetch is wrapped once when it is built, so nothing at the call sites has to remember to report.
   * `key` names the account whose allowance paces it (each key of a connection is its own allowance).
   */
  watch(id: string, base: typeof fetch = globalThis.fetch, key: string = id): typeof fetch {
    const health = this;
    this.watched.add(id);
    return async function watched(input: string | URL | Request, init?: RequestInit) {
      await health.paceFor(id, key, init?.signal);
      const started = Date.now();
      try {
        const response = await base(input, init);
        const took = Date.now() - started;
        const said = readRateLimit(response.headers, health.now());
        if (said) health.allowance.set(key, said);
        health.onHeaders?.(id, response.headers);
        if (response.ok) health.recordSuccess(id, took, response.headers);
        else health.recordFailure(id, Object.assign(new Error(`Provider HTTP ${response.status}`), { status: response.status }), took, response.headers);
        return response;
      } catch (error) {
        health.recordFailure(id, error, Date.now() - started);
        throw error;
      }
    } as typeof fetch;
  }
}

function describe(record: ConnectionHealth, ok: boolean): string {
  if (ok) {
    const speed = record.latencyMs === null ? "" : ` in ${Math.round(record.latencyMs)} ms`;
    return `Answered${speed} the last time it was used.`;
  }
  const times = record.consecutiveFailures === 1 ? "once" : `${record.consecutiveFailures} times in a row`;
  return `Has failed ${times}. Last complaint: ${record.lastError ?? "no reason given"}`;
}

/** The fallback sentence for the "why this model" line, when the first choice was skipped. */
export function fallbackReason(health: ProviderHealth, skipped: string[], chosen: string): string | null {
  if (!skipped.length) return null;
  const troubles = skipped.map((id) => `${id} (${health.get(id).lastError ?? "resting after a failure"})`);
  return `${troubles.join(", ")} ${skipped.length > 1 ? "were" : "was"} skipped, so ${chosen} took it`;
}
