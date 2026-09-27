import { ProviderStreamError } from "../contracts.js";
import { ProviderHttpError } from "../provider-retry.js";
import type { Account, AccountKind, Strategy } from "./settings.js";

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
}
export const freshState = (): AccountState =>
  ({ restUntil: 0, models: new Map(), limitedUntil: 0, lastUsedAt: 0, uses: 0, lastError: null, remaining: null });

export const restMs = { refused: 5 * 60_000, billing: 60 * 60_000, rate: 60_000, limit: 60 * 60_000 } as const;

export interface Failure { scope: "account" | "model"; untilMs: number; reason: "refused" | "billing" | "rate" }

const billingCodes = new Set(["insufficient_quota", "billing_not_active", "billing_hard_limit_reached", "billing_error",
  "credit_balance_exhausted", "spend_limit_exceeded", "monthly_spend_limit_exceeded", "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded", "organization_usage_limit_exceeded"]);

/** The HTTP refusal inside an error, unless part of an answer had already arrived. */
export function httpFailure(error: unknown): ProviderHttpError | null {
  let current = error;
  for (let depth = 0; current instanceof ProviderStreamError && depth < 4; depth++) {
    if (current.estimatedOutput > 0 || current.usage !== undefined) return null;
    current = current.cause;
  }
  return current instanceof ProviderHttpError ? current : null;
}

/**
 * What a failure means for the key that caused it, or null when it says nothing about the key (a
 * service that is down fails the same way for every key, so moving on would not help).
 */
export function failureFor(error: unknown, now: number): Failure | null {
  const failure = httpFailure(error);
  if (!failure) return null;
  const wait = failure.retryAfterMs;
  if (failure.status === 401 || failure.status === 403) return { scope: "account", untilMs: now + restMs.refused, reason: "refused" };
  if (failure.status === 402 || (failure.code && billingCodes.has(failure.code)))
    return { scope: "account", untilMs: now + Math.max(restMs.billing, wait ?? 0), reason: "billing" };
  if (failure.status === 429) return { scope: "model", untilMs: now + (wait ?? restMs.rate), reason: "rate" };
  return null;
}

export function rest(state: AccountState, failure: Failure, model: string): void {
  if (failure.scope === "account") state.restUntil = Math.max(state.restUntil, failure.untilMs);
  else state.models.set(model, Math.max(state.models.get(model) ?? 0, failure.untilMs));
}

/** Why an account cannot take this request now, or null when it can. */
export function unavailable(account: Account, state: AccountState, model: string, now: number, capReached: boolean): string | null {
  if (account.disabled) return "switched off";
  if (capReached) return "reached its monthly cap";
  if (state.restUntil > now) return "resting after a refusal";
  if ((state.models.get(model) ?? 0) > now) return `resting for ${model} after a rate limit`;
  if (state.limitedUntil > now) return "reached its plan limit";
  return null;
}

/**
 * The order to try the available accounts in. `preferred` (the conversation's or the owner's
 * choice) always goes first; the strategy orders the rest.
 */
export function orderFor(strategy: Strategy, available: Account[], states: Map<string, AccountState>, cursor: number, preferred: string | null): Account[] {
  const state = (id: string) => states.get(id) ?? freshState();
  let ordered = [...available].sort((a, b) => Number(b.pinned) - Number(a.pinned));
  if (strategy === "least-used") ordered.sort((a, b) => state(a.id).uses - state(b.id).uses);
  if (strategy === "round-robin" && ordered.length > 1) {
    const start = cursor % ordered.length;
    ordered = [...ordered.slice(start), ...ordered.slice(0, start)];
  }
  const first = ordered.findIndex((account) => account.id === preferred);
  if (first > 0) ordered.unshift(...ordered.splice(first, 1));
  return ordered;
}

/**
 * Where an account that has never reported its plan window sits in the running order: in the
 * middle, ahead of one known to be nearly empty and behind one known to be nearly full. It is a
 * tie-break for choosing, and nothing else.
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
 * Sign-in accounts, when the owner allowed sharing work: the one with most of its plan window left,
 * then the one used longest ago. Pinned ones come first.
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

/**
 * mac7/account-pooling (owner decision 2026-09-19): which accounts may share work at all.
 *
 * API keys are pay-per-use and always may. Among sign-in accounts (subscription plans), the set holds
 * at most ONE of the owner's own accounts, chosen exactly as `firstChoice` chooses (the
 * conversation's pick, the owner's default, the pinned one, the first), plus every account the owner
 * marked "kept separate" (someone else's, or work's). Which own account that is never depends on
 * limits, so Branch never moves one person's work between their own identical plans to get past a
 * limit; providers treat that as abuse.
 */
export function rotationSet(kind: AccountKind, usable: Account[], defaultAccount: string | null, sticky: string | null): Account[] {
  if (kind === "api-key") return usable;
  const self = firstChoice(usable.filter((account) => !account.keptSeparate), [sticky, defaultAccount]);
  return usable.filter((account) => account.keptSeparate || account.id === self?.id);
}
