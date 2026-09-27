/**
 * mac7/residuals: the window's side of the leftovers (docs/agents/STATUS-residuals.md), headless
 * against the local server. Each test fails with its fix taken out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings } from "./places.mjs";

async function fixture(t, { viewport = { width: 1440, height: 1000 }, before, provider, args = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-residuals-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true, args });
  let page = null;
  t.after(async () => {
    /* A route still answering when the test ends failed on the closed browser (ci-flakes-3). */
    await page?.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
    await browser.close(); await server.close(); await app.close(); await discardTemp(root);
  });
  page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (before) await before(page, app);
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click({ noWaitAfter: true });
  await page.locator("body.lx-ready").waitFor({ state: "attached", timeout: 120000 });
  // layout.js marks lx-ready as the page loads, before the key is taken (ci-flakes-3).
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, server, page, errors, browser };
}

// Redesign: Coming soon (sw:lang, the Language select in Settings › Appearance), checked at fc541c24.
test.skip("8. switched to French, the window asks for the achievements in French and shows them so", async (t) => {
  const { page, server } = await fixture(t);
  await page.evaluate(async (token) => {
    await fetch("/api/delight/settings", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ achievements: { on: true } }) });
    await globalThis.branchDelight.reload();
  }, server.token);
  const asked = [];
  page.on("request", (request) => { if (request.url().includes("/api/delight/achievements")) asked.push(new URL(request.url()).search); });
  await page.evaluate(async () => { const { setLanguage } = await import("/i18n.js"); await setLanguage("fr"); });
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  await page.evaluate(async () => { const { openSheet } = await import("/delight-achievements.js"); await openSheet(); });
  const sheet = page.locator("#ach-sheet");
  await sheet.getByText("Pousse", { exact: true }).waitFor();
  assert.ok(asked.includes("?lang=fr"), asked.join(" "));
});

// Redesign: Coming soon (sw:lang, the Language select in Settings › Appearance), checked at fc541c24.
test.skip("18. in French, Settings search names a setting whose control is not drawn yet in French too", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  const picked = await page.evaluate(async () => {
    const { SETTINGS_INDEX } = await import("/settings-index.js");
    const { fromEnglish } = await import("/i18n.js");
    const row = SETTINGS_INDEX.find((r) => !document.getElementById(r[0]) && fromEnglish(r[3]) && fromEnglish(r[3]) !== r[3]
      && fromEnglish(r[3]).length > 12);
    return row ? { id: row[0], english: row[3], french: fromEnglish(row[3]) } : null;
  });
  assert.ok(picked, "a setting that is not drawn yet and has French words");
  await openSettings(page, "general");
  await page.locator("#lx-settings-search").fill(picked.french);
  const row = page.locator(`#sg-found [data-setting="${picked.id}"] b`);
  await row.waitFor();
  assert.equal(await row.textContent(), picked.french, `${picked.id} is named in French, not "${picked.english}"`);
  assert.deepEqual(errors, []);
});

/* Redesign: a Trunk's message waiting on the owner is a row of the prototype's Inbox › Needs you
   (public/app/places/inbox.js messageRow): the message, which Trunk to which, "Don’t" and "Allow" (data-act="tmsg"). */
test("2 (new window). a Trunk's message waiting on the owner is in Inbox › Needs you: which Trunks, the message, Allow and Don't", async (t) => {
  let ann, ben;
  const { app, page, errors } = await newWindow(t, (app) => {
    for (const part of ["trunks", "messages"]) app.trunks.setMode(part, { mode: "on" });
    ann = app.trunks.create({ name: "Ann" }); ben = app.trunks.create({ name: "Ben" });
    const now = new Date().toISOString();
    app.store.save("settings", app.runtime.owner, "trunk-receipts", { items: [{ id: "0f8fad5b-d9cb-469f-a165-70867728950e", kind: "message",
      from: ann.id, to: ben.id, sessionId: ben.chatSessionId, prompt: "Message from Ann (@ann):\nCan you check the invoice?", status: "waiting",
      depth: 1, attempts: 1, runId: null, fromRunId: null, reply: null, error: null, at: now, updatedAt: now }] });
  });
  await page.locator('#side [data-act="view"][data-v="inbox"]').click();
  const row = page.locator("#main .prow").filter({ has: page.locator('[data-act="tmsg"]') });
  await row.waitFor({ timeout: 30000 });
  assert.match(await row.innerText(), /Ann → Ben/, "which Trunk, whose message");
  assert.match(await row.innerText(), /Can you check the invoice\?/);
  await row.locator('[data-act="tmsg"][data-v="answer"]').click();
  for (let i = 0; i < 100 && !app.trunks.messages.waiting()[0]?.armed; i++) await page.waitForTimeout(100);
  assert.equal(app.trunks.messages.waiting()[0].armed, true, "the route was told");
  await page.locator("#main .prow").filter({ has: page.locator('[data-act="tmsg"]') }).locator('[data-act="tmsg"][data-v="decline"]').click();
  await page.locator('#main [data-act="tmsg"]').first().waitFor({ state: "detached", timeout: 10000 });
  assert.deepEqual(app.trunks.messages.waiting(), [], "ended; the sender is told (tests/residuals.test.mjs 2)");
  assert.equal(app.trunks.messages.receipts(ben.id).find((r) => r.kind === "message").status, "failed");
  assert.deepEqual(errors, []);
});
async function newWindow(t, before) {
  const root = await mkdtemp(join(tmpdir(), "branch-residuals-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  before?.(app);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}

