/* The usage popover's "more usage" action, in a hidden (headless) window: with fixture accounts, one near its limit on a
   service that sells more usage (Claude plan) and one near its limit on a service that does not (Gemini CLI), the action
   shows only on the right row, opens that service's own page through the desktop bridge (stubbed: nothing leaves this
   computer, nothing is bought), and the row is read again when the owner comes back. The rows go through the engine's
   real rule (dist/usage-offers.js withOffers) before the window gets them. Set USAGE_OFFERS_SHOTS=<folder> for pictures. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { withOffers } from "../dist/usage-offers.js";

const plan = (used) => ({ id: "five_hour", title: "This 5-hour window", kind: "plan", limit: 100, remaining: 100 - used,
  resetAt: new Date(Date.now() + 3 * 3600_000).toISOString(), measuredAt: new Date().toISOString(), state: "measured", from: "test" });
const rows = (claudeUsed) => withOffers([
  { connection: "cli-claude-code", connectionName: "Claude plan", presets: ["cli-claude-code"], signIn: true, account: "primary",
    accountLabel: "claude-owner@example.test", verified: true, inUse: true, state: "measured", windows: [plan(claudeUsed)], note: "",
    provider: "cli-claude-code", switches: true, readable: true },
  { connection: "cli-gemini-cli", connectionName: "Gemini CLI", presets: ["cli-gemini-cli"], signIn: true, account: "primary",
    accountLabel: "gemini-owner@example.test", inUse: true, state: "measured", windows: [plan(98)], note: "",
    provider: "cli-gemini-cli", switches: true },
  // Only a name Branch gave it, never who the service said it is: the note does not name it.
  { connection: "chatgpt", connectionName: "ChatGPT plan", presets: ["chatgpt"], signIn: true, account: "primary",
    accountLabel: "Your sign-in", inUse: true, state: "measured", windows: [plan(96)], note: "", provider: "chatgpt" },
], Date.now());

test("the offer shows only on the row whose service sells more, opens its page, and the row is read again on return", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-usage-offers-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  const base = await call("/api/usage/glance");
  assert.equal(base.available, true);
  let served = { ...base, rows: rows(97) };

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // The desktop bridge's openExternal, stubbed: it only writes down what it was asked to open.
  await page.addInitScript(() => { window.__opened = []; window.branchDesktop = { openExternal: async (url) => { window.__opened.push(url); return true; } }; });
  await page.route("**/api/usage/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!["/api/usage/glance", "/api/usage/limits/look", "/api/usage/limits/refresh"].includes(path)) return route.continue();
    await route.fulfill({ json: served });
  });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });

  await page.locator('#statusbar [data-act="usagepop"]').click();
  const claude = page.locator(".lim-list .lim", { hasText: "Claude plan" }), gemini = page.locator(".lim-list .lim", { hasText: "Gemini CLI" });
  await claude.waitFor();
  const offer = claude.locator('[data-act="limoffer"]');
  const chatgpt = page.locator(".lim-list .lim", { hasText: "ChatGPT plan" });
  assert.equal(await page.locator('.lim-list [data-act="limoffer"]').count(), 2, "Claude and ChatGPT sell more; Gemini CLI does not");
  assert.equal(await offer.innerText(), "Add usage credits", "Claude's own words");
  assert.equal(await offer.getAttribute("aria-disabled"), null, "live, not greyed");
  assert.equal(await gemini.locator('[data-act="limoffer"]').count(), 0, "Gemini CLI offers nothing to buy, so nothing is shown");
  assert.match(await claude.locator(".lim-offer small").first().innerText(), /claude\.ai.*claude-owner@example\.test.*Nothing is bought/);
  assert.equal(await chatgpt.locator('[data-act="limoffer"]').innerText(), "Buy credits");
  assert.equal(await chatgpt.locator(".lim-offer small").first().innerText(), "Opens chatgpt.com in your browser. Nothing is bought unless you choose it there.",
    "an account known only by the name Branch gave it is not named");
  assert.equal(await chatgpt.locator(".lim-pool").count(), 0, "a single sign-in has no pool to move along");
  for (const one of [claude, gemini])
    assert.equal(await one.locator(".lim-pool").innerText(), "Branch switches to your next account automatically.", "the pool's sentence at the limit");
  if (process.env.USAGE_OFFERS_SHOTS) { // USAGE_OFFERS_SHOTS=<folder> keeps a picture of the popover with its offer
    await page.setViewportSize({ width: 390, height: 800 });
    await page.locator(".pop .lims").screenshot({ path: join(process.env.USAGE_OFFERS_SHOTS, "usage-offers-390.png") });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.locator(".pop .lims").screenshot({ path: join(process.env.USAGE_OFFERS_SHOTS, "usage-offers.png") });
  }

  await offer.click();
  await page.waitForFunction(() => window.__opened.length === 1);
  assert.deepEqual(await page.evaluate(() => window.__opened), ["https://claude.ai/settings/usage"], "the service's own page, as it is");
  served = { ...base, rows: rows(30) }; // what the service says once the owner has added usage credits there
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(400);
  assert.equal(await claude.locator('[data-act="limoffer"]').count(), 1, "a focus with no trip away reads nothing again");

  await page.keyboard.press("Escape"); // the popover closed while the owner was away
  await page.waitForFunction(() => !document.querySelector(".pop .lims"));
  const refreshed = page.waitForRequest((request) => request.url().endsWith("/api/usage/limits/refresh"));
  await page.evaluate(() => { window.dispatchEvent(new Event("blur")); window.dispatchEvent(new Event("focus")); });
  await refreshed; // a Claude plan is read from the service itself (row.readable): Check now's own read
  await page.waitForFunction(() => document.querySelector(".pop .lim-list")?.textContent.includes("70% left")
    && !document.querySelector(".pop .lim-list").textContent.includes("Checking…"));
  assert.equal(await claude.locator('[data-act="limoffer"]').count(), 0, "the new state: room left, no offer");
  assert.equal(await claude.locator(".lim-pool").count(), 0, "nor the pool's sentence");
  assert.equal(await gemini.locator(".lim-pool").count(), 1, "Gemini CLI is still at its limit");
  assert.deepEqual(await page.evaluate(() => window.__opened), ["https://claude.ai/settings/usage"], "nothing else was opened");
  assert.deepEqual(errors, []);
});
