/* wire-greyed: Settings › Advanced › Web search was drawn greyed ("Branch takes the search service from its launch settings
   file"). It is live now: each service is a real choice the engine saves (POST /api/web-search), the row says what the
   pick needs (a key's secret name, or SearXNG's address), and the engine's own refusal is shown in its words.
   Mutation: in public/app/settings/pages/advanced.js drop "ad-search" from markLive, and the first case goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

async function advancedPage(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-wire-advanced-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  await page.locator('[data-act="setlevel"][data-v="technical"]').first().click();
  await page.locator('[data-act="setpage"][data-v="advanced"]').click();
  await page.locator('[data-act="ad-search"]').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  const read = () => fetch(new URL("/api/web-search", server.url), { headers: { authorization: `Bearer ${server.token}` } }).then((r) => r.json());
  return { page, errors, read };
}

test("Web search is a live choice the engine keeps, and the row names the key it needs", async (t) => {
  const { page, errors, read } = await advancedPage(t);
  const brave = page.locator('[data-act="ad-search"][data-v="brave"]');
  assert.equal(await brave.getAttribute("aria-disabled"), null, "the Brave choice is not greyed");
  assert.equal(await page.locator('[data-act="ad-search"][data-v="duckduckgo"]').getAttribute("aria-pressed"), "true");
  await brave.click();
  await page.locator('[data-act="ad-search"][data-v="brave"][aria-pressed="true"]').waitFor();
  assert.equal((await read()).chosen.backend, "brave");
  const row = page.locator(".ctl", { has: brave });
  assert.match(await row.innerText(), /BRAVE_SEARCH_KEY/);
  assert.deepEqual(errors, []);
});

test("SearXNG takes its address from the box, and without one the engine's refusal is shown", async (t) => {
  const { page, read } = await advancedPage(t);
  await page.locator('[data-act="ad-search"][data-v="searxng"]').click();
  await page.locator(".toast", { hasText: "address of your SearXNG" }).waitFor();
  assert.equal((await read()).chosen.backend, "duckduckgo", "nothing was saved");
  assert.equal(await page.locator("#ad-searx").isDisabled(), false);
  await page.locator("#ad-searx").fill("http://127.0.0.1:8888");
  await page.locator('[data-act="ad-search"][data-v="searxng"]').click();
  await page.locator('[data-act="ad-search"][data-v="searxng"][aria-pressed="true"]').waitFor();
  const saved = await read();
  assert.deepEqual([saved.chosen.backend, saved.chosen.searxngUrl], ["searxng", "http://127.0.0.1:8888"]);
});
