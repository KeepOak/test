/**
 * Settings › Models › "Slow down near a rate limit" (src/model-savings/pacing.ts, src/provider-health.ts): below a
 * tenth of the allowance a service reported, a connection's requests are spread out; stopping ends the wait; one key's
 * allowance never slows another; and the switch is the owner's model-savings card, on as shipped.
 * The clock and the waits are handed in, so nothing here sleeps.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { ProviderHealth } from "../dist/provider-health.js";
import { paceDelay, pause, maxWaitMs, maxQueueMs } from "../dist/model-savings/pacing.js";
import { buildConnection } from "../dist/provider-factory.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { createBranch, readSavings } from "../dist/index.js";
import { savingsApi } from "../dist/model-savings/api.js";
import { accountsServiceFor, paceKey } from "../dist/accounts/service.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");
const at = (seconds) => new Date(NOW + seconds * 1000).toISOString();
const reading = (...windows) => ({ windows: windows.map((w) => ({ id: w.counts, title: "", source: "", measuredAt: at(0), resetSeconds: null, ...w })), limit: null, remaining: null, resetSeconds: null });

test("the wait: nothing above a tenth left; the refill time shared out below it; plan windows, stale and undated ones ignored", () => {
  assert.equal(paceDelay(null, NOW), 0);
  assert.equal(paceDelay(reading({ counts: "requests", limit: 100, remaining: 10, resetAt: at(30) }), NOW), 0, "a tenth left is not slowed");
  assert.equal(paceDelay(reading({ counts: "requests", limit: 100, remaining: 2, resetAt: at(30) }), NOW), 10_000, "30 s shared over the 2 left and the next");
  assert.equal(paceDelay(reading({ counts: "requests", limit: 100, remaining: 0, resetAt: at(9) }), NOW), 9_000, "none left: wait for the refill");
  assert.equal(paceDelay(reading({ counts: "tokens", limit: 100_000, remaining: 5_000, resetAt: at(20) }), NOW), 10_000, "half of the last tenth: half the refill");
  assert.equal(paceDelay(reading({ counts: "requests", limit: 100, remaining: 0, resetAt: at(600) }), NOW), maxWaitMs, "never longer than the cap");
  assert.equal(paceDelay(reading({ counts: "requests", limit: 100, remaining: 0, resetAt: at(-5) }), NOW), 0, "a refill time already past");
  assert.equal(paceDelay(reading({ counts: "requests", limit: 100, remaining: 0, resetAt: null }), NOW), 0, "undated");
  assert.equal(paceDelay(reading({ counts: "plan", limit: 100, remaining: 1, resetAt: at(3600) }), NOW), 0, "a plan's share");
  assert.equal(paceDelay(reading({ counts: "requests", limit: 100, remaining: 50, resetAt: at(30) }, { counts: "tokens", limit: 1000, remaining: 0, resetAt: at(4) }), NOW), 4_000, "the tightest window decides");
});

/** A health record with a hand-held clock, whose waits are written down and move the clock. */
function held({ on = true } = {}) {
  const clock = { now: NOW }, waits = [];
  const health = new ProviderHealth(() => clock.now, 64, async (ms, signal) => { signal?.throwIfAborted(); waits.push(ms); });
  health.pacing = () => on;
  return { health, clock, waits };
}
/** A fetch that answers with the allowance it is told to report. */
function service(remaining, limit = 100, reset = "30s") {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push(String(input));
    init?.signal?.throwIfAborted();
    return new Response("{}", { status: 200, headers: { "x-ratelimit-limit-requests": String(limit), "x-ratelimit-remaining-requests": String(remaining.value), "x-ratelimit-reset-requests": reset } });
  };
  return { fetchImpl, calls };
}

test("a connection near its limit waits before its next request, and the wait is written down", async () => {
  const { health, waits } = held();
  const left = { value: 50 }, api = service(left);
  const watched = health.watch("one", api.fetchImpl);
  await watched("https://api.example/v1/a");
  assert.deepEqual(waits, [], "plenty left: no wait");
  left.value = 2;
  await watched("https://api.example/v1/b");
  assert.deepEqual(waits, [], "the first request that hears of the limit had already left");
  await watched("https://api.example/v1/c");
  assert.deepEqual(waits, [10_000], "2 left of 100 with 30 s to go: one every 10 s");
  assert.equal(health.get("one").pacedMs, 10_000);
  assert.equal(health.get("one").pacedAt, at(0));
  assert.equal(api.calls.length, 3, "slowed, never refused");
});

test("switched off, nothing waits", async () => {
  const { health, waits } = held({ on: false });
  const api = service({ value: 0 }, 100, "30s");
  const watched = health.watch("one", api.fetchImpl);
  await watched("https://api.example/v1/a");
  await watched("https://api.example/v1/b");
  assert.deepEqual(waits, []);
  assert.equal(health.get("one").pacedMs, null);
});

