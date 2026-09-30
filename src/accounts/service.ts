import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { audit } from "../audit.js";
import type { ChatGPTAuth } from "../chatgpt-auth.js";
import { chatgptPresetPrefix, syncChatGPTPresets } from "../chatgpt-presets.js";
import { ChatGPTProvider } from "../chatgpt-provider.js";
import { savedConnections } from "../connections-preset.js";
import type { Completion, Provider } from "../contracts.js";
import type { ModelPreset, ModelRouter } from "../models.js";
import type { NetworkPolicy } from "../network-policy.js";
import { pinnedFetch } from "../pinned-fetch.js";
import { estimateCost, pricingSettings } from "../pricing.js";
import { catalogEntry, resolveBaseUrl } from "../provider-catalog.js";
import { buildConnection } from "../provider-factory.js";
import { codexModelsFor } from "../codex-models.js";
import { CliAgentProvider, accountHomeVariables, claudeDefaultEffort, claudeDefaultModel, rowFor, runCliAgent, strippedEnvironment, type SpawnAgent } from "../providers/cli-agent.js";
import { ClaudeSubscriptionProvider, type ClaudeSubscriptionDependencies } from "../providers/claude-subscription.js";
import { claudeCodePool, claudeSubscriptionPreset } from "../providers/claude-models.js";
import { currentAccountCall, refuseSignInForTrunk, withAccountCall } from "./context.js";
import type { Store } from "../store.js";
import { ChatGPTAccounts } from "./chatgpt-accounts.js";
import { claudePlanWindows, PlanWindowStore } from "../plan-windows.js";
import { codexPlanWindows, type PlanWindowSaid } from "../rate-limit-headers.js";
import type { AccountState } from "./pool.js";
import { firstChoice, freshState, unavailable } from "./pool.js";
import { pooled, trunkOrder, unwrapProvider, type TrunkMove } from "./pool-provider.js";
import {
  type Account, type AccountKind, type Pool, accountsSettings, applyPoolingRule, keyName, keyProject, primaryAccount,
  saveAccountsSettings, saveSessionChoice, savedAccountsSettings, sessionChoice,
} from "./settings.js";
import { AccountUsageLedger } from "./usage.js";
import { AccountRestStore } from "./rests.js";
import { AccountLeases, defaultJobsPerAccount } from "./leases.js";
import { accountCallReceipt } from "./call-usage.js";
import { mergeChatGPTDuplicates } from "./dedupe.js";
import { checkProgram, type RunStatus } from "./sign-ins.js";
import { accountPresentation, identityKey, type AccountIdentity, type AccountSignIn } from "./identity.js";
import { startedWithShortLivedKey } from "../key-context.js";
import { currentPerson } from "../people/context.js";
import { type ClaudeUsageRead, claudeNoLimits, claudeUsageWindows, readChatGPTUsage, runClaudeUsage } from "./plan-read.js";

export interface AccountsDeps {
  store: Store;
  owner: string;
  models: ModelRouter;
  policy?: NetworkPolicy;
  dataDir: string;
  userAgent: string;
  /** The sign-in Branch already had; it is the first ChatGPT account. */
  chatgpt?: ChatGPTAuth;
  fetchImpl?: typeof fetch;
  spawnAgent?: SpawnAgent;
  /** In-process native protocol test seam; never accepted from user settings or requests. */
  claudeSubscription?: ClaudeSubscriptionDependencies;
  /** Test seam: asks Claude Code for its plan usage (src/accounts/plan-read.ts). */
  claudeUsage?: ClaudeUsageRead;
  /** Test seam: runs a program's status command (src/accounts/sign-ins.ts runStatus). */
  statusRun?: RunStatus;
  now?: () => number;
}
export interface HelperAccountRef { pool: string; account: string }
export interface HelperConnection { preset: ModelPreset; accountRef?: Readonly<HelperAccountRef>; release?: () => void }

/** The lists whose plan can be read from the service itself, without a message; and how often, per account. */
export const planReadEveryMs: Readonly<Record<string, number>> = {
  chatgpt: 30_000, // one small request
  "cli-claude-code": 120_000, // starts the program, which takes a while
};

/**
 * Wires the account lists into the model list. Every connection that can have several accounts is
 * registered through `wrap`, which (with the switch on) puts the pool in front of the connection.
 * With the switch off `wrap` hands the connection back untouched, so nothing changes.
 */
