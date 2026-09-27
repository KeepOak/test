/**
 * usagefix: one ChatGPT account is one connection. Signing in again as an account Branch already has merges it into
 * that one, and a list that already holds the same account twice is merged at start. Every token here is a stand-in
 * made in the test; nothing reaches OpenAI.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { ChatGPTAuth } from "../dist/chatgpt-auth.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { LockerTokenVault } from "../dist/accounts/chatgpt-accounts.js";
import { mergeChatGPTDuplicates, sameChatGPTAccount } from "../dist/accounts/dedupe.js";
import { saveAccountsSettings, saveSessionChoice, sessionChoice } from "../dist/accounts/settings.js";
import { viewAll } from "../dist/accounts/manage.js";
import { TrunkRecords } from "../dist/trunks/record.js";

const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${part({ alg: "none" })}.${part(claims)}.sig`;
/** Stand-in tokens that say who signed in, the way OpenAI's do: the account id in the access token, the email in the ID token. */
const tokensFor = (accountId, email, refresh) => ({
  accessToken: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
  refreshToken: refresh, idToken: jwt({ email }), expiresAt: "2099-01-01T00:00:00.000Z",
});
function memoryVault(tokens = null) {
  const vault = { tokens, read: async () => vault.tokens, write: async (next) => { vault.tokens = next; }, clear: async () => { vault.tokens = null; } };
  return vault;
}
const account = (id, label) => ({ id, label, pinned: false, disabled: false, monthlyCapUsd: null, shared: false, createdAt: "2026-09-20T00:00:00.000Z" });
const TWIN = "abcdef12", COLLEAGUE = "12345678";

async function fixture(t, { dataDir, primary } = {}) {
  const root = dataDir ? null : await mkdtemp(join(tmpdir(), "branch-dedupe-"));
  const vault = primary ?? memoryVault(tokensFor("acct-1", "Owner@Example.com", "first-refresh"));
  const app = await createBranch({ workspace: join(dataDir ?? root, "..", "ws"), dataDir: dataDir ?? join(root, "data"), chatgpt: new ChatGPTAuth(vault) });
  t.after(async () => { await app.close(); if (root) await discardTemp(root); });
  return { app, vault, service: accountsServiceFor(app.runtime.models), owner: app.runtime.owner, root };
}
/** The owner's list as the report found it: the first sign-in, the same account signed in again, and a colleague in the same workspace. */
async function doubledList(app, owner) {
  saveAccountsSettings(app.store, owner, { mode: "when-needed", poolingRule: 1, poolingNotices: [], pools: [{
    pool: "chatgpt", kind: "chatgpt", strategy: "priority", autoSwitch: false, defaultAccount: TWIN,
    accounts: [account("primary", "First sign-in"), account(TWIN, "ChatGPT again"), account(COLLEAGUE, "Colleague")] }] });
  await new LockerTokenVault(app.store.locker, owner, TWIN).write(tokensFor("acct-1", "owner@example.com", "twin-refresh"));
  await new LockerTokenVault(app.store.locker, owner, COLLEAGUE).write(tokensFor("acct-1", "colleague@example.com", "colleague-refresh"));
}

test("D1 same account id and same email is one account; a shared workspace id alone, or a missing value, is not", () => {
  const owner = { accountId: "acct-1", email: "Owner@Example.com" };
  assert.equal(sameChatGPTAccount(owner, { accountId: "acct-1", email: "owner@example.com " }), true);
  assert.equal(sameChatGPTAccount(owner, { accountId: "acct-1", email: "colleague@example.com" }), false, "a work workspace shares its id");
  assert.equal(sameChatGPTAccount(owner, { accountId: "acct-2", email: "owner@example.com" }), false, "another plan of the same person");
  assert.equal(sameChatGPTAccount(owner, { accountId: "acct-1", email: null }), false);
  assert.equal(sameChatGPTAccount({ accountId: null, email: "a@b.c" }, { accountId: null, email: "a@b.c" }), false);
});

test("D2 a doubled list is merged into the first sign-in: choices follow it, the record is kept, a second run changes nothing", async (t) => {
  const { app, service, owner } = await fixture(t);
  await doubledList(app, owner);
  const session = app.store.createSession(owner);
  saveSessionChoice(app.store, owner, session, "chatgpt", TWIN);
  const trunk = app.trunks.create({ name: "Ed" });
  app.trunks.edit(trunk.id, { keys: { copyFromOwner: false, accounts: { chatgpt: TWIN } } });
  service.planWindows.record("chatgpt", "primary", [{ id: "primary", usedPercent: 10, minutes: 300, resetAt: null, measuredAt: "2026-09-27T01:00:00.000Z" }]);
  service.planWindows.record("chatgpt", TWIN, [{ id: "primary", usedPercent: 99, minutes: 300, resetAt: null, measuredAt: "2026-09-27T09:00:00.000Z" }]);

  const merges = await mergeChatGPTDuplicates(service);
  assert.deepEqual(merges, [{ from: TWIN, into: "primary", label: "ChatGPT again" }]);
  const pool = service.pool("chatgpt");
  assert.deepEqual(pool.accounts.map((a) => a.id), ["primary", COLLEAGUE], "the colleague in the same workspace stays");
  assert.equal(pool.defaultAccount, "primary", "used next follows the merge");
  assert.equal(sessionChoice(app.store, owner, session).chatgpt, "primary");
  assert.equal(new TrunkRecords(app.store, owner).find(trunk.id).keys.accounts.chatgpt, "primary");
  assert.equal(service.planWindows.get("chatgpt", "primary")[0].usedPercent, 99, "the newer reading is carried over");
  assert.equal(await new LockerTokenVault(app.store.locker, owner, TWIN).read(), null, "the second copy of the sign-in is taken out");
  assert.ok(await new LockerTokenVault(app.store.locker, owner, COLLEAGUE).read());
  const entry = app.store.audit.list(owner, {}).find((row) => row.outcome === "merged");
  assert.ok(entry, "the merge is written down");
  assert.match(entry.reason, /"id":"abcdef12".*"label":"ChatGPT again"/);
  assert.ok(!/refresh|eyJ/.test(entry.reason), "no token in the record");
  assert.deepEqual((await viewAll(service)).pools.find((p) => p.pool === "chatgpt").mergedInto, { [TWIN]: "primary" }, "a window waiting on it learns where it went");

  const before = JSON.stringify(service.settings());
  assert.deepEqual(await mergeChatGPTDuplicates(service), []);
  assert.equal(JSON.stringify(service.settings()), before);
});

