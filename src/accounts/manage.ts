import { mkdir } from "node:fs/promises";
import { z } from "zod";
import { audit } from "../audit.js";
import { FeatureModeSchema } from "../feature-switches.js";
import { markChosen } from "../ship-on.js";
import type { AccountsService } from "./service.js";
import {
  type AccountKind, type AccountsSettings, type Pool, AccountSchema, keyName, keyProject, maxAccounts,
  newAccountId, poolId, poolOf, poolingNotice, primaryAccount, programSignInLine, saveAccountsSettings, saveSessionChoice,
  sessionChoice, strategies,
} from "./settings.js";
import { accountHomeVariables, cliAgentCatalog, rowFor } from "../providers/cli-agent.js";
import { accountTerms } from "./terms.js";

/**
 * Adding, renaming, ordering, pinning, capping, sharing, switching and removing accounts. Every
 * change here is the owner's alone: the server refuses these routes to short-lived keys and to
 * household profiles. Nothing here ever returns a key or a token.
 */
const poolName = poolId;
const accountName = z.string().regex(/^(primary|[a-f0-9]{8})$/);
export const AddSchema = z.object({
  pool: poolName,
  label: z.string().trim().min(1).max(60),
  /** API keys only. Goes straight into the locker and is never shown again. */
  key: z.string().min(8).max(4096).optional(),
}).strict();
export const UpdateSchema = z.object({
  pool: poolName, account: accountName,
  label: z.string().trim().min(1).max(60).optional(),
  pinned: z.boolean().optional(),
  disabled: z.boolean().optional(),
  monthlyCapUsd: z.number().min(0).max(100_000).nullable().optional(),
  shared: z.boolean().optional(),
  /** Sign-in accounts only: this account belongs to someone else or to work (mac7/account-pooling). */
  move: z.enum(["up", "down"]).optional(),
  /** Replaces an API key in place. */
  key: z.string().min(8).max(4096).optional(),
}).strict();
export const PoolUpdateSchema = z.object({
  pool: poolName,
  strategy: z.enum(strategies).optional(),
  autoSwitch: z.boolean().optional(),
  defaultAccount: accountName.nullable().optional(),
  /** MODEL-050: helpers per account at once before the next helper takes another account. */
  jobsPerAccount: z.number().int().min(1).max(16).optional(),
}).strict();
export const NoticeSchema = z.object({ pool: poolName }).strict();
export const RemoveSchema = z.object({ pool: poolName, account: accountName }).strict();
export const SwitchSchema = z.object({
  pool: poolName, account: accountName,
  /** The conversation to switch; without one, the owner's default changes. */
  sessionId: z.string().uuid().optional(),
}).strict();
export const ModeSchema = z.object({ mode: FeatureModeSchema }).strict();

function note(service: AccountsService, subject: string, reason: string, outcome: string): void {
  audit(service.deps.store, service.deps.owner, { action: "connection.changed", actor: service.deps.owner, subject: subject.slice(0, 300), reason, outcome });
}
function save(service: AccountsService, settings: AccountsSettings): void {
  saveAccountsSettings(service.deps.store, service.deps.owner, settings);
}
/** The connection's kind, from the model list: a pool can only be made for a connection that exists. */
function kindOf(service: AccountsService, pool: string): AccountKind {
  for (const preset of service.deps.models.presets.values()) {
    const found = service.poolFor(preset);
    if (found?.pool === pool) return found.kind;
  }
  throw new Error(`There is no connection called "${pool}" that can have several accounts.`);
}
function existingPool(settings: AccountsSettings, pool: string): Pool {
  const found = settings.pools.find((entry) => entry.pool === pool);
  if (!found) throw new Error(`The connection "${pool}" has no list of accounts yet.`);
  return found;
}
function accountIn(pool: Pool, account: string) {
  const found = pool.accounts.find((entry) => entry.id === account);
  if (!found) throw new Error("That account is not in this list.");
  return found;
}

