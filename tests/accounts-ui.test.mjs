/**
 * mac6/accounts: the Accounts card (Settings › Accounts since redesign phase 2) and the account chip in the
 * title bar, opened the way a person opens them. A headless browser; the connection is a stand-in
 * and the extra key is never used, so nothing reaches a provider.
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
import { openPlace, openSettingFor } from "./places.mjs"; // the old window's helpers, for the skipped bodies only
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { accountsServiceFor } from "../dist/accounts/service.js";

const POOL = "openai-ui";
const KEY = "sk-ui-test-key-000000000"; // not-a-real-secret

/* Redesign: the new window (public/app/**). Settings › Accounts (settings/pages/accounts.js) lists the engine's
   accounts in the order it uses them; "Add an account" is the prototype's wizard (flows/account.js): the key on its own
   step ("Add key" sends it to the engine at once), then the name ("Add account"). The account menu's "Answer first" is
   the pool's default account, the one new work uses. */
async function fixture(t, width = 1440, before = () => undefined) {
  const scratch = join(tmpdir(), "branch-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-accounts-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const owner = app.runtime.owner;
  app.store.save("settings", owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI (work)", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  app.runtime.models.register({ id: POOL, name: "OpenAI (work)", model: "gpt-4o-mini", catalogId: "openai",
    provider: { name: "openai-chat", complete: async () => ({ content: "ok", toolCalls: [] }) } });
  app.runtime.models.configure(owner, { activePreset: POOL });
  before(app, owner);
  app.store.save("settings", app.runtime.owner, "onboarding", { done: true }); // setup opens on the first draw otherwise (flows/flows.js); not what this is about
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then((response) => response.json());
  const page = await browser.newPage({ viewport: { width, height: 1000 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors, app, owner, call };
}

/** Settings (the gear beside the person at the foot of the list; on a narrow window the menu button slides the list
    in first), then its Accounts page. */
async function openAccounts(page) {
  const gear = page.locator('#side [data-act="view"][data-v="settings"]');
  if (await page.evaluate(() => innerWidth <= 760)) await page.locator('[data-act="side"]').filter({ visible: true }).first().click();
  await gear.click();
  await page.locator('[data-act="setpage"][data-v="accounts"]').click();
  await page.locator(".set-col h1", { hasText: "Accounts" }).waitFor();
}
const openCard = openAccounts; // the skipped bodies below still name it

/** The key is nowhere in the window: not in its markup, not left in any field, not in its storage. */
async function keyNowhere(page, key) {
  assert.equal((await page.content()).includes(key), false, "the key is not on the page");
  assert.equal(await page.evaluate((key) => [...document.querySelectorAll("input, textarea")].some((node) => node.value.includes(key)), key), false,
    "no field still holds the key");
  assert.equal((await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }))).includes(key), false,
    "the key is never kept in the window's storage");
}

