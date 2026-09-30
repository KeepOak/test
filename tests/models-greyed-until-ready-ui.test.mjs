/* greyed-remaining (models-ui): the Models and Accounts controls greyed with a reason are greyed only until what they need
   is there, and then work. With two connections, a second account and videos on, each goes live and saves in the engine:
   Accounts' "Move to the next account in the list" (ac-next), Pick the model per task, Mix models on hard questions,
   the thinking effort of a model that takes one (m-effort), and the video service (m-vid-svc). Headless, 127.0.0.1. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { addAccount, setMode, updatePool } from "../dist/accounts/manage.js";

const reply = { async complete() { return { content: "ok", toolCalls: [] }; } };
const POOL = "openai-test";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-greyed-ready-"));
  const presets = [
    { id: POOL, name: "OpenAI test", model: "gpt-5", provider: { name: "openai-compatible", ...reply } },
    { id: "quick", name: "Quick", model: "quick-1", provider: { name: "scripted", ...reply } },
  ];
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets });
  const owner = app.runtime.owner;
  app.store.save("settings", owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI test", catalogId: "openai", model: "gpt-5", extras: {} }] });
  app.runtime.models.configure(owner, { activePreset: POOL });
  const service = accountsServiceFor(app.runtime.models);
  delete service.deps.policy;
  setMode(service, { mode: "on" });
  await addAccount(service, { pool: POOL, label: "Second key", key: "sk-second-key-value-000000" }); // not-a-real-secret
  updatePool(service, { pool: POOL, autoSwitch: false });
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
  await page.locator('[data-act="setlevel"][data-v="technical"]').click();
  return { page, errors, call, service };
}
const open = async (page, id, tab) => {
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).click();
  if (tab) await page.locator(`[data-act="mtab"][data-v="${tab}"]`).click();
  await page.waitForTimeout(1200);
};
async function waitFor(check, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) assert.fail("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
const live = async (locator) => (await locator.getAttribute("aria-disabled")) === null;

test("each greyed Models control goes live once what it needs is there, and saves", async (t) => {
  const { page, errors, call, service } = await fixture(t);

  // Accounts: two accounts on a connection, so moving to the next one is live.
  await open(page, "accounts");
  const next = page.locator("#ac-next");
  await next.waitFor();
  assert.ok(await live(next), "ac-next is live with a second account");
  await next.click();
  await waitFor(() => service.pool(POOL).autoSwitch === true);

  // Models › Defaults: the quick and the planning pick, then Pick the model per task, then Mix models.
  await open(page, "models", "defaults");
  await page.locator('[data-act="m-def"][data-k="quick"][data-v="quick"]').click();
  await page.locator('[data-act="m-def"][data-k="planning"][data-v="openai-test"]').click();
  await page.waitForTimeout(1200);
  const perTask = page.locator("#f15-pick-the-model-per-task");
  await perTask.waitFor();
  assert.ok(await live(perTask), "pick the model per task is live with both picks made");
  await perTask.click();
  await waitFor(async () => (await call("/api/model-savings")).values.difficulty.mode !== "off");
  const mix = page.locator("#f15-mix-models-on-hard-questions");
  await mix.waitFor();
  assert.ok(await live(mix), "mixing is live with two different connections picked");
  await mix.click();
  await waitFor(async () => (await call("/api/model-savings")).values.difficulty.mixHard === true);

  // The model in use takes a thinking effort, so the effort row is live.
  const medium = page.locator('[data-act="m-effort"][data-v="medium"]');
  await medium.waitFor();
  await medium.click();
  await waitFor(async () => (await call("/api/knobs")).values.reasoning.effortByModel?.[POOL] === "medium");

  // Media: with videos on, the video service can be chosen.
  await open(page, "models", "media");
  assert.equal(await page.locator('[data-act="m-vid-svc"]').count(), 0, "greyed while videos are off");
  await page.locator("#m-vid").click();
  const google = page.locator('[data-act="m-vid-svc"][data-v="google"]');
  await google.waitFor({ timeout: 15000 });
  await google.click();
  await waitFor(async () => (await call("/api/reach")).video?.service === "google");
  assert.deepEqual(errors, []);
});