export function setMode(service: AccountsService, input: unknown) {
  const { mode } = ModeSchema.parse(input);
  const settings = service.settings();
  save(service, { ...settings, mode });
  markChosen(service.deps.store, service.deps.owner, "accounts", ["mode"]); // the owner's own choice (src/ship-on.ts)
  service.rewrap();
  note(service, "several accounts per connection", `The switch was set to ${mode}`, mode);
  return { mode };
}

export async function addAccount(service: AccountsService, input: unknown) {
  const asked = AddSchema.parse(input);
  const settings = service.settings();
  const kind = kindOf(service, asked.pool);
  const pool = poolOf(settings, asked.pool, kind, new Date(service.now()));
  if (pool.accounts.length >= maxAccounts) throw new Error(`A connection can have at most ${maxAccounts} accounts.`);
  if (kind === "api-key" && !asked.key) throw new Error("Paste the key for this account.");
  if (kind !== "api-key" && asked.key) throw new Error("This connection signs in; it does not take a key.");
  const id = newAccountId();
  const address = kind === "api-key" ? service.addressOf(asked.pool) : null;
  if (kind === "api-key" && !address) throw new Error(`The connection "${asked.pool}" has no address Branch can tie a key to.`);
  if (asked.key) await service.deps.store.locker.set(service.deps.owner, keyProject(asked.pool), keyName(id), asked.key);
  if (kind === "cli") await mkdir(service.homeOf(asked.pool, id), { recursive: true, mode: 0o700 });
  pool.accounts.push(AccountSchema.parse({ id, label: asked.label, ...(address ? { address } : {}), createdAt: new Date(service.now()).toISOString() }));
  save(service, settings);
  service.rewrap();
  note(service, `${asked.label} (${asked.pool})`, "An account was added to a connection", "added");
  return viewPool(service, pool);
}

export async function updateAccount(service: AccountsService, input: unknown) {
  const asked = UpdateSchema.parse(input);
  const settings = service.settings();
  // A connection whose list was never written down (only its first account, as GET /api/accounts shows it) is written
  // down on its first change, the way adding an account does, so that first account can be switched off or renamed too.
  const pool = settings.pools.find((entry) => entry.pool === asked.pool) ?? poolOf(settings, asked.pool, kindOf(service, asked.pool), new Date(service.now()));
  const account = accountIn(pool, asked.account);
  if (asked.label !== undefined) account.label = asked.label;
  if (asked.pinned !== undefined) account.pinned = asked.pinned;
  if (asked.disabled !== undefined) account.disabled = asked.disabled;
  if (asked.monthlyCapUsd !== undefined) account.monthlyCapUsd = asked.monthlyCapUsd;
  if (asked.shared !== undefined) {
    if (asked.shared && pool.kind !== "api-key") throw new Error("A sign-in account belongs to one person and cannot be shared. Share an API key instead.");
    account.shared = asked.shared;
  }
  if (asked.move) moveAccount(pool, asked.account, asked.move);
  if (asked.key !== undefined) await replaceKey(service, pool, asked.account, asked.key);
  save(service, settings);
  return viewPool(service, pool);
}
function moveAccount(pool: Pool, account: string, direction: "up" | "down"): void {
  const index = pool.accounts.findIndex((entry) => entry.id === account);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= pool.accounts.length) return;
  [pool.accounts[index], pool.accounts[target]] = [pool.accounts[target]!, pool.accounts[index]!];
}
async function replaceKey(service: AccountsService, pool: Pool, account: string, key: string): Promise<void> {
  if (pool.kind !== "api-key") throw new Error("This connection signs in; it does not take a key.");
  if (account === primaryAccount) throw new Error("Replace the first key where the connection was added (Settings › Secrets).");
  await service.deps.store.locker.set(service.deps.owner, keyProject(pool.pool), keyName(account), key);
  service.dropBuilt(pool.pool, account);
  service.statesOf(pool.pool).delete(account);
  service.rests.forget(service.deps.owner, pool.pool, account); // a new key starts with no rest
}

