/**
 * A burst 429 on a sign-in used to bench the account until its tightest plan window refilled, which could be the weekly
 * one: days. Now only a plan limit the service states (usage_limit_reached with resets_at, as openai/codex reads it) or a
 * plan meter at zero benches the account; any other 429 rests it 30 seconds, doubling with each one in a row, at most a
 * day (openclaw's usage-failure-state), and never pushes out a rest already running. Rests are kept on disk.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { AccountPoolProvider } from "../dist/accounts/pool-provider.js";
import { withAccountCall } from "../dist/accounts/context.js";
import { addAccount, setMode } from "../dist/accounts/manage.js";
import { failureFor, freshState, rateBackoffMs, rest } from "../dist/accounts/pool.js";
import { ProviderHttpError, parseRetryAfter, rejectedHttpResponse } from "../dist/provider-retry.js";

const at = Date.parse("2026-09-29T10:00:00.000Z");
const week = 6 * 24 * 60 * 60_000;
const acct = (id) => ({ id, label: id, pinned: false, disabled: false, monthlyCapUsd: null, shared: false, createdAt: "2026-09-29T00:00:00Z" });
const refusal = (body, headers = {}) => rejectedHttpResponse(new Response(JSON.stringify(body), { status: 429, headers: { "content-type": "application/json", ...headers } }));

function pool({ accounts = ["a", "b"], script = {}, states = new Map(), kind = "chatgpt" } = {}) {
  const calls = [], slept = [];
  let clock = at;
  const saved = { pool: "chatgpt", kind, strategy: "priority", autoSwitch: true, defaultAccount: null, accounts: accounts.map(acct) };
  const provider = (id) => ({ name: "stand-in", async complete() {
    calls.push(id);
    const next = (script[id] ?? []).shift();
    if (next instanceof Error) throw next;
    return { content: `from ${id}`, toolCalls: [] };
  } });
  const pooled = new AccountPoolProvider(provider("original"), {
    owner: "owner", pool: "chatgpt", model: "m", settings: () => saved, states, cursor: { value: 0 }, now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    providerFor: async (id) => provider(id), capReached: () => false, record: () => undefined, personIsNotOwner: () => false,
    sessionChoice: () => null, rememberChoice: () => undefined,
  });
  const ask = () => withAccountCall({ sessionId: "s" }, () => pooled.complete({ messages: [{ role: "user", content: "hi" }], tools: [], signal: new AbortController().signal }));
  return { calls, slept, states, ask, now: () => clock, tick: (ms) => { clock += ms; } };
}
/** A sign-in whose plan meter says 40% left of a window that refills in six days. */
const metered = () => new Map([["a", { ...freshState(), remaining: 40, resetAt: new Date(at + week).toISOString() }]]);

test("a 429 without a usage-limit body on a sign-in rests seconds, not days", async () => {
  const burst = await refusal({ error: { type: "rate_limit_exceeded", message: "slow down" } });
  const p = pool({ states: metered(), script: { a: [burst, burst] } });
  assert.equal((await p.ask()).content, "from b", "the work moves on to the next account");
  const state = p.states.get("a");
  assert.equal(state.limitedUntil, 0, "not benched as a plan limit");
  assert.equal(state.models.get("m") - p.now(), 30_000, "rests 30 seconds, not until the weekly window refills");
  p.tick(31_000);
  p.states.get("a").models.clear();
  const again = pool({ states: p.states, script: { a: [burst, burst] } });
  await again.ask();
  assert.equal(p.states.get("a").models.get("m") - again.now(), 60_000, "a second run of 429s rests twice as long");
  assert.equal(rateBackoffMs(1), 30_000);
  assert.equal(rateBackoffMs(30), 24 * 60 * 60_000, "never more than a day");
});

test("sign-ins that are only resting after a rate limit say so as a rate limit, never as a plan limit", async () => {
  const burst = () => new ProviderHttpError(429, undefined, "rate_limit_exceeded");
  const both = pool({ states: metered(), script: { a: [burst(), burst()], b: [burst(), burst()] } });
  await assert.rejects(both.ask(), (error) => error instanceof ProviderHttpError && error.status === 429);
  both.tick(5_000);
  await assert.rejects(both.ask(), (error) => {
    assert.equal(error.name, "ProviderHttpError", "not an AccountLimitError, so the task may wait or fall back");
    assert.equal(error.retryAfterMs, 25_000, "back when the first rest ends");
    assert.doesNotMatch(error.message, /plan limit/);
    return true;
  }, "asked again inside the 30 seconds, both are resting");
  const resetsAt = Math.floor((at + 3 * 60 * 60_000) / 1000);
  const limit = await refusal({ error: { type: "usage_limit_reached", resets_at: resetsAt } });
  const mixed = pool({ script: { a: [limit], b: [burst(), burst()] } });
  await assert.rejects(mixed.ask());
  await assert.rejects(mixed.ask(), (error) => {
    assert.notEqual(error.name, "AccountLimitError", "one account is back in seconds, so this is not a plan limit");
    assert.equal(error.retryAfterMs, 30_000);
    return true;
  });
});

