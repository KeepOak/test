import { ProviderStreamError } from "../contracts.js";
import { ProviderHttpError } from "../provider-retry.js";
import type { Account, Strategy } from "./settings.js";

/**
 * Choosing an account and resting one that failed.
 *
 * The shape follows Hermes Agent's credential pool (`agent/credential_pool.py` and
 * `agent/credential_pool_model_cooldowns.py`, MIT, Copyright (c) 2025 Nous Research; see
 * THIRD_PARTY_NOTICES.md): the strategies (priority, round robin, least used), a rest for a whole
 * credential after a billing or sign-in failure, and a rest for one model only after a plain rate
 * limit, whose length is the service's own Retry-After when it gives one. Written again for Branch.
 */
export interface AccountState {
  /** The whole account rests until then (billing, a refused key). */
  restUntil: number;
  /** One model rests on this account until then (a rate limit). */
  models: Map<string, number>;
  /** A sign-in account that reached its plan limit, until then (or an hour, when nobody said). */
  limitedUntil: number;
  lastUsedAt: number;
  uses: number;
  lastError: string | null;
  /** Share of the plan window left, 0 to 100, when the service reports it. */
  remaining: number | null;
  /** When that plan window refills, as the service said (ISO), or null when it did not say. */
  resetAt?: string | null;
  /** long-work: true when `limitedUntil` is what the service or the plan meter said, not the hour assumed. */
  limitKnown?: boolean;
  /** Plain rate limits (429s that are not a plan limit) in a row with no answer between, for the growing rest. */
  rateFailures?: number;
  /** When the last of them came (ms); a run of them older than a day is forgotten (openclaw's FAILURE_WINDOW_MS). */
  lastRateAt?: number;
}
export const freshState = (): AccountState =>
  ({ restUntil: 0, models: new Map(), limitedUntil: 0, lastUsedAt: 0, uses: 0, lastError: null, remaining: null });

export const restMs = { refused: 5 * 60_000, billing: 60 * 60_000, rate: 60_000, limit: 60 * 60_000, model: 24 * 60 * 60_000 } as const;

/**
 * What a failure means for the account that caused it (Hermes Agent's credential pool triggers, see the file's head):
 * - "rate": a 429 that is not about money or a plan. The same account is tried once more; a second 429 in a row moves on.
 * - "limit": the account's plan limit (a program's own limit, or a 429 that says so). Moves on at once.
 * - "billing": 402 or a quota code. Moves on at once; the whole account rests.
 * - "auth": 401. The sign-in is refreshed first and tried again; only when that fails does it move on.
 * - "refused": 403. Moves on; the whole account rests.
 * - "model": the account is not entitled to this model. It is benched for this model only, and the work moves on.
 * null: the failure says nothing about the account (a service that is down fails the same way for every account).
 */
export type FailureKind = "rate" | "limit" | "billing" | "auth" | "refused" | "model";
export interface Failure { kind: FailureKind; scope: "account" | "model"; untilMs: number; reason: "refused" | "billing" | "rate" | "limit" | "model" }

const billingCodes = new Set(["insufficient_quota", "billing_not_active", "billing_hard_limit_reached", "billing_error",
  "credit_balance_exhausted", "spend_limit_exceeded", "monthly_spend_limit_exceeded", "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded", "organization_usage_limit_exceeded"]);
const planLimitCodes = new Set(["usage_limit_reached", "plan_limit_reached"]);
const modelCodes = new Set(["model_not_found", "model_not_available", "unsupported_model"]);
/**
 * ChatGPT's "your plan does not include this" (openai/codex codex-rs/codex-api/src/api_bridge.rs, Apache-2.0): sent
 * with a 429, it is about the model on this account, not about time, so the account is benched for that model only.
 */
const notIncludedCodes = new Set(["usage_not_included"]);

/**
 * The rest after a plain rate limit that did not say how long: 30 seconds, doubling with each one in a row, at most a
 * day. Adapted from openclaw src/agents/auth-profiles/usage-failure-state.ts (MIT, Copyright (c) 2026 OpenClaw
 * Foundation; see THIRD_PARTY_NOTICES.md): RATE_LIMIT_BACKOFF_BASE_MS, RATE_LIMIT_BACKOFF_MAX_MS and
 * calculateCappedExponentialBackoffMs.
 */
export const rateBackoff = { baseMs: 30_000, maxMs: 24 * 60 * 60_000 } as const;
export function rateBackoffMs(inARow: number): number {
  const exponent = Math.min(Math.max(1, inARow) - 1, Math.ceil(Math.log2(rateBackoff.maxMs / rateBackoff.baseMs)));
  return Math.min(rateBackoff.maxMs, rateBackoff.baseMs * 2 ** exponent);
}

/** The HTTP refusal inside an error, unless part of an answer had already arrived. */
export function httpFailure(error: unknown): ProviderHttpError | null {
  let current = error;
  for (let depth = 0; current instanceof ProviderStreamError && depth < 4; depth++) {
    if (current.estimatedOutput > 0 || current.usage !== undefined) return null;
    current = current.cause;
  }
  return current instanceof ProviderHttpError ? current : null;
}

