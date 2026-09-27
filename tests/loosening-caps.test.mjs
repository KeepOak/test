/**
 * Spend caps, how long conversations are kept and the emergency stop are held to the same rule as every other setting
 * that can make Branch less careful (src/policy-change-guard.ts looseningRefusal): a cap raised or removed, conversations
 * kept longer and the emergency stop let go need the owner's separate yes, `confirmLoosening`, and are refused under
 * Lockdown even with it. The other way (a cap lowered or added, keeping shortened, the stop pressed) is never held,
 * Lockdown or not. A household person at the window, the owner's short-lived key and a person's own key are refused
 * whatever they send.
 *
 * Mutations, and the case each turns red:
 *   M1  looseningRefusal: `if (confirmLoosening) return null;` moved above the Lockdown check  → every "under Lockdown"
 *   M2  looseningRefusal answers null always (the routes as they were)                         → every "without the yes"
 *   M3  accounts/api.ts capLooser answers null always (the account cap ungated)                → "account cap"
 *   M4  server.ts budgetLooser answers null always (the monthly limit ungated)                 → "monthly limit"
 *   M5  knobs/api.ts spendCapLooser ignores `reset` (a reset takes the task cap away unasked)  → "task spend cap"
 *   M6  retention.ts retentionLooser: a rule switched off is not weighed (enabled ignored)     → "keeping"
 *   M7  safety-extras/api.ts: the stop release not weighed (looser null)                       → "emergency stop"
 *   M8  catalogue.ts: the retention `weigh` hook dropped (the settings kit keeps longer unasked) → "keeping"
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveAccountsSettings } from "../dist/accounts/settings.js";

const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
const tick = 'Tick "Yes, make it less careful" to go ahead.';
const lockdownWords = "Lockdown is on, so settings cannot be changed from here. Turn it off first.";
const POOL = "openai-test";

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-loosening-caps-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { app.store.profiles.switch({ profileId: null }); await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, route, body, key = server.token) => fetch(server.url + route, {
    method,
    headers: { authorization: `Bearer ${key}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  const lockdown = async (on) => assert.equal((await call("POST", "/api/lockdown", { on })).status, 200);
  return { app, server, call, lockdown };
}

/** Each loosening route: how to set it up, one loosening and one tightening body, and how to read the value back. */
const routes = {
  "account cap": {
    route: "/api/accounts/update",
    setup: (app) => saveAccountsSettings(app.store, app.runtime.owner, { mode: "on", pools: [{ pool: POOL, kind: "api-key",
      accounts: [{ id: "primary", label: "First key", monthlyCapUsd: 10, createdAt: "2026-09-26T00:00:00.000Z" }] }] }),
    looser: [{ pool: POOL, account: "primary", monthlyCapUsd: 20 }, { pool: POOL, account: "primary", monthlyCapUsd: null }],
    words: "This makes Branch less careful: First key's monthly cap would go up from $10 to $20. " + tick,
    tighter: { pool: POOL, account: "primary", monthlyCapUsd: 5 },
    read: async (call) => (await call("GET", "/api/accounts")).body.pools.find((p) => p.pool === POOL).accounts[0].monthlyCapUsd,
    start: 10, loosened: 20, tightened: 5,
  },
  "monthly limit": {
    route: "/api/usage/budget",
    setup: async (_app, call) => assert.equal((await call("POST", "/api/usage/budget", { maxMonthlyDollars: 10, pauseAtBudget: true })).status, 200, "adding a limit is never held"),
    looser: [{ maxMonthlyDollars: 20, pauseAtBudget: true }, { maxMonthlyTokens: 5000, pauseAtBudget: true }, { maxMonthlyDollars: 10, pauseAtBudget: false }],
    words: "This makes Branch less careful: the monthly limit would go up from $10 to $20. " + tick,
    tighter: { maxMonthlyDollars: 5, pauseAtBudget: true },
    read: async (call) => (await call("GET", "/api/usage/budget")).body.budget.maxMonthlyDollars,
    start: 10, loosened: 20, tightened: 5,
  },
  "task spend cap": {
    route: "/api/knobs",
    setup: async (_app, call) => assert.equal((await call("POST", "/api/knobs", { card: "limits", values: { spendCapDollars: 10 } })).status, 200, "adding a cap is never held"),
    looser: [{ card: "limits", values: { spendCapDollars: 20 } }, { card: "limits", values: { spendCapDollars: null } }, { card: "limits", reset: true }],
    words: "This makes Branch less careful: a task's spend cap would go up from $10 to $20. " + tick,
    tighter: { card: "limits", values: { spendCapDollars: 5 } },
    read: async (call) => (await call("GET", "/api/knobs")).body.values.limits.spendCapDollars,
    start: 10, loosened: 20, tightened: 5,
  },
  "keeping": {
    route: "/api/retention",
    setup: async (_app, call) => assert.equal((await call("POST", "/api/retention", { enabled: true, keepDays: 30 })).status, 200, "a first rule is never held"),
    looser: [{ enabled: true, keepDays: 365 }, { enabled: false, keepDays: 30 }, { enabled: true, keepDays: 0 }],
    words: "This makes Branch less careful: conversations would be kept 365 days instead of 30. " + tick,
    tighter: { enabled: true, keepDays: 7 },
    read: async (call) => (await call("GET", "/api/retention")).body.settings.keepDays,
    start: 30, loosened: 365, tightened: 7,
  },
};

