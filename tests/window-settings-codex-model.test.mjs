/* QA 2026-09-28: Settings › Models › Connections › Codex has a model picker (GET/POST /api/codex-models). It offers the
   models Codex takes, most capable first, starts on "The best it takes", saves a pick at once, and keeps it after a
   reload. Stand-in Codex registration only; nothing is run. Headless, 127.0.0.1. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { setMode } from "../dist/accounts/manage.js";
import { gselChoices, pickGsel } from "./gsel.mjs";

test("Codex's model is picked in Settings › Models › Connections, saved in the engine and kept after a reload", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-codex-picker-"));
  const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  registerCliAgent(app.runtime.models, { id: "codex" }, {}, async () => ({ code: 1, stdout: "", stderr: "" }));
  setMode(accountsServiceFor(app.runtime.models), { mode: "on" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async () => {
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await page.locator('#side [data-act="view"][data-v="settings"]').first().click();
    await page.locator('[data-act="setpage"][data-v="models"]').click();
    await page.locator('[data-act="mtab"][data-v="connections"]').click();
    await page.waitForSelector("#m-codex:not(.soon)", { timeout: 30000 });
  };
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await open();
  const picker = page.locator("#m-codex");
  assert.equal(await picker.getAttribute("value"), "", "starts on the best it takes");
  assert.deepEqual((await gselChoices(picker)).map((c) => c.value), ["", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.5"]);
  await pickGsel(picker, "gpt-5.5");
  for (let i = 0; i < 100 && (await call("/api/codex-models")).chosen !== "gpt-5.5"; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal((await call("/api/codex-models")).inUse, "gpt-5.5");
  await page.reload();
  await open();
  assert.equal(await page.locator("#m-codex").getAttribute("value"), "gpt-5.5");
  assert.deepEqual(errors, []);
});
