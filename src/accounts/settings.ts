import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Store } from "../store.js";
import { FeatureModeSchema, type FeatureMode } from "../feature-switches.js";

/**
 * Several accounts per connection (GAPS row 40, the owner's request of 2026-09-17).
 *
 * What is written down here is only the list: labels, order, which one is pinned, caps, and how
 * the next one is chosen. A key or a sign-in never lives in this record: API keys and ChatGPT
 * tokens are in the locker, one locker project per connection or per account, and the installed
 * programs (claude, codex, gemini, copilot) keep their own sign-in in their own folder, which
 * Branch never opens. Backups copy this record and nothing else.
 *
 * The whole feature follows the owner's three-way switch and ships off. Off means one account per
 * connection, exactly as before.
 */
export const accountKinds = ["api-key", "chatgpt", "cli"] as const;
export type AccountKind = (typeof accountKinds)[number];
export const strategies = ["priority", "round-robin", "least-used"] as const;
export type Strategy = (typeof strategies)[number];

/** The account every connection already has: its first key, the old sign-in, the program's own folder. */
export const primaryAccount = "primary";
export const maxAccounts = 50;
const accountId = z.string().regex(/^(primary|[a-f0-9]{8})$/);
export const poolId = z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i);

export const AccountSchema = z.object({
  id: accountId,
  label: z.string().trim().min(1).max(60),
  pinned: z.boolean().default(false),
  disabled: z.boolean().default(false),
  /** US dollars per calendar month; null means no cap. Only API keys are charged. */
  monthlyCapUsd: z.number().min(0).max(100_000).nullable().default(null),
  /** Whether people sharing this computer may use it. Only an API key can be shared. */
  shared: z.boolean().default(false),
  /**
   * mac7/account-pooling: sign-in accounts only. The owner's mark that an account belongs to someone else or to work.
   * Since 2026-09-27 every account of a list may take the work when another runs out, so the mark is a label only.
   */
  keptSeparate: z.boolean().default(false),
  /** Extra API keys only: the address (scheme, host, port) the key was added for; it is sent nowhere else. */
  address: z.string().max(300).optional(),
  createdAt: z.string().max(40),
}).strict();
export type Account = z.infer<typeof AccountSchema>;

export const PoolSchema = z.object({
  pool: poolId,
  kind: z.enum(accountKinds),
  strategy: z.enum(strategies).default("priority"),
  /**
   * "Move to the next account" (owner decision 2026-09-27, Hermes Agent's credential pools): with two or more accounts
   * switched on, the work moves on by itself when one runs out, keys and sign-ins alike (src/accounts/pool-provider.ts).
   * Ships on: it spends nothing the owner did not already add, and each account's own terms still apply.
   */
  autoSwitch: z.boolean().default(true),
  /** The account new work uses, when no conversation picked one. Null means the first in the list. */
  defaultAccount: accountId.nullable().default(null),
  accounts: z.array(AccountSchema).max(maxAccounts).default([]),
}).strict();
export type Pool = z.infer<typeof PoolSchema>;

/** The version of the sharing rule the saved list was last brought up to (see `applyPoolingRule`). */
export const poolingRuleVersion = 2;
export const AccountsSettingsSchema = z.object({
  /**
   * Ships on (owner decision 2026-09-27, the ship-on rule): several accounts per connection spends nothing by itself,
   * sends nothing and deletes nothing. It uses only accounts the owner added, and each account's own terms apply.
   * "when-needed" is the ship-on
   * position of a three-way switch; the engine reads anything but "off" as on (`AccountsService.on`).
   */
  mode: FeatureModeSchema.default("when-needed"),
  pools: z.array(PoolSchema).max(64).default([]),
  poolingRule: z.number().int().min(0).max(1000).default(0),
  /** Connections whose sharing was stopped by the rule, until the owner has read why. */
  poolingNotices: z.array(poolId).max(64).default([]),
}).strict();
export type AccountsSettings = z.infer<typeof AccountsSettingsSchema>;

const settingKey = "accounts";

/**
 * The owner's decision of 2026-09-27 (Hermes Agent's credential pools): every list moves on to its next account by
 * itself when one runs out, the owner's own sign-ins of one service included. Rule version 1 (2026-09-19) had switched
 * that off for lists holding two of the owner's own sign-ins; version 2 switches every list's `autoSwitch` back on once
 * and clears the notices that rule left. Idempotent: once the saved list carries this version it is left alone, so an
 * owner who switches it off afterwards keeps it off.
 */
