import { z } from "zod";
import { AccountSchema, poolId } from "./accounts/settings.js";
import type { ModelPreset } from "./models.js";
import type { Store } from "./store.js";

export const HelperAccountRefSchema = z.object({ pool: poolId, account: AccountSchema.shape.id }).strict();
export const HelperSelectionSchema = z.object({ model: poolId.optional(), accountRef: HelperAccountRefSchema.optional() }).strict();
export type HelperSelection = z.infer<typeof HelperSelectionSchema>;
export type HelperAccountRef = z.infer<typeof HelperAccountRefSchema>;
export interface HelperConnection {
  preset: ModelPreset;
  accountRef?: HelperAccountRef;
  /** MODEL-050: gives back the account lease this helper holds (src/accounts/leases.ts); safe to call more than once. */
  release?: () => void;
}
const HelperRouteSchema = HelperSelectionSchema.extend({ model: poolId });
export type HelperRoute = z.infer<typeof HelperRouteSchema>;

/** Exact approval target for every helper destination named by a call. */
export function helperRouteTarget(tasks: readonly ({ specialist: string } & HelperSelection)[]): string {
  return JSON.stringify(tasks.map(({ specialist, model, accountRef }) => ({
    specialist, model: model ?? null, accountRef: accountRef ?? null,
  })));
}

const HelperRouteTargetSchema = z.array(z.object({ specialist: z.string(), model: poolId.nullable(), accountRef: HelperAccountRefSchema.nullable() }).strict());
/**
 * The approval question's words for a helper-route target: the target stays the exact binding key, but the
 * owner reads each named route in words ("Reviewer on alpha, account 1234abcd"), and nothing when every helper
 * keeps its usual route. Null when the target is not a helper-route target.
 */
export function helperRouteWords(target: string, nameOf: (id: string) => string | null): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(target); } catch { return null; }
  const routes = HelperRouteTargetSchema.safeParse(parsed);
  if (!routes.success) return null;
  return routes.data.filter((route) => route.model || route.accountRef).map((route) => {
    const who = nameOf(route.specialist) || "a helper";
    const account = route.accountRef ? `, account ${route.accountRef.account}` : "";
    return `${who} on ${route.model ?? "its usual model"}${account}`;
  }).join("; ");
}

/** Private session metadata: a helper never follows a later global account or model change. */
export function helperRoute(store: Store, owner: string, sessionId: string): HelperRoute | null {
  const saved = store.get("settings", owner, `helper-route:${sessionId}`);
  return saved ? HelperRouteSchema.parse(saved.data) : null;
}
export function keepHelperRoute(store: Store, owner: string, sessionId: string, connection: HelperConnection): void {
  if (!store.ownsSession(owner, sessionId)) throw new Error("Helper conversation belongs to another owner");
  const route = HelperRouteSchema.parse({ model: connection.preset.id, ...(connection.accountRef ? { accountRef: connection.accountRef } : {}) });
  const previous = helperRoute(store, owner, sessionId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(route)) throw new Error("The helper model and account are pinned to its conversation");
  store.save("settings", owner, `helper-route:${sessionId}`, route);
}

/**
 * Delegation helpers: checking a child's answer against the schema the parent asked for, and the
 * ordering of a fan-out where independent tasks run together and dependent ones wait.
 */
export const ResultSchemaSchema = z.record(z.string(), z.unknown()).refine((v) => typeof v.type === "string" || Array.isArray(v.enum), "Schema needs a type or enum");
export type ResultCheck = { status: "resolved"; value: unknown } | { status: "unresolved"; reason: string };

/** Parses JSON out of a child's text (bare or fenced) and checks it against a small JSON-Schema subset. */
export function checkResult(output: string, schema: Record<string, unknown> | undefined): ResultCheck {
  if (!schema) return { status: "resolved", value: output };
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(output)?.[1];
  let value: unknown;
  try { value = JSON.parse((fenced ?? output).trim()); } catch { return { status: "unresolved", reason: "The answer was not valid JSON" }; }
  const problem = mismatch(value, schema, "result");
  return problem ? { status: "unresolved", reason: problem } : { status: "resolved", value };
}
export function mismatch(value: unknown, schema: Record<string, unknown>, path: string): string | null {
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value)))
    return `${path} must be one of ${schema.enum.map((o) => JSON.stringify(o)).join(", ")}`;
  const type = schema.type;
  if (type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object`;
    const record = value as Record<string, unknown>, properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const key of (schema.required as string[] | undefined) ?? []) if (!(key in record)) return `${path}.${key} is required`;
    for (const [key, sub] of Object.entries(properties)) if (key in record) { const bad = mismatch(record[key], sub, `${path}.${key}`); if (bad) return bad; }
    return null;
  }
  if (type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} items`;
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) for (const [index, entry] of value.entries()) { const bad = mismatch(entry, items, `${path}[${index}]`); if (bad) return bad; }
    return null;
  }
  if (type === "string") {
    if (typeof value !== "string") return `${path} must be a string`;
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path} is too short`;
    return null;
  }
  if (type === "number" || type === "integer") {
    if (typeof value !== "number" || (type === "integer" && !Number.isInteger(value))) return `${path} must be a ${type}`;
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path} is below ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path} is above ${schema.maximum}`;
    return null;
  }
  if (type === "boolean") return typeof value === "boolean" ? null : `${path} must be true or false`;
  return null;
}

export const FanoutTaskSchema = z.object({
  ...HelperSelectionSchema.shape,
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/),
  prompt: z.string().min(1).max(8000),
  dependsOn: z.array(z.string()).max(8).default([]),
  resultSchema: ResultSchemaSchema.optional(),
  /** Exit criteria for this task (same shape as a run's checks). */
  checks: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type FanoutTask = z.infer<typeof FanoutTaskSchema>;

/** Waves of task ids: every task in a wave depends only on earlier waves. Rejects cycles and unknown ids. */
export function fanoutWaves(tasks: FanoutTask[]): string[][] {
  const ids = new Set(tasks.map((t) => t.id));
  if (ids.size !== tasks.length) throw new Error("Fan-out task ids must be unique");
  for (const task of tasks) for (const dep of task.dependsOn)
    if (!ids.has(dep)) throw new Error(`Task ${task.id} depends on unknown task ${dep}`);
  const done = new Set<string>(), waves: string[][] = [];
  while (done.size < tasks.length) {
    const wave = tasks.filter((t) => !done.has(t.id) && t.dependsOn.every((d) => done.has(d))).map((t) => t.id);
    if (!wave.length) throw new Error("Fan-out tasks depend on each other in a cycle");
    for (const id of wave) done.add(id);
    waves.push(wave);
  }
  return waves;
}
