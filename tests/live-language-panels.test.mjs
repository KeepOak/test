/**
 * #152 review: words drawn by these panels follow a language change while they are open, without
 * being drawn again — the label picker's heading and new-label field, the "hold messages overnight"
 * words beside their checkbox, a chart's two buttons whichever state the numbers toggle is in, and a
 * branch's carry-back button before and after it is pressed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { finishFirstRun, showEverything } from "./places.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** The app on a free port, a headless page connected to it, and all of it cleaned up afterwards. */
async function onPage(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-live-language-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const api = async (method, path, body) => {
    const response = await fetch(server.url + path, { method,
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await finishFirstRun(page);
  await showEverything(page);
  return { app, page, api, errors };
}

const locale = async (name) => JSON.parse(await readFile(new URL(`../public/locales/${name}.json`, import.meta.url), "utf8"));

// Redesign: Coming soon (sw:lang), checked at e5b8a610: the window has no language change yet (Settings › Appearance ›
// Language is greyed out); prototype.html also has no label picker.
test.skip("open panels follow a live language change: label picker, quiet hours and a chart's buttons", async (t) => {
  const answers = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
  const { page, api, errors } = await onPage(t, answers);
  const run = (await api("POST", "/api/run", { prompt: "the loft hatch" })).body;
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#rail-list .rail-item").first().click();
  await page.waitForFunction((id) => document.getElementById("conversation")?.dataset.sessionId === id, run.sessionId, { timeout: 15000 });

  // The quiet-hours row and a chart, drawn once in English and left on the page.
  await page.evaluate(async () => {
    const { showCollab } = await import("/collab.js");
    const { drawChart } = await import("/charts.js");
    const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
    const host = el("div"); host.id = "live-language-host"; host.style.cssText = "position:fixed;left:-5000px;top:0;width:800px;pointer-events:none";
    host.append(showCollab({ collab: {} }, { el, api: async () => ({}), toast: () => {}, refresh: async () => {} }),
      drawChart({ type: "bar", title: "Rooms", data: [{ label: "Loft", value: 2 }] }));
    document.body.append(host);
  });
  // Opened last: the picker closes itself when something else on the page takes over.
  await page.locator("#thread-labels").click();
  await page.locator(".label-picker .label-picker-head").waitFor();
  const read = () => page.evaluate(() => ({
    head: document.querySelector(".label-picker .label-picker-head")?.textContent,
    field: document.querySelector(".label-picker .label-new")?.placeholder,
    quiet: document.querySelector("#live-language-host .collab-row label.check")?.textContent.trim(),
    quietBox: document.querySelectorAll("#live-language-host .collab-row label.check input[type=checkbox]").length,
    buttons: [...document.querySelectorAll("#live-language-host .chart-actions button")].map((b) => b.textContent),
  }));
  const english = await read();
  assert.deepEqual(english.buttons, ["Show the numbers", "Save as a picture"]);
  const en = await locale("en"), fr = await locale("fr");
  assert.equal(english.quiet, en["collab.quiet.overnight"], "drawn in English first");
  assert.equal(english.head, en["labels.picker.title"]);

  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  const french = await read();
  assert.equal(french.head, fr["labels.picker.title"], "the open picker's heading");
  assert.equal(french.field, fr["labels.field.new"], "the open picker's new-label field");
  assert.equal(french.quiet, fr["collab.quiet.overnight"], "the words beside the checkbox");
  assert.equal(french.quietBox, 1, "the checkbox itself stays");
  assert.deepEqual(french.buttons, [fr["charts.action.showNumbers"], fr["charts.action.savePicture"]]);

  // Back to English while the picker is still open: every marked word follows again.
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
  const back = await read();
  assert.equal(back.head, english.head);
  assert.equal(back.field, english.field);
  assert.equal(back.quiet, english.quiet);

  // Pressed in French, the toggle says the other thing; back in English it still says that thing.
  // (Pressing it is a click outside the picker, so the picker closes here, as it should.)
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.evaluate(() => document.querySelector("#live-language-host .chart-actions button").click());
  assert.equal((await read()).buttons[0], fr["charts.action.chartOnly"]);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
  assert.equal((await read()).buttons[0], en["charts.action.chartOnly"], "the toggle's current state, in the new language");
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (sw:lang), checked at e5b8a610: the window has no language change yet.
test.skip("a branch's carry-back button follows a live language change, before and after it is pressed", async (t) => {
  const answers = { name: "scripted", async complete() { return { content: "The loft answer.", toolCalls: [] }; } };
  const { app, page, errors } = await onPage(t, answers);
  const owner = app.runtime.owner;
  const root = await app.runtime.run({ prompt: "the loft hatch" });
  const point = app.store.sessionView(owner, root.sessionId).messages.find((message) => message.role === "assistant");
  const branch = app.store.branchSession(owner, { sessionId: root.sessionId, messageId: point.messageId });
  /* The branch is opened in the window, as a person would, so the window's own redraws draw its tree too:
     a tree drawn for a conversation that is not on screen is hidden by the next redraw (#152 macOS shard 2). */
  await page.evaluate((id) => import("/app.js").then((shell) => shell.openConversation(id)), branch.sessionId);
  const button = page.locator("#branch-tree button.rail-row").last();
  await button.waitFor({ state: "visible" });
  const en = await locale("en"), fr = await locale("fr");
  assert.equal(await button.textContent(), en["other.action.carryBack"], "drawn in English first");

  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  assert.equal(await button.textContent(), fr["other.action.carryBack"], "the drawn button, in French without being drawn again");

  await button.click();
  await page.waitForFunction((words) => [...document.querySelectorAll("#branch-tree button.rail-row")].some((b) => b.textContent === words),
    fr["other.status.carriedBack"]);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("en"));
  assert.equal(await button.textContent(), en["other.status.carriedBack"], "its new state, in the new language");
  assert.deepEqual(errors, []);
});
