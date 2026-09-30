/* MODEL-128: an owner-chosen local model catalogue update (BRANCH_MODEL_CATALOG_FILE, src/provider-catalog-updates.ts)
   changes only model ids and prices of services Branch already knows; it cannot point a key anywhere else. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCatalogUpdates, catalogWithLocalUpdates } from "../dist/provider-catalog-updates.js";
import { providerCatalog } from "../dist/provider-catalog.js";
import { estimateCost } from "../dist/pricing.js";
import { discardTemp } from "./temp-dir.mjs";

const base = () => structuredClone(providerCatalog());
const service = base().services.find((entry) => entry.id === "openrouter");

test("an update changes a known service's models and prices, and nothing about where its key goes", () => {
  const updated = applyCatalogUpdates(base(), { version: 1, pricedAt: "2026-10-01",
    services: [{ id: "openrouter", defaultModel: "vendor/new-model", prices: { "vendor/new-model": { input: 1, output: 2 } } }] });
  const after = updated.services.find((entry) => entry.id === "openrouter");
  assert.equal(after.defaultModel, "vendor/new-model");
  assert.equal(after.baseUrl, service.baseUrl, "the address is the shipped one");
  assert.equal(updated.pricedAt, "2026-10-01");
  assert.throws(() => applyCatalogUpdates(base(), { version: 1, pricedAt: "2026-10-01", services: [{ id: "made-up-service", defaultModel: "x" }] }), /unknown service/);
  assert.throws(() => applyCatalogUpdates(base(), { version: 1, pricedAt: "2026-10-01", services: [{ id: "openrouter", baseUrl: "https://elsewhere.example" }] }),
    "an address cannot be changed");
  assert.throws(() => applyCatalogUpdates(base(), { version: 1, pricedAt: "2026-10-01", services: [{ id: "openrouter" }, { id: "openrouter" }] }), /repeats/);
});

test("a chosen update file's prices are used, with their own date, until the setting is removed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-catalog-update-"));
  t.after(() => { catalogWithLocalUpdates(base(), {}); return discardTemp(root); });
  const file = join(root, "catalogue.json");
  await writeFile(file, JSON.stringify({ version: 1, pricedAt: "2026-10-01",
    services: [{ id: "openrouter", prices: { "vendor/priced-model": { input: 3, output: 6 } } }] }));
  catalogWithLocalUpdates(base(), { BRANCH_MODEL_CATALOG_FILE: file });
  const cost = estimateCost("vendor/priced-model", { input: 1_000_000, output: 1_000_000 });
  assert.equal(cost.amount, 9);
  assert.equal(cost.note, "list price as of 2026-10-01");
  assert.throws(() => catalogWithLocalUpdates(base(), { BRANCH_MODEL_CATALOG_FILE: "catalogue.json" }), /absolute/);
  catalogWithLocalUpdates(base(), {});
  assert.equal(estimateCost("vendor/priced-model", { input: 1, output: 1 }).amount, null, "back to the shipped catalogue");
});

test("an update's rates lay over the shipped ones: a cache-write premium it leaves out is kept", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-catalog-cache-"));
  t.after(() => { catalogWithLocalUpdates(base(), {}); return discardTemp(root); });
  const file = join(root, "catalogue.json");
  const hourWrite = { input: 1_000_000, output: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 };
  const shipped = estimateCost("claude-opus-4-5", hourWrite).amount;
  await writeFile(file, JSON.stringify({ version: 1, pricedAt: "2026-10-01",
    services: [{ id: "anthropic", prices: { "claude-opus-4-5": { input: 5, output: 25 } } }] }));
  catalogWithLocalUpdates(base(), { BRANCH_MODEL_CATALOG_FILE: file });
  assert.equal(estimateCost("claude-opus-4-5", hourWrite).amount, shipped, "the one-hour write keeps its shipped premium");
  await writeFile(file, JSON.stringify({ version: 1, pricedAt: "2026-10-02",
    services: [{ id: "anthropic", prices: { "claude-opus-4-5": { input: 5, output: 25, cacheWrite1h: 12 } } }] }));
  catalogWithLocalUpdates(base(), { BRANCH_MODEL_CATALOG_FILE: file });
  assert.equal(estimateCost("claude-opus-4-5", hourWrite).amount, 12, "an update may name the cache-write rate itself");
});
