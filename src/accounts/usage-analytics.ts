import type { Store } from "../store.js";
import { startedWithShortLivedKey } from "../key-context.js";
import { currentPerson } from "../people/context.js";

export interface AccountActivity { pool: string; account: string; requests: number; input: number; output: number }
export interface PluginActivity { id: string; completed: number; failed: number; stalled: number }
export interface UsageAnalytics { month: string; accounts: AccountActivity[]; plugins: PluginActivity[]; restricted: boolean }

/** Owner-only monthly receipts. No identity, key, arguments or result bodies leave these reads. */
export function usageAnalytics(store: Store, owner: string, month: string): UsageAnalytics {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("A usage month must be YYYY-MM");
  const restricted = startedWithShortLivedKey() || currentPerson() !== null
    || !store.profiles.isOwner() || store.profiles.scope() !== owner;
  if (restricted) return { month, accounts: [], plugins: [], restricted: true };
  return { month, accounts: accountsUsed(store, owner, month), plugins: pluginsUsed(store, owner, month), restricted: false };
}

function accountsUsed(store: Store, owner: string, month: string): AccountActivity[] {
  if (!store.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_usage'").get()) return [];
  const rows = store.sqlite.prepare(`SELECT pool,account,requests,input,output FROM account_usage
    WHERE owner=? AND month=? AND requests>0 ORDER BY requests DESC,pool,account`).all(owner, month);
  return rows.map((row) => ({ pool: String(row.pool), account: String(row.account), requests: Number(row.requests),
    input: Number(row.input), output: Number(row.output) }));
}

/** Plugin activity is terminal tool-event receipts, not an estimate of each plugin's model spending. */
function pluginsUsed(store: Store, owner: string, month: string): PluginActivity[] {
  const rows = store.sqlite.prepare(`SELECT e.kind,
    CASE WHEN json_valid(e.data) THEN json_extract(e.data,'$.name') END AS name
    FROM events e JOIN tasks t ON t.id=e.run_id WHERE t.owner=? AND e.created_at>=? AND e.created_at<?
    AND e.kind IN ('tool.completed','tool.failed','tool.stalled')`).iterate(owner, `${month}-01`, monthEnd(month));
  const plugins = new Map<string, PluginActivity>();
  for (const row of rows) {
    const id = typeof row.name === "string" ? /^plugin\.([a-z][a-z0-9-]{0,39})\./.exec(row.name)?.[1] : undefined;
    if (!id) continue;
    const plugin = plugins.get(id) ?? { id, completed: 0, failed: 0, stalled: 0 };
    if (row.kind === "tool.completed") plugin.completed += 1;
    else if (row.kind === "tool.stalled") plugin.stalled += 1;
    else plugin.failed += 1;
    plugins.set(id, plugin);
  }
  return [...plugins.values()].sort((a, b) => b.completed + b.failed + b.stalled - a.completed - a.failed - a.stalled || a.id.localeCompare(b.id));
}

function monthEnd(month: string): string {
  const year = Number(month.slice(0, 4)), number = Number(month.slice(5));
  return `${number === 12 ? year + 1 : year}-${String(number === 12 ? 1 : number + 1).padStart(2, "0")}-01`;
}

/** Accounts count completed model calls; reported tokens can be incomplete when a provider gives no usage. */
export function analyticsLines(analytics: UsageAnalytics): string[] {
  if (analytics.restricted) return [];
  return [
    `Account calls this month (${analytics.month}):`,
    ...(analytics.accounts.length ? analytics.accounts.map((row) => `  ${row.pool} / ${row.account}: ${row.requests} completed call(s), ${row.input} recorded tokens in, ${row.output} out`)
      : ["  No per-account calls recorded."]),
    "Account tokens include only provider-reported usage; 0 recorded does not prove zero usage. Plan allowances and unreported tokens are unknown.",
    "Plugin tool receipts this month:",
    ...(analytics.plugins.length ? analytics.plugins.map((row) => `  ${row.id}: ${row.completed} completed, ${row.failed} failed, ${row.stalled} stalled`)
      : ["  No plugin tool receipts recorded."]),
    "Plugin model spending and background hook activity are not attributed by these receipts.",
  ];
}
