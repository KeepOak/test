/**
 * Redesign phase 2 (accounts, critiques #21, #60, #61): Settings › Accounts, the marks on Secrets and
 * on the chat apps. Opened the way a person opens them, headless; the connections are stand-ins and
 * no key is ever used, so nothing reaches a provider.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { openSettings } from "./places.mjs"; // the old window's helper, for the skipped bodies only

const answer = async () => ({ content: "ok", toolCalls: [] });

async function fixture(t, width = 1440) {
  const scratch = join(tmpdir(), "branch-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "accounts-page-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const owner = app.runtime.owner;
  app.store.save("settings", owner, "model-connections", { connections: [
    { id: "openai-work", name: "OpenAI", catalogId: "openai", model: "gpt-5.5", extras: {} },
    { id: "anthropic-home", name: "Anthropic", catalogId: "anthropic", model: "claude-sonnet-4-5", extras: {} },
  ] });
  app.runtime.models.register({ id: "openai-work", name: "OpenAI", model: "gpt-5.5", catalogId: "openai", provider: { name: "openai-compatible", complete: answer } });
  app.runtime.models.register({ id: "anthropic-home", name: "Anthropic", model: "claude-sonnet-4-5", catalogId: "anthropic", provider: { name: "anthropic", complete: answer } });
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, async () => ({ code: 0, stdout: "{}", stderr: "" }));
  app.runtime.models.configure(owner, { activePreset: "openai-work", fallbackOrder: ["anthropic-home"] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) }); // the first-run card (#323) is not what this is about
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then(async (response) => ({ status: response.status, body: await response.json().catch(() => ({})) }));
  const page = await browser.newPage({ viewport: { width, height: 950 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async () => {
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  };
  return { app, call, page, errors, open };
}
async function withAccounts(call) {
  await call("/api/accounts/settings", { mode: "on" });
  for (let i = 1; i <= 6; i++) await call("/api/accounts/add", { pool: "openai-work", label: `Key ${i}`, key: `sk-sample-00000000000${i}` });
  const added = (await call("/api/accounts/add", { pool: "cli-claude-code", label: "Work plan" })).body;
  return added.accounts.find((account) => account.label === "Work plan");
}

/* Redesign: the new window (public/app/**). Settings › Accounts (settings/pages/accounts.js) is one list of the
   engine's accounts in the order it uses them, each row naming its service; "Add an account" is the prototype's wizard
   (flows/account.js), whose last step says which Trunks use the new account. */
async function openSettingsPage(page, id) {
  const gear = page.locator('#side [data-act="view"][data-v="settings"]');
  if (await page.evaluate(() => innerWidth <= 760)) await page.locator('[data-act="side"]').filter({ visible: true }).first().click();
  await gear.click();
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).click();
  await page.locator(`[data-act="setpage"][data-v="${id}"][aria-current="true"]`).waitFor();
}
const accountRow = (page, label) => page.locator(".set-col .prow").filter({ has: page.locator("b", { hasText: new RegExp(`^${label}$`) }) });

