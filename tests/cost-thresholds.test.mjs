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

test("MODEL-129: cost thresholds include cache write tokens in the monthly cost estimate", async (t) => {
  const { app, big, small } = await fixture(t);
  // For gpt-4o: input=$2.5/M, output=$10/M, cacheWrite=$6.25/M
  // Set threshold at $0.0015, just above input ($0.001) + output ($0.001) but below with cache writes
  // 100 input tokens (~$0.00025) + 100 output tokens (~$0.001) + 1000 cacheWrite tokens (~$0.00625) = ~$0.0073
  saveSavings(app.store, owner, "costThresholds", { mode: "on",
    rules: [{ provider: "big", model: "gpt-4o", maxMonthlyDollars: 0.0015, fallbackPreset: "small" }] });
  const run = await app.runtime.run({ prompt: "test" });
  assert.equal(run.output, "big answer", "first round on new threshold always passes");
  // Manually inject a receipt with cache write tokens to verify calculation includes them
  const completed = run.id;
  const events = app.store.events(completed);
  const modelEvent = events.find((e) => e.kind === "model.completed");
  assert.ok(modelEvent, "model.completed event exists");
  // Modify it to include cache writes (simulating a response with cache writes)
  app.store.sqlite.prepare(`UPDATE events SET data = ? WHERE run_id = ? AND kind = 'model.completed'`).run(
    JSON.stringify({ ...modelEvent.data, reported: { input: 100, output: 100, cachedInput: 0, cacheWrite: 1000, cacheWrite1h: 0 } }),
    completed);
  // Now the second round should trigger the threshold because cache writes push cost over $0.0015
  const second = await app.runtime.run({ prompt: "second" });
  assert.equal(second.output, "small answer", "second round routed to fallback due to cache-inclusive cost");
  const [note] = routed(app, second.id);
  assert.deepEqual([note.from, note.preset], ["big", "small"]);
  assert.match(note.reason, /reached its recorded-estimate threshold/);
});
