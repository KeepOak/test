/* Settings › Models › Compare models › Side by side: each task of a suite, with each model's own answer beside the others
   and whether it passed, read from each task's own record (GET /api/runs/<id>). Two stand-in models answer the standard
   suite through the engine's real comparison (POST /api/evaluation/compare). Headless, 127.0.0.1. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const model = (name, reply) => ({ name, async complete() { return { content: reply, toolCalls: [] }; } });

test("Side by side shows each model's own answer to each task, beside the others", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-side-by-side-"));
  const presets = [
    { id: "alpha", name: "Alpha", model: "alpha-1", provider: model("alpha", "391") },
    { id: "beta", name: "Beta", model: "beta-2", provider: model("beta", "I think it is 390") },
  ];
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  const suite = (await call("/api/evaluation/suites")).suites[0];
  await call("/api/evaluation/compare", { suite: suite.id, presets: ["alpha", "beta"] });

  const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator('#side [data-act="view"][data-v="settings"]').first().click();
  await page.locator('[data-act="setlevel"][data-v="advanced"]').click();
  await page.locator('[data-act="setpage"][data-v="models"]').click();
  await page.locator('[data-act="compareb17"]').click();
  const side = page.locator('.dlg [data-act="cmpsideb17"]');
  await side.waitFor();
  assert.equal(await side.getAttribute("aria-disabled"), null, "live");
  await side.click();
  const table = page.locator(".dlg .side-b17");
  await table.waitFor();
  const text = await table.innerText();
  assert.match(text, /Alpha/);
  assert.match(text, /Beta/);
  const arithmetic = table.locator("tr", { hasText: "arithmetic" });
  const cells = await arithmetic.locator("td").allInnerTexts(), heads = await table.locator("thead th").allInnerTexts();
  const of = (name) => cells[heads.indexOf(name) - 1];
  assert.match(of("Alpha"), /Passed[\s\S]*391/);
  assert.match(of("Beta"), /Failed[\s\S]*I think it is 390/, "a failed task shows the model's own words, not only the check's");
  await page.locator('.dlg [data-act="cmpback17"]').click();
  await page.locator('.dlg [data-act="cmprunb17"]').waitFor();
  assert.deepEqual(errors, []);
});
