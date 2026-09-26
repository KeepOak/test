/* The owner: "any time I click something in Settings it takes me back up". A click in a page makes its next draw a fresh
   one, and a fresh draw put the page's scroll box back at the top. A redraw of the same page now keeps where its boxes
   were scrolled (public/app/main.js scrolledBoxes, putBack), the pressed control keeps the focus (core/dom.js keepFocus),
   and the choice is still saved, as a reload shows.
   Mutation: in public/app/main.js drop the putBack(main, at) call, and every case here goes red. */
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
  const root = await mkdtemp(join(tmpdir(), "branch-settings-scroll-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  // A short window, so each page scrolls.
  const page = await browser.newPage({ viewport: { width: 1280, height: 560 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const call = (path, body) => fetch(new URL(`/api/${path}`, server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { page, errors, call };
}

async function openPage(page, id) {
  if (!(await page.locator(".settings").count())) await page.locator('#side [data-act="view"][data-v="settings"]').first().click();
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).click();
  await page.locator(`[data-act="setpage"][data-v="${id}"][aria-current="true"]`).waitFor();
  await page.waitForTimeout(1200); // the page's own read of the engine, and its redraw
}

/* Scrolls the page down until the control sits near the top of the view, presses it with the mouse, and answers where
   the page was scrolled before and after the redraw the press causes. */
async function pressScrolled(page, selector) {
  await page.evaluate((selector) => {
    const box = document.querySelector(".set-page"), el = document.querySelector(selector);
    box.scrollTop = Math.max(0, el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - 40);
  }, selector);
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => document.querySelector(".set-page").scrollTop);
  const at = await page.locator(selector).boundingBox();
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await page.waitForTimeout(1500);
  const after = await page.evaluate(() => document.querySelector(".set-page").scrollTop);
  const focused = await page.evaluate((selector) => document.activeElement === document.querySelector(selector), selector);
  return { before, after, focused };
}

async function reopen(page, id) {
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 60000 });
  await openPage(page, id);
}

test("Settings › Branch itself: choosing Ask me first keeps the page where it was, and is saved", async (t) => {
  const { page, errors } = await signedIn(t);
  await openPage(page, "self");
  const choice = '.set-col [data-act="self-upd"][data-v="check"]';
  const { before, after, focused } = await pressScrolled(page, choice);
  assert.ok(before > 0, "the page was scrolled down");
  assert.ok(Math.abs(after - before) <= 2, `the page stayed at ${before}, not ${after}`);
  assert.ok(focused, "the pressed control keeps the focus");
  assert.equal(await page.locator(choice).getAttribute("aria-pressed"), "true");
  await reopen(page, "self");
  await page.locator(`${choice}[aria-pressed="true"]`).waitFor({ timeout: 15000 }); // the choice was saved in the engine
  assert.deepEqual(errors, []);
});

test("Settings › Appearance: choosing a conversation width keeps the page where it was, and is saved", async (t) => {
  const { page, errors } = await signedIn(t);
  await openPage(page, "appearance");
  const choice = '.set-col [data-act="widthset"][data-v="full"]';
  const { before, after, focused } = await pressScrolled(page, choice);
  assert.ok(before > 0, "the page was scrolled down");
  assert.ok(Math.abs(after - before) <= 2, `the page stayed at ${before}, not ${after}`);
  assert.ok(focused, "the pressed control keeps the focus");
  assert.equal(await page.locator(choice).getAttribute("aria-pressed"), "true");
  await reopen(page, "appearance");
  await page.locator(`${choice}[aria-pressed="true"]`).waitFor({ timeout: 15000 }); // the choice was saved
  assert.deepEqual(errors, []);
});

test("Settings › Permissions: a switch keeps the page where it was, and is saved", async (t) => {
  const { page, errors, call } = await signedIn(t);
  // Sending messages is allowed first, through the engine (with the yes a loosening needs), so the press here turns it
  // off: tightening, which asks nothing, where turning it on opens the "less careful" confirmation instead.
  assert.equal((await call("approvals/categories", { message: "allow", confirmLoosening: true })).status, 200);
  await openPage(page, "permissions");
  const choice = ".set-col #p-send";
  await page.waitForFunction((choice) => document.querySelector(choice)?.checked, choice, { timeout: 15000 }); // the page's read of the engine
  const { before, after, focused } = await pressScrolled(page, choice);
  assert.ok(before > 0, "the page was scrolled down");
  assert.ok(Math.abs(after - before) <= 2, `the page stayed at ${before}, not ${after}`);
  assert.ok(focused, "the pressed control keeps the focus");
  assert.equal(await page.locator(choice).isChecked(), false);
  const decision = await page.evaluate(async () => {
    const answer = await fetch("/api/approvals/categories", { headers: { authorization: `Bearer ${sessionStorage.getItem("branch-token")}` } });
    return (await answer.json()).categories.find((c) => c.id === "message")?.decision;
  });
  assert.notEqual(decision, "allow", "the switch was saved in the engine");
  assert.deepEqual(errors, []);
});
