import { z } from "zod";
import type { Store } from "./store.js";

/**
 * models-ui (MODEL-052, owner 2026-09-27): who spent what. The owner's own tasks and each Trunk's, over the last days,
 * with the accounts each answered through. Counted from this computer's own record: a task is a Trunk's when it was
 * that Trunk's turn (the "trunk.turn" event the runtime writes for its chat, routines and room seats); its accounts are
 * the "model.account" events of its calls; its tokens and cost are the task's own figures. A task on a plan sign-in has
 * no price (the plan is billed as a plan), so its tokens and tasks are counted and its cost is said to be unknown.
 */
export const UsageByTrunkRequestSchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).strict();

export interface TrunkSpend {
  trunk: { id: string; name: string } | null;
  /** A helper's specialist/mode as recorded when it started; null for the owner's and Trunks' tasks. */
  agent: { id: string; name: string } | null;
  tasks: number; tokens: number;
  /** Dollars for the tasks that have a price; null when none has one. */
  cost: number | null;
  unpricedTasks: number;
  accounts: { pool: string; account: string; label: string; calls: number }[];
}

export interface UsageByTrunkDeps {
  store: Store;
  owner: string;
  /** A Trunk by its id, for its name now (a removed Trunk is named by its id). */
  trunkName: (id: string) => string | null;
  /** A task's cost in dollars, or null when no price is on file. */
  costOf: (runId: string) => number | null;
  now?: () => number;
}

/** Most tasks counted, so a very busy stretch never makes the page slow. */
const cap = 3000;

function spendIdentity(deps: UsageByTrunkDeps, events: ReturnType<Store["events"]>): { key: string; trunk: TrunkSpend["trunk"]; agent: TrunkSpend["agent"] } {
  const start = events.find((event) => event.kind === "run.started")?.data;
  const helper = typeof start?.parentRunId === "string" && !!start.parentRunId && start.parentRunId !== "learning";
  const turn = events.find((event) => event.kind === "trunk.turn")?.data;
  const trunkId = typeof turn?.trunkId === "string" ? turn.trunkId : "";
  const trunk = trunkId ? { id: trunkId, name: deps.trunkName(trunkId) ?? trunkId } : null;
  if (!helper) return { key: trunkId ? `trunk:${trunkId}` : "owner", trunk, agent: null };
  const id = typeof start?.agent === "string" && start.agent ? start.agent : "helper";
  const name = typeof start?.agentName === "string" && start.agentName ? start.agentName : id;
  return { key: `helper:${trunkId}:${id}`, trunk, agent: { id, name } };
}

export function usageByTrunk(deps: UsageByTrunkDeps, input: unknown): { days: number; since: string; rows: TrunkSpend[]; counted: number; capped: boolean } {
  const { days } = UsageByTrunkRequestSchema.parse(input ?? {});
  const since = new Date((deps.now?.() ?? Date.now()) - days * 86_400_000).toISOString();
  const tasks = deps.store.taskIdsSince(deps.owner, since, cap + 1);
  const capped = tasks.length > cap;
  const counted = tasks.slice(0, cap);
  const rows = new Map<string, TrunkSpend>();
  for (const id of counted) {
    const events = deps.store.events(id);
    const identity = spendIdentity(deps, events);
    let row = rows.get(identity.key);
    if (!row) rows.set(identity.key, row = { trunk: identity.trunk, agent: identity.agent, tasks: 0, tokens: 0, cost: null, unpricedTasks: 0, accounts: [] });
    row.tasks += 1;
    const usage = deps.store.usage(id);
    row.tokens += (usage.reportedInput || usage.estimatedInput || 0) + (usage.reportedOutput || usage.estimatedOutput || 0);
    const cost = deps.costOf(id);
    if (cost === null) row.unpricedTasks += 1; else row.cost = (row.cost ?? 0) + cost;
    for (const event of events.filter((one) => one.kind === "model.account")) {
      const data = event.data as { pool?: unknown; account?: unknown; label?: unknown };
      const pool = String(data.pool ?? ""), account = String(data.account ?? "");
      if (!pool || !account) continue;
      const seen = row.accounts.find((one) => one.pool === pool && one.account === account);
      if (seen) seen.calls += 1;
      else row.accounts.push({ pool, account, label: String(data.label ?? account), calls: 1 });
    }
  }
  const list = [...rows.values()].map((row) => ({ ...row, cost: row.cost === null ? null : Math.round(row.cost * 10_000) / 10_000,
    accounts: row.accounts.sort((a, b) => b.calls - a.calls) }));
  // The owner's own first, then Trunks and helpers by how much they did.
  list.sort((a, b) => Number(a.trunk !== null || a.agent !== null) - Number(b.trunk !== null || b.agent !== null) || b.tasks - a.tasks);
  return { days, since, rows: list, counted: counted.length, capped };
}