test("requests that leave together are spaced one wait apart, each with its own start, up to the queue's end", async () => {
  const { health, waits } = held();
  const api = service({ value: 2 });
  const watched = health.watch("one", api.fetchImpl);
  await watched("https://api.example/v1/first");
  await Promise.all([watched("https://api.example/v1/a"), watched("https://api.example/v1/b"), watched("https://api.example/v1/c")]);
  assert.deepEqual(waits, [10_000, 20_000, 30_000], "10 s apart: none of them leave together");
  await Promise.all([watched("https://api.example/v1/d"), watched("https://api.example/v1/e")]);
  assert.deepEqual(waits.slice(3), [maxQueueMs, maxQueueMs], "never queued past forty seconds, under the 60 s silence");
});

test("a replaced key starts with nothing heard: the old key's allowance never slows it", async () => {
  const { health, waits } = held();
  const api = service({ value: 0 });
  const watched = health.watch("pool", api.fetchImpl, "pace:pool-second");
  await watched("https://api.example/v1/a");
  health.forgetPacing("pace:pool-second");
  await watched("https://api.example/v1/b");
  assert.deepEqual(waits, [], "forgotten when the key was replaced (AccountsService.dropBuilt)");
});

test("each key of a connection is its own allowance: one near its limit never slows another", async () => {
  const { health, waits } = held();
  const low = service({ value: 1 }), high = service({ value: 90 });
  const first = health.watch("pool", low.fetchImpl, "pool\u0000first"), second = health.watch("pool", high.fetchImpl, "pool\u0000second");
  await first("https://api.example/v1/a");
  await second("https://api.example/v1/a");
  await second("https://api.example/v1/b");
  assert.deepEqual(waits, [], "the second key has room");
  await first("https://api.example/v1/b");
  assert.deepEqual(waits, [15_000], "the first key is the one slowed (30 s over 2, held at the cap)");
});

test("stopping a request ends its wait at once, with the stop's own reason", async () => {
  const controller = new AbortController();
  const waiting = pause(60_000, controller.signal);
  controller.abort(new Error("Stopped"));
  await assert.rejects(waiting, /Stopped/);
  const health = new ProviderHealth(() => NOW);
  health.pacing = () => true;
  const api = service({ value: 0 }, 100, "10s");
  const watched = health.watch("one", api.fetchImpl);
  await watched("https://api.example/v1/a");
  const stop = new AbortController();
  const slowed = watched("https://api.example/v1/b", { signal: stop.signal });
  stop.abort(new Error("Stopped by the owner"));
  await assert.rejects(slowed, /Stopped by the owner/);
  assert.equal(api.calls.length, 1, "the stopped request was never sent");
});

test("a real connection is slowed through its own fetch, from the headers the service sent", async (t) => {
  let left = 1;
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.setHeader("x-ratelimit-limit-requests", "60");
    res.setHeader("x-ratelimit-remaining-requests", String(left));
    res.setHeader("x-ratelimit-reset-requests", "4s");
    res.end(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const { health, waits } = held();
  const connection = buildConnection({ provider: "custom", key: "k", extras: { baseUrl: `http://127.0.0.1:${server.address().port}/v1` },
    policy: new NetworkPolicy({ allowPrivateAddresses: true }), fetchImpl: health.watch("mine") });
  const ask = () => connection.provider.complete({ messages: [{ role: "user", content: "hello" }], tools: [], maxTokens: 10 });
  assert.equal((await ask()).content, "hi");
  left = 30;
  assert.equal((await ask()).content, "hi");
  assert.deepEqual(waits, [2_000], "4 s shared over the 1 left and the next");
  await ask();
  await ask();
  assert.deepEqual(waits, [2_000], "room again: no more waits");
});

test("the switch is the owner's model-savings card: on as shipped, off and on again through the route", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-pacing-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  assert.equal(readSavings(app.store, owner, "pacing").mode, "on");
  assert.equal(app.runtime.models.health.pacing(), true, "the engine reads the card");
  const post = (values) => savingsApi(app, { method: "POST" }, "/api/model-savings", new URL("http://branch.invalid/api/model-savings"), async () => ({ card: "pacing", values }));
  const off = await post({ mode: "off" });
  assert.equal(off.values.pacing.mode, "off");
  assert.equal(app.runtime.models.health.pacing(), false);
  const read = await savingsApi(app, { method: "GET" }, "/api/model-savings", new URL("http://branch.invalid/api/model-savings"), async () => ({}));
  assert.equal(read.values.pacing.mode, "off", "GET says what was saved");
  await post({ mode: "on" });
  assert.equal(app.runtime.models.health.pacing(), true);
  await assert.rejects(post({ mode: "sometimes" }), /mode/i);
  // A key replaced or removed (the accounts service drops what it built for it) forgets that key's pacing.
  const forgotten = [], health = app.runtime.models.health, was = health.forgetPacing.bind(health);
  health.forgetPacing = (key) => { forgotten.push(key); was(key); };
  accountsServiceFor(app.runtime.models).dropBuilt("pool-1", "acct-1");
  assert.deepEqual(forgotten, [paceKey("pool-1", "acct-1")]);
});
