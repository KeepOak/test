import type { Completion, CompletionRequest, Provider } from "../contracts.js";
import { ProviderHttpError } from "../provider-retry.js";
import { currentAccountCall, trunkSignInRefusal, type AccountCall } from "./context.js";
import {
  type AccountState, type Failure, failureFor, firstChoice, freshState, httpFailure, orderFor, rest, restMs, smartOrder, unavailable,
} from "./pool.js";
import type { Account, Pool } from "./settings.js";

/**
 * One connection answering through several accounts, the way Hermes Agent's credential pools do (owner decision
 * 2026-09-27; https://hermes-agent.nousresearch.com/docs/user-guide/features/credential-pools).
 *
 * It is on by itself once a connection has two or more switched-on accounts, API keys and sign-ins alike (the list's
 * "autoSwitch", which ships on; "Move to the next account" in Settings › Accounts). The list's strategy picks the order
 * (fill first by default: the first healthy account until it is exhausted, then the next; or round robin, or least
 * used). What moves the work on (pool.ts failureFor):
 *   429: the same account once more; the second 429 in a row moves on.
 *   402, a quota code or a plan limit: moves on at once.
 *   401: the sign-in is refreshed first and tried again; it moves on only when the refresh fails.
 *   A model the account is not entitled to: that account is benched for that model only.
 * Every move is said in the task's steps the moment it happens ("model.account_moved"). When every account is
 * exhausted the task falls through to what it did before: the wait for the reset (a sign-in's AccountLimitError,
 * src/long-work.ts), the next connection in the fallback order, or a model on this computer (src/runtime.ts fallBack).
 * With one account, or with the switch off, nothing moves.
 */
export interface PoolHooks {
  owner: string;
  pool: string;
  model: string;
  /** The pool as saved now, or null when this connection has no list of its own. */
  settings: () => Pool | null;
  states: Map<string, AccountState>;
  cursor: { value: number };
  /** The connection for one account; null means the connection as it was built. */
  providerFor: (account: string) => Promise<Provider | null>;
  /** Refreshes one account's sign-in after a 401; true when it got a new token. A key has nothing to refresh. */
  refresh?: (account: string) => Promise<boolean>;
  capReached: (account: Account) => boolean;
  record: (account: Account, completion: Completion) => void;
  /** True while someone other than the owner is using Branch on this computer. */
  personIsNotOwner: () => boolean;
  sessionChoice: (sessionId: string) => string | null;
  rememberChoice: (sessionId: string, account: string) => void;
  now: () => number;
}

/** mac7/lockdown-fix: what a Trunk's call is told when no key may answer it (see trunk-guard.ts). */
export { trunkSignInRefusal };
export const trunkKeyRefusal = (pool: string): string =>
  `This Trunk does not copy your keys and has no key picked for ${pool}. Pick one for it in Edit Trunk, under Keys.`;

/** Every account of a list is switched off: where the owner switches one on again. */
export const allSwitchedOff = "Every account of this connection is switched off. Switch one on in Settings › Accounts.";

/** A sign-in account (or every one) reached its plan limit and no other account could take the work. */
export class AccountLimitError extends Error {
  override name = "AccountLimitError";
  /** long-work: when the limit resets (ms since the epoch), so a task can wait for it and carry on (src/long-work.ts). */
  constructor(readonly pool: string, readonly account: string, message: string, readonly until?: number) { super(message); }
}

/**
 * Every key was already resting. Said as a rate limit that lasts until the first key is ready, so
 * the model list rests the whole connection and the task moves to the next one in the fallback order.
 */
export class EveryKeyRestingError extends ProviderHttpError {
  constructor(waitMs: number, reasons: string) {
    super(429, Math.max(0, waitMs), "rate_limit_exceeded");
    this.message = `Every key of this connection is resting or switched off (${reasons}).`;
  }
}

