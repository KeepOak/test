/* UP-UI-059: switching an account on in setup says hello through exactly that account, never another in its pool, and a
   switched-off account is refused. A stand-in provider and a fake fetch answer; nothing reaches a provider. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { addAccount, setMode, updateAccount } from "../dist/accounts/manage.js";
import { startServer } from "../dist/server.js";
import { chromium } from "playwright";

const POOL = "openai-test";
const SECOND_KEY = "sk-second-key-value-000000"; // not-a-real-secret

test("the setup hello goes through the chosen account only, and a switched-off account is refused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-account-hello-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const service = accountsServiceFor(app.runtime.models), owner = app.runtime.owner;
  delete service.deps.policy; // the stand-in fetch below is the whole network
  app.store.save("settings", owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI test", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  const calls = { first: 0, second: 0 };
  app.runtime.models.register({ id: POOL, name: "OpenAI test", model: "gpt-4o-mini", catalogId: "openai",
    provider: { name: "openai-chat", complete: async () => { calls.first++; return { content: "from the first key", toolCalls: [] }; } } });
  app.runtime.models.configure(owner, { activePreset: POOL });
  service.deps.fetchImpl = async (_url, init) => {
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${SECOND_KEY}`);
    calls.second++;
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  setMode(service, { mode: "on" });
  const second = (await addAccount(service, { pool: POOL, label: "Second", key: SECOND_KEY })).accounts.find((a) => a.label === "Second").id;
  let guarded = 0;
  const hello = await service.hello(POOL, second, () => { guarded++; });
  assert.deepEqual([hello.ok, hello.account, hello.accountLabel, hello.model, hello.reply], [true, second, "Second", "gpt-4o-mini", "OK"]);
  assert.deepEqual(calls, { first: 0, second: 1 }, "only the chosen account was asked");
  assert.ok(guarded >= 3, "the owner check is asked again across every wait");
  await updateAccount(service, { pool: POOL, account: second, disabled: true });
  await assert.rejects(service.hello(POOL, second, () => {}), /not available|disabled/);
  assert.equal(calls.second, 1);
});

/* Review 5914162541 P1: the provider's answer is this account's cost even when the hello is then refused, and spend that
   reaches the cap while the connection is built stops the hello before it is sent. */
test("the setup hello records what the provider answered before refusing it, and rechecks the cap after the wait", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-account-hello-usage-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const service = accountsServiceFor(app.runtime.models), owner = app.runtime.owner;
  delete service.deps.policy;
  app.store.save("settings", owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI test", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  app.runtime.models.register({ id: POOL, name: "OpenAI test", model: "gpt-4o-mini", catalogId: "openai",
    provider: { name: "openai-chat", complete: async () => ({ content: "unused", toolCalls: [] }) } });
  app.runtime.models.configure(owner, { activePreset: POOL });
  let sent = 0, reply = "";
  service.deps.fetchImpl = async () => {
    sent++;
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  setMode(service, { mode: "on" });
  const second = (await addAccount(service, { pool: POOL, label: "Second", key: SECOND_KEY })).accounts.find((a) => a.label === "Second").id;
  const used = () => service.ledger.month(owner, POOL, second).input;
  await assert.rejects(service.hello(POOL, second, () => {}), /no greeting/, "an empty answer is refused");
  assert.equal(used(), 5, "and its usage is still the account's");
  reply = "OK";
  let calls = 0;
  await assert.rejects(service.hello(POOL, second, () => { if (++calls === 3) throw new Error("The owner changed."); }), /owner changed/);
  assert.equal(used(), 10, "a refusal after the answer keeps the usage");
  assert.equal(sent, 2);
  await updateAccount(service, { pool: POOL, account: second, monthlyCapUsd: 1 });
  calls = 0;
  await assert.rejects(service.hello(POOL, second, () => {
    if (++calls === 2) service.ledger.record(owner, POOL, second, { input: 0, output: 0, costUsd: 2 });
  }), /spending cap/, "spend that reached the cap while the connection was built");
  assert.equal(sent, 2, "nothing was sent past the cap");
});

/* Review 5914162541 P2: a ChatGPT sign-in that finishes while the account list is still being read must not take over
   after Back: the flow it belonged to has ended, so no step 3 is drawn and no hello is asked for. A headless window; the
   sign-in answers are stand-ins and nothing reaches OpenAI. */
test("a sign-in finishing after Back leaves the dialog where the owner is and asks for no hello", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-account-hello-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  app.store.save("settings", app.runtime.owner, "onboarding", { done: true });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/accounts/sign-ins", async (route) => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: { ...body, chatgpt: { available: true, signedIn: false, pending: false, lastError: null } } });
  });
  await page.route("**/api/chatgpt/login", (route) => route.fulfill({ json: { signedIn: true } }));
  let hold = false, release, held;
  const gate = new Promise((resolve) => { release = resolve; });
  const reached = new Promise((resolve) => { held = resolve; });
  await page.route("**/api/accounts", async (route) => {
    if (hold && route.request().method() === "GET") { hold = false; held(); await gate; }
    await route.continue();
  });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.evaluate(() => { window.connectedEvents = 0; document.addEventListener("model-account-connected", () => { window.connectedEvents++; }); });
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator('[data-act="setpage"][data-v="accounts"]').click();
  const addAccount = page.getByRole("button", { name: "Add an account", exact: true });
  // Control: the same sign-in left alone finishes on step 3 and asks for one hello.
  await addAccount.click();
  await page.locator('.dlg [data-act="aa-plan"][data-v="chatgpt"]').click();
  await page.locator('.dlg [data-act="aa-dev"]').click();
  await page.locator('.dlg [data-act="aa-fin"]').waitFor({ timeout: 20000 });
  await page.waitForFunction(() => window.connectedEvents === 1);
  await page.locator('.dlg [data-act="aa-fin"]').click();
  await page.locator(".dlg").waitFor({ state: "detached", timeout: 20000 });
  await page.evaluate(() => { window.connectedEvents = 0; });
  await addAccount.click();
  await page.locator('.dlg [data-act="aa-plan"][data-v="chatgpt"]').click();
  hold = true;
  await page.locator('.dlg [data-act="aa-dev"]').click();
  await reached; // signed in; the list is being read
  await page.locator('.dlg [data-act="aa-back"]').click();
  await page.locator('.dlg [data-act="aa-plan"][data-v="chatgpt"]').waitFor();
  const read = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/accounts");
  release();
  await read;
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => window.connectedEvents), 0, "no hello for a flow that was left");
  assert.ok(await page.locator('.dlg [data-act="aa-plan"][data-v="chatgpt"]').isVisible(), "the dialog stays on the step the owner went back to");
  assert.deepEqual(errors, []);
});
