import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createBranch, syncChatGPTPresets } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { saveAccountsSettings } from "../dist/accounts/settings.js";
import { discardTemp } from "./temp-dir.mjs";

const ids = ["primary", "abcd1234", "bcde1234"];
const emails = ["personal@example.test", "work@example.test", "other@example.test"];
const reset = "2099-01-01T00:00:00.000Z", secret = "fixture-secret-never-public";

async function fixture(t, chatgpt = false) {
  const root = await mkdtemp(join(tmpdir(), "claude-usage-identity-")), bin = join(root, "bin");
  await mkdir(bin);
  for (const file of ["claude", "claude.cmd"]) await writeFile(join(bin, file), "", { mode: 0o755 });
  const oldPath = process.env.PATH, oldHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.PATH = bin;
  process.env.CLAUDE_CONFIG_DIR = join(root, "primary");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const service = accountsServiceFor(app.runtime.models), statusHomes = [], usageHomes = [];
  registerCliAgent(app.runtime.models, { id: "claude-code" });
  app.runtime.models.configure(app.runtime.owner, { activePreset: "cli-claude-code" });
  saveAccountsSettings(app.store, app.runtime.owner, { mode: "on", pools: [{ pool: "cli-claude-code", kind: "cli",
    accounts: ids.map((id, i) => ({ id, label: i ? `Claude ${i + 1}` : "Your usual sign-in", createdAt: new Date().toISOString() })) }] });
  const homes = ids.map((id) => id === "primary" ? service.primaryClaudeHome : service.homeOf("cli-claude-code", id));
  service.deps.statusRun = async (_row, args, env) => {
    assert.deepEqual(args, ["auth", "status"]);
    statusHomes.push(env.CLAUDE_CONFIG_DIR);
    return { code: 0, missing: false, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai",
      email: emails[homes.indexOf(env.CLAUDE_CONFIG_DIR)], accessToken: secret }) };
  };
  service.deps.claudeUsage = async (env) => {
    usageHomes.push(env.CLAUDE_CONFIG_DIR);
    return { rateLimitsAvailable: true, rateLimits: {
      five_hour: { utilization: [2, 0, 100][homes.indexOf(env.CLAUDE_CONFIG_DIR)], resets_at: reset },
      seven_day: { utilization: 97, resets_at: reset },
    } };
  };
  if (chatgpt) addChatGPTFixture(app, service);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const call = async (path, body) => fetch(new URL(path, server.url), { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}) }).then((res) => res.json());
  t.after(async () => {
    process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = oldHome;
    await server.close(); await app.close(); await discardTemp(root);
  });
  return { app, service, server, call, homes, statusHomes, usageHomes };
}

function addChatGPTFixture(app, service) {
  const auth = { accessToken: async () => "fixture-token", status: async () => ({ signedIn: true, email: "chatgpt@example.test" }) };
  service.deps.chatgpt = auth;
  syncChatGPTPresets(app.runtime.models, auth, true, "Fixture");
  service.deps.fetchImpl = async () => new Response(JSON.stringify({ rate_limit: {
    primary_window: { used_percent: 6, limit_window_seconds: 604800, reset_at: Date.parse(reset) / 1000 },
  } }), { status: 200 });
}

test("the first usage response has verified emails per profile and never exposes credentials", async (t) => {
  const fx = await fixture(t);
  const response = await fx.call("/api/usage/glance");
  assert.deepEqual(response.rows.filter((r) => r.connection === "cli-claude-code").map((r) => r.accountLabel), emails);
  assert.deepEqual(fx.statusHomes, fx.homes);
  assert.equal(JSON.stringify(response).includes(secret), false);
  await fx.call("/api/usage/glance");
  assert.equal(fx.statusHomes.length, 3, "identity cache is bounded and keyed per profile");
});

