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
import { accountsServiceFor } from "../dist/accounts/service.js";
import { openSettings } from "./places.mjs"; // the old window's helper, for the skipped bodies only

const answer = async () => ({ content: "ok", toolCalls: [] });

async function fixture(t, width = 1440) {
  const scratch = join(tmpdir(), "branch-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "accounts-page-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  accountsServiceFor(app.runtime.models).deps.statusRun = async () => ({ code: 0, missing: false });
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
  // Account pools (owner decision 2026-09-27): "Move to the next account" is each list's own switch, on as it ships,
  // with the strategy beside it and the owner's plain words on what switching means.
  const next = page.locator("#ac-next");
  assert.equal(await next.isChecked(), true, "Move to the next account ships on");
  assert.equal(await next.isDisabled(), false);
  assert.equal(await page.locator('[data-act="ac-strategy"][data-v="priority"]').getAttribute("aria-pressed"), "true", "fill first by default");
  assert.match(await page.locator(".set-col").innerText(), /Switching doesn't merge plans/);
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
  // trunks-use-subscriptions: a sign-in answers a Trunk's own work (src/accounts/trunk-guard.ts), so it is picked like a key.
  await page.locator('[data-act="addacct"][data-v="cli-claude-code"]').click();
  await page.locator(`.dlg [data-act="aa-tr"][data-v="${trunk.id}"]`).click();
  await page.locator(`.dlg [data-act="aa-tr"][data-v="${trunk.id}"][aria-pressed="true"]`).waitFor();
  await page.getByLabel("Call it", { exact: true }).fill("Partner plan");
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  // accounts-wizard-plans: an extra program account then shows the engine's line that signs it in to its own folder.
  await page.locator(".dlg .sigline14").waitFor({ timeout: 30000 });
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.locator(".dlg").waitFor({ state: "detached", timeout: 30000 });
  const partner = (await call("/api/accounts")).body.pools.find((pool) => pool.pool === "cli-claude-code").accounts.find((account) => account.label === "Partner plan");
  assert.equal(app.trunks.records.get(trunk.id).keys.accounts["cli-claude-code"], partner.id, "the sign-in is the Trunk's pick");
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

/* Batch D: "Fall back to this computer" is the engine's fallback order (tests/settings-batch-d.test.mjs D2); with no model
   on this computer, as here, it is greyed with that reason. "Move to the next account" is live here (A1). */
test("A3 when one runs out: the switches are in place, each greyed with its reason while it cannot act", async (t) => {
  const { call, page, errors, open } = await fixture(t);
  await withAccounts(call);
  await open();
  await openSettingsPage(page, "accounts");
  for (const box of [page.locator('.set-col input.sw[data-why="ac-fall"]')]) {
    assert.equal(await box.getAttribute("aria-disabled"), "true");
    assert.equal(await box.isDisabled(), true);
    assert.ok(await box.locator("xpath=ancestor::div[contains(@class,'ctl')]").getAttribute("data-why-text"), "its reason is under its row");
  }
  assert.deepEqual(errors, []);
});

test("A4 at 390 px the page fits and every account stays in sight", async (t) => {
  const { call, page, errors, open } = await fixture(t, 390);
  await withAccounts(call);
  await open();
  await openSettingsPage(page, "accounts");
  const plan = accountRow(page, "Work plan");
  // Metadata can redraw the page during Playwright's element-stability wait. Resolve and
  // scroll the current row in one browser turn, then wait for actual visible geometry.
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll(".set-col .prow")].find((node) =>
      [...node.querySelectorAll("b")].some((label) => label.textContent === "Work plan"));
    if (!row?.isConnected) return false;
    row.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const rect = row.getBoundingClientRect();
    return row.isConnected && rect.width > 0 && rect.height > 0 &&
      rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
  }, null, { timeout: 30000 });
  assert.equal(await plan.isVisible(), true);
  // Redesign: replaced by the new window (no "Kept separate" box in prototype.html's Settings › Accounts).
  const wide = await page.evaluate(() => [document.documentElement, document.querySelector(".set-page")].some((node) => node && node.scrollWidth > node.clientWidth + 1));
  assert.equal(wide, false, "nothing scrolls sideways");
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
  // GET /api/delight is the window's background and pet (shell/scene.js) read again after a refresh; the engine answers a
  // household person with nothing from it (src/delight.ts), which is checked below. Only that exact path, never /api/delight/*.
  const shell = new Set(["/api/lock", "/api/delight"]);
  assert.deepEqual(asked.filter((path) => path.startsWith("/api/") && !shell.has(path) && !/^\/api\/(accounts|state|activity|events|profiles)/.test(path)), [],
    "opening the page asks for nothing but the accounts (no Trunks)");
  assert.deepEqual((await call("/api/delight")).body, { available: false }, "the pet and background read tells Sam nothing of the owner's");
  assert.equal(await page.locator('.set-col [data-act="addacct"]:not([aria-disabled="true"])').count(), 0,
    "adding an account is the owner's: the engine refuses it for Sam");
  assert.deepEqual(errors, []);
});
