import { z } from "zod";
import type { Store } from "./store.js";
import type { ModelPreset } from "./models.js";
import { estimateCost, pricingSettings } from "./pricing.js";
import { UsageSchema } from "./contracts.js";

export type UsageKind = "api-key" | "chatgpt" | "cli" | "local" | null;
export const RoutineBudgetSchema = z.object({ monthlyEstimatedDollars: z.number().min(0.01).max(100_000).nullable() }).strict();
export type RoutineBudget = z.infer<typeof RoutineBudgetSchema>;
const taskCap = 3000, eventCap = 40_000;
const budgetKey = (id: string) => `routine-budget:${id}`;
export function routineBudget(store: Store, owner: string, id: string): RoutineBudget {
  return RoutineBudgetSchema.parse(store.get("governance", owner, budgetKey(id))?.data ?? { monthlyEstimatedDollars: null });
}
export function saveRoutineBudget(store: Store, owner: string, id: string, input: unknown): RoutineBudget {
  store.profiles.requireOwner("Your routine budget");
  const record = store.get("schedules", owner, id);
  if (!record) throw new Error("Schedule not found");
  const value = RoutineBudgetSchema.parse(input);
  store.save("governance", owner, budgetKey(id), value);
  return value;
}
export function usageMonth(now = new Date()): { month: string; from: string; until: string } {
  return { month: now.toISOString().slice(0, 7), from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    until: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString() };
}
export interface RoutineUsage {
  month: string; turns: number; tasks: number; modelCalls: number; tokens: number;
  estimatedModelDollars: number | null; recordedSpendDollars: number; unpricedCalls: number;
  capped: boolean; legacyTurns: number; budget: RoutineBudget;
}
function rootsOf(store: Store, owner: string, id: string): { ids: string[]; legacy: Set<string>; capped: boolean } {
  const rows = store.sqlite.prepare(`SELECT DISTINCT t.id FROM events e JOIN tasks t ON t.id=e.run_id
    WHERE t.owner=? AND e.kind='schedule.turn' AND json_valid(e.data) AND json_extract(e.data,'$.scheduleId')=?
    ORDER BY t.created_at DESC LIMIT ?`).all(owner, id, taskCap + 1);
  const ids = rows.slice(0, taskCap).map((row) => String(row.id)), legacy = new Set<string>();
  const history = store.get("schedules", owner, id)?.data.history;
  if (Array.isArray(history)) for (const entry of history.slice(-50)) {
    const runId = entry && typeof entry === "object" ? String((entry as { runId?: unknown }).runId ?? "") : "";
    if (runId && !ids.includes(runId) && store.run(runId)?.owner === owner) { ids.push(runId); legacy.add(runId); }
  }
  return { ids: ids.slice(0, taskCap), legacy, capped: rows.length > taskCap || ids.length > taskCap };
}
function familyOf(store: Store, owner: string, roots: string[]): { ids: string[]; capped: boolean } {
  const rows = store.sqlite.prepare(`WITH RECURSIVE links AS (
    SELECT e.run_id AS child,CASE WHEN e.kind='run.started' THEN COALESCE(NULLIF(json_extract(e.data,'$.parentRunId'),''),json_extract(e.data,'$.resumedFrom'))
      ELSE json_extract(e.data,'$.runId') END AS parent FROM events e
    WHERE e.kind IN ('run.started','routine.parent') AND json_valid(e.data)
      AND e.id=(SELECT MIN(first.id) FROM events first WHERE first.run_id=e.run_id AND first.kind=e.kind)
    ), family(id,depth,path) AS (
    SELECT id,0,','||id||',' FROM tasks WHERE owner=? AND id IN (SELECT value FROM json_each(?))
    UNION ALL SELECT t.id,f.depth+1,f.path||t.id||',' FROM family f JOIN links e ON e.parent=f.id
      JOIN tasks t ON t.id=e.child AND t.owner=? WHERE f.depth<20 AND instr(f.path,','||t.id||',')=0
    ) SELECT id,MAX(depth) AS depth FROM family GROUP BY id LIMIT ?`).all(owner, JSON.stringify(roots), owner, taskCap + 1);
  return { ids: rows.slice(0, taskCap).map((row) => String(row.id)), capped: rows.length > taskCap || rows.some((row) => Number(row.depth) >= 20) };
}
function amount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
function callCost(data: Record<string, unknown>, store: Store, owner: string): { cost: number | null; tokens: number } {
  if (data.cached === true) return { cost: 0, tokens: 0 };
  const reported = UsageSchema.safeParse(data.reported);
  const input = reported.success ? reported.data.input : amount(data.estimatedInput);
  const output = reported.success ? reported.data.output : amount(data.estimatedOutput);
  const tokens = (input ?? 0) + (output ?? 0);
  if (data.usageKind === "local") return { cost: 0, tokens };
  if (data.usageKind !== "api-key" || input === null || output === null || typeof data.model !== "string") return { cost: null, tokens };
  return { cost: estimateCost(data.model, { input, output, ...(reported.success && reported.data.cachedInput !== undefined ? { cached: reported.data.cachedInput } : {}) },
    pricingSettings(store, owner).overrides).amount, tokens };
}
/** Recorded call estimates, not an invoice. Each call keeps its own model and billing kind; no last-model pricing. */
export function routineUsage(store: Store, owner: string, id: string, now = new Date()): RoutineUsage {
  const period = usageMonth(now), roots = rootsOf(store, owner, id), family = familyOf(store, owner, roots.ids);
  const rows = store.sqlite.prepare(`SELECT e.kind,e.data FROM events e JOIN tasks t ON t.id=e.run_id
    WHERE t.owner=? AND e.run_id IN (SELECT value FROM json_each(?)) AND e.created_at>=? AND e.created_at<?
    AND e.kind IN ('model.completed','model.failed','model.stalled','model.cancelled','spend.recorded') ORDER BY e.id LIMIT ?`)
    .all(owner, JSON.stringify(family.ids), period.from, period.until, eventCap + 1);
  const counts = store.sqlite.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE owner=? AND id IN (SELECT value FROM json_each(?))
    AND created_at>=? AND created_at<?`).get(owner, JSON.stringify(roots.ids), period.from, period.until);
  const tasks = store.sqlite.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE owner=? AND id IN (SELECT value FROM json_each(?))
    AND created_at>=? AND created_at<?`).get(owner, JSON.stringify(family.ids), period.from, period.until);
  const legacyTurns = [...roots.legacy].filter((runId) => {
    const at = store.run(runId)?.createdAt; return !!at && at >= period.from && at < period.until;
  }).length;
  const out: RoutineUsage = { month: period.month, turns: Number(counts?.n ?? 0), tasks: Number(tasks?.n ?? 0), modelCalls: 0, tokens: 0,
    estimatedModelDollars: null, recordedSpendDollars: 0, unpricedCalls: 0,
    capped: roots.capped || family.capped || rows.length > eventCap, legacyTurns, budget: routineBudget(store, owner, id) };
  for (const row of rows.slice(0, eventCap)) {
    let data: Record<string, unknown>;
    try { data = JSON.parse(String(row.data)) as Record<string, unknown>; } catch { out.unpricedCalls++; continue; }
    if (row.kind === "spend.recorded") {
      const dollars = amount(data.dollars); if (dollars === null) out.unpricedCalls++; else out.recordedSpendDollars += dollars;
    } else if (row.kind !== "model.completed") { out.unpricedCalls++; out.modelCalls++; }
    else {
      if (data.cached !== true) out.modelCalls++;
      const call = callCost(data, store, owner); out.tokens += call.tokens;
      if (call.cost === null) out.unpricedCalls++; else out.estimatedModelDollars = (out.estimatedModelDollars ?? 0) + call.cost;
    }
  }
  return out;
}
/** The engine's parent chain, never a user-supplied schedule id. */
function routineFor(store: Store, owner: string, runId: string): string | null {
  const seen = new Set<string>();
  for (let depth = 0; depth < 20; depth++) {
    if (seen.has(runId) || store.run(runId)?.owner !== owner) throw new Error("The routine's task ancestry could not be verified");
    seen.add(runId);
    const events = store.events(runId), turn = events.find((event) => event.kind === "schedule.turn");
    if (turn && typeof turn.data.scheduleId === "string") return turn.data.scheduleId;
    const started = events.find((event) => event.kind === "run.started")?.data;
    const parent = typeof started?.parentRunId === "string" && started.parentRunId ? started.parentRunId : started?.resumedFrom;
    const routineParent = events.find((event) => event.kind === "routine.parent")?.data.runId;
    const next = typeof parent === "string" && parent ? parent : routineParent;
    // A learning pass (src/skill-authoring.ts learningTask) names the engine's "learning" marker, not a task: never a routine's.
    if (typeof next !== "string" || !next || next === "learning") return null;
    runId = next;
  }
  throw new Error("The routine's task ancestry exceeds the supported depth");
}
/** Checked before every model round, including helpers; stops on incomplete cost records rather than assuming zero. */
export function routineBudgetRefusal(store: Store, owner: string, runId: string, preset: ModelPreset, kind: UsageKind): string | null {
  const id = routineFor(store, owner, runId); if (!id) return null;
  const limit = routineBudget(store, owner, id).monthlyEstimatedDollars; if (limit === null) return null;
  if (kind !== "local" && (kind !== "api-key" || estimateCost(preset.model, { input: 0, output: 0 }, pricingSettings(store, owner).overrides).amount === null))
    return "This routine's budget cannot price the selected connection. Plan sign-ins and unknown prices are not treated as free. Change its budget in Automations.";
  const usage = routineUsage(store, owner, id);
  if (usage.capped || usage.unpricedCalls || usage.legacyTurns)
    return "This routine stopped because its month's cost record is incomplete. Change its budget in Automations; unknown use is not counted as free.";
  const spent = (usage.estimatedModelDollars ?? 0) + usage.recordedSpendDollars;
  return spent >= limit ? "This routine reached its monthly estimate budget. The owner can review or change it in Automations." : null;
}
