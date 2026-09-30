/**
 * RES-189: an open scheduled dashboard reads its retained snapshot again every fifteen seconds, so a newer page shows
 * without the owner pressing anything; reading it starts no task. The clock is Playwright's, so nothing waits 15 s.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, recordScheduledDashboard } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const page = (value) => JSON.stringify({ columns: [{ id: "state", label: "State" }], attention: [],
  rows: [{ id: "site", label: "Web site", cells: { state: { value, source: "status page", observedAt: new Date(Date.now() - 60_000).toISOString(), status: "fresh" } } }] });

test("RES-189: an open dashboard shows a newer retained page on its own", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-dash-refresh-"));
  const replies = [];
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir,
    provider: { name: "scripted", async complete() { return { content: replies.shift() ?? "", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir, port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner, id = randomUUID(), data = { kind: "task", prompt: "Check the site", dashboard: { title: "Site health" } };
  app.store.save("schedules", owner, id, data);
  const refresh = async (value) => { replies.push(page(value)); recordScheduledDashboard(app.store, owner, id, data, await app.runtime.run({ prompt: "Check the site" })); };
  await refresh("first-value");
  await fetch(server.url + "/api/onboarding", { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: '{"done":true}' });
  const tab = await browser.newPage({ serviceWorkers: "block" });
  await tab.clock.install();
  await tab.goto(server.url);
  await tab.getByLabel("Session token", { exact: true }).fill(server.token);
  await tab.getByRole("button", { name: "Connect", exact: true }).click();
  await tab.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await tab.evaluate((id) => {
    const button = Object.assign(document.createElement("button"), { type: "button" });
    Object.assign(button.dataset, { act: "schedule-dashboard", id });
    document.getElementById("app").append(button);
    button.click();
  }, id);
  const frame = tab.locator("#schedule-dashboard-frame");
  await tab.waitForFunction(() => /first-value/.test(document.getElementById("schedule-dashboard-frame")?.srcdoc ?? ""));
  await refresh("second-value");
  await tab.clock.fastForward(16_000);
  await tab.waitForFunction(() => /second-value/.test(document.getElementById("schedule-dashboard-frame")?.srcdoc ?? ""));
  assert.equal(await frame.count(), 1);
});