export function updatePool(service: AccountsService, input: unknown) {
  const asked = PoolUpdateSchema.parse(input);
  const settings = service.settings();
  const pool = poolOf(settings, asked.pool, kindOf(service, asked.pool), new Date(service.now()));
  if (asked.strategy) pool.strategy = asked.strategy;
  if (asked.autoSwitch !== undefined) {
    pool.autoSwitch = asked.autoSwitch;
    note(service, pool.pool, "Moving to the next account when one runs out was changed", asked.autoSwitch ? "on" : "off");
  }
  if (asked.defaultAccount !== undefined) {
    if (asked.defaultAccount) accountIn(pool, asked.defaultAccount);
    pool.defaultAccount = asked.defaultAccount;
  }
  if (asked.jobsPerAccount !== undefined) pool.jobsPerAccount = asked.jobsPerAccount;
  save(service, settings);
  return viewPool(service, pool);
}

export async function removeAccount(service: AccountsService, input: unknown) {
  const asked = RemoveSchema.parse(input);
  if (asked.account === primaryAccount) throw new Error("The first account is the connection itself. Remove the connection instead.");
  const settings = service.settings();
  const pool = existingPool(settings, asked.pool);
  const account = accountIn(pool, asked.account);
  pool.accounts = pool.accounts.filter((entry) => entry.id !== asked.account);
  if (pool.defaultAccount === asked.account) pool.defaultAccount = null;
  if (pool.kind === "api-key") service.deps.store.locker.remove(service.deps.owner, keyProject(pool.pool), keyName(asked.account));
  if (pool.kind === "chatgpt") await service.chatgptAccounts.forget(asked.account);
  save(service, settings);
  service.dropBuilt(pool.pool, asked.account);
  service.statesOf(pool.pool).delete(asked.account);
  service.ledger.forget(service.deps.owner, pool.pool, asked.account);
  service.rests.forget(service.deps.owner, pool.pool, asked.account);
  note(service, `${account.label} (${pool.pool})`, "An account was removed and its key or sign-in taken out of the locker", "removed");
  return viewPool(service, pool);
}

/** The owner has read why sharing between their own plans stopped (mac7/account-pooling). */
export function dismissNotice(service: AccountsService, input: unknown) {
  const { pool } = NoticeSchema.parse(input);
  const settings = service.settings();
  save(service, { ...settings, poolingNotices: settings.poolingNotices.filter((entry) => entry !== pool) });
  return { pool, dismissed: true };
}

/** Switching by hand: one conversation, or the default for new work. */
export function switchAccount(service: AccountsService, input: unknown) {
  const asked = SwitchSchema.parse(input);
  const settings = service.settings();
  const pool = existingPool(settings, asked.pool);
  const account = accountIn(pool, asked.account);
  const { store, owner } = service.deps;
  if (asked.sessionId) {
    if (!store.ownsSession(owner, asked.sessionId)) throw new Error("Conversation not found");
    saveSessionChoice(store, owner, asked.sessionId, pool.pool, account.id);
  } else {
    pool.defaultAccount = account.id;
    save(service, settings);
  }
  const label = service.presentation(pool.pool, account, pool.kind).label;
  return { pool: pool.pool, account: account.id, label, scope: asked.sessionId ? "conversation" : "default",
    message: asked.sessionId ? `This conversation now uses "${label}".` : `New work now uses "${label}".` };
}

/* ---------- what the screens read ---------- */

/** True while someone other than the owner is using Branch (a household profile, or a person signed in elsewhere). */
const someoneElse = (service: AccountsService): boolean => service.deps.store.profiles.scope() !== service.deps.owner;

