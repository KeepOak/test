/* models-ui (owner 2026-09-27, per-Trunk subscriptions): the usage popover says which Trunks answer with each account, and
   in a Trunk's own conversation the status bar's meter is that Trunk's account (its own window and reset), not the one
   the owner uses next. The glance rows are served as the engine gives them (two accounts of one Claude plan, the second
   near its limit, so the second offers more usage); the Trunk's pick is the engine's own (keys.accounts). Headless. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { withOffers } from "../dist/usage-offers.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";

const POOL = "cli-claude-code";
const plan = (used, hours) => ({ id: "five_hour", title: "This 5-hour window", kind: "plan", limit: 100, remaining: 100 - used,
  resetAt: new Date(Date.now() + hours * 3600_000).toISOString(), measuredAt: new Date().toISOString(), state: "measured", from: "test" });
const row = (account, label, used, hours, inUse) => ({ connection: POOL, connectionName: "Claude plan", presets: [POOL], signIn: true,
  account, accountLabel: label, verified: true, inUse, state: "measured", windows: [plan(used, hours)], note: "", provider: POOL, switches: true, readable: true });

test("each account's row names its Trunks, and a Trunk's own chat meters the account it picked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-usage-trunk-"));
  const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  // The owner's own model is the Claude plan (nothing is run), so the owner's meter is the account used next.
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, async () => ({ code: 1, stdout: "", stderr: "" }));
  app.runtime.models.configure(app.runtime.owner, { activePreset: POOL });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const { trunk } = await call("/api/trunks", { name: "Coder", title: "Test", description: "" });
  await call(`/api/trunks/${trunk.id}`, { model: POOL, keys: { copyFromOwner: true, accounts: { [POOL]: "work" } } });
  await app.trunks.introduced();
  const base = await call("/api/usage/glance");
  const served = { ...base, available: true, rows: withOffers([row("primary", "owner@example.test", 20, 4, true), row("work", "work@example.test", 97, 2, false)], Date.now()) };

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/usage/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!["/api/usage/glance", "/api/usage/limits/look", "/api/usage/limits/refresh"].includes(path)) return route.continue();
    await route.fulfill({ json: served });
  });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });

  const meter = page.locator('#statusbar [data-act="usagepop"]');
  await page.waitForFunction(() => /80% left/.test(document.querySelector('#statusbar [data-act="usagepop"]')?.textContent ?? ""), null, { timeout: 30000 });
  assert.doesNotMatch(await meter.innerText(), /Coder/, "the owner's own conversation meters the account used next");

  await meter.click();
  const work = page.locator(".lim-list .lim", { hasText: "work@example.test" }), own = page.locator(".lim-list .lim", { hasText: "owner@example.test" });
  await work.waitFor();
  assert.match(await work.locator(".lim-trunks").innerText(), /Trunks on this account: Coder/);
  assert.equal(await own.locator(".lim-trunks").count(), 0, "no Trunk picked the owner's first account");
  assert.equal(await work.locator('[data-act="limoffer"]').count(), 1, "the Trunk's account near its limit offers more usage");
  await page.keyboard.press("Escape");

  // In Coder's own conversation the meter is Coder's account: 3% left, its own reset.
  await page.evaluate((sid) => { const el = document.createElement("button"); el.dataset.act = "chat"; el.dataset.id = sid; document.body.append(el); el.click(); el.remove(); }, trunk.chatSessionId);
  await page.waitForFunction(() => /Coder on Claude plan \(work@example\.test\).*3% left/.test(document.querySelector('#statusbar [data-act="usagepop"]')?.textContent ?? ""), null, { timeout: 30000 });
  assert.deepEqual(errors, []);
});