export function failureFor(error: unknown, now: number): Failure | null {
  if (error instanceof Error && (error.name === "ProgramLimitError" || error.name === "AccountLimitError"))
    return { kind: "limit", scope: "account", untilMs: now + restMs.limit, reason: "limit" };
  const failure = httpFailure(error);
  if (!failure) return null;
  const wait = failure.retryAfterMs;
  if (failure.code && modelCodes.has(failure.code) && [400, 403, 404].includes(failure.status))
    return { kind: "model", scope: "model", untilMs: now + restMs.model, reason: "model" };
  if (failure.code && notIncludedCodes.has(failure.code))
    return { kind: "model", scope: "model", untilMs: now + restMs.model, reason: "model" };
  if (failure.status === 401) return { kind: "auth", scope: "account", untilMs: now + restMs.refused, reason: "refused" };
  if (failure.status === 403) return { kind: "refused", scope: "account", untilMs: now + restMs.refused, reason: "refused" };
  if (failure.status === 402 || (failure.code && billingCodes.has(failure.code)))
    return { kind: "billing", scope: "account", untilMs: now + Math.max(restMs.billing, wait ?? 0), reason: "billing" };
  // A plan limit says when it ends in its body (resets_at, openai/codex api_bridge.rs), else in Retry-After.
  if (failure.status === 429 && failure.code && planLimitCodes.has(failure.code))
    return { kind: "limit", scope: "account", untilMs: failure.resetsAtMs ?? now + (wait ?? restMs.limit), reason: "limit" };
  if (failure.status === 429) return { kind: "rate", scope: "model", untilMs: now + (wait ?? restMs.rate), reason: "rate" };
  return null;
}

/**
 * Rests an account (or one model on it) after a failure. With `now`, a plain rate limit never moves a rest that is
 * already running further out (openclaw's keepActiveWindowOrRecompute, see rateBackoffMs), so a burst of 429s cannot
 * push an account's return later and later.
 */
export function rest(state: AccountState, failure: Failure, model: string, now?: number): void {
  if (failure.kind === "limit") state.limitedUntil = Math.max(state.limitedUntil, failure.untilMs);
  else if (failure.scope === "account") state.restUntil = Math.max(state.restUntil, failure.untilMs);
  else {
    const running = state.models.get(model) ?? 0;
    const keep = failure.kind === "rate" && now !== undefined && running > now;
    state.models.set(model, keep ? running : Math.max(running, failure.untilMs));
  }
}

/** Why an account cannot take this request now, or null when it can. */
export function unavailable(account: Account, state: AccountState, model: string, now: number, capReached: boolean): string | null {
  if (account.disabled) return "switched off";
  if (capReached) return "reached its monthly cap";
  if (state.restUntil > now) return "resting after a refusal";
  if ((state.models.get(model) ?? 0) > now) return `resting for ${model}`;
  if (state.limitedUntil > now) return "reached its plan limit";
  return null;
}

/**
 * The order to try the available accounts in, by the list's strategy (Hermes Agent's credential pool):
 * - "priority" (fill first): the owner's pick (the conversation's, else the list's default) first, then the list's own
 *   order, pinned ones ahead; the first healthy account is used until it is exhausted, then the next.
 * - "round-robin": the next one along each request, starting after the last one used.
 * - "least-used": the one used least so far.
 * A pick made for this conversation or this Trunk always goes first, whatever the strategy.
 */
export function orderFor(strategy: Strategy, available: Account[], states: Map<string, AccountState>, cursor: number, preferred: string | null): Account[] {
  const state = (id: string) => states.get(id) ?? freshState();
  let ordered = [...available].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  if (strategy === "least-used") ordered.sort((a, b) => state(a.id).uses - state(b.id).uses || state(a.id).lastUsedAt - state(b.id).lastUsedAt);
  if (strategy === "round-robin" && ordered.length > 1) {
    const start = cursor % ordered.length;
    ordered = [...ordered.slice(start), ...ordered.slice(0, start)];
  }
  const first = ordered.findIndex((account) => account.id === preferred);
  if (first > 0) ordered.unshift(...ordered.splice(first, 1));
  return ordered;
}

/**
 * Where an account that has never reported its plan window sits in `smartOrder`: in the middle. A tie-break for
 * choosing, and nothing else.
 *
 * mac7/usage-bar: **this number must never reach a screen.** It is not a reading; nobody said it.
 * Anything that shows the owner how much is left reads `AccountState.remaining` itself and renders
 * `null` as the words "this service does not say what it allows" — see `remainingShown()` below
 * and `src/usage-limits.ts`.
 */
export const unknownRemainingForOrder = 50;

/** What a screen may show for a plan window: the reading, or nothing at all. Never a stand-in. */
export const remainingShown = (state: AccountState | undefined): number | null =>
  state?.remaining ?? null;

/**
 * Sign-in accounts under "least used": the one with most of its plan window left, then the one used longest ago.
 * Pinned ones come first.
 */
export function smartOrder(available: Account[], states: Map<string, AccountState>): Account[] {
  const state = (id: string) => states.get(id) ?? freshState();
  const forOrder = (id: string) => state(id).remaining ?? unknownRemainingForOrder;
  return [...available].sort((a, b) =>
    Number(b.pinned) - Number(a.pinned)
    || forOrder(b.id) - forOrder(a.id)
    || state(a.id).lastUsedAt - state(b.id).lastUsedAt);
}

/**
 * The account a sign-in list answers through when nothing moves by itself: the first of `wanted`
 * (the conversation's pick, then the owner's default) that is switched on, else the pinned one,
 * else the first switched on.
 */
export function firstChoice(accounts: Account[], wanted: (string | null)[]): Account | undefined {
  for (const id of wanted) {
    const found = id ? accounts.find((account) => account.id === id && !account.disabled) : undefined;
    if (found) return found;
  }
  return accounts.find((account) => account.pinned && !account.disabled) ?? accounts.find((account) => !account.disabled);
}
