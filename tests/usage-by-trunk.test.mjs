/* models-ui (MODEL-052): who spent what. The owner's own tasks and each Trunk's over the last days, with the accounts
   each answered through, counted from this computer's own record, and drawn in Settings › Data & usage. A Trunk on the
   owner's second key is counted apart from the owner, on that key. Stand-in services only; headless, 127.0.0.1. */
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
import { addAccount, setMode } from "../dist/accounts/manage.js";

const POOL = "openai-test";

test("each Trunk's tasks and accounts are counted apart from the owner's, and shown in Data & usage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-usage-by-trunk-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const owner = app.runtime.owner;
  app.store.save("settings", owner, "model-connections", { connections: [{ id: POOL, name: "OpenAI test", catalogId: "openai", model: "gpt-4o-mini", extras: {} }] });
  app.runtime.models.register({ id: POOL, name: "OpenAI test", model: "gpt-4o-mini", catalogId: "openai",
    provider: { name: "openai-chat", complete: async () => ({ content: "from the first key", toolCalls: [], usage: { input: 1000, output: 100 } }) } });
  app.runtime.models.configure(owner, { activePreset: POOL });
  const service = accountsServiceFor(app.runtime.models);
  delete service.deps.policy;
  service.deps.fetchImpl = async (_url, init) => JSON.parse(String(init.body)).stream
    ? new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "from the second key" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } })
    : new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "from the second key" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
  setMode(service, { mode: "on" });
  const second = (await addAccount(service, { pool: POOL, label: "Work key", key: "sk-second-key-value-000000" })).accounts.find((a) => a.label === "Work key").id; // not-a-real-secret
  for (const part of ["trunks", "rooms", "routines"]) app.trunks.setMode(part, { mode: "on" });
  const coder = app.trunks.create({ name: "Coder" });
  app.trunks.edit(coder.id, { keys: { copyFromOwner: true, accounts: { [POOL]: second } } });
  await app.trunks.introduced();
  await app.runtime.run({ prompt: "hello" });
  await app.runtime.run({ prompt: "hello again" });
  const chat = await app.runtime.run({ prompt: "hello", sessionId: coder.chatSessionId });
  assert.equal(chat.output, "from the second key");

  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());
  const spent = await call("/api/usage/by-trunk?days=7");
  const you = spent.rows.find((r) => r.trunk === null), trunk = spent.rows.find((r) => r.trunk?.name === "Coder");
  assert.ok(you && you.tasks >= 2, "the owner's own tasks");
  assert.deepEqual(you.accounts.map((a) => a.account), ["primary"], "on the owner's first key");
  assert.ok(trunk.tasks >= 1, "Coder's own turns (its introduction and its chat), counted apart");
  assert.ok(trunk.accounts.some((a) => a.account === second && a.label === "Work key"));

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
  await page.locator('[data-act="setpage"][data-v="usage"]').click();
  const row = page.locator(".spend-row", { hasText: "Coder" });
  await row.waitFor({ timeout: 30000 });
  assert.match(await row.innerText(), /Coder[\s\S]*tasks[\s\S]*Work key/);
  await page.locator(".spend-row", { hasText: "You" }).waitFor();
  assert.deepEqual(errors, []);
});
