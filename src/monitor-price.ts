import { z } from "zod";

/** Literal source fields avoid running user/page-supplied regular expressions on fetched content. */
export const PriceConditionSchema = z.object({
  item: z.string().trim().min(1).max(120),
  currency: z.string().regex(/^[A-Z]{3}$/),
  currencyMarker: z.string().trim().min(1).max(8),
  label: z.string().trim().min(1).max(80).refine((value) => !/[\r\n]/.test(value), "Use a single-line price label"),
  below: z.number().positive().max(1_000_000_000),
  decimals: z.number().int().min(0).max(3).default(2),
  decimalSeparator: z.enum([".", ","]).default("."),
}).strict().refine((rule) => Math.round(rule.below * 10 ** rule.decimals) / 10 ** rule.decimals === rule.below,
  "The threshold has more decimal places than the currency uses");
export type PriceCondition = z.infer<typeof PriceConditionSchema>;
const PricePointSchema = z.object({ at: z.iso.datetime(), amount: z.number().nonnegative().max(1_000_000_000) }).strict();
export type PricePoint = z.infer<typeof PricePointSchema>;
const historyCap = 100;

export function priceCondition(value: unknown): PriceCondition | null {
  return value == null ? null : PriceConditionSchema.parse(JSON.parse(String(value)));
}
export function priceHistory(value: unknown): PricePoint[] {
  return z.array(PricePointSchema).max(historyCap).parse(JSON.parse(String(value ?? "[]")));
}

/** One unique literal label, immediately followed by the configured currency marker and amount.
 * Ambiguous labels, wrong currency and unrecognized number formats are unknown, never a price of zero. */
export function extractPrice(text: string, rule: PriceCondition): number {
  const parts = text.split(rule.label);
  if (parts.length !== 2) throw new Error("The price label was missing or appeared more than once");
  const line = parts[1]!.split(/\r?\n/, 1)[0]!.trimStart();
  if (!line.startsWith(rule.currencyMarker)) throw new Error("The watched price had a different currency marker");
  const match = /^\s*(\d[\d.,]*)(?=$|[^\d.,])/.exec(line.slice(rule.currencyMarker.length));
  if (!match || match[1]!.length > 24) throw new Error("The watched price could not be read");
  const normalized = rule.decimalSeparator === "," ? match[1]!.replace(/\./g, "").replace(",", ".") : match[1]!.replace(/,/g, "");
  const grouping = rule.decimalSeparator === "." ? "," : "\\.";
  const separator = rule.decimalSeparator === "." ? "\\." : ",";
  const fraction = rule.decimals ? `(?:${separator}\\d{1,${rule.decimals}})?` : "";
  if (!new RegExp(`^(?:\\d+|\\d{1,3}(?:${grouping}\\d{3})+)${fraction}$`).test(match[1]!))
    throw new Error("The watched price did not match the configured number format");
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount > 1_000_000_000) throw new Error("The watched price was outside the supported range");
  return amount;
}

/** Source recipe: Hermes product-price-monitor at 7327624d3500d4bbc9ad58b0a75c324a306d882a (MIT),
 * threshold/drop comparison, retained good observations and duplicate suppression. Original Branch integration. */
export function observePrice(rule: PriceCondition, history: readonly PricePoint[], text: string, at: string) {
  const amount = extractPrice(text, rule), previous = history.at(-1)?.amount;
  const scale = 10 ** rule.decimals, minor = Math.round(amount * scale);
  const changed = previous !== undefined && minor < Math.round(previous * scale) && minor < Math.round(rule.below * scale);
  return { amount, previous, changed, history: [...history, { at, amount }].slice(-historyCap) };
}

export function priceSummary(rule: PriceCondition, amount: number, previous: number | undefined, target: string, at: string): string {
  return `${rule.item}: ${rule.currency} ${amount.toFixed(rule.decimals)}${previous === undefined ? "" : `, down from ${previous.toFixed(rule.decimals)}`}.
Below your ${rule.currency} ${rule.below.toFixed(rule.decimals)} threshold. Watched field: ${rule.label}.
Observed ${at}. Source: ${target}
This is the selected page field; availability, taxes, shipping and other variants are not inferred.`;
}
