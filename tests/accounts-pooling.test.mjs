/**
 * Account pools (owner decision 2026-09-27): a connection with two or more accounts moves the work on by itself when one
 * runs out, the way Hermes Agent's credential pools do, API keys and sign-ins (the owner's own plans included) alike.
 * The triggers: a 429 is tried once more and moves on at the second; 402, a quota code or a plan limit moves on at
 * once; a 401 refreshes the sign-in first; a model the account is not entitled to benches it for that model only. With
 * one account, or with the switch off, nothing moves. Every service is a stand-in; nothing reaches a provider.
 */
import test from "node:test";
import { fakeClaudeAccounts } from "./fixtures/claude-account-adapter.mjs";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { AccountsSettingsSchema, applyPoolingRule, poolingRuleVersion } from "../dist/accounts/settings.js";
import { AccountPoolProvider, AccountLimitError } from "../dist/accounts/pool-provider.js";
import { withAccountCall } from "../dist/accounts/context.js";
import { addAccount, setMode, updatePool } from "../dist/accounts/manage.js";
import { ProviderHttpError } from "../dist/provider-retry.js";
import { stateLines } from "../dist/live-steps.js";

const at = "2026-09-27T10:00:00.000Z";
const acct = (id, extra = {}) => ({
  id, label: extra.label ?? id, pinned: false, disabled: false, monthlyCapUsd: null, shared: false, createdAt: at, ...extra,
});
const http = (status, code, retryAfterMs) => new ProviderHttpError(status, retryAfterMs, code);
const ok = (who) => ({ content: `from ${who}`, toolCalls: [] });

/**
 * One pool, answered by a script per account: each account's list of outcomes is used in turn (an Error is thrown,
 * anything else answers), and an empty list answers. `calls` says which account was asked, in order.
 */
function pool({ kind = "chatgpt", accounts = ["a", "b", "c"], strategy = "priority", autoSwitch = true, script = {}, refresh, model = "m1", states = new Map(), defaultAccount = null } = {}) {
  const calls = [], notes = [], refreshed = [], slept = [];
  let clock = Date.parse(at);
  const saved = { pool: "p", kind, strategy, autoSwitch, defaultAccount, accounts: accounts.map((id) => (typeof id === "string" ? acct(id) : id)) };
  const provider = (id) => ({ name: "stand-in", async complete() {
    calls.push(id);
    const next = (script[id] ?? []).shift();
    if (next instanceof Error) throw next;
    return ok(id);
  } });
  const cursor = { value: 0 };
  const make = (asModel) => new AccountPoolProvider(provider("original"), {
    owner: "owner", pool: "p", model: asModel, settings: () => saved, states, cursor, now: () => clock,
    sleep: async (ms) => { slept.push(ms); clock += ms; },
    providerFor: async (id) => provider(id),
    ...(refresh ? { refresh: async (id) => { refreshed.push(id); return refresh(id); } } : {}),
    capReached: () => false, record: () => undefined, personIsNotOwner: () => false,
    sessionChoice: () => null, rememberChoice: () => undefined,
  });
  const provided = make(model);
  const ask = (as = provided) => withAccountCall({ sessionId: "s", note: (k, data) => notes.push({ kind: k, data }) },
    () => as.complete({ messages: [{ role: "user", content: "hi" }], tools: [], signal: new AbortController().signal }));
  return { saved, calls, notes, refreshed, slept, ask, other: (asModel) => make(asModel), tick: (ms) => { clock += ms; }, now: () => clock };
}

test("R1 rotation order: fill first keeps to the first healthy account; take turns and least used spread the work", async () => {
  const fill = pool({ script: { a: [http(402)] } });
  assert.equal((await fill.ask()).content, "from b");
  assert.equal((await fill.ask()).content, "from b", "the first rests after being out of credit; fill first stays on the next");
  assert.deepEqual(fill.calls, ["a", "b", "b"]);
  const turns = pool({ strategy: "round-robin" });
  for (let i = 0; i < 4; i++) await turns.ask();
  assert.deepEqual(turns.calls, ["a", "b", "c", "a"]);
  const least = pool({ kind: "api-key", strategy: "least-used" });
  for (let i = 0; i < 3; i++) await least.ask();
  assert.deepEqual(least.calls, ["a", "b", "c"], "each time the one used least");
  const picked = pool({ defaultAccount: "c" });
  await picked.ask();
  assert.deepEqual(picked.calls, ["c"], "fill first starts from the list's own pick");
});