export function viewPool(service: AccountsService, pool: Pool) {
  const now = service.now();
  // Somebody else sees only the keys shared with them, and none of the owner's spending.
  const others = someoneElse(service);
  const shown = others ? pool.accounts.filter((account) => pool.kind === "api-key" && account.shared) : pool.accounts;
  return {
    pool: pool.pool, kind: pool.kind, strategy: pool.strategy, autoSwitch: pool.autoSwitch,
    defaultAccount: pool.defaultAccount ?? pool.accounts[0]?.id ?? null,
    terms: accountTerms(pool.kind, pool.pool),
    accounts: shown.map((account) => {
      const state = service.stateOf(pool.pool, account.id);
      return {
        ...account,
        ...(!others ? service.presentation(pool.pool, account, pool.kind) : {}),
        ...(others ? { monthlyCapUsd: null } : {}),
        usage: others ? { requests: 0, input: 0, output: 0, costUsd: 0, lastUsedAt: null }
          : service.ledger.month(service.deps.owner, pool.pool, account.id, new Date(now)),
        capReached: others ? false : service.capReached(pool.pool, account),
        restingUntil: state.restUntil > now ? new Date(state.restUntil).toISOString() : null,
        limitedUntil: state.limitedUntil > now ? new Date(state.limitedUntil).toISOString() : null,
        remaining: state.remaining,
        lastUsedAt: state.lastUsedAt ? new Date(state.lastUsedAt).toISOString() : null,
        lastError: state.lastError,
        ...(pool.kind === "cli" ? programHome(service, pool.pool, account.id) : {}),
      };
    }),
  };
}

function programHome(service: AccountsService, pool: string, account: string) {
  const home = service.homeOf(pool, account), variable = accountHomeVariables[pool.slice(4)];
  return { home, ...(variable ? { signInLine: programSignInLine(variable, home, rowFor({ id: pool.slice(4) }).command) } : {}) };
}

/**
 * hardening-3: the name a person knows a connection by, for the window and `/account` alike: the
 * connection's own name, "ChatGPT", or the program's name for one not set up right now — never the
 * internal id unless nothing else is known.
 */
export function connectionName(service: AccountsService, pool: string): string {
  if (pool === "chatgpt") return "ChatGPT";
  for (const preset of service.deps.models.presets.values())
    if (service.poolFor(preset)?.pool === pool) return preset.name;
  const program = pool.startsWith("cli-") ? cliAgentCatalog.find((row) => row.id === pool.slice(4)) : undefined;
  return program?.name ?? pool;
}

/**
 * QA retest 2026-09-28 (m8): the list of the model that answers now (the owner's default), or null when that model has no
 * list (one on this computer). A list's "used next" is only true of the list the next answer comes from.
 */
function answeringPool(service: AccountsService): string | null {
  const models = service.deps.models;
  if (!models.configured) return null;
  const id = models.plan(service.deps.owner, "").choice.presetId;
  const preset = models.presets.get(id);
  return preset ? service.poolFor(preset)?.pool ?? null : null;
}

/** Every connection that can have several accounts, with its list (a list of one until more are added). */
export async function viewAll(service: AccountsService) {
  const settings = service.settings();
  await service.ensureChatGPTPresets().catch(() => undefined);
  const seen = new Map<string, { name: string; kind: AccountKind }>();
  for (const preset of service.deps.models.presets.values()) {
    const found = service.poolFor(preset);
    if (found && !seen.has(found.pool)) seen.set(found.pool, { name: found.kind === "chatgpt" ? "ChatGPT" : preset.name, kind: found.kind });
  }
  for (const pool of settings.pools) if (!seen.has(pool.pool)) seen.set(pool.pool, { name: connectionName(service, pool.pool), kind: pool.kind });
  // hardening-3: a household person sees the accounts shared with them and nothing of the owner's lists.
  // Integration review (phase2/accounts): `household` lets the page leave out the owner's cards even
  // when nothing is shared with them (an empty list says nothing about whose view it is).
  if (someoneElse(service)) return { mode: settings.mode, pools: sharedWithPerson(service, seen), household: true };
  await service.readIdentities();
  if (someoneElse(service)) return { mode: settings.mode, pools: sharedWithPerson(service, seen), household: true };
  const pools = [], answering = answeringPool(service);
  for (const [id, about] of seen) {
    const draft = { ...settings, pools: [...settings.pools] };
    const view = viewPool(service, poolOf(draft, id, about.kind, new Date(service.now())));
    const signIn = about.kind === "chatgpt" ? await signInState(service, view.accounts.map((a) => a.id))
      : about.kind === "cli" ? { signedIn: Object.fromEntries(view.accounts.map((a) => [a.id, a.signedIn])), problems: Object.fromEntries(view.accounts.map((a) => [a.id, a.signInProblem])) } : null;
    if (someoneElse(service)) return { mode: settings.mode, pools: sharedWithPerson(service, seen), household: true };
    // mac7/account-pooling: the one-time notice is the owner's alone to read.
    const notice = !someoneElse(service) && settings.poolingNotices.includes(id)
      ? { key: "accounts.notice.own-plans", service: about.name, text: poolingNotice(about.name) } : null;
    // An extra ChatGPT account whose sign-in turned out to be one Branch already had was merged into it (src/accounts/dedupe.ts).
    const merged = about.kind === "chatgpt" && service.mergedInto.size ? { mergedInto: Object.fromEntries(service.mergedInto) } : {};
    pools.push({ ...view, name: about.name, answering: id === answering, notice, signedIn: signIn?.signedIn ?? null, signInProblems: signIn?.problems ?? null, ...merged });
  }
  if (someoneElse(service)) return { mode: settings.mode, pools: sharedWithPerson(service, seen), household: true };
  return { mode: settings.mode, pools };
}
/**
 * hardening-3: what a household person is shown: only lists holding an account shared with them,
 * and of those only the name, the service's terms and the shared accounts — not how the owner's
 * list is run (its strategy, sharing, default, notices) nor which sign-ins the owner has.
 */