test("A1 Accounts is its own page after Models, with service names on every account", async (t) => {
  const { call, page, errors, open } = await fixture(t);
  await withAccounts(call);
  await open();
  await openSettingsPage(page, "accounts");
  await accountRow(page, "Key 6").waitFor({ timeout: 30000 });
  assert.match(await accountRow(page, "Key 1").innerText(), /OpenAI/);
  assert.match(await accountRow(page, "Work plan").innerText(), /Claude/);
  // The prototype's words for the same promise: nobody's allowance is spread across other people.
  assert.match(await page.locator(".set-col").innerText(), /No account’s allowance is shared with another person/);
  assert.equal(await page.locator(".set-col .prow").count() >= 8, true);
  // Redesign: replaced by the new window (prototype.html's Settings › Accounts has no "Search accounts" box and no
  // per-service terms links; its list is one order with "used next", Move up and the account menu).
  const links = await page.locator('[data-act="setpage"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.v));
  assert.equal(links[links.indexOf("models") + 1], "accounts", "Accounts comes right after Models, as in prototype.html");
  assert.deepEqual(errors, []);
});

test("A2 a new key can be given to a Trunk, saved on the Trunk, and a sign-in never is", async (t) => {
  const { app, call, page, errors, open } = await fixture(t);
  await withAccounts(call);
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const trunk = (await call("/api/trunks", { name: "Scout" })).body.trunk;
  await open();
  await openSettingsPage(page, "accounts");
  await page.locator('[data-act="addacct"][data-v="openai-work"]').click();
  await page.getByLabel("Key", { exact: true }).fill("test-key-not-real-sample-0000");
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  await page.locator(`.dlg [data-act="aa-tr"][data-v="${trunk.id}"]`).click();
  await page.locator(`.dlg [data-act="aa-tr"][data-v="${trunk.id}"][aria-pressed="true"]`).waitFor();
  await page.getByLabel("Call it", { exact: true }).fill("Scout key");
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await page.locator(".dlg").waitFor({ state: "detached", timeout: 30000 });
  const scoutKey = (await call("/api/accounts")).body.pools.find((pool) => pool.pool === "openai-work").accounts.find((account) => account.label === "Scout key");
  assert.ok(scoutKey, "the engine kept the new key");
  assert.equal(app.trunks.records.get(trunk.id).keys.accounts["openai-work"], scoutKey.id);
  assert.equal((await page.content()).includes("test-key-not-real-sample-0000"), false, "the key is never on the page");
  // A sign-in account is never used for a Trunk (src/trunks/accounts.ts), so it is never saved as one's pick.
  await page.locator('[data-act="addacct"][data-v="cli-claude-code"]').click();
  // For a sign-in, the Trunk chip is drawn disabled on purpose (#326): it cannot be picked at all.
  assert.equal(await page.locator(`.dlg [data-act="aa-tr"][data-v="${trunk.id}"]`).isDisabled(), true, "a sign-in's Trunk chip is disabled");
  await page.getByLabel("Call it", { exact: true }).fill("Partner plan");
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  // accounts-wizard-plans: an extra program account then shows the engine's line that signs it in to its own folder.
  await page.locator(".dlg .sigline14").waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.locator(".dlg").waitFor({ state: "detached", timeout: 30000 });
  assert.equal(app.trunks.records.get(trunk.id).keys.accounts["cli-claude-code"], undefined, "a sign-in is never a Trunk's key");
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (toast: the account menu's "Which Trunks use it"), checked at e5b8a610.
test.skip("A2 a Trunk's key is put back to the default", async (t) => {
  const { app, call, page, errors, open } = await fixture(t);
  await withAccounts(call);
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const trunk = (await call("/api/trunks", { name: "Scout" })).body.trunk;
  await open();
  await page.locator("#accounts-trunks-card .accounts-trunk").waitFor({ state: "attached", timeout: 30000 });
  await openSettings(page, "accounts");
  const row = page.locator(`#accounts-trunks-card .accounts-trunk[data-trunk="${trunk.id}"]`);
  assert.deepEqual(await row.locator("label").allInnerTexts(), ["Key for OpenAI", "Key for Anthropic"], "API key connections only; a sign-in never is");
  const pick = row.getByLabel("Key for OpenAI");
  const key3 = (await call("/api/accounts")).body.pools.find((pool) => pool.pool === "openai-work").accounts.find((account) => account.label === "Key 3");
  await pick.selectOption(key3.id);
  await page.waitForFunction(() => /Saved\. The Trunk uses it/.test(document.querySelector("#accounts-card [role=status]")?.textContent ?? ""));
  assert.equal(app.trunks.records.get(trunk.id).keys.accounts["openai-work"], key3.id);
  await page.locator(`#accounts-trunks-card .accounts-trunk[data-trunk="${trunk.id}"]`).getByLabel("Key for OpenAI").selectOption("");
  await page.waitForFunction((id) => document.querySelector(`.accounts-trunk[data-trunk="${id}"] select`)?.value === "", trunk.id);
  await page.waitForTimeout(300);
  assert.equal(app.trunks.records.get(trunk.id).keys.accounts["openai-work"], undefined, "the default key again");
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (sw:ac-next, sw:ac-fall: the prototype's "When one runs out" in place of the fallback list),
// checked at e5b8a610.
test.skip("A3 when one runs low: the fallback order and the way to change it", async (t) => {
  const { call, page, errors, open } = await fixture(t);
  await withAccounts(call);
  await open();
  await page.locator("#accounts-low-card .accounts-fallback li").first().waitFor({ state: "attached", timeout: 30000 });
  await openSettings(page, "accounts");
  const item = page.locator("#accounts-low-card .accounts-fallback li").first();
  assert.match(await item.innerText(), /Anthropic · claude-sonnet-4-5/);
  await page.locator("#accounts-low-card").getByRole("button", { name: "Change the fallback order" }).click();
  await page.locator("#lx-page-models").waitFor({ state: "visible" });
  assert.deepEqual(errors, []);
});

test("A3 when one runs out: the switches are in place, greyed out until the engine keeps them", async (t) => {
  const { call, page, errors, open } = await fixture(t);
  await withAccounts(call);
  await open();
  await openSettingsPage(page, "accounts");
  for (const id of ["ac-next", "ac-fall"]) {
    const box = page.locator(`#${id}`);
    assert.equal(await box.getAttribute("aria-disabled"), "true", `${id} is Coming soon`);
    assert.equal(await box.isDisabled(), true);
  }
  assert.deepEqual(errors, []);
});

test("A4 at 390 px the page fits and every account stays in sight", async (t) => {
  const { call, page, errors, open } = await fixture(t, 390);
  await withAccounts(call);
  await open();
  await openSettingsPage(page, "accounts");
  const plan = accountRow(page, "Work plan");
  await plan.scrollIntoViewIfNeeded();
  assert.equal(await plan.isVisible(), true);
  // Redesign: replaced by the new window (no "Kept separate" box in prototype.html's Settings › Accounts).
  const wide = await page.evaluate(() => [document.documentElement, document.querySelector(".set-page")].some((node) => node && node.scrollWidth > node.clientWidth + 1));
  assert.equal(wide, false, "nothing scrolls sideways");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (prototype.html's Settings › Saved sign-ins is Bitwarden's sign-ins; the named
// command secrets and their plain names are not in the design).
test.skip("A5 Secrets show plain names", async (t) => {
  const { call, page, errors, open } = await fixture(t);
  for (const name of ["OPENAI_API_KEY", "SLACK_BOT_TOKEN", "SUPPLIER_API_KEY"]) await call("/api/secrets", { project: "default", name, value: "sample-value-123" });
  await open();
  await openSettings(page, "secrets");
  const openai = page.locator("#secrets-list .secret-row", { hasText: "OPENAI_API_KEY" });
  await openai.waitFor({ timeout: 20000 });
  assert.equal(await openai.locator("strong").innerText(), "OpenAI key");
  assert.match(await openai.innerText(), /Commands use it as OPENAI_API_KEY/);
  const slack = page.locator("#secrets-list .secret-row", { hasText: "SLACK_BOT_TOKEN" });
  assert.ok(await slack.isVisible(), "Slack secret is shown");
  assert.equal(await page.locator("#secrets-list .secret-row", { hasText: "SUPPLIER_API_KEY" }).locator("strong").innerText(), "Supplier API key");
  assert.deepEqual(errors, []);
});

test("A5 chat apps show plain names, and a saved secret's value is never on the page", async (t) => {
  const { call, page, errors, open } = await fixture(t);
  for (const name of ["OPENAI_API_KEY", "SLACK_BOT_TOKEN", "SUPPLIER_API_KEY"]) await call("/api/secrets", { project: "default", name, value: "sample-value-123" });
  await open();
  await openSettingsPage(page, "secrets");
  assert.equal((await page.content()).includes("sample-value-123"), false, "a secret's value is never shown");
  await page.locator(".set-nav .set-back").click();
  await page.locator('#side [data-act="view"][data-v="customize"]').click();
  await page.locator('[data-act="ptab"][data-place="customize"][data-v="channels"]').first().click();
  // No brand marks shown; just service names
  const mattermost = page.locator('[data-act="ch-open"]', { hasText: "Mattermost" });
  await mattermost.waitFor({ timeout: 20000 });
  assert.ok(await mattermost.isVisible(), "Mattermost is shown by name");
  assert.ok(await page.locator('[data-act="ch-open"]', { hasText: "Microsoft Teams" }).first().isVisible(), "Microsoft Teams is shown");
  assert.equal((await page.content()).includes("sample-value-123"), false, "a secret's value is never shown");
  assert.deepEqual(errors, []);
});

// Integration review: someone on a household profile with nothing shared is shown none of the owner's
// accounts and no control they cannot use, and the page asks for nothing else of the owner's.
test("A6 a household person with nothing shared sees no owner accounts and no control they cannot use", async (t) => {
  const { call, page, errors, open } = await fixture(t);
  await call("/api/accounts/settings", { mode: "on" }); // no list saved, so nothing can be shared with Sam
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  await call("/api/trunks", { name: "Scout" });
  const sam = (await call("/api/profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call("/api/profiles/switch", { profileId: sam.id, pin: "2468" })).status, 200);
  await open();
  const asked = [];
  await openSettingsPage(page, "gateway");
  page.on("request", (request) => asked.push(new URL(request.url()).pathname));
  await page.locator('[data-act="setpage"][data-v="accounts"]').click();
  await page.locator(".set-col h1", { hasText: "Accounts" }).waitFor();
  await page.waitForTimeout(3500); // past one of the window's refreshes, which redraws the list
  assert.equal(await page.locator(".set-col .prow").count(), 0, "nothing is shared with Sam");
  // /api/profiles is the window noticing a profile switch every 2 s (#326), not the owner's data. GET /api/lock is the
  // App lock watcher (shell/applock.js watchLock) asking every 2 s whether this computer's window is locked: the
  // device's lock state, not the owner's records. Only that exact path is let through, never /api/lockdown or /api/lock/*.
  assert.deepEqual(asked.filter((path) => path.startsWith("/api/") && path !== "/api/lock" && !/^\/api\/(accounts|state|activity|events|profiles)/.test(path)), [],
    "opening the page asks for nothing but the accounts (no Trunks)");
  assert.equal(await page.locator('.set-col [data-act="addacct"]:not([aria-disabled="true"])').count(), 0,
    "adding an account is the owner's: the engine refuses it for Sam");
  assert.deepEqual(errors, []);
});
