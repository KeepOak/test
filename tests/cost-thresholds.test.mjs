/**
 * MODEL-129: an owner-set cost threshold per service and model. Once the rounds recorded since it was turned on reach
 * the figure, the next round goes to the owner's named fallback, or stops when there is none. Off by default.
 * Fake providers only; no real service is called.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, readSavings, saveSavings } from "../dist/index.js";
import { estimateCost } from "../dist/pricing.js";

const owner = "local";
function scripted(name, reply) {
  const provider = { name, requests: [], async complete(request) { provider.requests.push(request); return { content: reply, toolCalls: [] }; } };
  return provider;
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-thresholds-"));
  const big = scripted("big", "big answer"), small = scripted("small", "small answer");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets: [
    { id: "big", name: "Big", provider: big, model: "gpt-4o" },
    { id: "small", name: "Small", provider: small, model: "gpt-4o-mini" },
  ] });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, big, small };
}
const routed = (app, runId) => app.store.events(runId).filter((e) => e.kind === "model.routed" && e.data.kind === "cost-threshold").map((e) => e.data);

test("MODEL-129: thresholds ship off and change nothing until the owner turns one on", async (t) => {
  const { app, big } = await fixture(t);
  assert.deepEqual(readSavings(app.store, owner, "costThresholds"), { mode: "off", activatedAt: null, rules: [] });
  saveSavings(app.store, owner, "costThresholds", { rules: [{ provider: "big", maxMonthlyDollars: 0.001, fallbackPreset: "small" }] });
  for (const prompt of ["one", "two"]) assert.equal((await app.runtime.run({ prompt })).output, "big answer");
  assert.equal(big.requests.length, 2);
});

test("MODEL-129: past the threshold the next round goes to the named fallback, and it is written down", async (t) => {
  const { app, small } = await fixture(t);
  const saved = saveSavings(app.store, owner, "costThresholds", { mode: "on",
    rules: [{ provider: "big", maxMonthlyDollars: 0.001, fallbackPreset: "small" }] });
  assert.ok(saved.activatedAt, "turning it on starts the counting period");
  const first = await app.runtime.run({ prompt: "first" });
  assert.equal(first.output, "big answer", "nothing recorded yet, so the first round is not held back");
  assert.deepEqual(routed(app, first.id), []);
  const second = await app.runtime.run({ prompt: "second" });
  assert.equal(second.output, "small answer");
  assert.equal(small.requests.length, 1);
  const [note] = routed(app, second.id);
  assert.deepEqual([note.from, note.preset], ["big", "small"]);
  assert.match(note.reason, /reached its recorded-estimate threshold of \$0\.00/);
});

test("MODEL-129: with no fallback the round stops instead of spending past the threshold", async (t) => {
  const { app, big, small } = await fixture(t);
  saveSavings(app.store, owner, "costThresholds", { mode: "on", rules: [{ provider: "big", model: "gpt-4o", maxMonthlyDollars: 0.001 }] });
  await app.runtime.run({ prompt: "first" });
  const second = await app.runtime.run({ prompt: "second" });
  assert.notEqual(second.status, "done");
  assert.equal(big.requests.length, 1, "the second round never reached the service");
  assert.equal(small.requests.length, 0, "and nothing moved to a connection the owner did not name");
  assert.match(JSON.stringify(app.store.events(second.id)), /reached its recorded-estimate threshold/);
});

test("MODEL-129: one-hour cache writes are priced at their own rate in the monthly estimate", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-thresholds-"));
  const big = scripted("big", "big answer"), small = scripted("small", "small answer");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets: [
    { id: "big", name: "Big", provider: big, model: "claude-sonnet-4-5" },
    { id: "small", name: "Small", provider: small, model: "gpt-4o-mini" },
  ] });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const rule = (maxMonthlyDollars) => ({ provider: "big", model: "claude-sonnet-4-5", maxMonthlyDollars, fallbackPreset: "small" });
  saveSavings(app.store, owner, "costThresholds", { mode: "on", rules: [rule(1000)] });
  const first = await app.runtime.run({ prompt: "write a long prompt to the cache" });
  assert.equal(first.output, "big answer");
  // The service reports 200,000 prompt tokens written to its one-hour cache (Claude charges those at twice the input rate).
  const event = app.store.events(first.id).find((e) => e.kind === "model.completed");
  const input = event.data.estimatedInput + 200000, output = event.data.estimatedOutput;
  app.store.sqlite.prepare("UPDATE events SET data=? WHERE run_id=? AND kind='model.completed'")
    .run(JSON.stringify({ ...event.data, reported: { input, output, cacheWrite: 200000, cacheWrite1h: 200000 } }), first.id);
  const plain = estimateCost("claude-sonnet-4-5", { input, output }).amount;
  const written = estimateCost("claude-sonnet-4-5", { input, output, cacheWrite: 200000, cacheWrite1h: 200000 }).amount;
  assert.ok(written > plain + 0.5, "the one-hour writes cost more than ordinary input");
  saveSavings(app.store, owner, "costThresholds", { mode: "on", rules: [rule((plain + written) / 2)] });
  const second = await app.runtime.run({ prompt: "next" });
  assert.equal(second.output, "small answer", "counted at the one-hour write rate, the threshold is reached");
  assert.deepEqual(routed(app, second.id).map((note) => [note.from, note.preset]), [["big", "small"]]);
});
