/**
 * QA retest 2026-09-28 (m10): picking a model in a brand-new conversation's menu changed the model every new conversation
 * starts with (POST /api/models activePreset), so a one-off Claude Code question left later work on Claude Code. The pick
 * is now that conversation's own: it goes with its first message (POST /api/run preset), the owner's default is left as
 * it was, and only the owner at the window may make it. Node only: the real dist/ and public/, headless Chromium, port 0.
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

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-new-chat-model-"));
  const answered = [];
  const say = (name) => ({ name, async complete() { answered.push(name); return { content: `from ${name}`, toolCalls: [] }; } });
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), presets: [
    { id: "local", name: "Local model", provider: say("local"), model: "local-7b" },
    { id: "cloud", name: "Cloud model", provider: say("cloud"), model: "cloud-1" }] });
  app.runtime.models.configure(app.runtime.owner, { activePreset: "local" });
  const server = await startServer(app, { dataDir: join(root, "d"), port: 0 });
  const call = (path, body, token = server.token) => fetch(new URL(path, server.url), { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  await call("/api/onboarding", { done: true });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  return { app, server, call, answered };
}

test("a first message's model is its new conversation's own, and the owner's default is untouched", async (t) => {
  const { app, call, answered } = await served(t);
  const response = await call("/api/run", { prompt: "hello", preset: "cloud" });
  assert.equal(response.status, 200);
  const run = await response.json();
  assert.equal(app.runtime.models.session(app.runtime.owner, run.sessionId).preset, "cloud", "the conversation keeps it");
  assert.deepEqual(answered, ["cloud"], "and it answered with it");
  assert.equal(app.runtime.models.settings(app.runtime.owner).activePreset, "local", "new conversations still start on the default");
  const unknown = await call("/api/run", { prompt: "hello", preset: "nowhere" });
  assert.notEqual(unknown.status, 200, "an unknown model is refused");
  assert.equal(app.store.runs(app.runtime.owner).filter((r) => r.prompt === "hello").length, 1, "before any task is written");
  const key = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const byKey = await call("/api/run", { prompt: "from a script", preset: "cloud" }, key);
  assert.equal(byKey.status, 403, "a short-lived key does not pick the model");
});

test("in the window, a new conversation's model pick stays with that conversation", async (t) => {
  const { app, server, answered } = await served(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const chip = page.locator('#composer [data-act="modelmenu2"]');
  await page.waitForFunction(() => /Local model|local-7b/.test(document.querySelector('#composer [data-act="modelmenu2"] .lbl')?.textContent ?? ""));
  await chip.click();
  await page.locator('#app > .pop [data-act="pick-model"][data-v="cloud"]').click();
  await page.waitForFunction(() => /Cloud model|cloud-1/.test(document.querySelector('#composer [data-act="modelmenu2"] .lbl')?.textContent ?? ""));
  assert.equal(app.runtime.models.settings(app.runtime.owner).activePreset, "local", "picking it changed nothing for other conversations");
  await page.locator("#prompt").fill("hello");
  await page.locator("#prompt").press("Enter");
  await page.locator("#conversation .b .txt").first().waitFor({ timeout: 30000 });
  assert.deepEqual(answered, ["cloud"], "the conversation answered with the model picked for it");
  const [run] = app.store.runs(app.runtime.owner);
  assert.equal(app.runtime.models.session(app.runtime.owner, run.sessionId).preset, "cloud");
  assert.equal(app.runtime.models.settings(app.runtime.owner).activePreset, "local", "the default is still the owner's");
  assert.deepEqual(errors, []);
});
