import { join } from "node:path";
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
import { CliAgentProvider, accountHomeVariables, rowFor, runCliAgent, type SpawnAgent } from "../providers/cli-agent.js";
import type { Store } from "../store.js";
import { ChatGPTAccounts } from "./chatgpt-accounts.js";
import { claudePlanWindows, PlanWindowStore } from "../plan-windows.js";
import { codexPlanWindows, type PlanWindowSaid } from "../rate-limit-headers.js";
import type { AccountState } from "./pool.js";
import { firstChoice, freshState } from "./pool.js";
import { pooled, unwrapProvider } from "./pool-provider.js";
import {
  type Account, type AccountKind, type Pool, accountsSettings, applyPoolingRule, keyName, keyProject, primaryAccount,
  saveAccountsSettings, saveSessionChoice, savedAccountsSettings, sessionChoice,
} from "./settings.js";
import { AccountUsageLedger } from "./usage.js";
import { mergeChatGPTDuplicates } from "./dedupe.js";

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
  now?: () => number;
}

/**
 * Wires the account lists into the model list. Every connection that can have several accounts is
 * registered through `wrap`, which (with the switch on) puts the pool in front of the connection.
 * With the switch off `wrap` hands the connection back untouched, so nothing changes.
 */
export class AccountsService {
  readonly ledger: AccountUsageLedger;
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
  readonly now: () => number;