test("R2 a 429 is tried once more on the same account, and the second 429 in a row moves on", async () => {
  const once = pool({ kind: "api-key", script: { a: [http(429, "rate_limit_exceeded", 1000)] } });
  assert.equal((await once.ask()).content, "from a");
  assert.deepEqual(once.calls, ["a", "a"], "one 429, then the same account answers");
  const twice = pool({ kind: "api-key", script: { a: [http(429, "rate_limit_exceeded", 1000), http(429, "rate_limit_exceeded", 1000)] } });
  assert.equal((await twice.ask()).content, "from b");
  assert.deepEqual(twice.calls, ["a", "a", "b"]);
  const moved = twice.notes.find((n) => n.kind === "model.account_moved");
  assert.deepEqual([moved.data.from, moved.data.label, moved.data.reason], ["a", "b", "rate"]);
  assert.match(moved.data.why, /^hit its limit, resets /);
});

test("R3 402, a quota code or a plan limit moves on at once, and the step says which account it left and why", async () => {
  for (const refusal of [http(402), http(429, "insufficient_quota"), http(429, "usage_limit_reached", 60_000),
    Object.assign(new Error("Claude usage limit reached."), { name: "ProgramLimitError" })]) {
    const p = pool({ script: { a: [refusal] } });
    assert.equal((await p.ask()).content, "from b");
    assert.deepEqual(p.calls, ["a", "b"], `${refusal.message}: no second try on the same account`);
  }
  const limit = pool({ script: { a: [http(429, "usage_limit_reached", 30 * 60_000)] } });
  await limit.ask();
  const line = stateLines(null, { id: "r" }, limit.notes.map((n, i) => ({ id: String(i), kind: n.kind, data: n.data, createdAt: at })), 0)
    .find((l) => l.icon && /Moved to/.test(l.label));
  assert.match(line.label, /^Moved to “b” — “a” hit its limit, resets \d/);
});

test("R4 a 401 refreshes the sign-in first; it moves on only when the refresh fails", async () => {
  const fixed = pool({ script: { a: [http(401)] }, refresh: () => true });
  assert.equal((await fixed.ask()).content, "from a");
  assert.deepEqual([fixed.calls, fixed.refreshed], [["a", "a"], ["a"]]);
  const refused = pool({ script: { a: [http(401)] }, refresh: () => { throw new Error("refresh refused"); } });
  assert.equal((await refused.ask()).content, "from b");
  assert.deepEqual([refused.calls, refused.refreshed], [["a", "b"], ["a"]]);
  const again = pool({ script: { a: [http(401), http(401)] }, refresh: () => true });
  assert.equal((await again.ask()).content, "from b", "a new token that is refused as well moves on");
  const key = pool({ kind: "api-key", script: { a: [http(401)] } });
  assert.equal((await key.ask()).content, "from b", "a key has nothing to refresh");
  assert.deepEqual(key.calls, ["a", "b"]);
});

test("R5 a model the account is not entitled to benches that account for that model only", async () => {
  const states = new Map();
  const p = pool({ states, script: { a: [http(404, "model_not_found")] } });
  assert.equal((await p.ask()).content, "from b");
  assert.equal((await p.ask()).content, "from b", "benched for m1");
  assert.equal((await p.ask(p.other("m2"))).content, "from a", "still used for another model");
  assert.deepEqual(p.calls, ["a", "b", "b", "a"]);
  assert.equal(p.notes.find((n) => n.kind === "model.account_moved").data.why, "cannot use m1");
});

test("R6 nothing moves with one account, one switched on, or the switch off", async () => {
  const single = pool({ accounts: ["a"], script: { original: [http(429, "usage_limit_reached")] } });
  await assert.rejects(single.ask(), (error) => error.status === 429);
  assert.deepEqual(single.calls, ["original"], "a list of one is the connection itself");
  const oneOn = pool({ accounts: ["a", acct("b", { disabled: true })], script: { a: [http(429, "usage_limit_reached")] } });
  await assert.rejects(oneOn.ask(), AccountLimitError);
  assert.deepEqual(oneOn.calls, ["a"]);
  const off = pool({ autoSwitch: false, script: { a: [http(429, "usage_limit_reached")] } });
  await assert.rejects(off.ask(), (error) => /Moving to the next account is off/.test(error.message));
  assert.deepEqual(off.calls, ["a"]);
  const keys = pool({ kind: "api-key", accounts: ["a", acct("b", { disabled: true })], script: { a: [http(402)] } });
  await assert.rejects(keys.ask(), (error) => error.status === 402);
  assert.deepEqual(keys.calls, ["a"]);
});

