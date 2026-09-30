/**
 * QA retest 2026-09-28 (S2): in Automations, words the engine could not read as a schedule were gone from the box by
 * the time the refusal showed, because the page is drawn anew while the model reads them and the box was drawn empty.
 * The box now keeps its words, for each tab, through the refusal and through any redraw, and is cleared only once a
 * schedule or trigger is saved. Node only: the real dist/ and public/, a scripted model, headless Chromium, port 0.
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

/* A model that never reads words as a schedule, so every entry here is refused. */
const unreadable = { name: "scripted", async complete() { return { content: "not a schedule", toolCalls: [] }; } };

async function signedIn(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-box-words-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: unreadable });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#main").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors };
}

const openTab = (page, tab) => page.evaluate(async (tab) => {
  const [{ S }, { renderNow }] = await Promise.all([import("/app/core/state.js"), import("/app/core/dom.js")]);
  S.view = "automations";
  S.tabs.automations = tab;
  renderNow();
}, tab);

test("words the engine refuses stay in the box, through redraws and tab changes, each tab with its own", async (t) => {
  const { page, errors } = await signedIn(t);
  await openTab(page, "scheduled");
  const box = page.locator("#nl-in");
  await box.fill("when a receipt arrives in my email, file it");
  const refused = page.waitForResponse((r) => r.url().endsWith("/api/schedules/propose"), { timeout: 60000 });
  await page.locator('[data-act="nl-add"]').click();
  assert.equal((await refused).status() >= 400, true, "control: the engine refused the words");
  await page.waitForTimeout(500);
  await page.evaluate(async () => (await import("/app/core/dom.js")).renderNow());
  assert.equal(await box.inputValue(), "when a receipt arrives in my email, file it", "the refused words are still there to fix");
  assert.equal(await page.locator('[data-act="nl-add"]').isDisabled(), false, "and Add can be pressed again");

  await openTab(page, "triggers");
  assert.equal(await page.locator("#nl-in").inputValue(), "", "the Triggers box has its own words, none yet");
  await page.locator("#nl-in").fill("when a task finishes, tell me");
  await openTab(page, "scheduled");
  assert.equal(await page.locator("#nl-in").inputValue(), "when a receipt arrives in my email, file it", "back on Scheduled, its words");
  await openTab(page, "triggers");
  assert.equal(await page.locator("#nl-in").inputValue(), "when a task finishes, tell me", "and Triggers keeps its own");

  await page.locator("#nl-in").fill("");
  await openTab(page, "triggers");
  assert.equal(await page.locator('[data-act="trig-add"]').isDisabled(), true, "an emptied box stays empty, Add waits for words");
  assert.deepEqual(errors, []);
});
