/**
 * Overview in the window, on the engine's own data:
 * - Spend this week counts every task of the week, the ones set aside from Recent activity included: a helper's model
 *   calls are charged to the helper's own task, and they cost the owner all the same.
 * A scripted model; nothing reaches a provider.
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

const scripted = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

async function overview(t, seed, width = 1440) {
  const root = await mkdtemp(join(tmpdir(), "branch-overview-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  seed(app);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.evaluate(() => document.querySelector('[data-act="view"][data-v="overview"]')?.click());
  await page.locator(".ovs-cols").waitFor({ timeout: 20000 });
  return { page, errors };
}

/* A finished task of this week that spent `input` and `output` tokens on a model priced at $10,000 a million tokens each
   way (the most a price may be), so a hundred tokens cost $1. */
function priced(app, prompt, input, output, parentRunId) {
  const run = app.store.createRun(app.runtime.owner, prompt);
  if (parentRunId) app.store.event(run.id, "run.started", { provider: "scripted", parentRunId });
  app.store.event(run.id, "model.complete", { model: "overview-test-model" });
  app.store.addUsage(run.id, input, output);
  app.store.finish(run.id, "completed", "Done.");
  return run;
}

test("Spend this week counts a helper's priced work, though Recent activity leaves the helper out", async (t) => {
  const { page, errors } = await overview(t, (app) => {
    app.store.save("settings", app.runtime.owner, "pricing", { overrides: { "overview-test-model": { input: 10_000, output: 10_000 } } });
    const parent = priced(app, "Plan my trip", 100, 100);
    priced(app, "Look up train times", 200, 100, parent.id);
  });
  const recent = await page.locator(".ovs-act").allInnerTexts();
  assert.ok(recent.some((row) => row.includes("Plan my trip")), recent.join(" | "));
  assert.ok(!recent.some((row) => row.includes("Look up train times")), "the helper is not activity");
  const total = page.locator(".big-n");
  assert.equal((await total.count()) ? (await total.innerText()).trim() : "", "$5.00", "$2.00 for the task and $3.00 for its helper");
  assert.deepEqual(errors, []);
});
