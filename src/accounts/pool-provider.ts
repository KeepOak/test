import type { Completion, CompletionRequest, Provider } from "../contracts.js";
import { ProviderHttpError } from "../provider-retry.js";
import { currentAccountCall, trunkSignInRefusal, type AccountCall } from "./context.js";
import {
  type AccountState, failureFor, firstChoice, freshState, httpFailure, orderFor, rest, restMs, rotationSet, smartOrder, unavailable,
} from "./pool.js";
import type { Account, Pool } from "./settings.js";

/**
 * One connection answering through several accounts.
 *
 * API keys: the key is chosen by the pool's strategy for every request; a key that is refused or
 * rate limited rests (for as long as the service's Retry-After says) and the next key is tried in
 * the same request, so the task only moves to another connection once every key is resting.
 *
 * Sign-in accounts: the account is the conversation's choice, else the owner's default. When it
 * reaches its plan limit Branch stops and says so, naming the others; it moves on by itself only
 * when the owner turned on "share work between accounts", and then only to an account the owner
 * marked "kept separate" — never between the owner's own plans (mac7/account-pooling, `rotationSet`;
 * see docs/configuration.md for why).
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

/** A sign-in account reached its plan limit and Branch did not switch by itself. */
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

/** Refusals that come from a program's own plan limit (see src/providers/cli-agent.ts). */
const isLimit = (error: unknown): boolean =>
  httpFailure(error)?.status === 429 || (error instanceof Error && error.name === "ProgramLimitError");

export class AccountPoolProvider {
  constructor(private readonly original: Provider, private readonly hooks: PoolHooks) {}

