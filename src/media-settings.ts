import { z } from "zod";
import type { Store } from "./store.js";

/**
 * What the picture and sound tools should do, in the owner's own words. The model name is left
 * empty by default, which means "use whatever the connected provider calls its picture model".
 * Prices are the owner's own corrections, kept beside the built-in per-picture table.
 */
export const MediaSettingsSchema = z
  .object({
    /** The provider's picture model, for example gpt-image-1. Empty means the provider's default. */
    imageModel: z.string().trim().max(200).default(""),
    /** The workspace folder finished pictures and sounds are saved into. */
    folder: z
      .string()
      .trim()
      .max(100)
      .regex(/^[a-z0-9][a-z0-9 _-]*$/i, "Use a simple folder name with letters, digits, dashes or underscores")
      .default("media"),
    /** Corrections to the per-picture prices, in US dollars, keyed by model name. */
    imagePrices: z.record(z.string().min(1).max(200), z.number().min(0).max(1000)).default({}),
  })
  .strict();
export type MediaSettings = z.infer<typeof MediaSettingsSchema>;

export function mediaSettings(store: Store, owner: string): MediaSettings {
  const saved = MediaSettingsSchema.safeParse(store.get("settings", owner, "media")?.data ?? {});
  return saved.success ? saved.data : MediaSettingsSchema.parse({});
}
export function saveMediaSettings(store: Store, owner: string, input: unknown): MediaSettings {
  const value = MediaSettingsSchema.parse(input);
  if (Object.keys(value.imagePrices).length > 100) throw new Error("At most 100 price corrections");
  store.save("settings", owner, "media", value);
  return value;
}

/**
 * Published prices for one finished picture, in US dollars, read on the date below. A model that
 * is not listed reports no price rather than a made-up zero, exactly as token pricing does.
 */
export const imagePricedAt = "2026-09-16";
export const builtInImagePrices: Record<string, number> = {
  "gpt-image-1": 0.04,
  "dall-e-3": 0.04,
  "dall-e-2": 0.02,
  "gemini-2.5-flash-image": 0.039,
  "gemini-2.0-flash-preview-image-generation": 0.039,
};
/**
 * models-ui: the picture models Branch knows by kind of picture route (src/media-images.ts ImageEndpoint.kind), read off
 * the price table so a model is offered only where its price is on file. Settings › Models › Media offers the ones that
 * fit the connection making pictures now; anything else the owner typed stays theirs.
 */
export const knownPictureModels: Record<"openai" | "gemini", string[]> = {
  openai: Object.keys(builtInImagePrices).filter((model) => !model.startsWith("gemini")),
  gemini: Object.keys(builtInImagePrices).filter((model) => model.startsWith("gemini")),
};
export interface ImageCostEstimate {
  amount: number | null;
  currency: "USD";
  confidence: "table" | "override" | "unknown";
  note: string;
}
/** The one picture size the built-in prices were read for; every other size costs something else. */
export const pricedSize = "1024x1024";
/**
 * What a number of finished pictures probably cost. Never invents a price it does not have: a
 * model that is not listed, and any size other than the one the table was read for, both come
 * back with no amount at all rather than a figure that only looks right.
 */
export function estimateImageCost(
  model: string,
  pictures: number,
  overrides: Record<string, number> = {},
  size: string = pricedSize,
): ImageCostEstimate {
  const key = model.toLowerCase();
  const override = overrides[model] ?? overrides[key];
  const each = override ?? builtInImagePrices[model] ?? builtInImagePrices[key];
  if (each === undefined)
    return { amount: null, currency: "USD", confidence: "unknown", note: `no price on file for ${model}` };
  if (size !== pricedSize && override === undefined)
    return {
      amount: null, currency: "USD", confidence: "unknown",
      note: `the price on file for ${model} is for a ${pricedSize} picture, not ${size}`,
    };
  return {
    amount: Math.round(each * pictures * 1_000_000) / 1_000_000,
    currency: "USD",
    confidence: override === undefined ? "table" : "override",
    note: override === undefined ? `list price for one standard picture as of ${imagePricedAt}` : "your own price",
  };
}