export class AccountsService {
  readonly ledger: AccountUsageLedger;
  /** Each account's rest, kept on disk so a restart does not undo it (src/accounts/rests.ts). */
  readonly rests: AccountRestStore;
  /** MODEL-050: which accounts helpers are working through now, so parallel helpers spread out (src/accounts/leases.ts). */
  readonly leases = new AccountLeases();
  readonly chatgptAccounts: ChatGPTAccounts;
  /** What each sign-in's plan windows were last measured at, per account, kept across restarts. */
  readonly planWindows: PlanWindowStore;
  private readonly states = new Map<string, Map<string, AccountState>>();
  private readonly cursors = new Map<string, { value: number }>();
  private readonly built = new Map<string, Provider>();
  /** Whether the first ChatGPT sign-in is signed in, as last read. */
  legacySignedIn = false;
  /** Extra ChatGPT accounts merged into another sign-in of the same account (src/accounts/dedupe.ts), so a window
   *  still waiting on one learns where it went. */
  readonly mergedInto = new Map<string, string>();
  /** models-ui: the latest moves of a Trunk's work from one account to another, newest first, for the owner (GET /api/state). */
  readonly trunkMoves: TrunkMove[] = [];
  readonly now: () => number;
  readonly primaryClaudeHome = resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));

  constructor(readonly deps: AccountsDeps) {
    this.ledger = new AccountUsageLedger(deps.store.sqlite);
    this.rests = new AccountRestStore(deps.store.sqlite);
    // Read when each sign-in is made, so a test can hand in its stand-in service afterwards.
    this.chatgptAccounts = new ChatGPTAccounts({
      locker: deps.store.locker, owner: deps.owner, userAgent: deps.userAgent, get fetch() { return deps.fetchImpl; },
    });
    this.now = deps.now ?? Date.now;
    this.planWindows = new PlanWindowStore(deps.store, deps.owner);
  }

  /**
   * Keeps what a service said about one account's plan windows: in the store (for the screens) and in
   * the account's state (the tightest share, for `smartOrder`). A reading with no window changes nothing.
   */
  notePlanWindows(pool: string, account: string, said: PlanWindowSaid[]): void {
    if (!said.length) return;
    this.planWindows.record(pool, account, said);
    const tightest = said.reduce((low, one) => (one.usedPercent > low.usedPercent ? one : low));
    const state = this.statesOf(pool).get(account) ?? freshState();
    state.remaining = Math.max(0, Math.min(100, 100 - tightest.usedPercent));
    state.resetAt = tightest.resetAt; // never an old refill time beside a new share
    this.statesOf(pool).set(account, state);
  }
  /** Why the last read of an account's plan did not give a figure, by `pool/account`, until a read does. */
  readonly planNotes = new Map<string, string>();
  private readonly planReads = new Map<string, Promise<void>>();
  private readonly planReadAt = new Map<string, number>();
  /** Claude Code reads wait for one another: each starts the program, so only one runs at a time. */
  private claudeReads: Promise<unknown> = Promise.resolve();
  canReadPlan(pool: string): boolean { return pool in planReadEveryMs; }
  /**
   * Reads one sign-in's plan windows from the service itself (src/accounts/plan-read.ts): nothing is sent to the model
   * and nothing of the plan is spent. One read per account at a time, and at most one per `planReadEveryMs`; a read
   * asked for sooner is answered by the last one. A failed read keeps the last windows and says why in `planNotes`.
   */
  readPlan(pool: string, account: string): Promise<void> {
    if (!this.canReadPlan(pool)) throw new Error("Only a ChatGPT or Claude Code sign-in can be read this way.");
    if (account !== primaryAccount && !this.pool(pool)?.accounts.some((one) => one.id === account)) throw new Error("That account is not in this list.");
    const key = `${pool}/${account}`;
    const running = this.planReads.get(key);
    if (running) return running;
    const last = this.planReadAt.get(key);
    if (last !== undefined && this.now() - last < planReadEveryMs[pool]!) return Promise.resolve();
    this.planReadAt.set(key, this.now());
    const read = this.readPlanNow(pool, account).finally(() => { this.planReads.delete(key); });
    this.planReads.set(key, read);
    return read;
  }
  private async readPlanNow(pool: string, account: string): Promise<void> {
    const key = `${pool}/${account}`;
    try {
      const said = pool === "chatgpt" ? await this.readChatGPT(account) : await this.readClaude(pool, account);
      this.notePlanWindows(pool, account, said);
      this.planNotes.delete(key);
    } catch (error) {
      this.planNotes.set(key, error instanceof Error ? error.message : String(error));
    }
  }
  private readChatGPT(account: string): Promise<PlanWindowSaid[]> {
    const auth = account === primaryAccount ? this.deps.chatgpt : this.chatgptAccounts.auth(account);
    if (!auth) throw new Error("ChatGPT sign-in is not available in this launch.");
    return readChatGPTUsage(auth, this.deps.fetchImpl ?? globalThis.fetch, this.deps.userAgent, this.now);
  }
  private async readClaude(pool: string, account: string): Promise<PlanWindowSaid[]> {
    const env = strippedEnvironment();
    env[accountHomeVariables["claude-code"]!] = account === primaryAccount ? this.primaryClaudeHome : this.homeOf(pool, account);
    const asked = this.claudeReads.then(() => (this.deps.claudeUsage ?? runClaudeUsage)(env));
    this.claudeReads = asked.catch(() => undefined);
    const answer = await asked;
    const said = claudeUsageWindows(answer, this.now());
    if (!said.length) throw new Error(claudeNoLimits);
    return said;
  }

  /**
   * The account this list answers through next, as the pool would choose it (src/accounts/pool-provider.ts): with moving
   * on switched on, the first switched-on account in its order that is not at its limit or resting, else its first
   * choice. Round robin has no fixed next, so it is the first choice there too.
   */
  usedNext(pool: string): string | null {
    const found = this.usablePool(pool);
    if (!found) return null;
    const first = firstChoice(found.accounts, [found.defaultAccount ?? null]);
    if (!found.autoSwitch || found.strategy !== "priority" || !first) return first?.id ?? null;
    const on = found.accounts.filter((account) => !account.disabled).sort((a, b) => Number(b.pinned) - Number(a.pinned));
    const ordered = [first, ...on.filter((account) => account.id !== first.id)];
    const ready = ordered.find((account) => unavailable(account, this.stateOf(pool, account.id), "", this.now(), this.capReached(pool, account)) === null);
    return (ready ?? first).id;
  }

  /**
   * Verified identity per pool/account: ChatGPT's own sign-in, or the CLI's documented status JSON.
   * Cached only in memory and shown only to the owner; generic saved labels remain separate.
   */
  readonly identities = new Map<string, string>();
  readonly signIns = new Map<string, AccountSignIn>();
  private readonly identityReads = new Map<string, Promise<void>>();
  private identityVisible(): boolean {
    return this.deps.store.profiles.scope() === this.deps.owner && !startedWithShortLivedKey() && !currentPerson();
  }
  async readIdentities(onlyPools?: readonly string[]): Promise<void> {
    if (!this.identityVisible()) return;
    const pools = new Set(this.settings().pools.filter((pool) => pool.kind !== "api-key").map((pool) => pool.pool));
    if (this.deps.chatgpt) pools.add("chatgpt");
    for (const preset of this.deps.models.presets.values()) {
      const found = this.poolFor(preset);
      if (found && found.kind !== "api-key") pools.add(found.pool);
    }
    for (const pool of pools) for (const account of new Set([primaryAccount, ...(this.pool(pool)?.accounts.map((one) => one.id) ?? [])])) {
      if (onlyPools && !onlyPools.includes(pool)) continue;
      if (!this.identityVisible()) return;
      await this.readIdentity(pool, account);
    }
  }
  private readIdentity(pool: string, account: string): Promise<void> {
    const key = `${pool}/${account}`, running = this.identityReads.get(key);
    if (running) return running;
    const known = this.signIns.get(key);
    if (known && this.now() - known.checkedAt < 60_000) return Promise.resolve();
    const reading = this.readIdentityNow(pool, account).finally(() => { this.identityReads.delete(key); });
    this.identityReads.set(key, reading);
    return reading;
  }
  private async readIdentityNow(pool: string, account: string): Promise<void> {
    if (pool === "chatgpt") {
      const auth = account === primaryAccount ? this.deps.chatgpt : this.chatgptAccounts.auth(account);
      const status = await auth?.status().catch(() => null);
      this.noteSignIn(pool, account, { installed: !!auth, signedIn: status?.signedIn ?? false,
        ...(status?.signedIn && status.email ? { identity: { email: status.email } } : {}),
        message: status?.signedIn ? "Signed in." : "Not signed in." });
      return;
    }
    const status = await checkProgram({ service: this }, { id: pool.slice(4), account }, this.deps.statusRun)
      .catch(() => ({ installed: true, signedIn: null, message: "The program did not confirm this sign-in. Check again." }));
    this.noteSignIn(pool, account, status);
  }
  noteSignIn(pool: string, account: string, status: Omit<AccountSignIn, "checkedAt">): void {
    const key = `${pool}/${account}`;
    this.signIns.set(key, { installed: status.installed, signedIn: status.signedIn,
      ...(status.signedIn === true && status.identity ? { identity: status.identity } : {}),
      message: status.message, checkedAt: this.now() });
    if (status.signedIn && status.identity?.email) this.identities.set(key, status.identity.email);
    else this.identities.delete(key);
  }
  presentation(pool: string, account: Pick<Account, "id" | "label" | "disabled">, kind?: AccountKind) {
    if (!this.identityVisible()) return { ...accountPresentation(account.label), signedIn: null, duplicateOf: null,
      ready: kind === "api-key" && !account.disabled ? true : null, signInProblem: null };
    const { status, identity, duplicateOf } = this.cachedSignIn(pool, account.id);
    const signedIn = status?.signedIn ?? null;
    let subscription: boolean | null | undefined;
    if (pool === "cli-claude-code") subscription = identity?.authMethod === "claude.ai" ? true : identity?.authMethod === "api-key" ? false : null;
    let ready = kind === "api-key" ? true : signedIn;
    if (signedIn === true && subscription !== undefined) ready = subscription;
    if (account.disabled || duplicateOf) ready = false;
    let signInProblem: string | null = status && signedIn !== true ? status.message : null;
    if (!status && kind !== "api-key") signInProblem = "This sign-in has not been checked.";
    if (signedIn === true && subscription === false) signInProblem = "Signed in with API authentication.";
    if (signedIn === true && subscription === null) signInProblem = "The program has not confirmed Claude subscription authentication.";
    if (duplicateOf) signInProblem = "This is another saved entry for the same sign-in; it is counted once.";
    return { ...accountPresentation(account.label, identity), signedIn, duplicateOf,
      ...(subscription !== undefined ? { subscription } : {}),
      ready, signInProblem };
  }
  /** Internal eligibility uses private cached facts even when the caller may not see their identity. */
  private cachedSignIn(pool: string, account: string) {
    const status = this.signIns.get(`${pool}/${account}`);
    const identity: AccountIdentity | undefined = status?.identity ?? (this.identities.has(`${pool}/${account}`) ? { email: this.identities.get(`${pool}/${account}`)! } : undefined);
    const signature = identityKey(identity), siblings = this.pool(pool)?.accounts ?? [];
    const first = signature ? siblings.find((one) => !one.disabled && identityKey(this.signIns.get(`${pool}/${one.id}`)?.identity) === signature) : undefined;
    return { status, identity, duplicateOf: first && first.id !== account ? first.id : null };
  }
  settings() { return accountsSettings(this.deps.store, this.deps.owner); }
  on(): boolean { return this.settings().mode !== "off"; }
  pool(pool: string): Pool | null { return this.settings().pools.find((entry) => entry.pool === pool) ?? null; }
  statesOf(pool: string): Map<string, AccountState> {
    let found = this.states.get(pool);
    // The rests saved before a restart come back first: the map is handed to the pool by reference.
    if (!found) this.states.set(pool, found = this.rests.load(this.deps.owner, pool, this.now()));
    return found;
  }
  stateOf(pool: string, account: string): AccountState { return this.statesOf(pool).get(account) ?? freshState(); }

  /** Which list a connection belongs to, or null when it can only ever have one account. */
  poolFor(preset: Pick<ModelPreset, "id">): { pool: string; kind: AccountKind } | null {
    if (preset.id.startsWith(chatgptPresetPrefix)) return { pool: "chatgpt", kind: "chatgpt" };
    if (claudeSubscriptionPreset(preset.id)) return { pool: claudeCodePool, kind: "cli" };
    if (preset.id.startsWith("cli-") && accountHomeVariables[preset.id.slice(4)]) return { pool: preset.id, kind: "cli" };
    const record = savedConnections(this.deps.store, this.deps.owner).find((saved) => saved.id === preset.id);
    const entry = record ? catalogEntry(record.catalogId) : undefined;
    return entry && entry.auth !== "none" ? { pool: preset.id, kind: "api-key" } : null;
  }

  /** The hook ModelRouter runs on every connection it registers. */
  wrap = (preset: ModelPreset): ModelPreset => {
    const claude = !!claudeSubscriptionPreset(preset.id);
    // models-ui: a connection registered before Claude had a default model of its own (its model was the command) gets
    // Branch's default, Opus 5.5 at medium; a model it names and an effort already set are left as they are.
    if (claude && preset.model === "claude") preset = { ...preset, model: claudeDefaultModel };
    if (preset.id === claudeCodePool && !preset.reasoning) preset = { ...preset, reasoning: claudeDefaultEffort };
    const original = claude ? this.programConnection(claudeCodePool, primaryAccount, preset.model) : unwrapProvider(preset.provider);
    // The program's first account is the connection itself: what it prints about its plan is that account's.
    if (claude && (original instanceof CliAgentProvider || original instanceof ClaudeSubscriptionProvider) && !original.onOutput)
      original.onOutput = (stdout) => this.notePlanWindows(claudeCodePool, primaryAccount, claudePlanWindows(stdout, this.now()));
    const found = this.on() ? this.poolFor(preset) : null;
    if (!found) return original === preset.provider ? preset : { ...preset, provider: original };
    return { ...preset, provider: pooled(original, this.hooksFor(found.pool, found.kind, preset)) };
  };
  /** Puts every registered connection through `wrap` again, after the switch moved. */
  rewrap(): void {
    for (const preset of [...this.deps.models.presets.values()]) this.deps.models.register(preset);
  }

  private hooksFor(pool: string, kind: AccountKind, preset: ModelPreset) {
    let cursor = this.cursors.get(pool);
    if (!cursor) this.cursors.set(pool, cursor = { value: 0 });
    const store = this.deps.store, owner = this.deps.owner;
    return {
      owner, pool, name: preset.name, model: preset.model, originalAccount: primaryAccount, states: this.statesOf(pool), cursor, now: this.now,
      moved: (move: TrunkMove) => { this.trunkMoves.unshift(move); this.trunkMoves.splice(20); },
      settings: () => this.usablePool(pool),
      providerFor: (account: string) => this.providerFor(pool, kind, preset, account),
      refresh: (account: string) => this.refreshSignIn(kind, account),
      capReached: (account: Account) => this.capReached(pool, account),
      record: (account: Account, completion: Completion) => this.record(pool, account, preset.model, completion),
      saveRest: (account: string, state: AccountState) => this.rests.save(owner, pool, account, state, this.now()),
      personIsNotOwner: () => store.profiles.scope() !== owner,
      sessionChoice: (sessionId: string) => sessionChoice(store, owner, sessionId)[pool] ?? null,
      rememberChoice: (sessionId: string, account: string) => {
        if (store.ownsSession(owner, sessionId)) saveSessionChoice(store, owner, sessionId, pool, account);
      },
    };
  }

  /** The saved pool as the connection may use it now: ChatGPT's first account only while it is signed in. */
  usablePool(pool: string): Pool | null {
    const found = this.pool(pool);
    if (!found) return null;
    return { ...found, accounts: found.accounts.map((account) => {
      const shown = this.presentation(pool, account, found.kind);
      const cached = this.cachedSignIn(pool, account.id);
      return { ...account, label: shown.label, disabled: account.disabled || cached.duplicateOf !== null
        || (found.kind !== "api-key" && (cached.status?.signedIn === false || (found.kind === "chatgpt" && account.id === primaryAccount && !this.legacySignedIn))) };
    }) };
  }

  /** After a 401: a ChatGPT sign-in gets a new token (true when it did). A key or a program has nothing to refresh. */
  private async refreshSignIn(kind: AccountKind, account: string): Promise<boolean> {
    if (kind !== "chatgpt") return false;
    const auth = account === primaryAccount ? this.deps.chatgpt : this.chatgptAccounts.auth(account);
    if (!auth) return false;
    await auth.refreshNow();
    return true;
  }

  capReached(pool: string, account: Account): boolean {
    if (account.monthlyCapUsd === null) return false;
    return this.ledger.month(this.deps.owner, pool, account.id, new Date(this.now())).costUsd >= account.monthlyCapUsd;
  }
  private record(pool: string, account: Account, model: string, completion: Completion): void {
    const usage = completion.usage ?? { input: 0, output: 0 };
    const kind = this.pool(pool)?.kind;
    // The cache reads and writes are parts of the input, priced at their own rates (src/pricing.ts).
    const tokens = { input: usage.input, output: usage.output, cached: usage.cachedInput, cacheWrite: usage.cacheWrite, cacheWrite1h: usage.cacheWrite1h };
    const cost = kind === "api-key"
      ? estimateCost(model, tokens, pricingSettings(this.deps.store, this.deps.owner).overrides).amount ?? 0 : 0;
    this.ledger.record(this.deps.owner, pool, account.id, { input: usage.input, output: usage.output, costUsd: cost }, new Date(this.now()));
  }

  /**
   * "Measure now": the smallest real request, sent straight to this one account (never through the
   * pool, so no other account can answer it). Only for a sign-in: it spends a little of the plan's
   * window and no money. What the service says about the windows comes back through the usual hooks.
   */
  async measure(pool: string, account: string, signal: AbortSignal): Promise<void> {
    if (!this.identityVisible()) throw new Error("Only the owner can measure their sign-in account");
    const current = currentAccountCall();
    if (current && current.owner !== this.deps.owner) throw new Error("This sign-in belongs to another owner");
    refuseSignInForTrunk();
    const preset = [...this.deps.models.presets.values()].find((one) => this.poolFor(one)?.pool === pool);
    const found = preset ? this.poolFor(preset) : null;
    if (!preset || !found || found.kind === "api-key") throw new Error("Only a plan sign-in can be measured this way.");
    const listed = this.pool(pool)?.accounts.some((one) => one.id === account) ?? false;
    if (account !== primaryAccount && !listed) throw new Error("That account is not in this list.");
    // The first account is the connection itself (for a program, its usual sign-in), exactly as a message would go.
    const own = await this.providerFor(pool, found.kind, preset, account);
    const provider = own ?? unwrapProvider(preset.provider);
    await withAccountCall(current ?? { owner: this.deps.owner, sessionId: "account-measure", runId: "account-measure" }, () =>
      provider.complete({ messages: [{ role: "user", content: "Reply with the single word: ok" }], tools: [], signal, maxTokens: 16 }));
  }

  /** Forgets the connections built for one account, after its key changed or it was removed. */
  dropBuilt(pool: string, account: string): void {
    for (const key of [...this.built.keys()]) if (key.startsWith(`${pool}\u0000`) && key.endsWith(`\u0000${account}`)) this.built.delete(key);
    this.deps.models.health.forgetPacing(paceKey(pool, account)); // the new key is paced by what it hears, not the old one's
  }

  private async providerFor(pool: string, kind: AccountKind, preset: ModelPreset, account: string): Promise<Provider | null> {
    // The first account is the connection itself; a program's is run the same way, but says when it hit a limit.
    if (account === primaryAccount && kind !== "cli") return null;
    const cacheKey = `${pool}\u0000${preset.id}\u0000${preset.model}\u0000${kind === "api-key" ? this.addressOf(preset.id) : ""}\u0000${account}`;
    const cached = this.built.get(cacheKey);
    if (cached) return cached;
    const made = kind === "api-key" ? await this.keyConnection(pool, preset, account)
      : kind === "chatgpt" ? this.chatgptConnection(pool, preset, account)
      : this.programConnection(pool, account, preset.model);
    this.built.set(cacheKey, made);
    return made;
  }
  /** The web address a saved key connection sends its requests to (scheme, host and port), or null. */
  addressOf(connection: string): string | null {
    const record = savedConnections(this.deps.store, this.deps.owner).find((saved) => saved.id === connection);
    const entry = record ? catalogEntry(record.catalogId) : undefined;
    if (!record || !entry) return null;
    try { return new URL(resolveBaseUrl(entry, record.extras)).origin; } catch { return null; }
  }
  private async keyConnection(pool: string, preset: ModelPreset, account: string): Promise<Provider> {
    const record = savedConnections(this.deps.store, this.deps.owner).find((saved) => saved.id === preset.id);
    if (!record) throw new Error(`The connection ${preset.id} is no longer saved`);
    // A key belongs to the address it was added for: a connection removed and added again under the
    // same name, pointing somewhere else, must never receive the old keys.
    const added = this.pool(pool)?.accounts.find((entry) => entry.id === account)?.address;
    if (!added || added !== this.addressOf(preset.id))
      throw new Error(`The key "${this.pool(pool)?.accounts.find((entry) => entry.id === account)?.label ?? account}" was added for a different address than this connection now uses, so Branch did not send it. Remove it and add it again in Settings › Accounts.`);
    const name = keyName(account), project = keyProject(pool);
    const key = (await this.deps.store.locker.resolve(this.deps.owner, project, [name]))[name]!;
    // Every request still goes through the owner's network rules and is watched like the first key,
    // and stays with the addresses its check judged (src/pinned-fetch.ts).
    return buildConnection({
      provider: record.catalogId, key, extras: record.extras, model: preset.model,
      ...(this.deps.policy ? { policy: this.deps.policy } : {}),
      // Each key is its own allowance, so one key near its limit never slows another (Slow down near a rate limit).
      fetchImpl: this.deps.models.health.watch(preset.id, this.deps.fetchImpl ?? pinnedFetch, paceKey(pool, account)),
    }).provider;
  }
  private chatgptConnection(pool: string, preset: ModelPreset, account: string): Provider {
    const base = this.deps.fetchImpl ?? globalThis.fetch;
    const observed: typeof fetch = async (input, init) => {
      const response = await base(input, init);
      this.notePlanWindows(pool, account, codexPlanWindows(response.headers, this.now()));
      return response;
    };
    return new ChatGPTProvider(this.chatgptAccounts.auth(account), { model: preset.model, userAgent: this.deps.userAgent, fetch: observed });
  }
  private programConnection(pool: string, account: string, model: string): Provider {
    const rowId = pool.slice(4), spawn = this.deps.spawnAgent ?? runCliAgent;
    if (rowId === "claude-code") return this.claudeConnection(pool, account, model);
    const made = account === primaryAccount ? new CliAgentProvider(rowFor({ id: rowId }), {}, spawn)
      : new CliAgentProvider(rowFor({ id: rowId }), {}, spawn, { name: accountHomeVariables[rowId]!, path: this.homeOf(pool, account) });
    if (account === primaryAccount) made.detectLimits = true;
    if (rowId === "codex") made.codexModels = codexModelsFor(this.deps.models); // QA 2026-09-28: Codex's choice, read per call
    return made;
  }
  private claudeConnection(pool: string, account: string, model: string): Provider {
    const native = new ClaudeSubscriptionProvider({ owner: this.deps.owner, model: model === "claude" ? claudeDefaultModel : model,
      accountHome: { name: "CLAUDE_CONFIG_DIR", path: account === primaryAccount ? this.primaryClaudeHome : this.homeOf(pool, account) } }, this.deps.claudeSubscription);
    native.onOutput = (stdout) => this.notePlanWindows(pool, account, claudePlanWindows(stdout, this.now()));
    return new Proxy(native, { get: (target, property) => {
      if (property === "complete") return async (request: Parameters<Provider["complete"]>[0]) => {
        this.authorizeClaude(); request.signal.throwIfAborted(); await this.readIdentities(); this.authorizeClaude(); request.signal.throwIfAborted();
        const cached = this.cachedSignIn(pool, account);
        if (cached.status?.signedIn !== true || cached.identity?.authMethod !== "claude.ai" || cached.duplicateOf)
          throw new Error("This Claude subscription sign-in is not ready; check its account in Settings → Accounts");
        return target.complete(request);
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    } });
  }
  private authorizeClaude(): void {
    refuseSignInForTrunk();
    if (!this.identityVisible() || currentAccountCall()?.owner !== this.deps.owner)
      throw new Error("Claude subscription requires its owner's authorized model-call context");
  }
  /** Resolve once for a child, without changing the model router, pool defaults or another conversation. */
  async resolveHelper(selected: ModelPreset, accountRef: HelperAccountRef | undefined, parentSessionId: string): Promise<HelperConnection> {
    const preset = Object.freeze({ ...selected }), asked = accountRef ? Object.freeze({ ...accountRef }) : undefined;
    const call = currentAccountCall();
    if (!call || !this.deps.store.ownsSession(call.owner, parentSessionId)) throw new Error("The helper's parent conversation belongs to another owner");
    if (!this.deps.models.presets.has(preset.id)) throw new Error("That helper model is no longer registered");
    const found = this.poolFor(preset);
    if (!found) {
      if (asked) throw new Error("This helper model has no account pool");
      return { preset: Object.freeze({ ...preset, provider: unwrapProvider(preset.provider) }) };
    }
    this.authorizeHelper();
    if (found.kind !== "api-key") refuseSignInForTrunk();
    if (asked && asked.pool !== found.pool) throw new Error("The helper account belongs to another model connection");
    if (found.kind !== "api-key") await this.readIdentities();
    this.authorizeHelper();
    const pool = this.usablePool(found.pool);
    const preferred = sessionChoice(this.deps.store, this.deps.owner, parentSessionId)[found.pool] ?? pool?.defaultAccount ?? primaryAccount;
    // MODEL-050: a helper no account was named for takes the least-leased ready account, so helpers side by side spread.
    const lease = asked ? null : this.leaseHelperAccount(pool, found.kind, preset.model, preferred);
    const account = asked?.account ?? lease?.account ?? preferred;
    try {
      this.requireHelperAccount(found.pool, found.kind, account);
      const address = this.addressOf(preset.id);
      const chosen = await this.providerFor(found.pool, found.kind, preset, account);
      if (!chosen && account !== primaryAccount) throw new Error("The helper's exact account could not be bound");
      const bound = chosen ?? unwrapProvider(preset.provider); // only the connection's own primary provider
      this.authorizeHelper();
      const ref = Object.freeze({ pool: found.pool, account });
      return { preset: Object.freeze({ ...preset, provider: this.helperProvider(bound, preset, ref, found.kind, address) }), accountRef: ref,
        ...(lease ? { release: lease.release } : {}) };
    } catch (error) { lease?.release(); throw error; }
  }
  /**
   * MODEL-050 (Hermes Agent's acquire_lease, see src/accounts/leases.ts): the ready accounts of a list that moves on by
   * itself, the conversation's own first, and the one fewest helpers hold. Null when there is nothing to spread over.
   * Only accounts this call may use: switched on, signed in, not resting or capped, and a Trunk's own unless it copies.
   */
  private leaseHelperAccount(pool: Pool | null, kind: AccountKind, model: string, preferred: string): { account: string; release: () => void } | null {
    if (!pool?.autoSwitch || pool.accounts.filter((one) => !one.disabled).length < 2) return null;
    const trunk = currentAccountCall()?.trunk, own = trunk ? trunkOrder(trunk.keys, pool.pool) : [];
    const ready = pool.accounts.filter((one) => !one.disabled && (!trunk || trunk.keys.copyFromOwner || own.includes(one.id))
      && unavailable(one, this.stateOf(pool.pool, one.id), model, this.now(), this.capReached(pool.pool, one)) === null
      && this.helperAccountReady(pool.pool, kind, one.id));
    const ordered = [...ready].sort((a, b) => Number(b.id === preferred) - Number(a.id === preferred) || Number(b.pinned) - Number(a.pinned));
    return this.leases.acquire(pool.pool, ordered.map((one) => one.id), pool.jobsPerAccount ?? defaultJobsPerAccount);
  }
  private helperAccountReady(pool: string, kind: AccountKind, id: string): boolean {
    try { this.requireHelperAccount(pool, kind, id); return true; } catch { return false; }
  }
  private helperProvider(bound: Provider, preset: ModelPreset, ref: HelperAccountRef, kind: AccountKind, address: string | null): Provider {
    const authorize = (): void => {
      this.authorizeHelper(); if (kind !== "api-key") refuseSignInForTrunk();
      const current = this.deps.models.presets.get(preset.id);
      if (!current || current.model !== preset.model || current.catalogId !== preset.catalogId || current.provider.name !== preset.provider.name || this.addressOf(preset.id) !== address)
        throw new Error("The helper's model connection changed; resolve its account again before continuing");
      this.requireHelperAccount(ref.pool, kind, ref.account);
    };
    authorize();
    const provider = new Proxy(bound, { get: (target, property) => {
      if (property === "complete") return async (request: Parameters<Provider["complete"]>[0]) => {
        authorize(); request.signal.throwIfAborted();
        const completion = await target.complete(request); authorize(); request.signal.throwIfAborted();
        const listed = this.pool(ref.pool)?.accounts.find((one) => one.id === ref.account);
        if (listed) this.record(ref.pool, listed, preset.model, completion);
        currentAccountCall()?.note?.("model.account", accountCallReceipt(ref.pool, ref.account, listed?.label ?? ref.account, preset.model, completion));
        return completion;
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    } });
    return provider;
  }
  private authorizeHelper(): void {
    if (!this.identityVisible() || currentAccountCall()?.owner !== this.deps.owner)
      throw new Error("Resolving a helper account requires its owner's authorized model-call context");
  }
  private requireHelperAccount(pool: string, kind: AccountKind, id: string): void {
    const saved = this.pool(pool), account = saved?.accounts.find((one) => one.id === id);
    if (saved && (!account || account.disabled) || !saved && id !== primaryAccount)
      throw new Error("The helper account is missing or switched off");
    if (kind === "api-key") return;
    const cached = this.cachedSignIn(pool, id);
    if (cached.status?.signedIn !== true || cached.duplicateOf || pool === "cli-claude-code" && cached.identity?.authMethod !== "claude.ai")
      throw new Error("The helper sign-in is not ready; check its account in Settings → Accounts");
  }
  /** The folder a program keeps one account's sign-in in. Branch makes it and never reads inside it. */
  homeOf(pool: string, account: string): string {
    return join(this.deps.dataDir, "accounts", pool, account);
  }

  /**
   * Brings a saved list up to the current rule once (see `applyPoolingRule`): since the owner's decision of 2026-09-27
   * every list moves on to its next account by itself again, and each list the change touched is written to the record
   * of what Branch did.
   */
  applyPoolingRule(): string[] {
    // Nothing saved, or a damaged record (which reads as switched off and is left as it is).
    const current = savedAccountsSettings(this.deps.store, this.deps.owner);
    if (!current) return [];
    const { settings, stopped } = applyPoolingRule(current);
    if (settings === current) return [];
    saveAccountsSettings(this.deps.store, this.deps.owner, settings);
    for (const pool of stopped)
      audit(this.deps.store, this.deps.owner, { action: "connection.changed", actor: this.deps.owner, subject: pool,
        reason: "Moving to the next account when one runs out was switched on again (the owner's decision of 2026-09-27)", outcome: "on" });
    return stopped;
  }

  /** Registers the ChatGPT models when an extra account is signed in, even if the first one is not. */
  async ensureChatGPTPresets(): Promise<void> {
    const legacy = this.deps.chatgpt;
    if (!legacy) return;
    this.legacySignedIn = (await legacy.status()).signedIn;
    const pool = this.pool("chatgpt");
    let extra = false;
    for (const account of pool?.accounts ?? [])
      if (account.id !== primaryAccount && (await this.chatgptAccounts.auth(account.id).status()).signedIn) extra = true;
    const present = [...this.deps.models.presets.keys()].some((id) => id.startsWith(chatgptPresetPrefix));
    if (this.on() && extra && !present) syncChatGPTPresets(this.deps.models, legacy, true, this.deps.userAgent);
  }
}

/** The key an account's requests are paced by (Slow down near a rate limit): one per account of a connection. */
export const paceKey = (pool: string, account: string): string => `pace:${pool}\u0000${account}`;

/** One service per model list, so several copies of Branch in one process never share accounts. */
const services = new WeakMap<ModelRouter, AccountsService>();
export function accountsServiceFor(models: ModelRouter): AccountsService | undefined {
  return services.get(models);
}

/** The start-up hook (src/index.ts): installs the wrap and wraps what is already registered. */
export async function startAccounts(deps: AccountsDeps): Promise<AccountsService> {
  const service = new AccountsService(deps);
  services.set(deps.models, service);
  // The first ChatGPT account answers through the connection itself, whose fetch the health record watches.
  deps.models.health.onHeaders = (id, headers) => {
    if (id.startsWith(chatgptPresetPrefix)) service.notePlanWindows("chatgpt", primaryAccount, codexPlanWindows(headers, service.now()));
  };
  service.applyPoolingRule();
  // A list that already holds the same ChatGPT account twice is merged into one (src/accounts/dedupe.ts).
  await mergeChatGPTDuplicates(service).catch(() => undefined);
  deps.models.presetHook = service.wrap;
  service.rewrap();
  await service.ensureChatGPTPresets().catch(() => undefined);
  return service;
}
