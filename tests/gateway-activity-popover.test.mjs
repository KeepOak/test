/**
 * PLAT-014: the status bar's Gateway popover shows what the gateway has been doing, newest first, and offers Restart
 * engine beside the switch. The gateway's own answers are stood in for with page routes; nothing is restarted here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { signIn } from "./new-window-places.mjs";
import { discardTemp } from "./temp-dir.mjs";

test("PLAT-014: the Gateway popover lists recent gateway notes newest first and offers Restart the engine", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-gateway-pop-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ dataDir, workspace: join(root, "workspace") });
  const server = await startServer(app, { dataDir, port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(`${server.url}/api/onboarding`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: '{"done":true}' });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  await page.route("**/api/never-break", async (route) => {
    const response = await route.fetch(), data = await response.json();
    await route.fulfill({ response, json: { ...data, mode: "when-needed", underGateway: true } });
  });
  await page.route("**/gateway/health", (route) => route.fulfill({ json: { ok: true, notes: [
    { at: "2026-09-30T06:00:00.000Z", text: "Older note" }, { at: "2026-09-30T07:00:00.000Z", text: "The engine stopped unexpectedly" }] } }));
  await signIn(page, server);
  await page.locator('[data-act="gwpop"]').first().click();
  const panel = page.locator(".pop .gateway-activity14");
  await panel.getByText("The engine stopped unexpectedly").waitFor({ timeout: 20000 });
  assert.deepEqual(await panel.locator("li span").allInnerTexts(), ["The engine stopped unexpectedly", "Older note"]);
  assert.equal(await page.locator('.pop [data-act="gwpop-restart14"]').count(), 1);
});
