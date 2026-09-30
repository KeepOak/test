/** Real engine/API/UI; official status JSON fixtures replace the status subprocess only. No auth files are read. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { saveAccountsSettings } from "../dist/accounts/settings.js";
import { checkProgram } from "../dist/accounts/sign-ins.js";
import { claudeIdentity } from "../dist/accounts/identity.js";
import { viewSession, viewAll } from "../dist/accounts/manage.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { AccountPoolProvider } from "../dist/accounts/pool-provider.js";
import { discardTemp } from "./temp-dir.mjs";

// `claude auth status` is documented JSON; these are fabricated safe identity values, never real credentials.
const official = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "alex@example.test",
  orgId: "org-fixture-alex", orgName: "Alex's workspace", subscriptionType: "max", apiKeySource: "ignored-fixture" };
const secretSentinel = "token-must-never-reach-the-window";
const stamped = "2026-09-27T00:00:00.000Z";
async function fixture(t) {
  const scratch = tmpdir();
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "account-identities-")), bin = join(root, "bin");
  await mkdir(bin);
  for (const name of ["claude", "claude.cmd"]) await writeFile(join(bin, name), "", { mode: 0o755 });
  const priorPath = process.env.PATH;
  process.env.PATH = bin; // onPath sees a fixture file; the executable is never launched.
  t.after(() => { process.env.PATH = priorPath; });
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const service = accountsServiceFor(app.runtime.models), calls = [];
  let mode = "mixed";
  service.deps.statusRun = async (row, args, env) => {
    calls.push({ id: row.id, args, home: env.CLAUDE_CONFIG_DIR ?? null });
    const extra = env.CLAUDE_CONFIG_DIR?.endsWith("abcd1234");
    const signedOut = mode === "out" || mode === "mixed" && extra;
    const payload = signedOut ? { loggedIn: false, email: "stale@example.test" } : { ...official, accessToken: secretSentinel };
    return { code: signedOut ? 1 : 0, missing: false, stdout: JSON.stringify(payload) };
  };
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, async () => ({ code: 0, stdout: "{}", stderr: "" }));
  app.runtime.models.configure(app.runtime.owner, { activePreset: "cli-claude-code" });
  saveAccountsSettings(app.store, app.runtime.owner, { mode: "on", pools: [{ pool: "cli-claude-code", kind: "cli", accounts: [
    { id: "primary", label: "Your usual sign-in", createdAt: stamped },
    { id: "abcd1234", label: "Claude 2", createdAt: stamped },
    { id: "bcd12345", label: "Work plan", createdAt: stamped },
  ] }] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const call = async (path, body) => {
    const res = await fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() };
  };
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  return { app, service, server, call, calls, mode: (value) => { mode = value; } };
}

test("Claude official JSON is reduced to verified identity; false, malformed and oversized status never become signed in", () => {
  assert.deepEqual(claudeIdentity(JSON.stringify({ ...official, accessToken: secretSentinel, name: "Alex" })),
    { signedIn: true, identity: { authMethod: "claude.ai", email: official.email, name: "Alex", organization: official.orgName, organizationId: official.orgId } });
  assert.deepEqual(claudeIdentity('{"loggedIn":false,"email":"stale@example.test"}'), { signedIn: false });
  for (const output of ["", "{}", "null", "[]", '{"loggedIn":"true"}', "x".repeat(32769)]) assert.equal(claudeIdentity(output), null);
  assert.deepEqual(claudeIdentity('{"loggedIn":true,"email":"bad","name":"bad\\nname"}'), { signedIn: true, identity: { authMethod: "unknown" } });
});

test("per-profile status replaces generic labels everywhere and duplicate or signed-out saved entries cannot claim readiness", async (t) => {
  const { app, service, call, calls, mode } = await fixture(t);
  const listed = await call("/api/accounts");
  assert.equal(listed.status, 200);
  const pool = listed.body.pools.find((one) => one.pool === "cli-claude-code");
  const [primary, out, duplicate] = pool.accounts;
  assert.equal(primary.label, official.email);
  assert.equal(primary.ready, true);
  assert.equal(out.ready, false);
  assert.equal(pool.signedIn.abcd1234, false);
  assert.equal(out.identity, undefined, "a signed-out response cannot expose stale identity");
  assert.equal(duplicate.label, official.email);
  assert.equal(duplicate.customLabel, "Work plan");
  assert.equal(duplicate.duplicateOf, "primary");
  assert.equal(duplicate.ready, false);
  assert.equal(pool.accounts.filter((one) => one.ready).length, 1);
  assert.deepEqual(calls.map((one) => one.home), [service.primaryClaudeHome, service.homeOf("cli-claude-code", "abcd1234"), service.homeOf("cli-claude-code", "bcd12345")]);
  assert.ok(calls.every((one) => JSON.stringify(one.args) === '["auth","status"]'));
  const session = app.store.createSession(app.runtime.owner);
  const picker = viewSession(service, session.id);
  assert.equal(picker.label, official.email);
  assert.equal(picker.accounts[2].ready, false);
  const usage = await call("/api/usage/limits");
  assert.equal(usage.body.rows.find((one) => one.account === "primary").accountLabel, official.email);
  assert.equal(usage.body.rows.find((one) => one.account === "abcd1234").inUse, false);
  assert.equal(JSON.stringify([listed.body, picker, usage.body]).includes(secretSentinel), false);
  assert.equal(JSON.stringify([listed.body, picker, usage.body]).includes("apiKeySource"), false);
  assert.equal(JSON.stringify([...service.signIns.values()]).includes(secretSentinel), false);
  assert.equal(calls.length, 3, "all surfaces share one bounded reading per profile");
  mode("out");
  await checkProgram({ service }, { id: "claude-code" }, service.deps.statusRun);
  assert.equal(service.identities.has("cli-claude-code/primary"), false);
  assert.equal(service.presentation("cli-claude-code", service.pool("cli-claude-code").accounts[0], "cli").ready, false);
});

test("Claude identities load without ChatGPT and malformed exit-zero or false JSON are honest unknown/out states", async (t) => {
  const { service } = await fixture(t);
  service.deps.statusRun = async () => ({ code: 0, missing: false, stdout: "{}" });
  const unknown = await checkProgram({ service }, { id: "claude-code" }, service.deps.statusRun);
  assert.equal(unknown.signedIn, null);
  assert.equal(unknown.identity, undefined);
  service.deps.statusRun = async () => ({ code: 0, missing: false, stdout: '{"loggedIn":false,"email":"stale@example.test"}' });
  const out = await checkProgram({ service }, { id: "claude-code" }, service.deps.statusRun);
  assert.equal(out.signedIn, false, "exit zero cannot override the program's explicit signed-out JSON");
  assert.equal(out.identity, undefined);
});

test("API and unrecognized authentication remain signed in without claiming Claude subscription readiness", async (t) => {
  const { service } = await fixture(t);
  for (const method of ["apiKey", "api_key", "oauth_token", "future-method"]) {
    service.deps.statusRun = async () => ({ code: 0, missing: false, stdout: JSON.stringify({ ...official, authMethod: method }) });
    const status = await checkProgram({ service }, { id: "claude-code" });
    assert.equal(status.signedIn, true);
    const shown = service.presentation("cli-claude-code", service.pool("cli-claude-code").accounts[0], "cli");
    assert.notEqual(shown.ready, true);
    assert.equal(shown.label, official.email);
    assert.ok(shown.signInProblem);
  }
});

test("ChatGPT's verified email replaces First sign-in and preserves a custom alias without changing saved settings", async (t) => {
  const { app, service, call } = await fixture(t);
  service.deps.chatgpt = { status: async () => ({ signedIn: true, email: "pat@example.test" }) };
  saveAccountsSettings(app.store, app.runtime.owner, { mode: "on", pools: [{ pool: "chatgpt", kind: "chatgpt", accounts: [
    { id: "primary", label: "Personal account", createdAt: stamped },
  ] }] });
  const result = await call("/api/accounts");
  const account = result.body.pools.find((one) => one.pool === "chatgpt").accounts[0];
  assert.equal(account.label, "pat@example.test");
  assert.equal(account.customLabel, "Personal account");
  assert.equal(service.pool("chatgpt").accounts[0].label, "Personal account");
});

test("switching to a household profile during status reading stops later owner probes and returns no owner identity", async (t) => {
  const { app, service, call } = await fixture(t);
  let resolve, began;
  const first = new Promise((done) => { began = done; });
  const held = new Promise((done) => { resolve = done; });
  let probes = 0;
  service.deps.statusRun = async () => { probes++; began(); await held; return { code: 0, missing: false, stdout: JSON.stringify(official) }; };
  const pending = call("/api/accounts");
  await first;
  const person = app.store.profiles.create({ name: "Household fixture", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  resolve();
  const result = await pending;
  assert.equal(probes, 1);
  assert.equal(JSON.stringify(result.body).includes(official.email), false);
  await call("/api/accounts");
  assert.equal(probes, 1, "a household read never starts an owner status command");
});

test("short-lived read contexts retain generic account metadata and never see or refresh the owner's cached identity", async (t) => {
  const { service, calls } = await fixture(t);
  await service.readIdentities();
  const probes = calls.length;
  const view = await underShortLivedKey(() => viewAll(service));
  assert.equal(JSON.stringify(view).includes(official.email), false);
  assert.equal(JSON.stringify(view).includes(official.orgId), false);
  assert.equal(calls.length, probes);
  assert.equal(service.identities.get("cli-claude-code/primary"), official.email, "the private cache survives without leaking to the caller");
});

test("warm owner identity is discarded if the profile changes during the later ChatGPT sign-in state read", async (t) => {
  const { app, service, call } = await fixture(t);
  service.deps.chatgpt = { status: async () => ({ signedIn: true, email: "owner@example.test" }) };
  saveAccountsSettings(app.store, app.runtime.owner, { mode: "on", pools: [...service.settings().pools,
    { pool: "chatgpt", kind: "chatgpt", accounts: [{ id: "primary", label: "Owner primary", createdAt: stamped },
      { id: "cdef1234", label: "Owner extra", createdAt: stamped }] }] });
  let reads = 0, release, started;
  const began = new Promise((resolve) => { started = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  service.chatgptAccounts.auth = () => ({ status: async () => {
    if (++reads === 2) { started(); await held; }
    return { signedIn: true, email: "extra@example.test", lastError: null };
  } });
  await service.readIdentities();
  reads = 0; // warm cache skips readIdentities; ensureChatGPTPresets is first, signInState is second.
  const pending = call("/api/accounts");
  await began;
  const person = app.store.profiles.create({ name: "Later household fixture", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  release();
  const result = await pending;
  assert.equal(result.status, 200);
  assert.equal(result.body.household, true);
  assert.deepEqual(result.body.pools, []);
  for (const privateValue of [official.email, official.orgId, "owner@example.test", "extra@example.test", "Owner extra", "cdef1234"])
    assert.equal(JSON.stringify(result.body).includes(privateValue), false);
});

test("short-lived calls cannot select cached signed-out or duplicate accounts even though their public identity is redacted", async (t) => {
  const { service, app } = await fixture(t);
  await service.readIdentities();
  const selected = [];
  const provider = new AccountPoolProvider({ name: "unused-original", complete: async () => { throw new Error("unexpected original"); } }, {
    owner: app.runtime.owner, pool: "cli-claude-code", model: "fixture", settings: () => service.usablePool("cli-claude-code"),
    states: new Map(), cursor: { value: 0 }, now: Date.now,
    providerFor: async (id) => ({ name: "fixture", complete: async () => { selected.push(id); return { content: "fixture", toolCalls: [] }; } }),
    capReached: () => false, record: () => undefined, personIsNotOwner: () => false,
    sessionChoice: () => null, rememberChoice: () => undefined,
  });
  for (const refused of ["abcd1234", "bcd12345"]) {
    const settings = service.settings();
    settings.pools[0].defaultAccount = refused;
    saveAccountsSettings(app.store, app.runtime.owner, settings);
    await underShortLivedKey(async () => {
      const pool = service.usablePool("cli-claude-code");
      assert.equal(pool.accounts.find((one) => one.id === refused).disabled, true);
      assert.equal(JSON.stringify(pool).includes(official.email), false);
      await provider.complete({ messages: [{ role: "user", content: "fixture" }], tools: [], signal: new AbortController().signal });
    });
  }
  assert.deepEqual(selected, ["primary", "primary"], "only the confirmed distinct sign-in may answer");
});

test("Accounts and Models show verified email with custom label secondary, count only usable identities and retain Rename", async (t) => {
  const { call, server } = await fixture(t);
  await call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator('#app #side').waitFor();
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator('[data-act="setpage"][data-v="accounts"]').click();
  await page.waitForFunction(() => document.querySelector('.set-col')?.textContent?.includes("alex@example.test"));
  assert.match(await page.locator('.set-col').innerText(), /1 accounts signed in/);
  assert.equal(await page.locator('.set-col .prow b').filter({ hasText: official.email }).count(), 2);
  assert.match(await page.locator('.set-col').innerText(), /Work plan/);
  await page.locator('[data-act="acct-menu"][data-id="bcd12345"]').click();
  await page.locator('[data-act="acct-rename"]').click();
  assert.equal(await page.locator('#acct-name').inputValue(), "Work plan");
  await page.locator('[data-act="dlg-close"]').first().click();
  await page.locator('[data-act="setpage"][data-v="models"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.acct-g')].some((one) => one.textContent.includes("alex@example.test")));
  assert.equal(await page.locator('.acct-g .acct-r b').filter({ hasText: official.email }).count(), 2);
  assert.equal(await page.locator('.acct-g .pill.ok').count(), 1);
});