  constructor(readonly deps: AccountsDeps) {
    this.ledger = new AccountUsageLedger(deps.store.sqlite);
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
  /** The account this list answers through next, as the pool would choose it: its usable first choice. */
  usedNext(pool: string): string | null {
    const found = this.usablePool(pool);
    if (!found) return null;
    return firstChoice(found.accounts, [found.defaultAccount ?? null])?.id ?? null;
  }

  /**
   * Who each sign-in is, as the service itself said at sign-in: a ChatGPT account's email, read from its own sign-in
   * (the ID token's email claim). Kept by `pool/account`, filled by `readIdentities`, and shown only on the owner's
   * usage rows (src/usage-limits-api.ts), which refuse everybody else. A connection that says nothing has none.
   */
  readonly identities = new Map<string, string>();
  async readIdentities(): Promise<void> {
    const chatgpt = this.deps.chatgpt;
    if (!chatgpt) return;
    const listed = this.pool("chatgpt")?.accounts.map((account) => account.id) ?? [primaryAccount];
    for (const id of new Set([primaryAccount, ...listed])) {
      const status = await (id === primaryAccount ? chatgpt : this.chatgptAccounts.auth(id)).status().catch(() => null);
      if (status?.signedIn && status.email) this.identities.set(`chatgpt/${id}`, status.email);
      else this.identities.delete(`chatgpt/${id}`);
    }
  }
  settings() { return accountsSettings(this.deps.store, this.deps.owner); }
  on(): boolean { return this.settings().mode !== "off"; }
  pool(pool: string): Pool | null { return this.settings().pools.find((entry) => entry.pool === pool) ?? null; }
  statesOf(pool: string): Map<string, AccountState> {
    let found = this.states.get(pool);
    if (!found) this.states.set(pool, found = new Map());
    return found;
  }
  stateOf(pool: string, account: string): AccountState { return this.statesOf(pool).get(account) ?? freshState(); }

  /** Which list a connection belongs to, or null when it can only ever have one account. */
  poolFor(preset: Pick<ModelPreset, "id">): { pool: string; kind: AccountKind } | null {
    if (preset.id.startsWith(chatgptPresetPrefix)) return { pool: "chatgpt", kind: "chatgpt" };
    if (preset.id.startsWith("cli-") && accountHomeVariables[preset.id.slice(4)]) return { pool: preset.id, kind: "cli" };
    const record = savedConnections(this.deps.store, this.deps.owner).find((saved) => saved.id === preset.id);
    const entry = record ? catalogEntry(record.catalogId) : undefined;
    return entry && entry.auth !== "none" ? { pool: preset.id, kind: "api-key" } : null;
  }

  /** The hook ModelRouter runs on every connection it registers. */
  wrap = (preset: ModelPreset): ModelPreset => {
    const original = unwrapProvider(preset.provider);
    // The program's first account is the connection itself: what it prints about its plan is that account's.
    if (original instanceof CliAgentProvider && preset.id.startsWith("cli-claude-code") && !original.onOutput)
      original.onOutput = (stdout) => this.notePlanWindows(preset.id, primaryAccount, claudePlanWindows(stdout, this.now()));
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
      owner, pool, model: preset.model, states: this.statesOf(pool), cursor, now: this.now,
      settings: () => this.usablePool(pool),
      providerFor: (account: string) => this.providerFor(pool, kind, preset, account),
      capReached: (account: Account) => this.capReached(pool, account),
      record: (account: Account, completion: Completion) => this.record(pool, account, preset.model, completion),
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
    if (!found || found.kind !== "chatgpt" || this.legacySignedIn) return found;
    return { ...found, accounts: found.accounts.map((account) => account.id === primaryAccount ? { ...account, disabled: true } : account) };
  }

  capReached(pool: string, account: Account): boolean {
    if (account.monthlyCapUsd === null) return false;
    return this.ledger.month(this.deps.owner, pool, account.id, new Date(this.now())).costUsd >= account.monthlyCapUsd;
  }
  private record(pool: string, account: Account, model: string, completion: Completion): void {
    const usage = completion.usage ?? { input: 0, output: 0 };
    const kind = this.pool(pool)?.kind;
    const cost = kind === "api-key"
      ? estimateCost(model, usage, pricingSettings(this.deps.store, this.deps.owner).overrides).amount ?? 0 : 0;
    this.ledger.record(this.deps.owner, pool, account.id, { input: usage.input, output: usage.output, costUsd: cost }, new Date(this.now()));
  }

  /**
   * "Measure now": the smallest real request, sent straight to this one account (never through the
   * pool, so no other account can answer it). Only for a sign-in: it spends a little of the plan's
   * window and no money. What the service says about the windows comes back through the usual hooks.
   */
  async measure(pool: string, account: string, signal: AbortSignal): Promise<void> {
    const preset = [...this.deps.models.presets.values()].find((one) => this.poolFor(one)?.pool === pool);
    const found = preset ? this.poolFor(preset) : null;
    if (!preset || !found || found.kind === "api-key") throw new Error("Only a plan sign-in can be measured this way.");
    const listed = this.pool(pool)?.accounts.some((one) => one.id === account) ?? false;
    if (account !== primaryAccount && !listed) throw new Error("That account is not in this list.");
    // The first account is the connection itself (for a program, its usual sign-in), exactly as a message would go.
    const own = account === primaryAccount ? null : await this.providerFor(pool, found.kind, preset, account);
    const provider = own ?? unwrapProvider(preset.provider);
    await provider.complete({ messages: [{ role: "user", content: "Reply with the single word: ok" }], tools: [], signal, maxTokens: 16 });
  }

  /** Forgets the connections built for one account, after its key changed or it was removed. */
  dropBuilt(pool: string, account: string): void {
    for (const key of [...this.built.keys()]) if (key.startsWith(`${pool}\u0000`) && key.endsWith(`\u0000${account}`)) this.built.delete(key);
  }

  private async providerFor(pool: string, kind: AccountKind, preset: ModelPreset, account: string): Promise<Provider | null> {
    // The first account is the connection itself; a program's is run the same way, but says when it hit a limit.
    if (account === primaryAccount && kind !== "cli") return null;
    const cacheKey = `${pool}\u0000${preset.id}\u0000${preset.model}\u0000${kind === "api-key" ? this.addressOf(preset.id) : ""}\u0000${account}`;
    const cached = this.built.get(cacheKey);
    if (cached) return cached;
    const made = kind === "api-key" ? await this.keyConnection(pool, preset, account)
      : kind === "chatgpt" ? this.chatgptConnection(pool, preset, account)
      : this.programConnection(pool, account);
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
      fetchImpl: this.deps.models.health.watch(preset.id, this.deps.fetchImpl ?? pinnedFetch),
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
  private programConnection(pool: string, account: string): Provider {
    const rowId = pool.slice(4), spawn = this.deps.spawnAgent ?? runCliAgent;
    const made = account === primaryAccount ? new CliAgentProvider(rowFor({ id: rowId }), {}, spawn)
      : new CliAgentProvider(rowFor({ id: rowId }), {}, spawn, { name: accountHomeVariables[rowId]!, path: this.homeOf(pool, account) });
    if (account === primaryAccount) made.detectLimits = true;
    if (rowId === "claude-code") made.onOutput = (stdout) => this.notePlanWindows(pool, account, claudePlanWindows(stdout, this.now()));
    return made;
  }
  /** The folder a program keeps one account's sign-in in. Branch makes it and never reads inside it. */
  homeOf(pool: string, account: string): string {
    return join(this.deps.dataDir, "accounts", pool, account);
  }

  /**
   * mac7/account-pooling: brings a saved list up to the sharing rule once (see `applyPoolingRule`).
   * A list that shared work between the owner's own plans stops, keeps their first choice, and is
   * written to the record of what Branch did.
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
        reason: "Sharing work between the owner's own sign-ins of one service was stopped: providers treat it as abuse", outcome: "off" });
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