test("a usage_limit_reached body benches the account until its resets_at", async () => {
  const resetsAt = Math.floor((at + 3 * 60 * 60_000) / 1000);
  const limit = await refusal({ error: { type: "usage_limit_reached", resets_at: resetsAt, plan_type: "plus" } });
  assert.equal(limit.code, "usage_limit_reached");
  assert.equal(limit.resetsAtMs, resetsAt * 1000);
  const p = pool({ states: metered(), script: { a: [limit] } });
  assert.equal((await p.ask()).content, "from b");
  assert.deepEqual(p.calls, ["a", "b"], "a plan limit moves on at once");
  const state = p.states.get("a");
  assert.equal(state.limitedUntil, resetsAt * 1000, "until the body's resets_at, not the weekly meter's refill");
  assert.equal(state.limitKnown, true);
  const spent = new Map([["a", { ...freshState(), remaining: 0, resetAt: new Date(at + 5 * 60 * 60_000).toISOString() }]]);
  const meter = pool({ states: spent, script: { a: [new ProviderHttpError(429), new ProviderHttpError(429)] } });
  await meter.ask();
  assert.equal(spent.get("a").limitedUntil, at + 5 * 60 * 60_000, "a meter at zero makes a bare 429 its plan limit, until that window refills");
});

test("usage_not_included benches that model only; a short Retry-After is waited for, a decimal one read", async () => {
  const notIncluded = await refusal({ error: { type: "usage_not_included" } });
  const failure = failureFor(notIncluded, at);
  assert.deepEqual([failure.kind, failure.scope], ["model", "model"]);
  assert.equal(parseRetryAfter("1.5"), 1500);
  const brief = await refusal({ error: { type: "rate_limit_exceeded" } }, { "retry-after": "2" });
  const p = pool({ script: { a: [brief] } });
  assert.equal((await p.ask()).content, "from a", "the same account answers after the wait");
  assert.deepEqual(p.slept, [2000], "Retry-After is waited out before the second try");
  const state = freshState();
  rest(state, { kind: "rate", scope: "model", untilMs: at + 30_000, reason: "rate" }, "m", at);
  rest(state, { kind: "rate", scope: "model", untilMs: at + 90_000, reason: "rate" }, "m", at + 1_000);
  assert.equal(state.models.get("m"), at + 30_000, "a rest already running is never pushed further out");
});

test("rests survive a restart: a billing bench is still there after Branch starts again", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-rests-"));
  const options = { workspace: join(root, "workspace"), dataDir: join(root, "data") };
  let again = null;
  t.after(async () => { await again?.close(); await discardTemp(root); });
  const app = await createBranch(options);
  const service = accountsServiceFor(app.runtime.models), owner = app.runtime.owner, POOL = "openai-test";
  delete service.deps.policy; // the stand-in fetch below is the whole network
  app.store.save("settings", owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI test", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  app.runtime.models.register({ id: POOL, name: "OpenAI test", model: "gpt-4o-mini", catalogId: "openai",
    provider: { name: "openai-chat", complete: async () => { throw new ProviderHttpError(402, undefined, "insufficient_quota"); } } });
  app.runtime.models.configure(owner, { activePreset: POOL });
  service.deps.fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "from the second key" } }] }),
    { status: 200, headers: { "content-type": "application/json" } });
  setMode(service, { mode: "on" });
  await addAccount(service, { pool: POOL, label: "Second", key: "sk-second-key-value-000000" }); // not-a-real-secret
  const run = await app.runtime.run({ prompt: "hello" });
  assert.equal(run.output, "from the second key");
  const until = service.statesOf(POOL).get("primary").restUntil;
  assert.ok(until > Date.now(), "the first key is benched for being out of credit");
  await app.close();

  again = await createBranch(options);
  const restored = accountsServiceFor(again.runtime.models).statesOf(POOL).get("primary");
  assert.equal(restored?.restUntil, until, "the bench is still there after the restart");
  assert.match(restored.lastError, /billing/);
});