  complete = async (request: CompletionRequest): Promise<Completion> => {
    const pool = this.hooks.settings();
    const call = currentAccountCall();
    // mac7/lockdown-fix: a Trunk's call never falls through to a sign-in or to the owner's default.
    if (call?.trunk) return this.forTrunk(pool, call, request);
    if (!pool || pool.accounts.length < 2) return this.original.complete(request);
    const usable = pool.accounts.filter((account) => this.personMayUse(pool, account));
    if (!usable.length) throw new Error("None of this connection's accounts is shared with you. Ask the owner to share one.");
    if (pool.kind === "api-key") return this.withKeys(pool, usable, request, call);
    if (pool.autoSwitch) return this.shared(pool, usable, request, call);
    return this.single(pool, usable, request, call);
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
   * owner (the Trunk's pick, else its conversation's, else the default; a limit stops it, and sharing
   * moves work only as `rotationSet` allows), but only when the owner is behind the work (`signIns`).
   */
  private forTrunk(pool: Pool | null, call: AccountCall, request: CompletionRequest): Promise<Completion> {
    // No list saved yet: the connection's one account is the owner's, so it is used only when copied.
    // A sign-in connection also refuses by itself when the owner is not behind the work (refuseSignInForTrunk).
    if (!pool) {
      if (!call.trunk!.keys.copyFromOwner) throw new Error(trunkKeyRefusal(this.hooks.pool));
      return this.original.complete(request);
    }
    if (pool.kind !== "api-key" && call.trunk!.signIns !== true) throw new Error(trunkSignInRefusal);
    const picked = call.trunk!.keys.accounts[pool.pool];
    const usable = pool.accounts.filter((account) => this.personMayUse(pool, account)
      && (call.trunk!.keys.copyFromOwner || account.id === picked));
    if (!usable.length) throw new Error(trunkKeyRefusal(pool.pool));
    if (pool.kind === "api-key") return this.withKeys(pool, usable, request, call);
    return pool.autoSwitch ? this.shared(pool, usable, request, call) : this.single(pool, usable, request, call);
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

  private async withKeys(pool: Pool, usable: Account[], request: CompletionRequest, call: AccountCall | undefined): Promise<Completion> {
    const ready = usable.filter((account) => this.why(account) === null);
    const ordered = orderFor(pool.strategy, ready, this.hooks.states, this.hooks.cursor.value++, this.preferred(pool, call));
    let last: unknown = null;
    for (const account of ordered) {
      try { return await this.attempt(account, request, call); } catch (error) {
        const failure = failureFor(error, this.hooks.now());
        if (!failure || request.signal.aborted) throw error;
        rest(this.state(account.id), failure, this.hooks.model);
        this.state(account.id).lastError = `${failure.reason} (${new Date(failure.untilMs).toISOString()})`;
        call?.note?.("model.account_resting", { pool: this.hooks.pool, account: account.id, label: account.label, reason: failure.reason, until: new Date(failure.untilMs).toISOString() });
        last = error;
      }
    }
    if (last) throw last;
    const reasons = usable.map((account) => `${account.label}: ${this.why(account) ?? "ready"}`).join("; ");
    throw new EveryKeyRestingError(this.firstReady(usable) - this.hooks.now(), reasons);
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

  private async single(pool: Pool, usable: Account[], request: CompletionRequest, call: AccountCall | undefined): Promise<Completion> {
    // mac7/account-pooling: chosen as `rotationSet` chooses the owner's own account, so both agree.
    const account = firstChoice(usable, [this.preferred(pool, call), pool.defaultAccount]);
    if (!account) throw new Error("Every account of this connection is switched off. Switch one on in Settings › Accounts.");
    if (this.state(account.id).limitedUntil > this.hooks.now()) throw this.limitError(pool, usable, account);
    try { return await this.attempt(account, request, call); } catch (error) {
      if (!isLimit(error) || request.signal.aborted) throw error;
      this.markLimited(account, error, call);
      throw this.limitError(pool, usable, account);
    }
  }

  private async shared(pool: Pool, usable: Account[], request: CompletionRequest, call: AccountCall | undefined): Promise<Completion> {
    const sticky = call?.sessionId ? this.hooks.sessionChoice(call.sessionId) : null;
    // mac7/account-pooling: at most one of the owner's own plans, plus the accounts kept separate.
    const allowed = this.mayShare(pool, usable, sticky);
    if (allowed.length < 2) return this.single(pool, usable, request, call);
    const ready = smartOrder(allowed.filter((account) => this.why(account) === null), this.hooks.states);
    // A conversation's own plan, once picked, is never replaced by Branch: were it overwritten by a
    // kept-separate account, the next limit would move the work on to the owner's default plan.
    const keepPick = usable.some((account) => account.id === sticky && !account.keptSeparate);
    const first = ready.findIndex((account) => account.id === sticky);
    if (first > 0) ready.unshift(...ready.splice(first, 1));
    for (const account of ready) {
      try {
        const completion = await this.attempt(account, request, call);
        if (call?.sessionId && account.id !== sticky && !keepPick) this.hooks.rememberChoice(call.sessionId, account.id);
        return completion;
      } catch (error) {
        if (!isLimit(error) || request.signal.aborted) throw error;
        this.markLimited(account, error, call);
      }
    }
    const fallback = allowed.find((account) => account.id === sticky) ?? allowed[0]!;
    throw this.limitError(pool, usable, fallback, "Every account this connection may share work between has reached its plan limit.");
  }

  /**
   * `rotationSet`, less the owner's own plan while the conversation is on an account kept separate
   * and another of the owner's own plans is at its limit (mac7/pooling-review). The conversation may
   * have come from that plan (the owner switched it by hand), and Branch cannot tell, so it never
   * moves it on, or points it, to a second of the owner's own plans.
   */
  private mayShare(pool: Pool, usable: Account[], current: string | null): Account[] {
    const allowed = rotationSet(pool.kind, usable, pool.defaultAccount, current);
    if (!usable.some((account) => account.id === current && account.keptSeparate)) return allowed;
    const own = allowed.find((account) => !account.keptSeparate);
    const otherOwnLimited = usable.some((account) => !account.keptSeparate && account.id !== own?.id
      && this.state(account.id).limitedUntil > this.hooks.now());
    return otherOwnLimited ? allowed.filter((account) => account.keptSeparate) : allowed;
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

  /**
   * mac7/account-pooling: the sentence names only accounts work may move to (`rotationSet`), never
   * another of the owner's own plans of this service.
   */
  private limitError(pool: Pool, usable: Account[], account: Account, lead?: string): AccountLimitError {
    const until = new Date(this.state(account.id).limitedUntil).toISOString().slice(11, 16);
    const allowed = this.mayShare(pool, usable, account.id);
    const ready = (entry: Account) => entry.id !== account.id && this.why(entry) === null;
    const others = allowed.filter(ready).map((entry) => `"${entry.label}"`);
    const ownReady = usable.some((entry) => ready(entry) && !allowed.includes(entry));
    const head = lead ?? `The account "${account.label}" has reached its plan limit (until about ${until} UTC).`;
    const next = others.length
      ? ` Branch does not switch sign-in accounts by itself. To go on, type /account ${others[0]!.slice(1, -1)} or choose another account in Settings › Accounts (available: ${others.join(", ")}).`
      : ownReady
        ? " Branch does not move your work between your own plans of one service: providers treat that as abuse. Wait for the limit to reset, or pick another model."
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
