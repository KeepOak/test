import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AnthropicProvider } from "../dist/providers.js";
import { AnthropicStream } from "../dist/provider-stream.js";
import { Store } from "../dist/store.js";
import { estimateCost, tokenCountsOf } from "../dist/pricing.js";
import { saveKnobs } from "../dist/knobs/settings.js";
import { spendCapCheck } from "../dist/knobs/apply.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";

/**
 * Anthropic's input_tokens leaves out the prompt-cache reads and writes, which it counts apart. Branch recorded only
 * input_tokens (and, off the stream, the reads), so the budget, the caps and the Usage screen undercounted every cached
 * turn. The counts are now whole: input is the whole prompt, the reads and writes are parts of it, priced at their own
 * rates.
 */
const said = {
  input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2_000,
  cache_creation: { ephemeral_5m_input_tokens: 1_500, ephemeral_1h_input_tokens: 500 },
};
const whole = { input: 12_100, output: 50, cachedInput: 10_000, cacheWrite: 2_000, cacheWrite1h: 500 };
// claude-opus-5-5: $4 in, $20 out, $0.20 cache read, $5 five-minute write, $8 one-hour write, per million.
const dollars = (100 * 4 + 10_000 * 0.2 + 1_500 * 5 + 500 * 8 + 50 * 20) / 1_000_000;

async function serve(t, body) {
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("a cached Anthropic reply counts its cache writes and reads as part of its input", async (t) => {
  const base = await serve(t, { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: said });
  const completion = await new AnthropicProvider({ endpoint: base, model: "claude-opus-5-5", apiKey: "k" }).complete({
    messages: [{ role: "user", content: "q" }], tools: [], maxTokens: 256, signal: new AbortController().signal,
  });
  assert.deepEqual(completion.usage, whole);
});

test("a streamed cached Anthropic reply counts them too, and keeps the closing output count", () => {
  const stream = new AnthropicStream(() => undefined);
  for (const event of [
    { type: "message_start", message: { usage: { ...said, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } },
    { type: "message_stop" },
  ]) stream.consume(JSON.stringify(event));
  assert.deepEqual(stream.result().usage, whole);
});

test("the cache tokens reach the task's usage and its cost, and the spending cap sees them", () => {
  const store = new Store(":memory:");
  const owner = "owner-cache";
  const run = store.createRun(owner, "q");
  store.addUsage(run.id, 0, 50, whole);
  const usage = store.usage(run.id);
  assert.equal(usage.reportedInput, 12_100);
  assert.equal(usage.reportedCachedInput, 10_000);
  assert.equal(usage.reportedCacheWrite, 2_000);
  assert.equal(usage.reportedCacheWrite1h, 500);
  const cost = estimateCost("claude-opus-5-5", tokenCountsOf(usage));
  assert.equal(cost.confidence, "table", "Branch's default model has a price on file");
  assert.equal(cost.amount, Math.round(dollars * 1_000_000) / 1_000_000);
  // Only input_tokens, as before, would have cost 100 in and 50 out: a tenth of a cent short of what was billed.
  assert.ok(cost.amount > estimateCost("claude-opus-5-5", { input: 100, output: 50 }).amount * 10);
  saveKnobs(store, owner, "limits", { spendCapDollars: 0.01 });
  assert.match(spendCapCheck(store, owner, [run.id], "claude-opus-5-5").refusal ?? "", /limit/);
  store.close?.();
});

test("a cache write with no one-hour rate on file is charged at the five-minute rate, as litellm does", () => {
  const overrides = { m: { input: 1, output: 2, cached: 0.1, cacheWrite: 1.25 } };
  const cost = estimateCost("m", { input: 1_000_000, output: 0, cached: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 }, overrides);
  assert.equal(cost.amount, 1.25);
  const bare = estimateCost("m", { input: 1_000_000, output: 0, cached: 500_000 }, { m: { input: 1, output: 2 } });
  assert.equal(bare.amount, 1, "a missing cache-read rate is the input rate");
});

async function install(root, name) {
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  return createBranch({ workspace: join(root, name, "workspace"), dataDir: join(root, name, "data"), provider });
}

test("a backup with cache usage in it puts back into a fresh install, with every count kept", async (t) => {
  // A usage column whose name the backup cannot carry would break every restore of a copy that has used a model.
  const root = await mkdtemp(join(tmpdir(), "branch-cache-backup-"));
  const apps = [];
  t.after(async () => { for (const app of apps) await app.close(); await discardTemp(root); });
  const used = await install(root, "used");
  apps.push(used);
  const run = used.store.createRun(used.runtime.owner, "q");
  used.store.addUsage(run.id, 0, 50, whole);
  const snapshot = used.store.backup(used.version);
  const fresh = await install(root, "fresh");
  apps.push(fresh);
  assert.ok(fresh.store.restore(snapshot).rows > 0);
  const usage = fresh.store.usage(run.id);
  assert.equal(usage.reportedCachedInput, 10_000);
  assert.equal(usage.reportedCacheWrite, 2_000);
  assert.equal(usage.reportedCacheWrite1h, 500);
});
