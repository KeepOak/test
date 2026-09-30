import type { Completion, CompletionRequest, Provider } from "../contracts.js";
import { ProviderHttpError, waitForRetry } from "../provider-retry.js";
import { currentAccountCall, trunkSignInRefusal, type AccountCall } from "./context.js";
import {
  type AccountState, type Failure, failureFor, firstChoice, freshState, httpFailure, orderFor, rateBackoffMs, rest, restMs, smartOrder,
  unavailable,
} from "./pool.js";
import type { Account, Pool } from "./settings.js";
import { accountCallReceipt } from "./call-usage.js";

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
  /** The connection's name as the window shows it, for what a Trunk is told. */
  name?: string;
  /** models-ui: a Trunk's work moved on to another account (told to the owner, src/accounts/service.ts trunkMoves). */
  moved?: (move: TrunkMove) => void;
  model: string;
  /** Identity bound to the original provider, when its creator knows it. */
  originalAccount?: string;
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
  /** Waits out a short Retry-After before the same account is asked again; a test hands in its own clock. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Keeps an account's rest on disk, so a restart does not undo it (src/accounts/rests.ts). */
  saveRest?: (account: string, state: AccountState) => void;
}

/** The longest Retry-After the same account is waited for before a second try; a longer one moves the work on. */
export const sameAccountWaitMs = 5_000;
/** A plan window with less than this share left (percent) is spent: a 429 from it is its plan limit. */
const spentShare = 1;
/** A run of rate limits is forgotten a day after the last one (openclaw usage-failure-state's FAILURE_WINDOW_MS). */
const rateMemoryMs = 24 * 60 * 60_000;

/** mac7/lockdown-fix: what a Trunk's call is told when no key may answer it (see trunk-guard.ts). */
export { trunkSignInRefusal };
/* models-ui: named as the window names the connection, and pointing at the tab where the pick is made. */
export const trunkKeyRefusal = (pool: string, name?: string): string =>
  `This Trunk does not copy your accounts and has no account picked for ${name || pool}. Pick one for it in Edit Trunk › Accounts.`;

