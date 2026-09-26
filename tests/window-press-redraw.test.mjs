/* A person's press lasts 80-200 ms. The window used to draw the sidebar, the title bar and the status bar anew on every
   redraw, and a redraw that landed between pointerdown and pointerup (an engine event, a poll) replaced the button under
   the pointer, so the press never became a click: the Places header, a conversation row and the title bar's buttons
   "only worked sometimes". A region is now drawn again only when its markup changed, and never under a press
   (public/app/core/dom.js paintChanged, pressIn).
   Mutation: in public/app/core/dom.js make paintChanged always paint (drop the unchanged check and the pressIn check),
   and every case here goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

async function signedIn(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-press-redraw-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const owner = app.runtime.owner;
  const sessions = [];
  for (const words of ["First conversation", "Second conversation"]) {
    const run = app.store.createRun(owner, words);
    app.store.message(run.sessionId, { role: "user", content: words });
    app.store.message(run.sessionId, { role: "assistant", content: "Done." });
    app.store.finish(run.id, "completed", "Done.");
    sessions.push(run.sessionId);
  }
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
  await page.locator(`#side [data-act="chat"][data-id="${sessions[0]}"]`).waitFor({ state: "visible", timeout: 120000 });
  return { page, sessions, errors };
}

/* Holds a real mouse press on the control for 150 ms while the window redraws; `change` also changes what the sidebar
   shows first (a conversation's last line, as a new message does), so the sidebar's markup really differs. */
async function pressDuringRedraw(page, selector, change) {
  const box = await page.locator(selector).first().boundingBox();
  assert.ok(box, `${selector} is on screen`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(async (change) => {
    const [{ E }, { renderNow }] = await Promise.all([import("/app/core/state.js"), import("/app/core/dom.js")]);
    if (change) E.sessions[0].lastMessage = `${E.sessions[0].lastMessage ?? ""} and more`;
    renderNow();
  }, change);
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(300);
}

test("a press on the Places header still folds it when a redraw lands mid-press", async (t) => {
  const { page, errors } = await signedIn(t);
  const header = '#side [data-act="places14"]';
  for (const change of [false, true, false, true]) {
    const before = await page.locator(header).getAttribute("aria-expanded");
    await pressDuringRedraw(page, header, change);
    assert.notEqual(await page.locator(header).getAttribute("aria-expanded"), before, `the press folded or unfolded Places (sidebar changed: ${change})`);
  }
  assert.deepEqual(errors, []);
});

test("a press on a conversation row still opens it when a redraw lands mid-press", async (t) => {
  const { page, sessions, errors } = await signedIn(t);
  for (const [i, change] of [[1, true], [0, false], [1, false], [0, true]]) {
    const row = `#side [data-act="chat"][data-id="${sessions[i]}"]`;
    await pressDuringRedraw(page, row, change);
    await page.waitForFunction((row) => document.querySelector(row)?.getAttribute("aria-current") === "true", row, { timeout: 5000 });
  }
  assert.deepEqual(errors, []);
});

test("a press on a title bar button still works when a redraw lands mid-press", async (t) => {
  const { page, errors } = await signedIn(t);
  const hidden = () => page.evaluate(() => document.getElementById("app").classList.contains("side-hidden"));
  for (const change of [true, false]) {
    const before = await hidden();
    await pressDuringRedraw(page, '.titlebar [data-act="side-toggle"]', change);
    assert.notEqual(await hidden(), before, `the press showed or hid the list (sidebar changed: ${change})`);
  }
  assert.deepEqual(errors, []);
});
