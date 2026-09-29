import { z } from "zod";
import { catalogPrices } from "./provider-catalog.js";
import { localCatalogPriceUpdates } from "./provider-catalog-updates.js";
import type { Store } from "./store.js";

/**
 * What a model costs, so token counts can be shown as money. Prices are published figures that
 * change without notice, so every estimate says how much to trust it: a price from this table, a
 * price the owner typed in, or no price at all. A model with no price on file never reports zero —
 * zero is reserved for models that genuinely cost nothing, like one running on this computer.
 */
export interface ModelPrice {
  /** US dollars per million input tokens. */
  input: number;
  /** US dollars per million output tokens. */
  output: number;
  /** US dollars per million tokens read back from the provider's cache, when it offers one. */
  cached?: number | undefined;
}
export type CostConfidence = "table" | "override" | "unknown";
export interface CostEstimate {
  /** US dollars, or null when no price is on file for this model. */
  amount: number | null;
  currency: "USD";
  confidence: CostConfidence;
  /** Plain-language note for the screen, for example "no price on file". */
  note: string;
}
export interface TokenCounts {
  input: number;
  output: number;
  /** Tokens served from the provider's cache. Nothing records these yet; reserved for later. */
  cached?: number;
}

/** The date the built-in prices were last checked against the providers' public pricing pages. */
export const pricedAt = "2026-09-17";

/**
 * Published list prices in US dollars per million tokens, keyed by the model identifiers that
 * already appear in src/providers/presets.ts. Sources, all read on the date above:
 * OpenAI openai.com/api/pricing, Anthropic anthropic.com/pricing, Google ai.google.dev/pricing,
 * Groq groq.com/pricing, Mistral mistral.ai/technology, DeepSeek platform.deepseek.com/api-docs/pricing.
 * These are estimates for the owner's own planning, never a bill. Correct any of them under
 * Settings, which stores an override in `settings/pricing`.
 */