function sharedWithPerson(service: AccountsService, seen: Map<string, { name: string; kind: AccountKind }>) {
  const settings = service.settings(), pools = [];
  for (const [id, about] of seen) {
    const saved = settings.pools.find((pool) => pool.pool === id);
    if (!saved) continue;
    const { accounts, terms } = viewPool(service, saved);
    if (accounts.length) pools.push({ pool: id, name: about.name, kind: about.kind, terms, accounts });
  }
  return pools;
}
/** Whether each ChatGPT account is signed in, and why the last sign-in failed (never a token). */
async function signInState(service: AccountsService, ids: string[]) {
  const signedIn: Record<string, boolean> = {}, problems: Record<string, string | null> = {};
  for (const id of ids) {
    if (someoneElse(service)) break;
    if (id === primaryAccount) { signedIn[id] = service.legacySignedIn; problems[id] = null; continue; }
    const status = await service.chatgptAccounts.auth(id).status();
    if (someoneElse(service)) break;
    signedIn[id] = status.signedIn;
    problems[id] = status.lastError;
  }
  return { signedIn, problems };
}

/** What the conversation header shows: for the connection answering now, which account it uses. */
export function viewSession(service: AccountsService, sessionId: string) {
  const { models, owner, store } = service.deps;
  if (!service.on()) return { on: false, pool: null };
  if (sessionId && !store.ownsSession(owner, sessionId)) throw new Error("Conversation not found");
  const choice = models.plan(owner, sessionId).choice;
  const found = service.poolFor({ id: choice.presetId });
  const pool = found ? service.pool(found.pool) : null;
  if (!pool || pool.accounts.length < 2) return { on: true, pool: null };
  const chosen = sessionId ? sessionChoice(store, owner, sessionId)[pool.pool] ?? null : null;
  const visible = someoneElse(service) ? pool.accounts.filter((account) => pool.kind === "api-key" && account.shared) : pool.accounts;
  if (!visible.length) return { on: true, pool: null };
  const active = visible.find((account) => account.id === (chosen ?? pool.defaultAccount)) ?? visible[0]!;
  return {
    on: true, pool: pool.pool, kind: pool.kind, account: active.id, label: someoneElse(service) ? active.label : service.presentation(pool.pool, active, pool.kind).label,
    chosenHere: chosen !== null,
    accounts: visible.filter((account) => !account.disabled).map((account) => ({ id: account.id,
      ...(someoneElse(service) ? { label: account.label } : service.presentation(pool.pool, account, pool.kind)) })),
  };
}
