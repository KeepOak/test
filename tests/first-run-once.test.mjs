/**
 * Dogfood B7: "How should Branch think?" came back on every new conversation and covered it, although ChatGPT was
 * connected and "Done, start chatting" had been pressed. Good looks like: shown once, never again once a model works.
 * The first answer from a real model ends setup; the offline demonstration does not.
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

const answering = { name: "answering", async complete() { return { content: "Hello there.", toolCalls: [], usage: { input: 20, output: 3 } }; } };

async function fixture(t, presets) {
  const root = await mkdtemp(join(tmpdir(), "branch-setup-once-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(presets ? { presets } : {}) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const onboarding = async () => (await (await fetch(server.url + "/api/state", { headers: { authorization: "Bearer " + server.token } })).json()).onboarding;
  return { app, server, onboarding };
}

test("the first answer from a real model ends setup, without the owner pressing Done", async (t) => {
  const { app, onboarding } = await fixture(t, [{ id: "good", name: "Good model", provider: answering, model: "g-1" }]);
  assert.equal((await onboarding()).done, false, "control: a new Branch shows the card");
  await app.runtime.run({ prompt: "hello" });
  assert.equal((await onboarding()).done, true);
});

test("an empty reply is no answer: it does not end setup (NAS ca8db88)", async (t) => {
  const empty = { name: "empty", async complete() { return { content: "", toolCalls: [], usage: { input: 5, output: 0 } }; } };
  const { app, onboarding } = await fixture(t, [{ id: "empty", name: "Empty model", provider: empty, model: "e-1" }]);
  await app.runtime.run({ prompt: "hello" }).catch(() => undefined);
  assert.equal((await onboarding()).done, false);
});

test("the offline demonstration answering does not end setup", async (t) => {
  const { app, onboarding } = await fixture(t);
  assert.equal(app.runtime.provider.name, "offline-demo-fixture", "control: this Branch has only the demonstration");
  await app.runtime.run({ prompt: "hello" });
  assert.equal((await onboarding()).done, false);
});

/* Redesign: in the new window the first-run card is "Set up Branch" (flows/setup.js, the .ob9 dialog), opened by itself
   once, a moment after the first draw, while the engine's setup is not done and this window has not shown it yet
   (flows/flows.js checkFirstRun). The window leaves it closed under automation (navigator.webdriver), so the test
   pages below say they are not automated, as a person's browser does. */
async function personWindow(browser, server) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block" });
  await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "webdriver", { get: () => false }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors };
}
const setupCard = (page) => page.getByRole("dialog", { name: "Set up Branch" });
/** It opens a moment after the window is drawn, so "not shown" is read once that moment has passed. */
const shownAfterAMoment = async (page) => { await page.waitForTimeout(1500); return setupCard(page).isVisible(); };

test("in the window, the card goes once a model has answered and a new conversation does not bring it back", async (t) => {
  const { server, onboarding } = await fixture(t, [{ id: "good", name: "Good model", provider: answering, model: "g-1" }]);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const { page, errors } = await personWindow(browser, server);
  await setupCard(page).waitFor({ state: "visible", timeout: 10000 });
  // The owner leaves setup without finishing it, and writes straight away.
  // Redesign: Skip for now shows only after Welcome (35e53413), so the owner ticks the trust box and starts first.
  await page.locator("#ob-trust").check();
  await page.locator('[data-act="ob-next"]').click();
  await page.getByRole("button", { name: "Skip for now", exact: true }).click();
  await setupCard(page).waitFor({ state: "detached" });
  await page.locator("#prompt").fill("hello");
  await page.locator("#send").click();
  await page.locator("#conversation").getByText("Hello there.").first().waitFor({ timeout: 20000 });
  assert.equal((await onboarding()).done, true, "the first answer ended setup");
  await page.keyboard.press("ControlOrMeta+N");
  await page.waitForFunction(() => !document.querySelector("#conversation .b"), null, { timeout: 10000 });
  assert.equal(await shownAfterAMoment(page), false, "a new conversation does not bring it back");
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  assert.equal(await shownAfterAMoment(page), false, "a reloaded window does not show it either");
  // A window that never showed it (another browser, nothing remembered) does not show it once a model has answered.
  const other = await personWindow(browser, server);
  assert.equal(await shownAfterAMoment(other.page), false, "a fresh window does not show it once a model has answered");
  assert.deepEqual(errors, []);
  assert.deepEqual(other.errors, []);
});
