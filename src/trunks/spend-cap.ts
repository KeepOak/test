import { z } from "zod";
import { audit } from "../audit.js";
import { recordedSpend } from "../knobs/apply.js";
import { estimateCost, pricingSettings } from "../pricing.js";
import type { Store } from "../store.js";
import type { TrunkRecords } from "./record.js";

/**
 * models-ui (P2, cost per Trunk): the most a Trunk may spend in a calendar month.
 *
 * What a Trunk spent is counted from this computer's own record: every task that was one of its turns this
 * month, with the helpers those turns started, priced at the list price of the model each answered on (or
 * the owner's own price on the Usage page) plus anything a task recorded spending outside the model. A
 * task on a model with no price on file cannot be counted and is said to be uncounted, never taken as free.
 * A plan sign-in is billed as a plan, so for it this is what the same work would cost at list price.
 *
 * Once the month's spending reaches the limit, the Trunk starts nothing new and a turn already running stops
 * before its next model call (src/runtime.ts), each time in one plain sentence. Nothing saved means no
 * limit, exactly as before this existed. Kept in `governance` under `trunk-spend-cap:<id>`, off the Trunk
 * record, so the generic edit cannot change it and a shared Trunk file never carries it; every change is
 * the owner's and is written in the activity log.
 */
export const TrunkSpendCapSchema = z.object({
  monthlyUsd: z.number().min(0.01).max(100_000).nullable(),
}).strict();

export interface TrunkSpendView {
  /** The month's limit in dollars, or null for none. */
  monthlyUsd: number | null;
  /** Dollars this month for the tasks that have a price. */
  spentUsd: number;
  /** Tasks counted this month, and those of them with no price on file. */
  tasks: number;
  unpricedTasks: number;
  /** When the month began (local time), as an ISO timestamp. */
  since: string;
  /** True when more tasks ran than are counted. */
  capped: boolean;
}

export interface TrunkSpendCapDeps {
  store: Store;
  owner: string;
  records: TrunkRecords;
  now?: () => number;
}

const key = (trunkId: string): string => `trunk-spend-cap:${trunkId}`;
/** Most tasks counted, so a very busy month never slows a turn down. */
const countedMost = 5000;
/** How long a month's total is reused before it is counted again; a model call checks it each time. */
const freshMs = 20_000;

export class TrunkSpendCap {
  private readonly totals = new Map<string, { at: number; view: Omit<TrunkSpendView, "monthlyUsd"> }>();
  constructor(private readonly deps: TrunkSpendCapDeps) {}

  private now(): number { return this.deps.now?.() ?? Date.now(); }

  /** The saved limit, or null while nothing is saved or the record cannot be read. */
  limit(trunkId: string): number | null {
    const parsed = TrunkSpendCapSchema.safeParse(this.deps.store.get("governance", this.deps.owner, key(trunkId))?.data);
    return parsed.success ? parsed.data.monthlyUsd : null;
  }

  view(trunkId: string): TrunkSpendView {
    this.deps.records.get(trunkId);
    return { monthlyUsd: this.limit(trunkId), ...this.spent(trunkId, true) };
  }

  set(trunkId: string, input: unknown): TrunkSpendView {
    const trunk = this.deps.records.get(trunkId);
    const next = TrunkSpendCapSchema.parse(input ?? {});
    this.deps.store.save("governance", this.deps.owner, key(trunkId), next);
    audit(this.deps.store, this.deps.owner, { action: "trunk.spend_cap", actor: this.deps.owner, subject: `Trunk "${trunk.name}"`,
      reason: next.monthlyUsd === null ? "No monthly spending limit" : `It may spend up to $${next.monthlyUsd.toFixed(2)} a month`,
      outcome: "changed" });
    return this.view(trunkId);
  }

  /** Why the Trunk may not go on now (this month's spending reached its limit), or null. */
  refusal(trunkId: string): string | null {
    const cap = this.limit(trunkId);
    if (cap === null) return null;
    const { spentUsd } = this.spent(trunkId, false);
    if (spentUsd < cap) return null;
    const name = this.deps.records.find(trunkId)?.name ?? "This Trunk";
    return `${name} has spent about $${spentUsd.toFixed(2)} this month, which reaches its limit of $${cap.toFixed(2)}, so it stopped. Raise or clear the limit in Edit Trunk › Accounts.`;
  }

  /** This month's spending, counted again when asked for fresh or when the last count is older than a few seconds. */
  private spent(trunkId: string, fresh: boolean): Omit<TrunkSpendView, "monthlyUsd"> {
    const now = this.now(), start = monthStart(now);
    const kept = this.totals.get(trunkId);
    if (!fresh && kept && now - kept.at < freshMs && kept.view.since === start) return kept.view;
    const ids = this.deps.store.trunkTaskIdsSince(trunkId, start, countedMost + 1);
    const counted = ids.slice(0, countedMost);
    const { overrides } = pricingSettings(this.deps.store, this.deps.owner);
    let spentUsd = recordedSpend(this.deps.store, counted), unpricedTasks = 0;
    for (const id of counted) {
      const cost = taskCost(this.deps.store, id, overrides);
      if (cost === null) unpricedTasks += 1; else spentUsd += cost;
    }
    const view = { spentUsd: Math.round(spentUsd * 10_000) / 10_000, tasks: counted.length, unpricedTasks, since: start, capped: ids.length > countedMost };
    this.totals.set(trunkId, { at: now, view });
    return view;
  }
}

/** The first moment of this calendar month, local time. */
export function monthStart(now: number): string {
  const date = new Date(now);
  return new Date(date.getFullYear(), date.getMonth(), 1).toISOString();
}

/** One task's model tokens at the price of the model it last answered on; null when it has tokens and no price. */
function taskCost(store: Store, runId: string, overrides: ReturnType<typeof pricingSettings>["overrides"]): number | null {
  const usage = store.usage(runId);
  const tokens = { input: usage.reportedInput || usage.estimatedInput || 0, output: usage.reportedOutput || usage.estimatedOutput || 0 };
  if (!tokens.input && !tokens.output) return 0;
  const model = String(store.events(runId).filter((event) => event.kind.startsWith("model.") && event.data.model !== undefined).at(-1)?.data.model ?? "");
  return model ? estimateCost(model, tokens, overrides).amount : null;
}
