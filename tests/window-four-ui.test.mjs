/**
 * The four window features together (RES-701 Home panel, RES-702 Ctrl+Enter, RES-703 panes, RES-704 Simple): Simple
 * folds the panes and the Home panel away and Advanced brings both back as they were; Ctrl+Enter while another pane is
 * active writes to that pane, never to a new background conversation. A real engine and window, a scripted model, a
 * hidden browser.
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

function seedTopic(app, thing) {
  const run = app.store.createRun(app.runtime.owner, `Tell me about ${thing}`);
  app.store.message(run.sessionId, { role: "user", content: `Tell me about ${thing}` });
  app.store.message(run.sessionId, { role: "assistant", content: `Here is what I know about ${thing}.` });
  app.store.finish(run.id, "completed", `Here is what I know about ${thing}.`);
  return run.sessionId;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-four-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete(request) { return { content: `Heard: ${[...request.messages].reverse().find((m) => m.role === "user")?.content}`, toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const ids = { pears: seedTopic(app, "pears"), plums: seedTopic(app, "plums") };
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 }, serviceWorkers: "block" })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors, ids };
}
async function pearsBeside(page, ids) {
  await page.locator(`#side [data-act="chat"][data-id="${ids.plums}"]`).click();
  await page.locator("#conversation").getByText("Here is what I know about plums.").waitFor();
  await page.locator(`#side [data-act="chat"][data-id="${ids.pears}"]`).click({ button: "right" });
  await page.locator(`.pop [data-act="pane-add"][data-id="${ids.pears}"]`).click();
  await page.locator(`.pn19[data-pane="${ids.pears}"]`).getByText("Here is what I know about pears.").waitFor();
}

test("Simple folds the panes and the Home panel away, and Advanced brings both back as they were", async (t) => {
  const { page, errors, ids } = await fixture(t);
  await pearsBeside(page, ids);
  await page.locator('.titlebar [data-act="home19"]').click();
  await page.locator("#home19 .hm19").waitFor();
  await page.locator('[data-act="simple19"]').click();
  await page.locator("#app.simple19").waitFor();
  assert.equal(await page.locator(".pn19").count(), 0, "the main conversation alone");
  assert.ok(await page.locator("#home19").isHidden(), "the Home panel is put away");
  await page.locator('[data-act="simple19"]').click();
  await page.locator(`.pn19[data-pane="${ids.pears}"]`).waitFor();
  await page.locator("#home19 .hm19").waitFor();
  assert.deepEqual(errors, []);
});

test("Ctrl+Enter while another pane is active writes to that pane, not to a new background conversation", async (t) => {
  const { app, page, errors, ids } = await fixture(t);
  await pearsBeside(page, ids);
  await page.locator('[data-act="newconv"], [data-act="newmenu"]').first().click();
  if (await page.locator('.pop [data-act="newconv"]').count()) await page.locator('.pop [data-act="newconv"]').click();
  await page.locator(".empty-chat").waitFor();
  await page.locator(`.pn19[data-pane="${ids.pears}"] .bs-body15`).hover();
  await page.locator(`.pn19.on19[data-pane="${ids.pears}"]`).waitFor();
  const before = app.store.runs(app.runtime.owner).length;
  await page.locator("#prompt").fill("Which pear first?");
  await page.locator("#prompt").press("Control+Enter");
  await page.locator(`.pn19[data-pane="${ids.pears}"]`).getByText("Heard: Which pear first?").waitFor({ timeout: 60000 });
  const runs = app.store.runs(app.runtime.owner);
  assert.equal(runs.length, before + 1);
  assert.equal(runs.find((r) => r.prompt === "Which pear first?")?.sessionId, ids.pears, "it went to the pears conversation");
  assert.deepEqual(errors, []);
});