for (const [name, r] of Object.entries(routes)) {
  test(`${name}: loosening refused without the yes in the engine's words, saved with it; tightening never held`, async (t) => {
    const { app, call } = await served(t);
    await r.setup(app, call);
    assert.equal(await r.read(call), r.start);
    const refused = await call("POST", r.route, r.looser[0]);
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.error, r.words);
    for (const body of r.looser.slice(1)) {
      const answer = await call("POST", r.route, body);
      assert.equal(answer.status, 409, JSON.stringify(body));
      assert.match(answer.body.error, /^This makes Branch less careful: /);
    }
    assert.equal(await r.read(call), r.start, "nothing saved without the yes");
    assert.notEqual((await call("POST", r.route, { ...r.looser[0], confirmLoosening: "yes" })).status, 200, "confirmLoosening is true or false");
    const confirmed = await call("POST", r.route, { ...r.looser[0], confirmLoosening: true });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    assert.equal(await r.read(call), r.loosened, "read back: the owner's yes saved it");
    assert.equal((await call("POST", r.route, r.tighter)).status, 200, "tightening needs no yes");
    assert.equal(await r.read(call), r.tightened);
  });

  test(`${name}: under Lockdown loosening is refused even with the yes; tightening still goes through`, async (t) => {
    const { app, call, lockdown } = await served(t);
    await r.setup(app, call);
    await lockdown(true);
    const locked = await call("POST", r.route, { ...r.looser[0], confirmLoosening: true });
    assert.equal(locked.status, 409, JSON.stringify(locked.body));
    assert.equal(locked.body.error, lockdownWords);
    assert.equal(await r.read(call), r.start, "Lockdown kept it");
    assert.equal((await call("POST", r.route, r.tighter)).status, 200, "tightening under Lockdown");
    assert.equal(await r.read(call), r.tightened);
  });

  test(`${name}: a household person, the owner's short-lived key and a person's own key are refused, even with the yes`, async (t) => {
    const { app, call } = await served(t);
    await r.setup(app, call);
    assert.equal((await call("POST", "/api/people/settings", { mode: "on" })).status, 200);
    const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
    const ownersKey = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
    const samsKey = app.people.keys.issue(sam.id, 60, "pin", "test").key;
    const loosen = { ...r.looser[0], confirmLoosening: true };
    for (const [who, key] of [["the owner's short-lived key", ownersKey], ["Sam's own key", samsKey]]) {
      const answer = await call("POST", r.route, loosen, key);
      assert.ok(answer.status >= 400 && answer.status < 500, `${who}: ${answer.status}`);
    }
    app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
    const atWindow = await call("POST", r.route, loosen);
    assert.ok(atWindow.status >= 400 && atWindow.status < 500, `Sam at the window: ${atWindow.status}`);
    app.store.profiles.switch({ profileId: null });
    assert.equal(await r.read(call), r.start, "none of them changed the owner's setting");
  });
}

test("keeping: the settings kit weighs a longer keep the same way", async (t) => {
  const { call } = await served(t);
  assert.equal((await call("POST", "/api/retention", { enabled: true, keepDays: 30 })).status, 200);
  const plan = (value, extra = {}) => ({ plan: { source: "set", key: "retention", field: "keepDays", value }, accept: ["retention.keepDays"], ...extra });
  const refused = await call("POST", "/api/settings-kit/apply", plan(365));
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.match(refused.body.error, /less careful/);
  assert.equal((await call("GET", "/api/retention")).body.settings.keepDays, 30);
  assert.equal((await call("POST", "/api/settings-kit/apply", plan(7))).status, 200, "shorter needs no yes");
  assert.equal((await call("POST", "/api/settings-kit/apply", plan(365, { confirmLoosening: true }))).status, 200);
  assert.equal((await call("GET", "/api/retention")).body.settings.keepDays, 365);
});

test("emergency stop: letting it go needs the yes, and never under Lockdown; pressing it never does", async (t) => {
  const { app, call, lockdown } = await served(t);
  const read = async () => (await call("GET", "/api/safety-extras")).body.stop.engaged;
  assert.equal((await call("POST", "/api/safety-extras/stop/release", {})).status, 200, "nothing held: nothing to let go");
  await lockdown(true);
  assert.equal((await call("POST", "/api/safety-extras/stop", { everything: true })).status, 200, "pressing it under Lockdown");
  const locked = await call("POST", "/api/safety-extras/stop/release", { confirmLoosening: true });
  assert.equal(locked.status, 409);
  assert.equal(locked.body.error, lockdownWords, "Lockdown must be turned off first");
  await lockdown(false);
  assert.equal(await read(), true, "Lockdown kept the stop");
  const refused = await call("POST", "/api/safety-extras/stop/release", {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, `This makes Branch less careful: the emergency stop would be let go, and stopped work could start again. ${tick}`);
  assert.equal(await read(), true, "still stopped without the yes");
  assert.notEqual((await call("POST", "/api/safety-extras/stop/release", { confirmLoosening: "yes" })).status, 200);
  // Others are refused, even with the yes.
  assert.equal((await call("POST", "/api/people/settings", { mode: "on" })).status, 200);
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  const ownersKey = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const samsKey = app.people.keys.issue(sam.id, 60, "pin", "test").key;
  for (const [who, key] of [["the owner's short-lived key", ownersKey], ["Sam's own key", samsKey]]) {
    const answer = await call("POST", "/api/safety-extras/stop/release", { confirmLoosening: true }, key);
    assert.ok(answer.status >= 400 && answer.status < 500, `${who}: ${answer.status}`);
  }
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  const atWindow = await call("POST", "/api/safety-extras/stop/release", { confirmLoosening: true });
  assert.ok(atWindow.status >= 400 && atWindow.status < 500, `Sam at the window: ${atWindow.status}`);
  app.store.profiles.switch({ profileId: null });
  assert.equal(await read(), true, "none of them let it go");
  const released = await call("POST", "/api/safety-extras/stop/release", { confirmLoosening: true });
  assert.equal(released.status, 200, JSON.stringify(released.body));
  assert.equal(await read(), false, "the owner's yes let it go");
});
