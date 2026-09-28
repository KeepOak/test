import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import type { ToolRegistry } from "./registry.js";
import type { Runtime } from "./runtime.js";
import { accountsServiceFor } from "./accounts/service.js";
import { currentPerson } from "./people/context.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { shareLeft, usageGlanceSettings } from "./usage-glance.js";
import { limitsNow } from "./usage-limits-api.js";
import type { LimitRow } from "./usage-limits.js";

/**
 * The lead's workbench (SELF-307): long sessions on the owner's plans. The lead sees what each account of its own
 * connection has left (accounts.usage), from the very rows the usage ring draws (src/usage-limits-api.ts limitsNow),
 * so there is one reading and no second way of counting. At a plan limit the work already moves to the next account by
 * itself (src/accounts/pool-provider.ts); only when every account it could move to is at or past 98% used, or resting
 * at its limit, is a running task asked, once per conversation and plan window, to write a handoff. Nobody else is
 * shown the owner's numbers: a Trunk of its own, a household person and a short-lived key are refused.
 */
export const nearLimitPercentUsed = 98;

export interface AccountUsage {
  account: string | null; label: string | null; inUse: boolean;
  /** Resting at its plan limit or refused now, whatever its windows say. */
  limited: boolean;
  /** The most used of its measured windows, 0 to 100, or null when nothing was measured. */
  percentUsed: number | null;
  near: boolean;
  windows: { title: string; percentLeft: number | null; resetAt: string | null; estimated: boolean }[];
}
export interface ConnectionUsage { connection: string; connectionName: string; accounts: AccountUsage[]; everyAccountNear: boolean; resetAt: string | null }

type UsageApp = Pick<Runtime, "owner" | "models" | "store">;
const limitsApp = (runtime: UsageApp) => ({ store: runtime.store, runtime: { owner: runtime.owner, models: runtime.models } });

function accountUsage(runtime: UsageApp, row: LimitRow, now: number): AccountUsage {
  const service = accountsServiceFor(runtime.models);
  const state = row.account ? service?.statesOf(row.connection).get(row.account) : undefined;
  const limited = !!state && (state.limitedUntil > now || state.restUntil > now);
  const measured = row.windows.map((window) => shareLeft(window)).filter((share): share is number => share !== null);
  const percentUsed = measured.length ? Math.round(100 - Math.min(...measured)) : null;
  return {
    account: row.account, label: row.accountLabel, inUse: row.inUse, limited, percentUsed,
    near: limited || (percentUsed !== null && percentUsed >= nearLimitPercentUsed),
    windows: row.windows.map((window) => {
      const share = shareLeft(window);
      return { title: window.title, percentLeft: share === null ? null : Math.floor(share), resetAt: window.resetAt, estimated: window.state === "estimated" };
    }),
  };
}

/** What the connection a conversation uses has left, account by account; switched-off accounts are left out. */
export function connectionUsage(runtime: UsageApp, sessionId: string, now = Date.now()): ConnectionUsage | null {
  const preset = runtime.models.plan(runtime.owner, sessionId).choice.presetId;
  const rows = limitsNow(limitsApp(runtime)).rows.filter((row) => row.connection === preset || (row.presets ?? []).includes(preset));
  if (!rows.length) return null;
  const service = accountsServiceFor(runtime.models);
  const pool = service?.on() ? service.pool(rows[0]!.connection) : null;
  const off = new Set((pool?.accounts ?? []).filter((account) => account.disabled).map((account) => account.id));
  const accounts = rows.filter((row) => !row.account || !off.has(row.account)).map((row) => accountUsage(runtime, row, now));
  const resets = accounts.flatMap((one) => one.windows.map((window) => window.resetAt)).filter((at): at is string => !!at).sort();
  return {
    connection: rows[0]!.connection, connectionName: rows[0]!.connectionName, accounts,
    everyAccountNear: accounts.length > 0 && accounts.every((one) => one.near), resetAt: resets[0] ?? null,
  };
}

/** The owner's own turn (or their default Trunk's, which is theirs), in their window: nobody else sees these numbers. */
function ownersOwn(context: ToolContext): boolean {
  return !context.trunk && !startedWithShortLivedKey() && !currentPerson();
}

export const handoffNote = (usage: ConnectionUsage): string =>
  `Every account this conversation can use (${usage.connectionName}) is at or past ${nearLimitPercentUsed}% of its plan, or resting at its limit, `
  + `so there is no account left to move to${usage.resetAt ? ` until ${usage.resetAt}` : ""}. Write a handoff now, before you go on: in this `
  + "conversation (and in the work's own handoff file if it keeps one), what is done, what is in progress (with the numbers of helpers, pull requests "
  + "and wake-ups), and the next steps, so the work can be picked up the moment an account refills. Then carry on if you can.";

const topLevel = (runtime: Runtime, runId: string): boolean =>
  !runtime.store.events(runId).some((event) => event.kind === "run.started" && event.data.parentRunId);

/**
 * Asks each running task of the owner's, once per conversation and plan window, to write a handoff when every account
 * it could use is near its limit. Called on the scheduler's tick; reads only what Branch already holds.
 */
export function askForHandoffs(runtime: Runtime, now = Date.now()): void {
  // The owner's one switch for asking running tasks to save their progress (Settings, the usage ring) rules this too.
  if (usageGlanceSettings(runtime.store, runtime.owner).saveProgress === "off") return;
  for (const run of runtime.store.activeRuns(runtime.owner)) {
    if (run.status !== "running" || !topLevel(runtime, run.id)) continue;
    let usage: ConnectionUsage | null;
    try { usage = connectionUsage(runtime, run.sessionId, now); } catch { continue; }
    if (!usage?.everyAccountNear) continue;
    const window = `${usage.connection}|${usage.resetAt ?? new Date(now).toISOString().slice(0, 13)}`;
    const asked = runtime.store.get("settings", runtime.owner, `handoff-asked:${run.sessionId}`)?.data as { window?: string } | undefined;
    if (asked?.window === window) continue;
    runtime.store.save("settings", runtime.owner, `handoff-asked:${run.sessionId}`, { window, at: new Date(now).toISOString() });
    runtime.store.event(run.id, "usage.handoff_asked", { connection: usage.connection, accounts: usage.accounts.length, resetAt: usage.resetAt });
    try { runtime.steer(run.id, handoffNote(usage), "Branch (every account is near its plan limit)"); } catch { /* it finished meanwhile */ }
  }
}

export function registerLeadUsage(registry: ToolRegistry, runtime: Runtime): void {
  registry.register({
    name: "accounts.usage", permission: "settings.read", group: "settings",
    description: `What each account of the connection this conversation uses has left of its plan (the same numbers as the usage ring) and which one is in use; also whether every one is near its limit (${nearLimitPercentUsed}% used, or resting). At a limit the work moves to the next account by itself; write a handoff only when every account is near its limit.`,
    parameters: z.object({}).strict(),
    execute: async (_input, context: ToolContext) => {
      if (!ownersOwn(context)) throw new Error("Only the owner's own conversations can see what their accounts have left.");
      const sessionId = runtime.store.run(context.runId)?.sessionId;
      if (!sessionId) throw new Error("This task has no conversation.");
      return connectionUsage(runtime, sessionId) ?? { connection: null, note: "This connection does not report a plan or a limit." };
    },
  });
}