/** A Trunk's work moving from one account to another, as the owner is told it. */
export interface TrunkMove { sessionId: string; pool: string; name: string; from: string; to: string; why: string; at: string }
/** A Trunk's own accounts for a connection, in its order: its pick, then where it goes on to. */
export function trunkOrder(keys: { accounts: Record<string, string>; next?: Record<string, string[]> | undefined }, pool: string): string[] {
  return [...new Set([keys.accounts[pool], ...(keys.next?.[pool] ?? [])].filter((id): id is string => !!id))];
}

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
  constructor(waitMs: number, reasons: string, what: "key" | "account" = "key") {
    super(429, Math.max(0, waitMs), "rate_limit_exceeded");
    this.message = `Every ${what} of this connection is resting or switched off (${reasons}).`;
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

/**
 * A plan limit, as opposed to a passing rate limit. Only when the service says so (usage_limit_reached, a program's own
 * limit), or when a sign-in's plan meter says its window is spent: a burst 429 on a sign-in is a rate limit and rests
 * seconds, never until the plan's weekly window refills (openai/codex api_bridge.rs reads a 429 the same way).
 */
const limitLike = (failure: Failure | null, pool: Pool, state: AccountState): boolean =>
  failure?.kind === "limit" || (failure?.kind === "rate" && pool.kind !== "api-key"
    && state.remaining !== null && state.remaining < spentShare);

export class AccountPoolProvider {
  constructor(private readonly original: Provider, private readonly hooks: PoolHooks) {}

  complete = async (request: CompletionRequest): Promise<Completion> => {
    const pool = this.hooks.settings();
    const call = currentAccountCall();
    // mac7/lockdown-fix: a Trunk's call never falls through to a sign-in or to the owner's default.
    if (call?.trunk) return this.forTrunk(pool, call, request);
    // The one account of a list switched off is the owner saying this connection does not answer.
    if (pool?.accounts.length === 1 && pool.accounts[0]!.disabled) throw new Error(allSwitchedOff);
    if (!pool || pool.accounts.length < 2) return this.completeOriginal(request, call);
    const usable = pool.accounts.filter((account) => this.personMayUse(pool, account));
    if (!usable.length) throw new Error("None of this connection's accounts is shared with you. Ask the owner to share one.");
    return this.answer(pool, usable, request, call);
  };

  private async completeOriginal(request: CompletionRequest, call: AccountCall | undefined): Promise<Completion> {
    const completion = await this.original.complete(request);
    const account = this.hooks.originalAccount ?? null;
    const label = account ? this.hooks.settings()?.accounts.find((one) => one.id === account)?.label ?? account : null;
    // A pool default is not evidence of what the original provider used; only its creator can bind it.
    call?.note?.("model.account", accountCallReceipt(this.hooks.pool, account, label, this.hooks.model, completion, "connection"));
    return completion;
  }

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
      if (!call.trunk!.keys.copyFromOwner) throw new Error(trunkKeyRefusal(this.hooks.pool, this.hooks.name));
      return this.completeOriginal(request, call);
    }
    if (pool.kind !== "api-key" && call.trunk!.signIns !== true) throw new Error(trunkSignInRefusal);
    // models-ui: its pick, then the accounts it goes on to (keys.next), and the owner's others only when it copies them.
    const own = trunkOrder(call.trunk!.keys, pool.pool);
    const usable = pool.accounts.filter((account) => this.personMayUse(pool, account)
      && (call.trunk!.keys.copyFromOwner || own.includes(account.id)));
    if (!usable.length) throw new Error(trunkKeyRefusal(pool.pool, this.hooks.name));
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
    // An answer ends a run of rate limits, so the next one rests 30 seconds again.
    if (state.rateFailures) { state.rateFailures = 0; this.hooks.saveRest?.(account.id, state); }
    this.hooks.record(account, completion);
    call?.note?.("model.account", accountCallReceipt(this.hooks.pool, account.id, account.label, this.hooks.model, completion));
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
    const ordered = orderFor(pool.strategy, ready, this.hooks.states, this.hooks.cursor.value++, first);
    // models-ui: a Trunk goes through its own accounts in its own order first, then (when it copies them) the owner's.
    const own = call?.trunk ? trunkOrder(call.trunk.keys, pool.pool) : [];
    const rank = (account: Account): number => { const at = own.indexOf(account.id); return at < 0 ? own.length : at; };
    return own.length ? [...ordered].sort((a, b) => rank(a) - rank(b)) : ordered;
  }

  private async answer(pool: Pool, usable: Account[], request: CompletionRequest, call: AccountCall | undefined): Promise<Completion> {
    if (!usable.some((account) => !account.disabled)) throw new Error(allSwitchedOff);
    const list = this.candidates(pool, usable, call);
    let last: unknown = null, left: { account: Account; failure: Failure; limited: boolean } | null = null;
    for (const account of list) {
      // A lone sign-in known to be at its limit is not asked again: its sentence says when it is back.
      if (list.length === 1 && pool.kind !== "api-key" && this.state(account.id).limitedUntil > this.hooks.now()) break;
      if (left) this.sayMoved(left.account, left.failure, left.limited, account, call);
      try {
        const answered = await this.tryAccount(account, request, call);
        // A sign-in conversation stays on the account it moved to (its prompt cache is there now); keys go by the strategy.
        if (left && pool.kind !== "api-key" && call?.sessionId && !call.trunk) this.hooks.rememberChoice(call.sessionId, account.id);
        return answered;
      } catch (error) {
        const failure = failureFor(error, this.hooks.now());
        if (!failure || request.signal.aborted) throw error;
        const limited = this.benchOrRest(pool, account, failure, error, call);
        last = error;
        left = { account, failure, limited };
      }
    }
    return this.exhausted(pool, usable, last, left?.limited ?? false);
  }

  /**
   * One account, with the tries it gets before the work moves on: a 429 is tried once more, and a 401 once more after
   * the sign-in was refreshed. Anything else, or the second failure, goes back to `answer`.
   */
  private async tryAccount(account: Account, request: CompletionRequest, call: AccountCall | undefined): Promise<Completion> {
    try { return await this.attempt(account, request, call); } catch (error) {
      const failure = failureFor(error, this.hooks.now());
      if (!failure || request.signal.aborted) throw error;
      if (failure.kind === "rate") {
        // The service's own Retry-After is waited for (up to a few seconds) before the same account is asked again;
        // a longer one moves the work on at once, and the account rests for it.
        const wait = httpFailure(error)?.retryAfterMs ?? 0;
        if (wait > sameAccountWaitMs) throw error;
        if (wait > 0) await (this.hooks.sleep ?? waitForRetry)(wait, request.signal);
        return this.attempt(account, request, call);
      }
      if (failure.kind === "auth" && this.hooks.refresh && await this.hooks.refresh(account.id).catch(() => false))
        return this.attempt(account, request, call);
      throw error;
    }
  }

  /** Rests or benches the account that failed; true when that was its plan limit. */
  private benchOrRest(pool: Pool, account: Account, failure: Failure, error: unknown, call: AccountCall | undefined): boolean {
    const state = this.state(account.id);
    if (limitLike(failure, pool, state)) { this.markLimited(account, error, call); return true; }
    if (failure.kind === "rate") failure = this.rateRest(state, failure, error);
    rest(state, failure, this.hooks.model, this.hooks.now());
    if (failure.kind === "rate") failure = { ...failure, untilMs: state.models.get(this.hooks.model) ?? failure.untilMs };
    state.lastError = `${failure.reason} (${new Date(failure.untilMs).toISOString()})`;
    this.hooks.saveRest?.(account.id, state);
    call?.note?.("model.account_resting", { pool: this.hooks.pool, account: account.id, label: account.label, reason: failure.reason, until: new Date(failure.untilMs).toISOString() });
    return false;
  }

  /** A plain rate limit rests as long as Retry-After says, else 30 s doubling with each one in a row (rateBackoffMs). */
  private rateRest(state: AccountState, failure: Failure, error: unknown): Failure {
    const now = this.hooks.now();
    if (state.lastRateAt !== undefined && now - state.lastRateAt > rateMemoryMs) state.rateFailures = 0;
    state.rateFailures = (state.rateFailures ?? 0) + 1;
    state.lastRateAt = now;
    const said = httpFailure(error)?.retryAfterMs;
    return { ...failure, untilMs: now + (said ?? rateBackoffMs(state.rateFailures)) };
  }

  /** The step line the moment the work moves on: to which account, which one it left, why, and when that one is back. */
  private sayMoved(from: Account, failure: Failure, limited: boolean, to: Account, call: AccountCall | undefined): void {
    const state = this.state(from.id);
    const until = limited ? state.limitedUntil : failure.kind === "rate" ? state.models.get(this.hooks.model) ?? failure.untilMs : failure.untilMs;
    const known = limited ? state.limitKnown === true : failure.kind === "rate";
    const why = whyMoved(failure, this.hooks.model, until, known);
    call?.note?.("model.account_moved", { pool: this.hooks.pool, from: from.label, account: to.id, label: to.label,
      reason: failure.kind, why, until: new Date(until).toISOString(), known, model: this.hooks.model });
    // models-ui: a Trunk's work moving on is told to the owner too, wherever they are in the window.
    if (call?.trunk) this.hooks.moved?.({ sessionId: call.sessionId ?? "", pool: this.hooks.pool, name: this.hooks.name ?? this.hooks.pool,
      from: from.label, to: to.label, why, at: new Date(this.hooks.now()).toISOString() });
  }

  /** Every account tried, or none ready: what the task did before this list existed. */
  private exhausted(pool: Pool, usable: Account[], last: unknown, lastLimited: boolean): never {
    if (pool.kind === "api-key") {
      if (last) throw last;
      const reasons = usable.map((account) => `${account.label}: ${this.why(account) ?? "ready"}`).join("; ");
      throw new EveryKeyRestingError(this.firstReady(usable) - this.hooks.now(), reasons);
    }
    if (last && !lastLimited) throw last;
    const on = usable.filter((account) => !account.disabled);
    // An account whose limit ended while the others were tried still counts: its known reset (now past) makes the task
    // wait a moment and ask it again, rather than end naming a later account whose reset is unknown.
    const now = this.hooks.now(), justEnded = (state: AccountState): boolean => state.limitKnown === true && state.limitedUntil > now - 60_000;
    const limited = on.filter((account) => this.state(account.id).limitedUntil > now || justEnded(this.state(account.id)));
    // A sign-in that is only resting after a rate limit is back in seconds: said as a rate limit that lasts until the
    // first one is ready (as for keys), so the task waits or falls back instead of stopping on a plan limit it never hit.
    const resting = on.filter((account) => this.state(account.id).limitedUntil <= now && this.why(account) !== null);
    if (resting.length && !on.some((account) => this.state(account.id).limitedUntil <= now && justEnded(this.state(account.id))))
      throw new EveryKeyRestingError(this.firstReady(resting) - now, on.map((account) => `${account.label}: ${this.why(account) ?? "ready"}`).join("; "), "account");
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
    const refusal = httpFailure(error), now = this.hooks.now();
    // What the refusal said first: its body's resets_at (openai/codex api_bridge.rs), then its Retry-After.
    const saidAt = refusal?.resetsAtMs ?? (refusal?.retryAfterMs !== undefined ? now + refusal.retryAfterMs : undefined);
    const said = saidAt !== undefined && saidAt > now ? saidAt : undefined;
    const state = this.state(account.id);
    // long-work: else the plan meter's own reset time, when it has one. That is the tightest window's: the one that is
    // spent when the meter made this a limit (limitLike), and the best guess for a plan limit that said nothing else.
    const resets = state.resetAt ? Date.parse(state.resetAt) : Number.NaN;
    const metered = Number.isFinite(resets) && resets > now ? resets : undefined;
    state.limitedUntil = said ?? metered ?? now + restMs.limit;
    state.limitKnown = said !== undefined || metered !== undefined;
    state.lastError = "reached its plan limit";
    call?.note?.("model.account_limit", { pool: this.hooks.pool, account: account.id, label: account.label, until: new Date(state.limitedUntil).toISOString() });
    this.hooks.saveRest?.(account.id, state);
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