/** The words a step says about the account the work left: why, and when it is back when that is known. */
export function whyMoved(failure: Pick<Failure, "kind">, model: string, untilMs: number, known: boolean): string {
  const time = new Date(untilMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (failure.kind === "billing") return "is out of credit";
  if (failure.kind === "auth" || failure.kind === "refused") return "was refused by the service";
  if (failure.kind === "model") return `cannot use ${model}`;
  return known ? `hit its limit, resets ${time}` : "hit its limit";
}

/** A plan limit, or a 429 from a sign-in (its plan's limit), as opposed to a failure of the service itself. */
const limitLike = (failure: Failure | null, pool: Pool): boolean =>
  failure?.kind === "limit" || (failure?.kind === "rate" && pool.kind !== "api-key");

export class AccountPoolProvider {
  constructor(private readonly original: Provider, private readonly hooks: PoolHooks) {}

  complete = async (request: CompletionRequest): Promise<Completion> => {
    const pool = this.hooks.settings();
    const call = currentAccountCall();
    // mac7/lockdown-fix: a Trunk's call never falls through to a sign-in or to the owner's default.
    if (call?.trunk) return this.forTrunk(pool, call, request);
    // The one account of a list switched off is the owner saying this connection does not answer.
    if (pool?.accounts.length === 1 && pool.accounts[0]!.disabled) throw new Error(allSwitchedOff);
    if (!pool || pool.accounts.length < 2) return this.original.complete(request);
    const usable = pool.accounts.filter((account) => this.personMayUse(pool, account));
    if (!usable.length) throw new Error("None of this connection's accounts is shared with you. Ask the owner to share one.");
    return this.answer(pool, usable, request, call);
  };

  private personMayUse(pool: Pool, account: Account): boolean {
    return !this.hooks.personIsNotOwner() || (pool.kind === "api-key" && account.shared);
  }
  private state(id: string): AccountState {
    let found = this.hooks.states.get(id);
    if (!found) this.hooks.states.set(id, found = freshState());
    return found;
  }
  private preferred(pool: Pool, call: AccountCall | undefined): string | null {
    const pick = call?.trunk?.keys.accounts[pool.pool];
    if (pick) return pick;
    // mac7/lockdown-fix: a key is the Trunk's pick only. trunks-use-subscriptions: a sign-in goes on as the owner's does.
    if (call?.trunk && pool.kind === "api-key") return null;
    const chosen = call?.sessionId ? this.hooks.sessionChoice(call.sessionId) : null;
    return chosen ?? pool.defaultAccount;
  }
  /**
   * mac7/lockdown-fix (R17-005): a Trunk's keys — the one picked for it first, then the owner's other
   * keys when it copies them. trunks-use-subscriptions: a sign-in list answers a Trunk as it answers the
   * owner, but only when the owner is behind the work (`signIns`).
   */
  private forTrunk(pool: Pool | null, call: AccountCall, request: CompletionRequest): Promise<Completion> {
    if (!pool) {
      if (!call.trunk!.keys.copyFromOwner) throw new Error(trunkKeyRefusal(this.hooks.pool));
      return this.original.complete(request);
    }
    if (pool.kind !== "api-key" && call.trunk!.signIns !== true) throw new Error(trunkSignInRefusal);
    const picked = call.trunk!.keys.accounts[pool.pool];
    const usable = pool.accounts.filter((account) => this.personMayUse(pool, account)
      && (call.trunk!.keys.copyFromOwner || account.id === picked));
    if (!usable.length) throw new Error(trunkKeyRefusal(pool.pool));
    return this.answer(pool, usable, request, call);
  }
  private why(account: Account): string | null {
    return unavailable(account, this.state(account.id), this.hooks.model, this.hooks.now(), this.hooks.capReached(account));
  }

  private async attempt(account: Account, request: CompletionRequest, call: AccountCall | undefined): Promise<Completion> {
    const state = this.state(account.id);
    state.lastUsedAt = this.hooks.now();
    state.uses += 1;
    const provider = (await this.hooks.providerFor(account.id)) ?? this.original;
    const completion = await provider.complete(request);
    state.lastError = null;
    this.hooks.record(account, completion);
    call?.note?.("model.account", { pool: this.hooks.pool, account: account.id, label: account.label });
    return completion;
  }

  /**
   * The accounts to try, in order. With moving on switched off, or only one account switched on, that is the one
   * account the conversation (or the list) picked, and nothing moves.
   */
  private candidates(pool: Pool, usable: Account[], call: AccountCall | undefined): Account[] {
    const on = usable.filter((account) => !account.disabled);
    const preferred = this.preferred(pool, call);
    if (!pool.autoSwitch || on.length < 2) {
      const one = firstChoice(on, [preferred, pool.defaultAccount]);
      return one ? [one] : [];
    }
    const ready = on.filter((account) => this.why(account) === null);
    if (pool.strategy === "least-used" && pool.kind !== "api-key") return smartOrder(ready, this.hooks.states);
    // Fill first starts from the owner's pick; round robin and least used start from their own turn, a Trunk's pick aside.
    const first = pool.strategy === "priority" ? preferred : call?.trunk ? preferred : null;
    return orderFor(pool.strategy, ready, this.hooks.states, this.hooks.cursor.value++, first);
  }

  private async answer(pool: Pool, usable: Account[], request: CompletionRequest, call: AccountCall | undefined): Promise<Completion> {
    if (!usable.some((account) => !account.disabled)) throw new Error(allSwitchedOff);
    const list = this.candidates(pool, usable, call);
    let last: unknown = null, left: { account: Account; failure: Failure } | null = null;
    for (const account of list) {
      // A lone sign-in known to be at its limit is not asked again: its sentence says when it is back.
      if (list.length === 1 && pool.kind !== "api-key" && this.state(account.id).limitedUntil > this.hooks.now()) break;
      if (left) this.sayMoved(left.account, left.failure, account, call);
      try {
        const answered = await this.tryAccount(account, request, call);
        // A sign-in conversation stays on the account it moved to (its prompt cache is there now); keys go by the strategy.
        if (left && pool.kind !== "api-key" && call?.sessionId && !call.trunk) this.hooks.rememberChoice(call.sessionId, account.id);
        return answered;
      } catch (error) {
        const failure = failureFor(error, this.hooks.now());
        if (!failure || request.signal.aborted) throw error;
        this.benchOrRest(pool, account, failure, error, call);
        last = error;
        left = { account, failure };
      }
    }
    return this.exhausted(pool, usable, last);
  }

  /**
   * One account, with the tries it gets before the work moves on: a 429 is tried once more, and a 401 once more after
   * the sign-in was refreshed. Anything else, or the second failure, goes back to `answer`.
   */
  private async tryAccount(account: Account, request: CompletionRequest, call: AccountCall | undefined): Promise<Completion> {
    try { return await this.attempt(account, request, call); } catch (error) {
      const failure = failureFor(error, this.hooks.now());
      if (!failure || request.signal.aborted) throw error;
      if (failure.kind === "rate") return this.attempt(account, request, call);
      if (failure.kind === "auth" && this.hooks.refresh && await this.hooks.refresh(account.id).catch(() => false))
        return this.attempt(account, request, call);
      throw error;
    }
  }

  private benchOrRest(pool: Pool, account: Account, failure: Failure, error: unknown, call: AccountCall | undefined): void {
    if (limitLike(failure, pool)) return this.markLimited(account, error, call);
    const state = this.state(account.id);
    rest(state, failure, this.hooks.model);
    state.lastError = `${failure.reason} (${new Date(failure.untilMs).toISOString()})`;
    call?.note?.("model.account_resting", { pool: this.hooks.pool, account: account.id, label: account.label, reason: failure.reason, until: new Date(failure.untilMs).toISOString() });
  }

  /** The step line the moment the work moves on: to which account, which one it left, why, and when that one is back. */
  private sayMoved(from: Account, failure: Failure, to: Account, call: AccountCall | undefined): void {
    const state = this.state(from.id);
    const pool = this.hooks.settings();
    const limited = pool ? limitLike(failure, pool) : false;
    const until = limited ? state.limitedUntil : failure.kind === "rate" ? state.models.get(this.hooks.model) ?? failure.untilMs : failure.untilMs;
    const known = limited ? state.limitKnown === true : failure.kind === "rate";
    call?.note?.("model.account_moved", { pool: this.hooks.pool, from: from.label, account: to.id, label: to.label,
      reason: failure.kind, why: whyMoved(failure, this.hooks.model, until, known), until: new Date(until).toISOString(), known, model: this.hooks.model });
  }

  /** Every account tried, or none ready: what the task did before this list existed. */
  private exhausted(pool: Pool, usable: Account[], last: unknown): never {
    if (pool.kind === "api-key") {
      if (last) throw last;
      const reasons = usable.map((account) => `${account.label}: ${this.why(account) ?? "ready"}`).join("; ");
      throw new EveryKeyRestingError(this.firstReady(usable) - this.hooks.now(), reasons);
    }
    if (last && !limitLike(failureFor(last, this.hooks.now()), pool)) throw last;
    const on = usable.filter((account) => !account.disabled);
    // An account whose limit ended while the others were tried still counts: its known reset (now past) makes the task
    // wait a moment and ask it again, rather than end naming a later account whose reset is unknown.
    const now = this.hooks.now(), justEnded = (state: AccountState): boolean => state.limitKnown === true && state.limitedUntil > now - 60_000;
    const limited = on.filter((account) => this.state(account.id).limitedUntil > now || justEnded(this.state(account.id)));
    const soonest = [...limited].sort((a, b) => this.state(a.id).limitedUntil - this.state(b.id).limitedUntil)[0] ?? on[0]!;
    throw this.limitError(pool, on, soonest);
  }
  /** When the first of these keys can answer this model again; a minute when none of them will by itself. */
  private firstReady(accounts: Account[]): number {
    const now = this.hooks.now();
    const times = accounts.filter((account) => !account.disabled && !this.hooks.capReached(account)).map((account) => {
      const state = this.state(account.id);
      return Math.max(state.restUntil, state.models.get(this.hooks.model) ?? 0);
    });
    return times.length ? Math.max(now, Math.min(...times)) : now + restMs.rate;
  }

  private markLimited(account: Account, error: unknown, call: AccountCall | undefined): void {
    const wait = httpFailure(error)?.retryAfterMs;
    const state = this.state(account.id);
    // long-work: with no Retry-After, the plan meter's own reset time, when it has one, says when the limit ends.
    const resets = state.resetAt ? Date.parse(state.resetAt) : Number.NaN;
    const metered = Number.isFinite(resets) && resets > this.hooks.now() ? resets - this.hooks.now() : undefined;
    state.limitedUntil = this.hooks.now() + (wait ?? metered ?? restMs.limit);
    state.limitKnown = wait !== undefined || metered !== undefined;
    state.lastError = "reached its plan limit";
    call?.note?.("model.account_limit", { pool: this.hooks.pool, account: account.id, label: account.label, until: new Date(state.limitedUntil).toISOString() });
  }

  /** The sentence when no account of a sign-in list could take the work, naming one the owner could still pick. */
  private limitError(pool: Pool, on: Account[], account: Account): AccountLimitError {
    const until = new Date(this.state(account.id).limitedUntil).toISOString().slice(11, 16);
    const others = on.filter((entry) => entry.id !== account.id && this.why(entry) === null).map((entry) => `"${entry.label}"`);
    const head = `The account "${account.label}" has reached its plan limit (until about ${until} UTC).`;
    const next = others.length && !pool.autoSwitch
      ? ` Moving to the next account is off. To go on, type /account ${others[0]!.slice(1, -1)} or turn it on in Settings › Accounts (available: ${others.join(", ")}).`
      : " No other account of this connection is ready. Wait for the limit to reset, or pick another model.";
    const state = this.state(account.id);
    return new AccountLimitError(pool.pool, account.id, head + next, state.limitKnown ? state.limitedUntil : undefined);
  }
}

/** The same connection, answering through the pool. Everything but `complete` is the connection's own. */
export const originalOf = Symbol("branch.accounts.original");
export function pooled(original: Provider, hooks: PoolHooks): Provider {
  const pool = new AccountPoolProvider(original, hooks);
  return new Proxy(original, {
    get(target, property) {
      if (property === "complete") return pool.complete;
      if (property === originalOf) return target;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
export function unwrapProvider(provider: Provider): Provider {
  return ((provider as unknown as Record<symbol, Provider | undefined>)[originalOf]) ?? provider;
}
