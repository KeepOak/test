/**
 * SELF-065 review of #1157, the window's side of the task-settings card.
 * P1: the dialog repeats the owner's typed request, so an answer that arrives after App lock or a profile switch must
 * not open it. P3: the proposal checkboxes are live controls the owner can tick; a pinned one stays disabled.
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
import { waitInPage } from "./wait-in-page.mjs";

const REQUEST = "Please debug and trace why the export is slow";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-task-settings-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  // Both ship on; switched off here, so the card suggests them for a slow, traced task.
  for (const key of ["run-recording", "event-loop-watch"]) app.store.save("settings", app.runtime.owner, key, { mode: "off" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, serviceWorkers: "block" });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120_000 });
  await page.locator("#prompt").fill(REQUEST);
  return { app, server, page };
}

/* Holds the task-preview answer until the test lets it go, and says when the window has asked. */
async function holdPreview(page) {
  let release, asked;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = new Promise((resolve) => { asked = resolve; });
  await page.route("**/api/settings-kit/task-preview", async (route) => { asked(); await gate; await route.continue(); });
  return { release, seen };
}

/* After the held answer has reached the window, gives its handler time to run, then reads whether the dialog opened. */
async function openedAfter(page, release) {
  const answered = page.waitForResponse((response) => response.url().includes("/api/settings-kit/task-preview"));
  release();
  await answered;
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  return page.evaluate((words) => [...document.querySelectorAll(".dlg")].some((box) => box.textContent.includes(words)), REQUEST);
}

test("#1157 P1: a task-settings answer that arrives after App lock does not open the owner's request", async (t) => {
  const { page } = await fixture(t);
  const { release, seen } = await holdPreview(page);
  await page.locator('#composer [data-act="task-settings-open"]').click();
  await seen;
  await page.evaluate(async () => (await import("/app/shell/applock.js")).showLock());
  assert.equal(await openedAfter(page, release), false, "the private request opened in a dialog over the lock screen");
});

test("#1157 P1: a task-settings answer that arrives after a profile switch does not open the owner's request", async (t) => {
  const { page } = await fixture(t);
  const { release, seen } = await holdPreview(page);
  await page.locator('#composer [data-act="task-settings-open"]').click();
  await seen;
  // What main.js does when GET /api/profiles names somebody else: the window's profile record changes.
  await page.evaluate(async () => {
    const { E } = await import("/app/core/state.js");
    E.profiles = { ...E.profiles, active: { id: "someone-else", name: "Someone else" }, isOwner: false };
  });
  assert.equal(await openedAfter(page, release), false, "the owner's request opened for another profile");
});

test("#1157 P3: the suggested settings can be ticked and applied; a pinned one stays disabled", async (t) => {
  const { app, server, page } = await fixture(t);
  const pinned = await fetch(new URL("/api/settings-kit/pins", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.url },
    body: JSON.stringify({ key: "event-loop-watch", field: "mode", pinned: true }) });
  assert.equal(pinned.status, 200, await pinned.text());
  await page.locator('#composer [data-act="task-settings-open"]').click();
  const box = page.locator(".dlg", { hasText: REQUEST });
  await box.waitFor({ state: "visible" });
  const states = await box.locator("[data-task-setting]").evaluateAll((inputs) =>
    inputs.map((input) => ({ id: input.dataset.taskSetting, disabled: input.disabled })));
  const free = states.find((state) => state.id.startsWith("run-recording"));
  const held = states.find((state) => state.id.startsWith("event-loop-watch"));
  assert.ok(free && held, JSON.stringify(states));
  assert.equal(free.disabled, false, "the unpinned suggestion was greyed out");
  assert.equal(held.disabled, true, "the pinned suggestion could be ticked");
  await box.locator(`[data-task-setting="${free.id}"]`).check();
  await box.locator('[data-act="task-settings-apply"]').click();
  await waitInPage(page, () => !document.querySelector(".dlg"));
  assert.equal(app.store.get("settings", app.runtime.owner, "run-recording")?.data?.mode, "when-needed");
  assert.equal(app.store.get("settings", app.runtime.owner, "event-loop-watch")?.data?.mode, "off", "the pinned setting changed");
});
