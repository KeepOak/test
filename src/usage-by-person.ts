import type { Store } from "./store.js";
import { runOrigin } from "./key-context.js";
import { tokenCountsOf } from "./pricing.js";

export interface PersonUsageRow {
  kind: "owner" | "person" | "unassigned";
  profileId: string | null;
  /** Current household name only; null preserves removed-person attribution without inventing a name. */
  name: string | null;
  tasks: number;
  tokens: { input: number; output: number };
  estimatedModelCost: number | null;
  unpricedTasks: number;
}
export interface PersonUsageReport {
  days: number; since: string; inspected: number; counted: number; capped: boolean;
  rows: PersonUsageRow[];
}
export interface PersonUsageDeps {
  store: Store; owner: string;
  /** Existing per-task model list-price estimate; excludes non-model purchases. */
  modelCostOf: (runId: string) => number | null;
  now?: () => number;
}
const maximumTasks = 3000;

/** Captured model usage only; continuation/helper attribution follows the existing recorded origin chain. */
export function usageByPerson(deps: PersonUsageDeps, days = 30): PersonUsageReport {
  days = Number.isInteger(days) && days >= 1 && days <= 90 ? days : 30;
  const since = new Date((deps.now?.() ?? Date.now()) - days * 86_400_000).toISOString();
  const tasks = deps.store.taskIdsSince(deps.owner, since, maximumTasks + 1);
  const inspected = tasks.slice(0, maximumTasks);
  const profiles = new Map(deps.store.profiles.list().map((profile) => [profile.id, profile.name]));
  const rows = new Map<string, PersonUsageRow>();
  let counted = 0;
  for (const id of inspected) {
    const usage = deps.store.usage(id), tokens = tokenCountsOf(usage), events = deps.store.events(id);
    // Setup-only/bootstrap tasks that never called a model do not become unpriced work.
    if (!usage.attempts && !tokens.input && !tokens.output && !events.some((event) => event.kind === "model.started")) continue;
    const origin = runOrigin(deps.store, id);
    const profileId = origin.personProfileId;
    const started = events.find((event) => event.kind === "run.started")?.data;
    const ownerRecorded = !profileId && started?.source === "owner" && origin.source === "owner"
      && !origin.shortLivedKey && !origin.lentTo;
    const kind = profileId ? "person" : ownerRecorded ? "owner" : "unassigned";
    const key = profileId ? `person:${profileId}` : kind;
    let row = rows.get(key);
    if (!row) rows.set(key, row = { kind, profileId, name: profileId ? profiles.get(profileId) ?? null : null,
      tasks: 0, tokens: { input: 0, output: 0 }, estimatedModelCost: null, unpricedTasks: 0 });
    row.tasks += 1;
    row.tokens.input += tokens.input;
    row.tokens.output += tokens.output;
    const cost = deps.modelCostOf(id);
    if (cost === null || !Number.isFinite(cost) || cost < 0) row.unpricedTasks += 1;
    else row.estimatedModelCost = (row.estimatedModelCost ?? 0) + cost;
    counted += 1;
  }
  return { days, since, inspected: inspected.length, counted, capped: tasks.length > maximumTasks,
    rows: [...rows.values()].map((row) => ({ ...row,
      estimatedModelCost: row.estimatedModelCost === null ? null : Math.round(row.estimatedModelCost * 1_000_000) / 1_000_000,
    })).sort((a, b) => (b.tokens.input + b.tokens.output) - (a.tokens.input + a.tokens.output)) };
}
