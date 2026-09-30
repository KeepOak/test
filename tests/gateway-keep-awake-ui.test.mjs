import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";
import { chromium } from "playwright";

test("Gateway power choice saves and distinguishes a requested preference from reported active state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-gateway-power-ui-"));
  const dataDir = join(root, "data");
  const app = await createBranch({ dataDir, workspace: join(root, "workspace") });
  const server = await startServer(app, { dataDir, port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (body) => fetch(server.url + "/api/never-break", { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());
  await fetch(server.url + "/api/onboarding", { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: '{"done":true}' });
  const page = await browser.newPage({ serviceWorkers: "block" });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator('[data-act="setpage"][data-v="gateway"]').click();
  const box = page.getByRole("checkbox", { name: "Keep this computer awake while the gateway runs", exact: true });
  await box.waitFor();
  assert.equal(await box.isChecked(), false);
  await box.click();
  await page.getByText("Saved on; an active desktop blocker is not confirmed.", { exact: false }).waitFor();
  assert.equal((await call()).config.keepAwake, true);
  assert.equal((await call()).mode, "off");
  assert.equal((await call()).keepAwakeRuntime, null);
  await page.route("**/api/never-break", async (route) => {
    const response = await route.fetch(), data = await response.json();
    await route.fulfill({ response, json: { ...data, keepAwakeRuntime: { requested: true, active: true, suspended: false, error: null } } });
  });
  await page.evaluate(async () => (await import("/app/settings/pages/gateway.js")).load());
  await page.getByText("Keeping the system awake now.", { exact: false }).waitFor();
  assert.match(await box.locator("..").textContent(), /Closing a laptop lid, battery limits or OS policy/);
});