test("D3 when the kept first sign-in no longer works, it keeps the working copy's credentials", async (t) => {
  const { app, service, owner, vault } = await fixture(t);
  await doubledList(app, owner);
  service.deps.chatgpt.lastError = "ChatGPT sign-in could not refresh"; // its last refresh failed; its tokens are still there
  await mergeChatGPTDuplicates(service);
  assert.equal(vault.tokens.refreshToken, "twin-refresh", "the working credentials were kept");
  assert.equal((await service.deps.chatgpt.status()).lastError, null);
  assert.deepEqual(service.pool("chatgpt").accounts.map((a) => a.id), ["primary", COLLEAGUE]);
});

test("D4 a doubled list saved by an older build is merged when Branch starts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-dedupe-start-"));
  const dataDir = join(root, "data");
  const first = await fixture({ after: () => undefined }, { dataDir });
  await doubledList(first.app, first.owner);
  await first.app.close();
  const again = await fixture(t, { dataDir, primary: first.vault });
  t.after(() => discardTemp(root)); // after the engine above has closed
  assert.deepEqual(again.service.pool("chatgpt").accounts.map((a) => a.id), ["primary", COLLEAGUE]);
  // Account pools (rev476): the merge runs before the lists are put in front of the connections, so the rotation only
  // ever sees the two real accounts; the merged-away twin is never a second account to move to.
  assert.deepEqual(again.service.usablePool("chatgpt").accounts.map((a) => a.id), ["primary", COLLEAGUE]);
  assert.equal(again.service.pool("chatgpt").autoSwitch, true, "rule version 2 turned moving on back on");
});

/* A stand-in for OpenAI's device sign-in: the code, an approval at once, and tokens for the given account. */
function deviceSignIn(tokens) {
  const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  return async (url) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/deviceauth/usercode")) return json({ user_code: "ABCD-1234", device_auth_id: "device-1", interval: 1 });
    if (path.endsWith("/deviceauth/token")) return json({ authorization_code: "code", code_verifier: "verifier" });
    if (path.endsWith("/oauth/token")) return json({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken, id_token: tokens.idToken, expires_in: 3600 });
    return new Response("not here", { status: 404 });
  };
}
const until = async (what, done) => {
  for (let i = 0; i < 200; i++) { const value = await done(); if (value) return value; await new Promise((resolve) => setImmediate(resolve)); }
  throw new Error(`timed out waiting for ${what}`);
};

test("D5 an extra account that signs in as the account Branch already has updates that one; no second is kept", async (t) => {
  const { app, service, owner, vault } = await fixture(t);
  const { addAccount } = await import("../dist/accounts/manage.js");
  const { accountsApi } = await import("../dist/accounts/api.js");
  const added = await addAccount(service, { pool: "chatgpt", label: "ChatGPT again" });
  const id = added.accounts.find((a) => a.label === "ChatGPT again").id;
  // The browser was signed in as the owner already, so the device page approves the same account.
  service.chatgptAccounts.auths.set(id, new ChatGPTAuth(new LockerTokenVault(app.store.locker, owner, id),
    { fetch: deviceSignIn(tokensFor("acct-1", "owner@example.com", "fresh-refresh")), sleep: async () => undefined }));
  const answer = await accountsApi({ method: "POST", url: "/api/accounts/chatgpt/login" }, "/api/accounts/chatgpt/login",
    { service, readBody: async () => ({ account: id }), requireOwner: () => undefined });
  assert.equal(answer.userCode, "ABCD-1234");
  const pool = await until("the merge", async () => (await viewAll(service)).pools.find((p) => p.pool === "chatgpt" && p.mergedInto?.[id]));
  assert.equal(pool.mergedInto[id], "primary");
  assert.deepEqual(pool.accounts.map((a) => a.id), ["primary"], "one ChatGPT row, not two");
  assert.equal(vault.tokens.refreshToken, "fresh-refresh", "the existing connection now holds the new sign-in's credentials");
  assert.equal(await new LockerTokenVault(app.store.locker, owner, id).read(), null);
});

test("D6 the first sign-in, made again as an account already in the list, takes that one's place", async (t) => {
  const { app, owner, root } = await fixture(t, { primary: memoryVault(null) });
  const { startServer } = await import("../dist/server.js");
  await doubledList(app, owner); // the list holds the owner's account as an extra, and the first sign-in is signed out
  app.chatgpt.fetch = deviceSignIn(tokensFor("acct-1", "owner@example.com", "first-again"));
  app.chatgpt.sleep = async () => undefined;
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const response = await fetch(`${server.url}/api/chatgpt/login`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 200);
  const service = accountsServiceFor(app.runtime.models);
  await until("the merge", () => service.mergedInto.get(TWIN) === "primary");
  assert.deepEqual(service.pool("chatgpt").accounts.map((a) => a.id), ["primary", COLLEAGUE]);
  assert.equal((await app.chatgpt.status()).email, "owner@example.com");
});
