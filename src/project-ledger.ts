import type { Store } from "./store.js";
import { estimateCost, formatCost, pricingSettings } from "./pricing.js";

/**
 * What each project has cost. Every task now records the project it was done under, so the figures
 * can be added up a project at a time without guessing from the conversation it belonged to. Tasks
 * whose model has no price on file are counted separately rather than shown as nothing, exactly as
 * the figures screen already does.
 */
export interface ProjectCost {
  projectId: string;
  name: string;
  runs: number;
  tokens: { input: number; output: number };
  /** US dollars for the tasks with a price on file. */
  cost: number;
  /** How it reads for a person. */
  display: string;
  /** Tasks whose model has no price, so the figure above is not the whole story. */
  unpricedRuns: number;
}

interface Row { project: string; run_id: string; input: number; output: number; cached: number; cacheWrite: number; cacheWrite1h: number }

/** Every task's project, tokens and model, since a moment. */
function rows(store: Store, owner: string, since: string): Row[] {
  return store.sqlite.prepare(
    `SELECT t.project AS project, t.id AS run_id,
       COALESCE(u.reported_input, 0) + COALESCE(u.estimated_input, 0) AS input,
       COALESCE(u.reported_output, 0) + COALESCE(u.estimated_output, 0) AS output,
       COALESCE(u.reported_cached_input, 0) AS cached, COALESCE(u.reported_cache_write, 0) AS cache_write,
       COALESCE(u.reported_cache_write_hour, 0) AS cache_write_hour
     FROM tasks t LEFT JOIN usage u ON u.run_id = t.id
     WHERE t.owner = ? AND t.created_at >= ? ORDER BY t.created_at`,
  ).all(owner, since).map((row) => ({
    project: String(row.project ?? "default"), run_id: String(row.run_id),
    input: Number(row.input ?? 0), output: Number(row.output ?? 0),
    cached: Number(row.cached ?? 0), cacheWrite: Number(row.cache_write ?? 0), cacheWrite1h: Number(row.cache_write_hour ?? 0),
  }));
}

/** The model a task finished on, from its own events; empty when nothing said. */
function modelOf(store: Store, runId: string): string {
  const named = store.events(runId).filter((event) => event.kind.startsWith("model.") && event.data.model !== undefined);
  return String(named.at(-1)?.data.model ?? "");
}

/**
 * The ledger, grouped by project. `sinceDays` counts back from today; the default month is what the
 * figures screen shows everywhere else.
 */
export function costByProject(store: Store, owner: string, sinceDays = 30): ProjectCost[] {
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const { overrides } = pricingSettings(store, owner);
  const names = new Map(store.projects.list(owner).map((project) => [project.id, project.name]));
  const totals = new Map<string, ProjectCost>();
  for (const row of rows(store, owner, since)) {
    const entry = totals.get(row.project) ?? {
      projectId: row.project, name: names.get(row.project) ?? row.project, runs: 0,
      tokens: { input: 0, output: 0 }, cost: 0, display: "", unpricedRuns: 0,
    };
    entry.runs += 1;
    entry.tokens.input += row.input;
    entry.tokens.output += row.output;
    const model = modelOf(store, row.run_id);
    const estimate = model ? estimateCost(model, { input: row.input, output: row.output, cached: row.cached, cacheWrite: row.cacheWrite, cacheWrite1h: row.cacheWrite1h }, overrides) : null;
    if (estimate?.amount === null || estimate === null) entry.unpricedRuns += 1;
    else entry.cost += estimate.amount;
    totals.set(row.project, entry);
  }
  return [...totals.values()]
    .map((entry) => ({ ...entry, display: formatCost({ amount: entry.cost, currency: "USD", confidence: "table", note: "" }) }))
    .sort((a, b) => b.cost - a.cost || a.projectId.localeCompare(b.projectId));
}
