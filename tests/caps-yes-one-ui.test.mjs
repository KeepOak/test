/**
 * Spend caps in Data & usage (public/app/settings/p17-usage.js): the owner's yes to raising one cap is that cap's alone.
 * Every connection's first account is called "primary", so a yes kept by account id would go along with the next
 * connection's first account too. Two connections' first caps raised in one save must each show the engine's words.
 *
 * Mutation: capsYes kept as `at.account` and compared with `a.account` (the id alone) → the second cap is raised unasked.
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
import { saveAccountsSettings } from "../dist/accounts/settings.js";

const pool = (name) => ({ pool: name, kind: "api-key",
  accounts: [{ id: "primary", label: `${name} key`, monthlyCapUsd: 10, createdAt: "2026-09-26T00:00:00.000Z" }] });

test("spend caps: the yes to one raised cap never goes along with another connection's first account", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-caps-yes-"));
  const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), presets: [{ id: "main", name: "S", provider, model: "m" }] });
  const server = await startServer(app, { dataDir: join(root, "d"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, route, body) => fetch(new URL(route, server.url), { method,
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then((response) => response.json());
  await call("POST", "/api/onboarding", { done: true });
  saveAccountsSettings(app.store, app.runtime.owner, { mode: "on", pools: [pool("alpha-test"), pool("beta-test")] });
  const caps = async () => Object.fromEntries((await call("GET", "/api/accounts")).pools.map((p) => [p.pool, p.accounts[0].monthlyCapUsd]));
  assert.deepEqual(await caps(), { "alpha-test": 10, "beta-test": 10 });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  await page.locator('[data-act="setlevel"][data-v="technical"]').first().click();
  await page.locator('[data-act="setpage"][data-v="usage"]').first().click();
  await page.locator('.set-col [data-act="capsb17"]').click();
  await page.locator(".scrim #cap-b17-1").waitFor();
  await page.locator(".scrim #cap-b17-0").fill("20");
  await page.locator(".scrim #cap-b17-1").fill("30");
  await page.locator('.scrim [data-act="capssaveb17"]').click();
  const yes = page.locator('.scrim [data-act="capsloosenb17"]');
  await yes.waitFor();
  assert.match(await page.locator(".scrim .dlg").innerText(), /alpha-test key's monthly cap would go up from \$10 to \$20/);
  assert.deepEqual(await caps(), { "alpha-test": 10, "beta-test": 10 }, "nothing raised before the yes");
  await yes.click();
  await page.waitForFunction(() => /beta-test key's monthly cap would go up/.test(document.querySelector(".scrim .dlg")?.textContent ?? ""),
    undefined, { timeout: 15000 });
  assert.deepEqual(await caps(), { "alpha-test": 20, "beta-test": 10 }, "the yes raised the cap it named, and only that one");
  await page.locator('.scrim [data-act="capsloosenb17"]').click();
  await page.waitForFunction(() => !document.querySelector('.scrim [data-act="capsloosenb17"]'), undefined, { timeout: 15000 });
  // The dialog can close while its save is still on the way, so the engine is asked until the save has landed.
  let now = await caps();
  for (let tries = 0; tries < 150 && now["beta-test"] !== 30; tries++) { await page.waitForTimeout(100); now = await caps(); }
  assert.deepEqual(now, { "alpha-test": 20, "beta-test": 30 }, "its own yes raised the second");
  assert.deepEqual(errors, []);
});
