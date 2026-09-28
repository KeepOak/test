/* models-ui: Settings › Models › Decision models › "Filter long lists before a Trunk reads them" is the engine's own
   switch (lists, on as shipped), live with a decision model on this computer and greyed with its reason without one.
   Headless, 127.0.0.1. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const reply = { async complete() { return { content: "ok", toolCalls: [] }; } };
const ID = "f15-filter-long-lists-before-a-trunk-reads-t";

async function open(t, local) {
  const root = await mkdtemp(join(tmpdir(), "branch-filter-lists-ui-"));
  const presets = [{ id: "task", name: "Task model", model: "task-1", provider: { name: "scripted", ...reply } },
    ...(local ? [{ id: "here", name: "Small here", model: "small-1", provider: { name: "openai-compatible", embeddings: () => ({ endpoint: "http://127.0.0.1:11434/v1", apiKey: "" }), ...reply } }] : [])];
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets });
  app.runtime.models.configure(app.runtime.owner, { activePreset: "task" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator('#side [data-act="view"][data-v="settings"]').first().click();
  await page.locator('[data-act="setlevel"][data-v="advanced"]').click();
  await page.locator('[data-act="setpage"][data-v="models"]').click();
  await page.locator(".dm17d").waitFor();
  return { page, errors, call };
}

test("with a decision model on this computer the filter switch is on and saves", async (t) => {
  const { page, errors, call } = await open(t, true);
  const sw = page.locator(`#${ID}`);
  await sw.waitFor();
  assert.equal(await sw.getAttribute("aria-disabled"), null, "live");
  assert.ok(await sw.isChecked(), "ships on");
  assert.match(await page.locator(".ctl", { has: sw }).innerText(), /Done by Small here, for lists of 60 lines or more/);
  await sw.click();
  for (let i = 0; i < 100 && (await call("/api/decisions")).settings.lists !== false; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await call("/api/decisions")).settings.lists, false);
  assert.deepEqual(errors, []);
});

test("with no cheap decision model the switch is greyed with its reason", async (t) => {
  const { page, errors } = await open(t, false);
  const row = page.locator(".dm17d .ctl", { hasText: "Filter long lists" });
  await row.waitFor();
  const sw = row.locator("input.sw");
  assert.equal(await sw.getAttribute("aria-disabled"), "true");
  assert.match(await sw.getAttribute("data-tip"), /Choose a decision model on this computer, or one apart from the task's own/);
  assert.deepEqual(errors, []);
});
