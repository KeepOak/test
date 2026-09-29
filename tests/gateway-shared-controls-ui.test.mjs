import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";

test("General and Gateway share saved preference, while footer reports running state without scheduled-task setup", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-gateway-shared-controls-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ dataDir, workspace: join(root, "workspace") });
  const server = await startServer(app, { dataDir, port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ serviceWorkers: "block" });
  let scheduled = 0;
  await page.route("**/api/deployment/daemon", (route) => { scheduled++; return route.fulfill({ status: 403, contentType: "application/json", body: '{"error":"Access is denied"}' }); });
  const auth = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
  await fetch(server.url + "/api/onboarding", { method: "POST", headers: auth, body: '{"done":true}' });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator('[data-act="setpage"][data-v="general"]').click();
  const saved = page.locator("#main #g-tray");
  await saved.waitFor();
  assert.equal(await saved.isChecked(), false);
  await saved.click();
  await page.waitForFunction(() => document.querySelector("#main #g-tray")?.checked === true);
  const current = () => fetch(server.url + "/api/never-break", { headers: auth }).then((r) => r.json());
  // A native switch shows its new state at once; the engine's saved answer is what counts.
  for (let at = 0; at < 100 && (await current()).mode !== "on"; at++) await page.waitForTimeout(100);
  assert.equal((await current()).mode, "on");
  assert.equal((await current()).underGateway, false, "saved On is not proof of a running gateway");
  assert.equal(scheduled, 0, "window-close preference never attempts schtasks setup");
  const footer = page.locator('[data-act="gwpop"]');
  await footer.click();
  // The footer's own popover line (General's row below says the same words, so each is found where it is drawn).
  await page.locator("p.pp", { hasText: "Saved on. The gateway is not running yet" }).waitFor();
  assert.match(await footer.textContent(), /Gateway off/, "the footer reports actual running state");
  await page.locator('[data-act="setpage"][data-v="gateway"]').click();
  await page.locator("#main .status").filter({ hasText: "The gateway is switched on, not running yet" }).waitFor();
  assert.match(await page.locator("#main .status").textContent(), /takes over the next time Branch starts/);
  assert.equal(await page.locator("#main #gw-mode").isChecked(), true);
  await page.locator("#main #gw-mode").click();
  await page.waitForFunction(() => document.querySelector("#main #gw-mode")?.checked === false);
  for (let at = 0; at < 100 && (await current()).mode !== "off"; at++) await page.waitForTimeout(100);
  assert.equal((await current()).mode, "off", "the Gateway page saves the same preference");
  await page.locator('[data-act="setpage"][data-v="general"]').click();
  await page.waitForFunction(() => document.querySelector("#main #g-tray")?.checked === false);
  await page.route("**/api/never-break", (route) => route.request().method() === "POST"
    ? route.fulfill({ status: 403, contentType: "application/json", body: '{"error":"Saving the gateway choice was denied"}' }) : route.continue());
  await saved.click();
  await page.getByText("Saving the gateway choice was denied", { exact: false }).waitFor();
  await page.waitForFunction(() => document.querySelector("#main #g-tray")?.checked === false);
  assert.equal((await current()).mode, "off", "a rejected save leaves the original preference visible");
  assert.equal(scheduled, 0);
});

test("an unreadable gateway leaves the rest of General drawn and is never switched blind", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-gateway-unread-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ dataDir, workspace: join(root, "workspace") });
  const server = await startServer(app, { dataDir, port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ serviceWorkers: "block" });
  let posts = 0;
  await page.route("**/api/never-break", (route) => {
    if (route.request().method() === "POST") { posts++; return route.continue(); }
    return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"gateway state unreadable"}' });
  });
  const auth = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
  await fetch(server.url + "/api/onboarding", { method: "POST", headers: auth, body: '{"done":true}' });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator('[data-act="setpage"][data-v="general"]').click();
  const saved = page.locator("#main #g-tray");
  await saved.waitFor();
  await page.locator("#main #g-start").waitFor();
  await page.getByText("Gateway status could not be verified", { exact: false }).first().waitFor();
  assert.equal(await saved.isChecked(), false);
  await saved.click();
  await page.waitForTimeout(300);
  assert.equal(await saved.isChecked(), false, "an unverified gateway row stays off");
  assert.equal(posts, 0, "no preference is written from an unread state");
});