async function addKey(page, name) {
  await page.getByRole("button", { name: "Add an account", exact: true }).click();
  await page.locator(`.dlg [data-act="aa-prov"][data-v="${POOL}"]`).click();
  await page.getByLabel("Key", { exact: true }).fill(KEY);
  await page.getByRole("button", { name: "Add key", exact: true }).click();
  if (name === undefined) return;
  await page.getByLabel("Call it", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Add account", exact: true }).click();
  await page.locator(".dlg").waitFor({ state: "detached", timeout: 30000 });
}

test("U1 the list lives in Settings › Accounts, starts off, and adding a key keeps the key off the page", async (t) => {
  const { page, errors, app, call } = await fixture(t);
  await openAccounts(page);
  // Redesign: the design has no switch for several accounts per connection (the old #accounts-mode). The engine's own
  // switch still starts off (the owner's decision of 2026-09-17); adding an account from the window is the owner's
  // choice, so the window switches it on first, as the chat-app wizard does (#326), and nothing else is needed.
  assert.equal((await call("/api/accounts")).mode, "off", "several accounts per connection starts off");
  await addKey(page, "Personal");
  assert.notEqual((await call("/api/accounts")).mode, "off", "adding an account switched it on (the window uses \"when needed\")");
  const pool = (await call("/api/accounts")).pools.find((p) => p.pool === POOL);
  // Redesign: replaced by the new window (the old per-pool terms line is not in the design); the engine still says it.
  assert.match(pool.terms.text, /entitled to use/);
  const row = page.locator(".set-col .prow", { hasText: "Personal" });
  await row.waitFor({ state: "visible", timeout: 20000 });
  await keyNowhere(page, KEY);
  const added = (await call("/api/accounts")).pools.find((p) => p.pool === POOL).accounts.find((a) => a.label === "Personal");
  assert.ok(added, "the engine kept the new account");
  await row.getByRole("button", { name: "More for Personal", exact: true }).click();
  await page.locator('.pop [data-act="acct-first"]').click();
  await page.locator(".set-col .prow", { hasText: "Personal" }).locator(".pill", { hasText: "used next" }).waitFor({ timeout: 20000 });
  // Redesign: replaced by the new window (the old #accounts-chip-select in the chat; the model menu's "Accounts and
  // order…" leads here). The account new work uses is the pool's default, which the engine now keeps.
  assert.equal((await call("/api/accounts")).pools.find((p) => p.pool === POOL).defaultAccount, added.id, "new work uses this one");
  assert.equal(await page.locator(".set-col .pill", { hasText: "used next" }).count(), 1, "only one account answers first");
  assert.equal(app.runtime.models.presets.get(POOL).provider.name, "openai-chat");
  assert.deepEqual(errors, []);
});

test("U2 at 400 px nothing scrolls sideways and the page fits", async (t) => {
  const { page, errors, call } = await fixture(t, 400);
  await call("/api/accounts/settings", { mode: "on" });
  await call("/api/accounts/add", { pool: POOL, label: "Personal", key: KEY });
  await openAccounts(page);
  await page.locator(".set-col .prow", { hasText: "Personal" }).waitFor();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.equal(wide, false);
  const fits = await page.waitForFunction(() => {
    const box = document.querySelector(".set-col")?.getBoundingClientRect();
    return box && box.width > 0 && box.x >= 0 && box.right <= 400;
  }, undefined, { timeout: 5000 }).then(() => true, () => false);
  assert.ok(fits, "the accounts page fits inside 400 px");
  const raw = await page.evaluate(() => document.querySelector(".set-col").innerText.match(/\{[a-z]+\}/g));
  assert.equal(raw, null, "no {placeholder} is ever shown");
  await keyNowhere(page, KEY);
  // The language picker in Settings › Appearance is live, offering only languages that really work (English, Français).
  await page.locator('[data-act="setpage"][data-v="appearance"]').click();
  assert.notEqual(await page.locator("#lang").getAttribute("aria-disabled"), "true");
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (sw:lang), checked at e5b8a610.
test.skip("U2 French: every word has a key, and French is real French", async (t) => {
  const { page, errors } = await fixture(t, 400);
  await openCard(page);
  await page.locator("#accounts-mode").selectOption("on");
  await page.locator(`.accounts-pool[data-pool="${POOL}"]`).waitFor();
  const unkeyed = await page.evaluate(() => [...document.querySelectorAll("#accounts-card :is(p, label, option, button, a, span, strong, h2, h3)")]
    .filter((node) => node.children.length === 0 && node.textContent.trim() && !node.dataset.t && !node.dataset.tKey && !node.classList.contains("accounts-data") && node.getAttribute("role") !== "status" && !/^[\s·]*$/.test(node.textContent))
    .map((node) => node.textContent.trim()));
  assert.deepEqual(unkeyed, [], "only account names and the last message (server words) are data");
  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openSettingFor(page, "#accounts-card");
  await page.waitForFunction(() => document.querySelector("label[for=accounts-mode]")?.textContent === "Plusieurs comptes par connexion");
  assert.match(await page.locator("#accounts-card .terms-line").first().innerText(), /Conditions/);
  assert.deepEqual(errors, []);
});

/* mac7/account-pooling: a list that shared work between the owner's own plans, from before the rule. */
function oldSharedList(app, owner) {
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, async () => ({ code: 0, stdout: "{}", stderr: "" }));
  const at = "2026-09-19T10:00:00.000Z";
  app.store.save("settings", owner, "accounts", { mode: "on", pools: [{ pool: "cli-claude-code", kind: "cli", autoSwitch: true,
    accounts: [{ id: "primary", label: "Mine", createdAt: at }, { id: "abcd1234", label: "Partner plan", createdAt: at }] }] });
  accountsServiceFor(app.runtime.models).applyPoolingRule();
}

// Redesign: replaced by the new window (prototype.html's Settings › Accounts has no pooling notice and no "Kept
// separate" box; its accounts are rows with "used next", Move up and the account menu).
test.skip("U3 a sign-in list says once why sharing stopped, and an account can be marked kept separate", async (t) => {
  const { page, errors, app } = await fixture(t, 1440, oldSharedList);
  await openCard(page);
  const pool = page.locator('.accounts-pool[data-pool="cli-claude-code"]');
  await pool.waitFor();
  const notice = pool.locator(".accounts-notice");
  assert.match(await notice.innerText(), /no longer switches between your own .+ plans.*mark it kept separate/s);
  await notice.getByRole("button", { name: "Got it" }).click();
  await notice.waitFor({ state: "detached" });
  const row = pool.locator(".accounts-row", { hasText: "Partner plan" });
  await row.getByLabel(/Kept separate/).check();
  await pool.locator(".accounts-row", { hasText: "Partner plan" }).getByText("(kept separate)").waitFor();
  const saved = accountsServiceFor(app.runtime.models).settings();
  assert.equal(saved.pools[0].accounts.find((account) => account.id === "abcd1234").keptSeparate, true);
  assert.deepEqual(saved.poolingNotices, [], "the notice is read once");
  assert.match(await pool.innerText(), /It never moves between your own plans/, "the words beside the tick box say the rule");
  assert.equal(await pool.getByLabel(/Kept separate/).count(), 2, "every sign-in has the box");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (no pooling notice or "Kept separate" box in prototype.html); its French is
// Coming soon (sw:lang), checked at e5b8a610.
test.skip("U4 the notice and the Kept separate box fit at 400 px, carry keys, and read in French", async (t) => {
  const { page, errors } = await fixture(t, 400, oldSharedList);
  await openCard(page);
  const pool = page.locator('.accounts-pool[data-pool="cli-claude-code"]');
  await pool.locator(".accounts-notice").waitFor();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.equal(wide, false, "nothing scrolls sideways");
  const keyed = await page.evaluate(() => [...document.querySelectorAll('.accounts-pool[data-pool="cli-claude-code"] :is(.accounts-notice p, .accounts-notice button, label span)')]
    .every((node) => node.dataset.t || node.dataset.tKey));
  assert.ok(keyed, "the notice, its button and the box's words come from keys");
  await openPlace(page, "settings:appearance");
  await page.locator("#appearance-language").selectOption("fr");
  await openSettingFor(page, "#accounts-card");
  await page.waitForFunction(() => /Tenu à part/.test(document.querySelector('.accounts-pool[data-pool="cli-claude-code"]')?.innerText ?? ""));
  const text = await pool.innerText();
  assert.match(text, /Branch ne passe plus d'un de vos abonnements .+ à un autre/);
  assert.match(text, /Compris/);
  assert.match(text, /Tenu à part : ce compte appartient/);
  assert.equal(text.match(/\{[a-z]+\}/g), null, "no {placeholder} is ever shown");
  assert.equal(await pool.getByLabel(/Tenu à part/).count(), 2, "the box survives the language change");
  const stillNarrow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  assert.equal(stillNarrow, false, "the longer French words still fit");
  assert.deepEqual(errors, []);
});