export const builtInPrices: Record<string, ModelPrice> = {
  // OpenAI
  "gpt-4o": { input: 2.5, output: 10, cached: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cached: 0.075 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "gpt-4": { input: 30, output: 60 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
  // Anthropic (date suffixes are stripped before lookup)
  "claude-3-5-sonnet": { input: 3, output: 15, cached: 0.3 },
  "claude-3-5-haiku": { input: 0.8, output: 4, cached: 0.08 },
  "claude-3-sonnet": { input: 3, output: 15 },
  "claude-opus-4-1": { input: 15, output: 75, cached: 1.5 },
  // Read from platform.claude.com/docs/en/about-claude/pricing on 2026-09-17 (cached = cache hits).
  "claude-opus-4": { input: 15, output: 75, cached: 1.5 },
  "claude-opus-4-5": { input: 5, output: 25, cached: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cached: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cached: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cached: 0.5 },
  "claude-opus-5": { input: 5, output: 25, cached: 0.5 },
  "claude-sonnet-4": { input: 3, output: 15, cached: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cached: 0.3 },
  "claude-sonnet-4-6": { input: 3, output: 15, cached: 0.3 },
  "claude-sonnet-5": { input: 2, output: 10, cached: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cached: 0.1 },
  // Google Gemini
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
  "gemini-2.0-flash": { input: 0.1, output: 0.4 },
  // Groq
  "llama-3-70b-8192": { input: 0.59, output: 0.79 },
  "llama-3-8b-8192": { input: 0.05, output: 0.08 },
  "mixtral-8x7b-32768": { input: 0.24, output: 0.24 },
  "gemma-7b-it": { input: 0.07, output: 0.07 },
  // Mistral
  "mistral-large-2": { input: 2, output: 6 },
  "mistral-medium": { input: 0.4, output: 2 },
  "mistral-small": { input: 0.1, output: 0.3 },
  // DeepSeek
  "deepseek-chat": { input: 0.27, output: 1.1, cached: 0.07 },
  "deepseek-coder": { input: 0.27, output: 1.1, cached: 0.07 },
  // Models running on this computer cost nothing to call.
  llama2: { input: 0, output: 0 },
  mistral: { input: 0, output: 0 },
  "neural-chat": { input: 0, output: 0 },
  "starling-lm": { input: 0, output: 0 },
  "local-model": { input: 0, output: 0 },
};

const priceSchema = z
  .object({
    input: z.number().min(0).max(10000),
    output: z.number().min(0).max(10000),
    cached: z.number().min(0).max(10000).optional(),
  })
  .strict();
/** Owner corrections, keyed by model identifier, stored in `settings/pricing`. */
export const PricingSettingsSchema = z
  .object({ overrides: z.record(z.string().min(1).max(256), priceSchema).default({}) })
  .strict();
export type PricingSettings = z.infer<typeof PricingSettingsSchema>;

/** A model identifier as it is written in the table: lower case, no vendor prefix, no date suffix. */
export function normalizeModelId(model: string): string {
  const withoutVendor = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return withoutVendor.toLowerCase().replace(/[-_]?(\d{8}|latest|v\d+(\.\d+)?)$/, "");
}

/**
 * The prices the provider catalog carries, for models this file does not list. The catalog is read
 * lazily and cached, so a damaged catalog cannot stop the rest of the program from starting.
 */
let catalogTable: Record<string, ModelPrice> | undefined;
function pricesFromCatalog(): Record<string, ModelPrice> {
  if (catalogTable) return catalogTable;
  // A missing or damaged catalog means no extra prices, never a program that will not start.
  try { return (catalogTable = catalogPrices()); } catch { return (catalogTable = {}); }
}
/** Replaces the cached catalog prices; tests use this after swapping the catalog. */
export function resetCatalogPrices(): void {
  catalogTable = undefined;
}

/**
 * The table price for a model, trying the exact identifier, then the catalog's own prices, then
 * the normalized identifier. An explicitly selected metadata bundle's prices win over the shipped tables.
 */
export function tablePrice(model: string, table: Record<string, ModelPrice> = builtInPrices): ModelPrice | undefined {
  const normalized = normalizeModelId(model);
  if (table !== builtInPrices) return table[model] ?? table[normalized];
  const catalog = pricesFromCatalog();
  const updated = localCatalogPriceUpdates?.prices;
  return updated?.[model] ?? updated?.[normalized] ?? table[model] ?? table[normalized] ?? catalog[model] ?? catalog[normalized];
}

const round = (value: number): number => Math.round(value * 1_000_000) / 1_000_000;

/**
 * What one model call or one run probably cost. `overrides` wins over the built-in table; a model
 * in neither comes back as unknown with no amount, so nothing ever displays a made-up zero.
 */
export function estimateCost(
  model: string,
  usage: TokenCounts,
  overrides: Record<string, ModelPrice> = {},
): CostEstimate {
  const override = tablePrice(model, overrides);
  const price = override ?? tablePrice(model);
  if (!price) return { amount: null, currency: "USD", confidence: "unknown", note: "no price on file" };
  const cachedTokens = usage.cached ?? 0;
  const amount = round(
    (usage.input * price.input + usage.output * price.output + cachedTokens * (price.cached ?? price.input)) / 1_000_000,
  );
  const confidence: CostConfidence = override ? "override" : "table";
  const updates = localCatalogPriceUpdates;
  const priceDate = updates && (updates.prices[model] || updates.prices[normalizeModelId(model)]) ? updates.pricedAt : pricedAt;
  return {
    amount,
    currency: "USD",
    confidence,
    note: override ? "your own price" : `list price as of ${priceDate}`,
  };
}

/** The owner's saved corrections, or an empty map when nothing is saved or the record is damaged. */
export function pricingSettings(store: Store, owner: string): PricingSettings {
  const saved = PricingSettingsSchema.safeParse(store.get("settings", owner, "pricing")?.data ?? {});
  return saved.success ? saved.data : { overrides: {} };
}

/** Saves the owner's corrections after checking every price is a sensible number. */
export function savePricingSettings(store: Store, owner: string, input: unknown): PricingSettings {
  const value = PricingSettingsSchema.parse(input);
  if (Object.keys(value.overrides).length > 200) throw new Error("At most 200 price corrections");
  store.save("settings", owner, "pricing", value);
  return value;
}

/** Everything the Usage screen and the diagnostics bundle need to show which prices are in use. */
export function pricingTableInUse(store: Store, owner: string) {
  const { overrides } = pricingSettings(store, owner);
  return { pricedAt, builtIn: builtInPrices, overrides, currency: "USD" as const };
}

/** Formats an estimate for a person: a dollar figure, or an honest admission that there is none. */
export function formatCost(estimate: CostEstimate): string {
  if (estimate.amount === null) return "no price on file";
  return estimate.amount < 0.01 && estimate.amount > 0
    ? `less than $0.01`
    : `$${estimate.amount.toFixed(estimate.amount < 1 ? 4 : 2)}`;
}
