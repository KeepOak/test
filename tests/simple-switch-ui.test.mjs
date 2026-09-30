/**
 * RES-704, Hermes' Simple mode: one click in the title row hides the developer instrumentation, and one more puts the
 * whole workspace back exactly as it was: the "How much to show" level (here Technical), the side panel and its tab,
 * kept across a reload. Choosing a level in Settings leaves Simple and is the advanced level remembered.
 * A real engine and window, a scripted model, a hidden browser.
 * Mutation: have the switch forget the level it put away (always go back to Advanced), or leave the side panel shut,
 * and the round trip goes red.
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
import { saveConversationModeSettings } from "../dist/conversation-mode.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-simple-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const context = await browser.newContext({ viewport: { width: 1400, height: 860 }, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors };
}
const saved = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("branch-window") || "{}"));
const simple = (page) => page.locator('[data-act="simple19"]');

async function chooseLevel(page, level) {
  if (!(await page.locator(".set-level").isVisible())) await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator(`[data-act="setlevel"][data-v="${level}"]`).click();
  await page.locator(`[data-act="setlevel"][data-v="${level}"][aria-pressed="true"]`).waitFor();
}

test("Simple hides the instrumentation, and Advanced puts back the level, the side panel and its tab exactly, across a reload", async (t) => {
  const { page, errors } = await fixture(t);
  await chooseLevel(page, "technical");
  await page.locator(".set-back").click();
  await page.locator("#prompt").fill("Say done.");
  await page.locator("#send").click();
  await page.locator("#conversation .b .txt").first().waitFor({ timeout: 20000 });
  await page.locator('.head [data-act="pane"][data-p="activity"]').click();
  await page.locator('#pane [data-act="ptabp"][data-p="terminal"]').click();
  await page.locator("#pane:not([hidden])").waitFor();
  assert.equal(await simple(page).getAttribute("aria-pressed"), "false");

  await simple(page).click();
  await page.locator("#app.simple19").waitFor();
  assert.equal(await simple(page).getAttribute("aria-pressed"), "true", "the switch says Simple is on");
  assert.ok(await page.locator("#pane").isHidden(), "the side panel is put away");
  for (const act of ["pane", "stage", "roster10h"]) assert.equal(await page.locator(`.head [data-act="${act}"]`).first().isVisible(), false, `${act} is out of sight`);
  assert.equal(await page.locator('#statusbar [data-act="tasks10"]').isVisible(), false, "the running-tasks chip is out of sight");
  assert.equal((await saved(page)).level, "regular", "Simple is the Regular level");

  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
  await page.locator("#app.simple19").waitFor();
  assert.equal(await simple(page).getAttribute("aria-pressed"), "true", "Simple is kept across a reload");

  await simple(page).click();
  await page.waitForFunction(() => !document.getElementById("app").classList.contains("simple19"));
  assert.equal((await saved(page)).level, "technical", "the level it was on comes back, not a default");
  assert.equal(await simple(page).getAttribute("aria-pressed"), "false");
  await page.locator('#side .row[data-id]').first().click();
  await page.locator("#pane:not([hidden])").waitFor();
  assert.equal(await page.locator('#pane [data-act="ptabp"][data-p="terminal"]').getAttribute("aria-selected"), "true", "the side panel's tab comes back");
  assert.ok(await page.locator('.head [data-act="stage"]').first().isVisible(), "the instruments are back");
  assert.deepEqual(errors, []);
});

test("choosing a level in Settings leaves Simple, and that advanced level is the one the switch remembers", async (t) => {
  const { page, errors } = await fixture(t);
  await simple(page).click();
  await page.locator("#app.simple19").waitFor();
  await chooseLevel(page, "advanced");
  await page.waitForFunction(() => !document.getElementById("app").classList.contains("simple19"));
  assert.equal((await saved(page)).simple, false, "picking a level left Simple");
  await chooseLevel(page, "technical");
  await simple(page).click();
  await page.locator("#app.simple19").waitFor();
  assert.equal(await page.locator('[data-act="setlevel"][data-v="regular"]').getAttribute("aria-pressed"), "true", "Settings shows Regular while Simple is on");
  await simple(page).click();
  await page.locator('[data-act="setlevel"][data-v="technical"][aria-pressed="true"]').waitFor();
  assert.equal((await saved(page)).advLevel, "technical");
  assert.deepEqual(errors, []);
});
