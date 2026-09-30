import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { Catalog } from "./provider-catalog.js";
import type { ModelPrice } from "./pricing.js";

const modelId = z.string().min(1).max(256);
const price = z.object({ input: z.number().min(0).max(10000), output: z.number().min(0).max(10000),
  cached: z.number().min(0).max(10000).optional() }).strict();
const update = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/),
  defaultModel: modelId.optional(),
  recommendedModels: z.array(modelId).min(1).max(20).optional(),
  prices: z.record(modelId, price).optional(),
}).strict();

/** Model metadata only: an update cannot redirect a key or change a service's adapter, capabilities or terms. */
export const CatalogUpdatesSchema = z.object({
  version: z.literal(1),
  pricedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  services: z.array(update).min(1).max(200),
}).strict();
export let localCatalogPriceUpdates: { pricedAt: string; prices: Record<string, ModelPrice> } | undefined;

/** Applies one checked update bundle to the shipped transports. Unknown or repeated provider ids are refused. */
export function applyCatalogUpdates(catalog: Catalog, body: unknown): Catalog {
  const bundle = CatalogUpdatesSchema.parse(body);
  const known = new Set(catalog.services.map((entry) => entry.id));
  const updates = new Map<string, z.infer<typeof update>>();
  for (const entry of bundle.services) {
    if (!known.has(entry.id)) throw new Error(`The model catalogue update names an unknown service: ${entry.id}`);
    if (updates.has(entry.id)) throw new Error(`The model catalogue update repeats a service: ${entry.id}`);
    updates.set(entry.id, entry);
  }
  // Only the fields an update names are changed; its prices are added over the shipped ones.
  return { ...catalog, pricedAt: bundle.pricedAt, services: catalog.services.map((entry) => {
    const change = updates.get(entry.id);
    if (!change) return entry;
    return { ...entry,
      ...(change.defaultModel !== undefined ? { defaultModel: change.defaultModel } : {}),
      ...(change.recommendedModels !== undefined ? { recommendedModels: change.recommendedModels } : {}),
      ...(change.prices !== undefined ? { prices: { ...(entry.prices ?? {}), ...change.prices } } : {}) };
  }) };
}

/** The owner's explicitly selected local bundle, loaded at startup; nothing is downloaded or written here. */
export function catalogWithLocalUpdates(catalog: Catalog, env: NodeJS.ProcessEnv = process.env): Catalog {
  localCatalogPriceUpdates = undefined;
  const path = env.BRANCH_MODEL_CATALOG_FILE;
  if (!path) return catalog;
  if (!isAbsolute(path)) throw new Error("BRANCH_MODEL_CATALOG_FILE must be an absolute file path");
  const file = statSync(path);
  if (!file.isFile() || file.size > 1024 * 1024) throw new Error("The model catalogue update must be a file of at most 1 MiB");
  const bundle = CatalogUpdatesSchema.parse(JSON.parse(readFileSync(path, "utf8")) as unknown);
  const updated = applyCatalogUpdates(catalog, bundle);
  localCatalogPriceUpdates = { pricedAt: bundle.pricedAt,
    prices: Object.assign({}, ...bundle.services.map((entry) => entry.prices ?? {})) as Record<string, ModelPrice> };
  return updated;
}