test("a profile switch during the usage identity read returns no owner's rows", async (t) => {
  const fx = await fixture(t), gate = Promise.withResolvers(), began = Promise.withResolvers();
  let reads = 0;
  fx.service.deps.statusRun = async () => {
    reads++; began.resolve(); await gate.promise;
    return { code: 0, missing: false, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: emails[0] }) };
  };
  const pending = fx.call("/api/usage/glance");
  await began.promise;
  const person = fx.app.store.profiles.create({ name: "Household fixture", pin: "1234" });
  fx.app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  gate.resolve();
  assert.deepEqual(await pending, { available: false });
  assert.equal(reads, 1, "no later owner profile is probed after the switch");
});

test("a PIN lock during the usage identity read returns no owner's rows", async (t) => {
  const fx = await fixture(t), gate = Promise.withResolvers(), began = Promise.withResolvers();
  fx.app.sessionLock.setPin({ pin: "1234" });
  fx.service.deps.statusRun = async () => {
    began.resolve(); await gate.promise;
    return { code: 0, missing: false, stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: emails[0] }) };
  };
  const pending = fx.call("/api/usage/glance");
  await began.promise;
  fx.app.sessionLock.lock();
  gate.resolve();
  assert.deepEqual(await pending, { available: false });
});

async function connect(t, fx) {
  await fx.call("/api/onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, serviceWorkers: "block" });
  await page.goto(fx.server.url);
  await page.getByLabel("Session token", { exact: true }).fill(fx.server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor();
  return page;
}

test("usage and identity use the same profiles; popup and Settings show verified emails", async (t) => {
  const fx = await fixture(t);
  for (const account of ids) await fx.call("/api/usage/limits/refresh", { connection: "cli-claude-code", account });
  const response = await fx.call("/api/usage/glance"), rows = response.rows.filter((r) => r.connection === "cli-claude-code");
  assert.deepEqual(fx.usageHomes, fx.homes);
  assert.deepEqual(fx.statusHomes, fx.homes);
  const page = await connect(t, fx);
  await page.locator('#statusbar [data-act="usagepop"]').click();
  await page.locator(".lim-list .lim-share").first().waitFor();
  await page.waitForFunction(() => !document.querySelector(".lim-list")?.textContent.includes("Checking…"));
  for (const email of emails) assert.equal(await page.locator(".lim-list .lim-h").filter({ hasText: email }).count(), 1);
  const settings = await page.evaluate(async (rows) => {
    const { limitRow } = await import("/app/settings/pages/usage.js");
    const node = document.createElement("div"); node.innerHTML = rows.map(limitRow).join("");
    return [...node.querySelectorAll(".lim-h .muted")].map((el) => el.textContent);
  }, rows);
  assert.deepEqual(settings, emails);
});

test("mixed-provider usage keeps verified Claude and ChatGPT account emails", async (t) => {
  const fx = await fixture(t, true), settings = fx.service.settings();
  settings.pools[0].accounts = settings.pools[0].accounts.filter((account) => account.id === "primary");
  saveAccountsSettings(fx.app.store, fx.app.runtime.owner, settings);
  await fx.call("/api/usage/limits/refresh", { connection: "cli-claude-code", account: "primary" });
  await fx.call("/api/usage/limits/refresh", { connection: "chatgpt", account: "primary" });
  const page = await connect(t, fx);
  await page.locator('#statusbar [data-act="usagepop"]').click();
  await page.locator(".lim-list .lim-share").first().waitFor();
  await page.waitForFunction(() => !document.querySelector(".lim-list")?.textContent.includes("Checking…"));
  const claude = page.locator(".lim-list .lim-h").filter({ hasText: emails[0] });
  const chatgpt = page.locator(".lim-list .lim-h").filter({ hasText: "chatgpt@example.test" });
  assert.equal(await claude.count(), 1);
  assert.equal(await chatgpt.count(), 1);
  if (process.env.CLAUDE_USAGE_SHOT) await page.locator(".pop .lims").screenshot({ path: process.env.CLAUDE_USAGE_SHOT });
});