test("R7 every account exhausted: a sign-in list waits for the soonest reset; a key list hands back the last refusal", async () => {
  const signIns = pool({ accounts: ["a", "b"], script: { a: [http(429, "usage_limit_reached", 20 * 60_000)], b: [http(429, "usage_limit_reached", 10 * 60_000)] } });
  const error = await signIns.ask().catch((e) => e);
  assert.ok(error instanceof AccountLimitError);
  assert.equal(error.account, "b", "the one back first");
  assert.equal(error.until, Date.parse(at) + 10 * 60_000, "a known reset, so the task can wait for it");
  const keys = pool({ kind: "api-key", accounts: ["a", "b"], script: { a: [http(402)], b: [http(402)] } });
  await assert.rejects(keys.ask(), (e) => e.status === 402);
});

test("R8 an old list that rule 1 stopped moves on again once; the owner's off afterwards stays off", () => {
  const old = AccountsSettingsSchema.parse({ mode: "on", poolingRule: 1, poolingNotices: ["chatgpt"],
    pools: [{ pool: "chatgpt", kind: "chatgpt", autoSwitch: false, accounts: [acct("primary"), acct("aaaaaaaa")] }] });
  const { settings, stopped } = applyPoolingRule(old);
  assert.deepEqual([settings.pools[0].autoSwitch, settings.poolingRule, settings.poolingNotices, stopped], [true, poolingRuleVersion, [], ["chatgpt"]]);
  const offAgain = { ...settings, pools: [{ ...settings.pools[0], autoSwitch: false }] };
  assert.equal(applyPoolingRule(offAgain).settings, offAgain, "left alone once brought up to the rule");
});

test("R9 a real task on Claude Code: the owner's plan runs out, the next of their plans answers, and the plan meter says which is next", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-pools-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const service = accountsServiceFor(app.runtime.models);
  await fakeClaudeAccounts(t, service);
  const seen = [];
  const spawn = async (row, prompt, signal, limits, home) => {
    const who = home ? home.path.split(/[\\/]/).pop() : "primary";
    seen.push(who);
    return who === "primary" ? { code: 1, stdout: "", stderr: "Claude usage limit reached. Your limit resets at 3pm." } : { code: 0, stdout: JSON.stringify({ result: `from ${who}` }), stderr: "" };
  };
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, spawn);
  app.runtime.models.configure(app.runtime.owner, { activePreset: "cli-claude-code" });
  service.deps.spawnAgent = spawn;
  setMode(service, { mode: "on" });
  const second = (await addAccount(service, { pool: "cli-claude-code", label: "Second" })).accounts.at(-1).id;
  assert.equal(service.usedNext("cli-claude-code"), "primary");
  const run = await app.runtime.run({ prompt: "hello" });
  assert.equal(run.status, "completed");
  assert.equal(run.output, `from ${second}`, "the owner's second plan takes the work");
  assert.deepEqual(seen, ["primary", second]);
  assert.equal(service.usedNext("cli-claude-code"), second, "the plan meter marks the one used next");
  const moved = app.store.events(run.id).find((event) => event.kind === "model.account_moved");
  assert.deepEqual([moved.data.from, moved.data.label], ["Your usual sign-in", "Second"]);
  updatePool(service, { pool: "cli-claude-code", autoSwitch: false });
  service.statesOf("cli-claude-code").clear();
  seen.length = 0;
  const stopped = await app.runtime.run({ prompt: "again" });
  assert.equal(stopped.status, "failed", "with the switch off it stops, as before");
  assert.deepEqual(seen, ["primary"]);
});

test("R10 the kept-separate mark is gone: an older list that still carries it reads whole, and /api/accounts/update refuses it", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-pools-mark-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const service = accountsServiceFor(app.runtime.models);
  app.store.save("settings", app.runtime.owner, "accounts", { mode: "on", poolingRule: 2, poolingNotices: [], pools: [{ pool: "cli-claude-code", kind: "cli",
    strategy: "priority", autoSwitch: true, defaultAccount: null, accounts: [{ ...acct("primary"), keptSeparate: false }, { ...acct("aaaaaaaa", { label: "Work" }), keptSeparate: true }] }] });
  const list = service.settings();
  assert.equal(list.mode, "on", "not taken for a damaged record");
  assert.deepEqual(list.pools[0].accounts.map((a) => [a.label, "keptSeparate" in a]), [["primary", false], ["Work", false]]);
  const { updateAccount } = await import("../dist/accounts/manage.js");
  await assert.rejects(updateAccount(service, { pool: "cli-claude-code", account: "aaaaaaaa", keptSeparate: true }), /keptSeparate|Unrecognized/i);
});
