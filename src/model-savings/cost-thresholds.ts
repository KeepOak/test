import { z } from "zod";
import type { ModelPreset, ModelRouter } from "../models.js";
import type { Store } from "../store.js";
import { estimateCost, pricingSettings } from "../pricing.js";
import { CostThresholdSettingsSchema, readSavings, type SavingsValues } from "./settings.js";
import { currentPerson } from "../people/context.js";
import { startedWithShortLivedKey } from "../key-context.js";

type Rule = SavingsValues["costThresholds"]["rules"][number];
export const thresholdProvider = (preset: ModelPreset): string => preset.catalogId ?? preset.id;
const hasPrice = (store: Store, owner: string, preset: ModelPreset): boolean =>
  estimateCost(preset.model, { input: 1, output: 1 }, pricingSettings(store, owner).overrides).amount !== null;
const ReceiptSchema = z.object({
  catalogId: z.string().optional(), preset: z.string(), model: z.string(), cached: z.boolean().optional(),
  estimatedInput: z.number().nonnegative(), estimatedOutput: z.number().nonnegative(),
  reported: z.object({
    input: z.number().nonnegative(), output: z.number().nonnegative(),
    cachedInput: z.number().nonnegative().optional(),
    cacheWrite: z.number().nonnegative().optional(),
    cacheWrite1h: z.number().nonnegative().optional(),
  }).nullable().optional(),
});

/** Validate actual connections before saving; the API has already checked who is asking. */
export function checkCostThresholds(store: Store, owner: string, models: ModelRouter, input: Record<string, unknown>): void {
  const value = CostThresholdSettingsSchema.parse({ ...readSavings(store, owner, "costThresholds"), ...input });
  const seen = new Set<string>();
  for (const rule of value.rules) {
    const key = JSON.stringify([rule.provider, rule.model]);
    if (seen.has(key)) throw new Error("Two cost thresholds name the same service and model.");
    seen.add(key);
    const presets = [...models.presets.values()].filter((preset) => thresholdProvider(preset) === rule.provider);
    if (!presets.some((preset) => !rule.model || preset.model === rule.model)) throw new Error("That service and model are not set up.");
    if (rule.fallbackPreset && !models.presets.has(rule.fallbackPreset)) throw new Error("The threshold fallback connection is not set up.");
  }
}

/** Current-price estimate from completed round receipts after activation. Unknown price is never zero. */
function spent(store: Store, owner: string, rule: Rule, since: string): { dollars: number; unknown: boolean } {
  const rows = store.sqlite.prepare(`SELECT e.data FROM events e JOIN tasks t ON t.id=e.run_id
    WHERE t.owner=? AND e.kind='model.completed' AND e.created_at>=?`).iterate(owner, since);
  const overrides = pricingSettings(store, owner).overrides;
  let dollars = 0, unknown = false;
  for (const row of rows) {
    let data: unknown;
    try { data = JSON.parse(String(row.data)); } catch { unknown = true; continue; }
    const parsed = ReceiptSchema.safeParse(data);
    if (!parsed.success) { unknown = true; continue; }
    const receipt = parsed.data;
    if ((receipt.catalogId ?? receipt.preset) !== rule.provider || (rule.model && receipt.model !== rule.model) || receipt.cached) continue;
    const cost = estimateCost(receipt.model, {
      input: Math.max(receipt.estimatedInput, receipt.reported?.input ?? 0),
      output: Math.max(receipt.estimatedOutput, receipt.reported?.output ?? 0),
      cached: receipt.reported?.cachedInput,
      cacheWrite: receipt.reported?.cacheWrite,
      cacheWrite1h: receipt.reported?.cacheWrite1h,
    }, overrides).amount;
    if (cost === null) unknown = true;
    else dollars += cost;
  }
  return { dollars, unknown };
}

function refusal(store: Store, owner: string, preset: ModelPreset, rules: Rule[], since: string): { reason: string; rule: Rule } | null {
  for (const rule of rules.filter((one) => one.provider === thresholdProvider(preset) && (!one.model || one.model === preset.model))) {
    const total = spent(store, owner, rule, since);
    if (total.unknown || !hasPrice(store, owner, preset)) return { rule, reason: `The enabled cost threshold cannot price ${preset.name}; add its price or turn off this threshold.` };
    if (total.dollars >= rule.maxMonthlyDollars) return { rule, reason: `${preset.name} reached its recorded-estimate threshold of $${rule.maxMonthlyDollars.toFixed(2)} this month (about $${total.dollars.toFixed(2)} recorded).` };
  }
  return null;
}

/** Only the explicitly named fallback is considered; its own thresholds and the caller's constraints still apply. */
export function thresholdPreset(store: Store, models: ModelRouter, owner: string, preset: ModelPreset,
  constraints: { runId: string; allowFallback: boolean; mayUse: (preset: ModelPreset) => boolean }): ModelPreset {
  const raw = store.get("settings", owner, "model-savings-costThresholds")?.data;
  if (raw?.mode === "on" && !CostThresholdSettingsSchema.safeParse(raw).success)
    throw new Error("The enabled cost thresholds could not be read. Review them before continuing.");
  const value = readSavings(store, owner, "costThresholds");
  if (value.mode !== "on") return preset;
  const monthStart = new Date().toISOString().slice(0, 7) + "-01T00:00:00.000Z";
  const since = value.activatedAt && value.activatedAt > monthStart ? value.activatedAt : monthStart;
  const blocked = refusal(store, owner, preset, value.rules, since);
  if (!blocked) return preset;
  const privateFigures = !!currentPerson() || startedWithShortLivedKey() || !store.profiles.isOwner() || store.profiles.scope() !== owner;
  const reason = privateFigures ? "This connection cannot take another round under the owner's cost settings." : blocked.reason;
  const fallback = blocked.rule.fallbackPreset ? models.presets.get(blocked.rule.fallbackPreset) : undefined;
  if (!constraints.allowFallback || !fallback || fallback.id === preset.id || !constraints.mayUse(fallback)
    || !hasPrice(store, owner, fallback) || refusal(store, owner, fallback, value.rules, since)) throw new Error(reason);
  store.event(constraints.runId, "model.routed", { kind: "cost-threshold", from: preset.id, preset: fallback.id, reason });
  return fallback;
}