export function applyPoolingRule(settings: AccountsSettings): { settings: AccountsSettings; stopped: string[] } {
  if (settings.poolingRule >= poolingRuleVersion) return { settings, stopped: [] };
  const changed: string[] = [];
  const pools = settings.pools.map((pool) => {
    if (pool.autoSwitch) return pool;
    changed.push(pool.pool);
    return { ...pool, autoSwitch: true };
  });
  return { settings: { ...settings, pools, poolingRule: poolingRuleVersion, poolingNotices: [] }, stopped: changed };
}
/**
 * The one-time notice, naming the service ("ChatGPT", "Claude Code"). The window shows the locale
 * key `accounts.notice.own-plans` with the same words; this text is for `/account`.
 */
export const poolingNotice = (service: string): string =>
  `Branch moves the work to your next ${service} account by itself when one runs out. Switching doesn't merge plans: each account's own terms apply. Switch it off in Settings › Accounts.`;
type Reader = Pick<Store, "get">;

/** The list as saved, or null when nothing is saved or what is saved is damaged. */
export function savedAccountsSettings(store: Reader, owner: string): AccountsSettings | null {
  const found = store.get("settings", owner, settingKey);
  if (!found) return null;
  const saved = AccountsSettingsSchema.safeParse(found.data ?? {});
  return saved.success ? saved.data : null;
}
/**
 * A list never saved starts under the current sharing rule, so one made from now on is never
 * mistaken for an old one that shared work between the owner's own plans (mac7/account-pooling).
 */
export function accountsSettings(store: Reader, owner: string): AccountsSettings {
  return savedAccountsSettings(store, owner) ?? AccountsSettingsSchema.parse({ poolingRule: poolingRuleVersion });
}
export function saveAccountsSettings(store: Store, owner: string, value: AccountsSettings): AccountsSettings {
  const parsed = AccountsSettingsSchema.parse(value);
  store.save("settings", owner, settingKey, parsed);
  return parsed;
}
export const accountsMode = (store: Reader, owner: string): FeatureMode => accountsSettings(store, owner).mode;

/** The pool, created with its first account when it is asked for the first time. */
export function poolOf(settings: AccountsSettings, pool: string, kind: AccountKind, now = new Date()): Pool {
  const found = settings.pools.find((entry) => entry.pool === pool);
  if (found) return found;
  const created = PoolSchema.parse({
    pool, kind,
    accounts: [{ id: primaryAccount, label: primaryLabel(kind), shared: kind === "api-key", createdAt: now.toISOString() }],
  });
  settings.pools.push(created);
  return created;
}
export function primaryLabel(kind: AccountKind): string {
  return kind === "api-key" ? "First key" : kind === "chatgpt" ? "First sign-in" : "Your usual sign-in";
}
export const newAccountId = (): string => randomBytes(4).toString("hex");

/** Where one pool's extra API keys are kept: a locker project of its own (the locker holds 64 per project). */
export function keyProject(pool: string): string {
  return `acct-${createHash("sha256").update(pool).digest("hex").slice(0, 12)}`;
}
export const keyName = (account: string): string => `KEY_${account.toUpperCase()}`;
/** Each ChatGPT account's tokens sit in a locker project of their own. */
export const tokenProject = (account: string): string => `acct-chatgpt-${account}`;

/**
 * The line the owner types once to sign a program in to one account's folder, written for the
 * computer's own shell: PowerShell on Windows, a POSIX shell elsewhere. Quoted so spaces and
 * apostrophes in the path are kept as they are.
 */
export function programSignInLine(variable: string, path: string, command: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return `$env:${variable}='${path.replace(/'/g, "''")}'; ${command}`;
  return `${variable}='${path.replace(/'/g, "'\\''")}' ${command}`;
}

/* ---------- the account a conversation chose ---------- */

const SessionChoiceSchema = z.record(poolId, accountId);
const sessionKey = (sessionId: string): string => `account-session:${sessionId}`;
export function sessionChoice(store: Reader, owner: string, sessionId: string): Record<string, string> {
  if (!sessionId) return {};
  const saved = SessionChoiceSchema.safeParse(store.get("settings", owner, sessionKey(sessionId))?.data ?? {});
  return saved.success ? saved.data : {};
}
export function saveSessionChoice(store: Store, owner: string, sessionId: string, pool: string, account: string | null): void {
  const choice = { ...sessionChoice(store, owner, sessionId) };
  if (account) choice[pool] = account; else delete choice[pool];
  store.save("settings", owner, sessionKey(sessionId), SessionChoiceSchema.parse(choice));
}
