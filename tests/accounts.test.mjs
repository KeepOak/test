/**
 * mac6/accounts: several accounts per connection. Every service here is a stand-in: API keys are
 * answered by a fake fetch, installed programs by a fake runner, and nothing reaches a provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { ProviderHttpError } from "../dist/provider-retry.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { AccountsSettingsSchema, keyName, keyProject, saveAccountsSettings } from "../dist/accounts/settings.js";
import { failureFor, freshState, rest, unavailable, orderFor } from "../dist/accounts/pool.js";
import { LockerTokenVault, remainingFrom } from "../dist/accounts/chatgpt-accounts.js";
import { executeCommand } from "../dist/commands/execute.js";
import { saveCommandSettings } from "../dist/commands/settings.js";
import { lookup } from "../dist/commands/catalog.js";
import { fakeClaudeAccounts } from "./fixtures/claude-account-adapter.mjs";
import { offLimitsToShortLivedKeys } from "../dist/server.js";

const POOL = "openai-test";
const SECOND_KEY = "sk-second-key-value-000000"; // not-a-real-secret

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-accounts-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const service = accountsServiceFor(app.runtime.models);
  service.deps.statusRun = async () => ({ code: 0, missing: false });
  await fakeClaudeAccounts(t, service);
  let clock = Date.parse("2026-09-17T10:00:00Z");
  service.deps.now = () => clock;
  Object.defineProperty(service, "now", { value: () => clock });
  delete service.deps.policy; // the stand-in fetch below is the whole network
  // Several accounts per connection ships on (the owner's decision, 2026-09-27); these tests start from off and turn it
  // on where they need it, so the owner switches it off first.
  const { setMode } = await import("../dist/accounts/manage.js");
  setMode(service, { mode: "off" });
  return { app, service, owner: app.runtime.owner, root, tick: (ms) => { clock += ms; } };
}

/** A saved OpenAI connection whose first key is a stand-in provider, and a fake service for extra keys. */
function apiConnection(fx, first) {
  const { app, owner, service } = fx;
  app.store.save("settings", owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI test", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  const calls = { first: 0, second: 0 };
  const provider = { name: "openai-chat", complete: async (request) => { calls.first++; return first(request); } };
  app.runtime.models.register({ id: POOL, name: "OpenAI test", model: "gpt-4o-mini", catalogId: "openai", provider });
  app.runtime.models.configure(owner, { activePreset: POOL });
  service.deps.fetchImpl = async (url, init) => {
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${SECOND_KEY}`);
    calls.second++;
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "from the second key" } }], usage: { prompt_tokens: 1000, completion_tokens: 1000 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { calls, provider };
}
async function turnOn(service, mode = "on") {
  const { setMode } = await import("../dist/accounts/manage.js");
  setMode(service, { mode });
}
async function addKey(service) {
  const { addAccount } = await import("../dist/accounts/manage.js");
  const view = await addAccount(service, { pool: POOL, label: "Second", key: SECOND_KEY });
  return view.accounts.find((account) => account.label === "Second").id;
}
const rateLimited = () => { throw new ProviderHttpError(429, 30_000, "rate_limit_exceeded"); };
const events = (app, run, kind) => app.store.events(run.id).filter((event) => event.kind === kind);

test("A1 with the switch off nothing changes: the connection is registered exactly as given", async (t) => {
  const fx = await fixture(t);
  await turnOn(fx.service, "off"); // it ships on; the owner switched it off
  const { provider } = apiConnection(fx, () => ({ content: "first", toolCalls: [] }));
  assert.equal(fx.app.runtime.models.presets.get(POOL).provider, provider);
  const run = await fx.app.runtime.run({ prompt: "hello" });
  assert.equal(run.status, "completed");
  assert.equal(events(fx.app, run, "model.account").length, 0);
  await turnOn(fx.service);
  assert.notEqual(fx.app.runtime.models.presets.get(POOL).provider, provider, "on: the pool stands in front");
  assert.equal(fx.app.runtime.models.presets.get(POOL).provider.name, "openai-chat", "everything but complete is the connection's own");
  await turnOn(fx.service, "off");
  assert.equal(fx.app.runtime.models.presets.get(POOL).provider, provider, "off again: the connection itself");
});

test("A2 a 429 whose Retry-After is longer than a few seconds rests the key for that long and the next key answers in the same request", async (t) => {
  const fx = await fixture(t);
  const { calls } = apiConnection(fx, rateLimited);
  await turnOn(fx.service);
  const second = await addKey(fx.service);
  const run = await fx.app.runtime.run({ prompt: "hello" });
  assert.equal(run.status, "completed", run.output);
  assert.equal(run.output, "from the second key");
  assert.deepEqual(calls, { first: 1, second: 1 }, "a 30-second Retry-After is not waited out on the same key: the next one answers");
  assert.equal(events(fx.app, run, "model.account_resting")[0].data.reason, "rate");
  assert.equal(events(fx.app, run, "model.account")[0].data.account, second);
  assert.equal(events(fx.app, run, "model.fallback").length, 0, "no other connection was needed");
  fx.tick(29_000);
  await fx.app.runtime.run({ prompt: "again" });
  assert.equal(calls.first, 1, "still resting: the first key is not asked again inside Retry-After");
  fx.tick(2_000);
  await fx.app.runtime.run({ prompt: "and again" }).catch(() => undefined);
  assert.equal(calls.first, 2, "after Retry-After the first key is first again");
  const serialized = JSON.stringify(fx.app.store.events(run.id));
  assert.ok(!serialized.includes(SECOND_KEY), "the key never reaches the task's record");
});

test("A3 a rate limit rests one model; a billing refusal rests the whole key; an outage rests nothing", () => {
  const now = 1_000;
  const state = freshState();
  const account = { id: "primary", label: "k", pinned: false, disabled: false, monthlyCapUsd: null, shared: false, createdAt: "" };
  rest(state, failureFor(new ProviderHttpError(429, 5_000, "rate_limit_exceeded"), now), "model-a");
  assert.match(unavailable(account, state, "model-a", now + 1, false), /model-a/);
  assert.equal(unavailable(account, state, "model-b", now + 1, false), null, "the same key still serves another model");
  assert.equal(unavailable(account, state, "model-a", now + 5_001, false), null);
  const billing = failureFor(new ProviderHttpError(429, undefined, "insufficient_quota"), now);
  assert.equal(billing.scope, "account");
  assert.equal(failureFor(new ProviderHttpError(401), now).scope, "account");
  assert.equal(failureFor(new ProviderHttpError(503), now), null);
  assert.equal(failureFor(new Error("fetch failed"), now), null);
  const a = { ...account, id: "aaaaaaaa" }, b = { ...account, id: "bbbbbbbb", pinned: true };
  assert.deepEqual(orderFor("priority", [a, b], new Map(), 0, null).map((x) => x.id), ["bbbbbbbb", "aaaaaaaa"], "pinned first");
  assert.deepEqual(orderFor("round-robin", [a, account], new Map(), 1, null).map((x) => x.id), ["primary", "aaaaaaaa"]);
  const used = new Map([["aaaaaaaa", { ...freshState(), uses: 5 }], ["primary", { ...freshState(), uses: 1 }]]);
  assert.deepEqual(orderFor("least-used", [a, account], used, 0, null).map((x) => x.id), ["primary", "aaaaaaaa"]);
  assert.deepEqual(orderFor("priority", [a, account], new Map(), 0, "primary").map((x) => x.id), ["primary", "aaaaaaaa"], "the chosen one goes first");
});

test("A4 once every key rests, the task falls back to the next connection", async (t) => {
  const fx = await fixture(t);
  const { app, owner } = fx;
  apiConnection(fx, rateLimited);
  fx.service.deps.fetchImpl = async () => new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429, headers: { "retry-after": "20", "content-type": "application/json" } });
  app.runtime.models.register({ id: "backup", name: "Backup", model: "backup-model", provider: { name: "backup", complete: async () => ({ content: "from the backup", toolCalls: [] }) } });
  app.runtime.models.configure(owner, { activePreset: POOL, fallbackOrder: ["backup"] });
  await turnOn(fx.service);
  await addKey(fx.service);
  const run = await app.runtime.run({ prompt: "hello" });
  assert.equal(run.output, "from the backup");
  assert.equal(events(app, run, "model.account_resting").length, 2, "both keys were tried first");
  assert.equal(events(app, run, "model.fallback").length, 1);
});

test("A4b when every key was already resting, the task still falls back instead of failing", async (t) => {
  const fx = await fixture(t);
  const { app, owner } = fx;
  apiConnection(fx, rateLimited);
  fx.service.deps.fetchImpl = async () => new Response(JSON.stringify({ error: { code: "rate_limit_exceeded" } }), { status: 429, headers: { "retry-after": "20", "content-type": "application/json" } });
  let backup = 0;
  app.runtime.models.register({ id: "backup", name: "Backup", model: "backup-model", provider: { name: "backup", complete: async () => { backup++; return { content: "from the backup", toolCalls: [] }; } } });
  app.runtime.models.configure(owner, { activePreset: POOL, fallbackOrder: ["backup"], cooldownMs: 0 });
  await turnOn(fx.service);
  await addKey(fx.service);
  await app.runtime.run({ prompt: "rest both keys" });
  const run = await app.runtime.run({ prompt: "hello again" });
  assert.equal(run.output, "from the backup");
  assert.equal(events(app, run, "model.account_resting").length, 0, "no key was asked: both were still resting");
  assert.equal(events(app, run, "model.fallback").length, 1);
  assert.match(events(app, run, "model.fallback")[0].data.reason, /Every key of this connection is resting/);
  assert.equal(backup, 2);
});

test("A5 a key that reached its monthly cap is passed over", async (t) => {
  const fx = await fixture(t);
  const { app, owner, service } = fx;
  const { calls } = apiConnection(fx, () => ({ content: "first", toolCalls: [], usage: { input: 1, output: 1 } }));
  app.store.save("settings", owner, "pricing", { overrides: { "gpt-4o-mini": { input: 1000, output: 1000 } } });
  await turnOn(service);
  const second = await addKey(service);
  const { updateAccount, updatePool, switchAccount } = await import("../dist/accounts/manage.js");
  switchAccount(service, { pool: POOL, account: second });
  updatePool(service, { pool: POOL, strategy: "priority" });
  await updateAccount(service, { pool: POOL, account: second, monthlyCapUsd: 1 });
  const first = await app.runtime.run({ prompt: "one" });
  assert.equal(first.output, "from the second key", "the default answers while under its cap");
  const view = (await import("../dist/accounts/manage.js")).viewPool(service, service.pool(POOL));
  const row = view.accounts.find((account) => account.id === second);
  assert.equal(row.usage.requests, 1);
  assert.equal(row.usage.costUsd, 2, "1000 in and 1000 out at $1000 per million");
  assert.equal(row.capReached, true);
  const next = await app.runtime.run({ prompt: "two" });
  assert.equal(next.output, "first", "over its cap, the key is skipped");
  assert.deepEqual(calls, { first: 1, second: 1 });
});

test("A6 /account switches one conversation by hand, and lists on every surface that has it", async (t) => {
  const fx = await fixture(t);
  const { app, owner, service } = fx;
  await turnOn(service, "off"); // it ships on; the owner switched it off
  apiConnection(fx, () => ({ content: "first", toolCalls: [] }));
  saveCommandSettings(app.store, owner, { mode: "on" });
  const host = { runtime: app.runtime, requireOwner: () => undefined };
  const off = await executeCommand(host, { surface: "window", line: "/account", access: "full" });
  assert.match(off.text, /switched off/);
  await turnOn(service);
  await addKey(service);
  const run = await app.runtime.run({ prompt: "hello" });
  assert.equal(run.output, "first");
  for (const surface of ["window", "phone", "dashboard"]) {
    const listed = await executeCommand(host, { surface, line: "/account", sessionId: run.sessionId, access: "read" });
    assert.match(listed.text, /→ First key\n {2}Second/, surface);
  }
  const refused = await executeCommand(host, { surface: "phone", line: "/account Second", sessionId: run.sessionId, access: "run" });
  assert.ok(refused.refused, "switching is the owner's");
  const switched = await executeCommand(host, { surface: "window", line: "/account second", sessionId: run.sessionId, access: "full" });
  assert.match(switched.text, /This conversation now uses "Second"/);
  const again = await app.runtime.run({ prompt: "more", sessionId: run.sessionId });
  assert.equal(again.output, "from the second key");
  const other = await app.runtime.run({ prompt: "elsewhere" });
  assert.equal(other.output, "first", "other conversations are unchanged");
  assert.equal(lookup("account").surfaces.includes("chat"), false, "never from a chat app");
  const defaulted = await executeCommand(host, { surface: "window", line: "/account default Second", access: "full" });
  assert.match(defaulted.text, /New work now uses "Second"/);
});

function programFixture(fx, outcomes) {
  const seen = [];
  const spawn = async (row, prompt, signal, limits, home) => {
    const who = home ? home.path.split(/[\\/]/).pop() : "primary";
    seen.push({ who, variable: home?.name ?? null });
    const outcome = outcomes[who] ?? outcomes.default;
    return typeof outcome === "function" ? outcome() : outcome;
  };
  registerCliAgent(fx.app.runtime.models, { id: "claude-code" }, {}, spawn);
  fx.app.runtime.models.configure(fx.owner, { activePreset: "cli-claude-code" });
  fx.service.deps.spawnAgent = spawn;
  return seen;
}
const limited = { code: 1, stdout: "", stderr: "Claude usage limit reached. Your limit resets at 3pm." };
const answer = (text) => ({ code: 0, stdout: JSON.stringify({ result: text }), stderr: "" });

test("A7 a sign-in account at its plan limit moves the work to the owner's next account; with moving on off it stops", async (t) => {
  const fx = await fixture(t);
  const { app, service } = fx;
  const seen = programFixture(fx, { primary: limited, default: answer("from the work account") });
  await turnOn(service);
  const { addAccount, updatePool, updateAccount } = await import("../dist/accounts/manage.js");
  const view = await addAccount(service, { pool: "cli-claude-code", label: "Work" });
  const work = view.accounts.find((account) => account.label === "Work");
  assert.ok(work.home.startsWith(join(fx.root, "data", "accounts")), "each account has its own folder under Branch's data");
  // Account pools (owner decision 2026-09-27): on by itself with two accounts, the owner's own plans included.
  const moved = await app.runtime.run({ prompt: "hello" });
  assert.equal(moved.output, "from the work account");
  assert.deepEqual(seen.map((s) => s.who), ["primary", work.id]);
  assert.deepEqual(seen.at(-1), { who: work.id, variable: "CLAUDE_CONFIG_DIR" });
  const again = await app.runtime.run({ prompt: "hello" });
  assert.equal(again.output, "from the work account");
  assert.equal(seen.filter((s) => s.who === "primary").length, 1, "a limited account is not asked again until it resets");
  await assert.rejects(updateAccount(service, { pool: "cli-claude-code", account: work.id, shared: true }), /cannot be shared/);
  updatePool(service, { pool: "cli-claude-code", autoSwitch: false });
  service.statesOf("cli-claude-code").clear();
  const stopped = await app.runtime.run({ prompt: "hello" });
  assert.equal(stopped.status, "failed");
  assert.match(stopped.output, /"Your usual sign-in" has reached its plan limit/);
  assert.match(stopped.output, /Moving to the next account is off/);
});

test("A8 ChatGPT tokens live in the locker per account and never reach the list; the plan window is read", async (t) => {
  const fx = await fixture(t);
  const vault = new LockerTokenVault(fx.app.store.locker, fx.owner, "abcdef12");
  assert.equal(await vault.read(), null);
  const tokens = { accessToken: "a".repeat(5000), refreshToken: "refresh-secret", idToken: "i".repeat(5000), expiresAt: "2026-09-18T00:00:00.000Z" };
  await vault.write(tokens);
  assert.deepEqual(await vault.read(), tokens);
  assert.equal(await new LockerTokenVault(fx.app.store.locker, fx.owner, "99999999").read(), null, "each account is kept apart");
  const backup = JSON.stringify(fx.app.store.backup("test"));
  assert.ok(!backup.includes("refresh-secret"), "a backup never carries a token");
  await vault.clear();
  assert.equal(await vault.read(), null);
  assert.equal(remainingFrom(new Headers({ "x-codex-primary-used-percent": "12.5" })), 87.5);
  assert.equal(remainingFrom(new Headers()), null);
});

test("A9 the routes: reads for any key, changes for the owner only, and no key in any answer", async (t) => {
  const fx = await fixture(t);
  const { app, owner, service } = fx;
  await turnOn(service, "off"); // it ships on; the owner switched it off
  apiConnection(fx, () => ({ content: "first", toolCalls: [] }));
  const server = await startServer(app, { dataDir: join(fx.root, "data"), port: 0 });
  t.after(() => server.close());
  const run = app.sessionTokens.create(owner, { name: "script", scope: "run" }).token;
  const call = async (method, path, key, body) => {
    const response = await fetch(server.url + path, { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  assert.equal((await call("POST", "/api/accounts/add", server.token, { pool: POOL, label: "x", key: SECOND_KEY })).status, 409, "switched off");
  assert.equal((await call("POST", "/api/accounts/settings", run, { mode: "on" })).status, 401, "a short-lived key cannot switch it on");
  assert.equal((await call("POST", "/api/accounts/settings", server.token, { mode: "on" })).status, 200);
  const added = await call("POST", "/api/accounts/add", server.token, { pool: POOL, label: "Second", key: SECOND_KEY });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const second = added.body.accounts.find((account) => account.label === "Second").id;
  for (const path of ["/api/accounts/add", "/api/accounts/remove", "/api/accounts/switch", "/api/accounts/update", "/api/accounts/pool", "/api/accounts/chatgpt/login"])
    assert.match(offLimitsToShortLivedKeys("POST", path), /short-lived key/, path);
  assert.equal((await call("POST", "/api/accounts/switch", run, { pool: POOL, account: second })).status, 401);
  assert.equal((await call("POST", "/api/accounts/remove", run, { pool: POOL, account: second })).status, 401);
  const listed = await call("GET", "/api/accounts", run);
  assert.equal(listed.status, 200);
  assert.ok(!JSON.stringify(listed.body).includes(SECOND_KEY), "the key never comes back");
  const pool = listed.body.pools.find((entry) => entry.pool === POOL);
  assert.deepEqual(pool.accounts.map((account) => account.label), ["First key", "Second"]);
  assert.match(pool.terms.text, /rate limited twice in a row|next key/);
  assert.equal((await call("GET", "/api/accounts/session?sessionId=", run)).body.pool, POOL);
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const household = await call("POST", "/api/accounts/switch", server.token, { pool: POOL, account: second });
  assert.equal(household.status >= 400, true, "a household profile cannot switch the owner's accounts");
  app.store.profiles.switch({ profileId: null });
  assert.equal((await call("POST", "/api/accounts/remove", server.token, { pool: POOL, account: second })).status, 200);
  assert.equal(app.store.locker.exists(owner, keyProject(POOL), keyName(second)), false, "removing takes the key out of the locker");
});

test("A10 people sharing the computer use only keys the owner shared, and never a sign-in", async (t) => {
  const fx = await fixture(t);
  const { app, service } = fx;
  const { calls } = apiConnection(fx, () => ({ content: "first", toolCalls: [] }));
  await turnOn(service);
  const second = await addKey(service);
  const { updateAccount } = await import("../dist/accounts/manage.js");
  await updateAccount(service, { pool: POOL, account: "primary", shared: false });
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  const refused = await app.runtime.run({ prompt: "hello" });
  assert.match(refused.output, /None of this connection's accounts is shared with you/);
  const { viewAll } = await import("../dist/accounts/manage.js");
  const hidden = (await viewAll(service)).pools.find((pool) => pool.pool === POOL);
  // hardening-3: not even the list itself (its kind, strategy, default) while nothing is shared with them.
  assert.equal(hidden, undefined, "nothing of the owner's is listed for them while nothing is shared");
  app.store.profiles.switch({ profileId: null });
  await updateAccount(service, { pool: POOL, account: second, shared: true, monthlyCapUsd: 50 });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const seen = (await viewAll(service)).pools.find((pool) => pool.pool === POOL);
  assert.deepEqual(seen.accounts.map((account) => account.label), ["Second"]);
  assert.deepEqual(Object.keys(seen).sort(), ["accounts", "kind", "name", "pool", "terms"], "only the shared accounts, not how the owner's list is run");
  assert.equal(seen.accounts[0].monthlyCapUsd, null, "the owner's cap is not shown to them");
  assert.equal(seen.accounts[0].usage.costUsd, 0);
  const shared = await app.runtime.run({ prompt: "hello" });
  assert.equal(shared.output, "from the second key");
  assert.equal(calls.first, 0);
  /* Bucket 19: a person signed in from their own device is held to the same rule. */
  app.store.profiles.switch({ profileId: null });
  const { asPerson } = await import("../dist/people/context.js");
  const theirs = await asPerson({ profileId: person.id, keyId: "phone" }, () => app.runtime.run({ prompt: "hello" }));
  assert.equal(theirs.output, "from the second key");
  assert.equal(calls.first, 0, "the owner's unshared first key is never used for them");
});

test("A11 a damaged list reads as switched off; a missing one reads as it ships; the owner's off stays off", async (t) => {
  const fx = await fixture(t);
  fx.app.store.save("settings", fx.owner, "accounts", { mode: "sideways" });
  assert.equal(fx.service.settings().mode, "off");
  fx.app.store.delete("settings", fx.owner, "accounts");
  assert.equal(fx.service.settings().mode, "when-needed", "nothing saved: on, as it ships (the owner's decision, 2026-09-27)");
  await turnOn(fx.service, "off");
  saveAccountsSettings(fx.app.store, fx.owner, { ...fx.service.settings(), pools: [] });
  assert.equal(fx.service.on(), false, "the owner's own off survives a later save of the list");
});

/* ---------- integrator (adversarial) checks ---------- */

test("I1 an extra key only ever goes to the address it was added for", async (t) => {
  const fx = await fixture(t);
  const { app, owner, service } = fx;
  const save = (baseUrl) => app.store.save("settings", owner, "model-connections", { connections: [{ id: "custom", name: "Mine", catalogId: "custom", model: "m1", extras: { baseUrl } }] });
  save("https://a.example/v1");
  const provider = { name: "openai-chat", complete: async () => ({ content: "first", toolCalls: [] }) };
  app.runtime.models.register({ id: "custom", name: "Mine", model: "m1", catalogId: "custom", provider });
  app.runtime.models.configure(owner, { activePreset: "custom" });
  const hosts = [];
  service.deps.fetchImpl = async (url) => {
    hosts.push(new URL(String(url)).host);
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "from the second key" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await turnOn(service);
  const { addAccount, updateAccount } = await import("../dist/accounts/manage.js");
  const second = (await addAccount(service, { pool: "custom", label: "Second", key: SECOND_KEY })).accounts.find((a) => a.label === "Second").id;
  await updateAccount(service, { pool: "custom", account: "primary", disabled: true });
  assert.equal((await app.runtime.run({ prompt: "hello" })).output, "from the second key");
  assert.deepEqual(hosts, ["a.example"]);
  // The connection is taken away and added again under the same name, pointing somewhere else.
  save("https://b.example/v1");
  app.runtime.models.register({ id: "custom", name: "Mine", model: "m1", catalogId: "custom", provider });
  const moved = await app.runtime.run({ prompt: "hello" });
  assert.equal(moved.status, "failed");
  assert.match(moved.output, /added for a different address/);
  assert.deepEqual(hosts, ["a.example"], "the key never reached the new address");
  assert.ok(second);
});

test("I2 a ChatGPT sign-in too long for the locker fails in a sentence and writes nothing", async (t) => {
  const fx = await fixture(t);
  const vault = new LockerTokenVault(fx.app.store.locker, fx.owner, "abcdef12");
  const before = { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: "2026-09-18T00:00:00.000Z" };
  await vault.write(before);
  const long = { accessToken: "a".repeat(100), refreshToken: "r".repeat(9000), expiresAt: "2026-09-19T00:00:00.000Z" };
  await assert.rejects(vault.write(long), (error) => {
    assert.match(error.message, /^This ChatGPT sign-in is longer than the locker can hold/);
    assert.ok(!error.message.includes("rrrr"), "the token is not in the message");
    return true;
  });
  assert.deepEqual(await vault.read(), before, "nothing was half-written or cut short");
});

test("I4 people never learn whether the owner's cap was reached, and /account is refused for them", async (t) => {
  const fx = await fixture(t);
  const { app, owner, service } = fx;
  apiConnection(fx, () => ({ content: "first", toolCalls: [] }));
  saveCommandSettings(app.store, owner, { mode: "on" });
  await turnOn(service);
  const second = await addKey(service);
  const { updateAccount, viewAll } = await import("../dist/accounts/manage.js");
  await updateAccount(service, { pool: POOL, account: second, shared: true, monthlyCapUsd: 1 });
  service.ledger.record(owner, POOL, second, { input: 1, output: 1, costUsd: 5 }, new Date(service.now()));
  assert.equal((await viewAll(service)).pools.find((p) => p.pool === POOL).accounts.find((a) => a.id === second).capReached, true);
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  const seen = (await viewAll(service)).pools.find((p) => p.pool === POOL).accounts;
  assert.equal(seen.find((a) => a.id === second).capReached, false, "the cap stays the owner's business");
  const host = { runtime: app.runtime, requireOwner: (what) => app.store.profiles.requireOwner(what) };
  const listed = await executeCommand(host, { surface: "window", line: "/account", access: "full" });
  assert.match(listed.text, /belongs to the owner/);
  assert.ok(!listed.text.includes("Second"));
});

test("I5 account lists are named like connections: no path pieces", async (t) => {
  const fx = await fixture(t);
  apiConnection(fx, () => ({ content: "first", toolCalls: [] }));
  await turnOn(fx.service);
  const { addAccount, updatePool } = await import("../dist/accounts/manage.js");
  for (const pool of ["../../evil", "cli-claude-code/../x", "a\\b"]) {
    await assert.rejects(addAccount(fx.service, { pool, label: "x" }), { name: "ZodError" }, pool);
    assert.throws(() => updatePool(fx.service, { pool, strategy: "priority" }), { name: "ZodError" }, pool);
  }
});

test("I6 the sign-in line for a program's folder is written for the computer it runs on", async () => {
  const { programSignInLine } = await import("../dist/accounts/settings.js");
  assert.equal(programSignInLine("CLAUDE_CONFIG_DIR", "/Volumes/My Disk/data/accounts/cli-claude-code/abcd1234", "claude", "darwin"),
    "CLAUDE_CONFIG_DIR='/Volumes/My Disk/data/accounts/cli-claude-code/abcd1234' claude");
  assert.equal(programSignInLine("CODEX_HOME", "/home/o'neil/data/accounts/cli-codex/abcd1234", "codex", "linux"),
    "CODEX_HOME='/home/o'\\''neil/data/accounts/cli-codex/abcd1234' codex");
  assert.equal(programSignInLine("COPILOT_HOME", "C:\\Users\\O'Neil\\Branch\\accounts\\cli-copilot\\abcd1234", "copilot", "win32"),
    "$env:COPILOT_HOME='C:\\Users\\O''Neil\\Branch\\accounts\\cli-copilot\\abcd1234'; copilot");
});

test("I7 the accounts source is plain text", async () => {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(new URL("../src/accounts/service.ts", import.meta.url), "utf8");
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text), "no raw control characters in the source");
});
