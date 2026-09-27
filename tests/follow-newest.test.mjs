/**
 * Dogfood B4 and B5, in a real window with Show everything on (as the owner uses it):
 * - the question a task stops on ("It needs your answer") sits under the conversation, where the work is, not above
 *   its first message;
 * - sending goes to the newest message, and the view keeps up with the answer, unless the person has scrolled up
 *   to read.
 *
 * Redesign: the new window (public/app/chat/chat.js). The conversation scrolls in #scroll; the person's messages are
 * #conversation > .u and the replies #conversation > .b (the question card sits in one too); a conversation is opened
 * from its row in the sidebar list. The window draws the open conversation again on every answer and whenever the
 * person causes a redraw, which is where "more arriving" happens now. The old window's internal follow flag
 * (globalThis.branchFollowNewest) is replaced by the new window: what it stood for is checked by where the view is.
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

async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-follow-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 700 }, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}
const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} of a long answer, with enough words to take a line.`).join("\n\n");
const gap = (page) => page.evaluate(() => { const box = document.getElementById("scroll"); return box.scrollHeight - box.scrollTop - box.clientHeight; });
const top = (page) => page.evaluate(() => document.getElementById("scroll").scrollTop);
const REPLIES = "#conversation > .b .txt";
async function send(page, words) {
  const before = await page.locator(REPLIES).count();
  await page.locator("#prompt").fill(words);
  await page.locator("#send").click();
  await page.waitForFunction(([n, css]) => document.querySelectorAll(css).length > n, [before, REPLIES], { timeout: 20000 });
  await page.waitForFunction(() => !document.getElementById("send").disabled, null, { timeout: 20000 });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function scrollUp(page) {
  const box = await page.locator("#scroll").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  for (let i = 0; i < 20 && await top(page) > 0; i += 1) await page.mouse.wheel(0, -2000);
}
const row = (page, words) => page.locator('#side [data-act="chat"]').filter({ hasText: words });
/* A redraw of the open conversation, as the person causes one (switching light or dark draws the window again), with a
   control that the conversation really was drawn again. */
async function redrawn(page) {
  await page.evaluate(() => { globalThis.__draws = 0; new MutationObserver(() => globalThis.__draws++).observe(document.getElementById("main"), { childList: true }); });
  // Redesign: since #341, an unchanged view is redrawn only after the person acts in it.
  // Dispatch a click on #scroll before the theme flip.
  await page.locator('#scroll').dispatchEvent('click');
  await page.locator('#tbActions [data-act="theme-flip"]').click();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.ok(await page.evaluate(() => globalThis.__draws) > 0, "control: the conversation was drawn again");
}

test("B4 the question a task stops on sits under the conversation, where the work is", async (t) => {
  let asked = 0;
  const { page, errors } = await fixture(t, { name: "scripted", async complete() {
    asked += 1;
    return asked === 1 ? { content: long, toolCalls: [] }
      : asked === 2 ? { content: "", toolCalls: [{ id: "c1", name: "files.write", arguments: JSON.stringify({ path: "gated.txt", content: "x" }) }] }
        : { content: "Done.", toolCalls: [] };
  } });
  await send(page, "Tell me a long story first.");
  await page.evaluate(async () => {
    await fetch("/api/policy", { method: "POST", headers: { authorization: "Bearer " + sessionStorage.getItem("branch-token"), "content-type": "application/json" },
      body: JSON.stringify({ preset: "ask-before-changes" }) });
  });
  await page.locator("#prompt").fill("Now write a gated file.");
  await page.locator("#send").click();
  await page.locator("#live-ask").waitFor({ state: "visible", timeout: 20000 });
  const where = await page.evaluate(() => {
    const ask = document.getElementById("live-ask").getBoundingClientRect();
    const messages = [...document.querySelectorAll("#conversation > .u, #conversation > .b")].filter((node) => !node.querySelector("#live-ask"));
    return { askTop: ask.top, firstTop: messages[0].getBoundingClientRect().top, lastBottom: messages.at(-1).getBoundingClientRect().bottom };
  });
  assert.ok(where.askTop > where.firstTop, `the card is not above the first message (${where.askTop} vs ${where.firstTop})`);
  assert.ok(where.askTop >= where.lastBottom - 1, `the card is under the last message (${where.askTop} vs ${where.lastBottom})`);
  assert.ok(await page.locator("#live-ask").isVisible() && (await gap(page)) <= 80, "and it is on screen: the view followed it down");
  assert.deepEqual(errors, []);
});

test("B5 sending and the answer follow the newest message, unless the person has scrolled up to read", async (t) => {
  const { page, errors } = await fixture(t, { name: "scripted", async complete() { return { content: long, toolCalls: [] }; } });
  await send(page, "First, a long answer please.");
  assert.ok((await gap(page)) <= 80, `after the answer the view is at the newest message (${await gap(page)} px above the bottom)`);
  // Reading further up is left alone while more arrives.
  // Scrolled up with the wheel, as a person does.
  await scrollUp(page);
  assert.equal(await top(page), 0, "control: reading from the top");
  await redrawn(page);
  assert.equal(await top(page), 0, "someone reading further up is not pulled away");
  // Sending goes back to the bottom and follows the next answer.
  await send(page, "And another.");
  assert.ok((await gap(page)) <= 80, `sending went to the newest message (${await gap(page)} px above the bottom)`);
  assert.deepEqual(errors, []);
});

test("B5 a real answer landing does not pull someone reading further up down (NAS 545cb4d)", async (t) => {
  let release = null, calls = 0;
  const { page, errors } = await fixture(t, { name: "scripted", async complete() {
    calls += 1;
    // The second answer waits until the person has scrolled up to read.
    if (calls > 1) await new Promise((resolve) => { release = resolve; });
    return { content: long, toolCalls: [] };
  } });
  await send(page, "First, a long answer please.");
  await page.locator("#prompt").fill("And a second one.");
  await page.locator("#send").click();
  for (let i = 0; i < 100 && !release; i += 1) await page.waitForTimeout(50);
  assert.ok(release, "control: the second answer is on its way");
  await scrollUp(page);
  assert.equal(await top(page), 0, "control: reading from the top");
  release();
  await page.waitForFunction((css) => document.querySelectorAll(css).length >= 2, REPLIES, { timeout: 20000 });
  await page.waitForTimeout(800);
  assert.equal(await top(page), 0, "the answer landing leaves the reader where they are");
  assert.deepEqual(errors, []);
});

test("B5 opening a conversation from Recents in a fresh window starts at its newest message", async (t) => {
  const { page, errors } = await fixture(t, { name: "scripted", async complete() { return { content: long, toolCalls: [] }; } });
  await send(page, "A long answer to come back to.");
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await row(page, "A long answer to come back to").waitFor({ timeout: 20000 });
  await row(page, "A long answer to come back to").click();
  await page.waitForFunction((css) => document.querySelectorAll(css).length >= 1, REPLIES, { timeout: 20000 });
  await page.waitForTimeout(500);
  assert.ok((await gap(page)) <= 80, `opened at the newest message (${await gap(page)} px above the bottom)`);
  assert.deepEqual(errors, []);
});

test("Q197 Shift+Space, and a key pressed with the focus on the page itself, count as reading up (NAS b613f63)", async (t) => {
  const { page, errors } = await fixture(t, { name: "scripted", async complete() { return { content: long, toolCalls: [] }; } });
  await send(page, "A long answer please.");
  // The window reloads the conversation after an answer lands: wait until the page is quiet, so that redraw's own
  // scroll cannot land between a key and the check that follows it.
  // (The page keeps polling, so it is never network-idle: quiet here means its height held for two looks in a row.)
  for (let still = 0, tries = 0; still < 2 && tries < 40; tries++)
    still = await page.evaluate(() => new Promise((resolve) => {
      const box = document.getElementById("scroll"), before = box.scrollHeight;
      setTimeout(() => resolve(box.scrollHeight === before), 400);
    })) ? still + 1 : 0;
  assert.ok((await gap(page)) <= 80, "control: following after the answer");
  await page.locator("#conversation").click();
  await page.keyboard.press("Shift+Space");
  await page.waitForTimeout(300);
  const read = await top(page);
  assert.ok((await gap(page)) > 80, "control: Shift+Space scrolled up");
  await redrawn(page);
  assert.equal(await top(page), read, "Shift+Space in the conversation counts as reading: a redraw leaves the view");
  await page.evaluate(() => document.getElementById("scroll").scrollTo(0, document.getElementById("scroll").scrollHeight));
  await page.evaluate(() => { document.activeElement?.blur(); });
  await page.keyboard.press("PageUp");
  await page.waitForTimeout(300);
  const paged = await top(page);
  assert.ok((await gap(page)) > 80, "control: PageUp scrolled up");
  await redrawn(page);
  assert.equal(await top(page), paged, "PageUp with the focus on the page itself counts as reading");
  assert.deepEqual(errors, []);
});

test("Q198 a conversation opened from Recents after a scroll up on the empty screen starts at its newest message (NAS e87c522)", async (t) => {
  const { page, errors } = await fixture(t, { name: "scripted", async complete() { return { content: long, toolCalls: [] }; } });
  await send(page, "A long answer to come back to.");
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  // A wheel turned upward over the empty screen.
  await page.evaluate(() => document.getElementById("scroll").dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true })));
  await row(page, "A long answer to come back to").waitFor({ timeout: 20000 });
  await row(page, "A long answer to come back to").click();
  await page.waitForFunction((css) => document.querySelectorAll(css).length >= 1, REPLIES, { timeout: 20000 });
  await page.waitForTimeout(500);
  assert.ok((await gap(page)) <= 80, `opened at the newest message (${await gap(page)} px above the bottom)`);
  assert.deepEqual(errors, []);
});

// NAS f050949: a submit that sends nothing (a slash command, a box of spaces, a first send that fails) left the send
// flag set, so after a wheel up the next conversation opened from Recents started at its top.
test("a slash command on the empty screen leaves no send under way: Recents still opens at the newest message", async (t) => {
  const { page, errors } = await fixture(t, { name: "scripted", async complete() { return { content: long, toolCalls: [] }; } });
  await send(page, "A long answer to open again.");
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  let runs = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/run")) runs += 1; });
  await page.locator("#prompt").fill("/help");
  // Redesign: in the prototype, the first Enter picks the command from the / list and the second runs it.
  await page.locator("#prompt").press("Enter");
  await page.locator("#prompt").press("Enter");
  await page.waitForFunction(() => document.getElementById("prompt").value === "", null, { timeout: 20000 });
  await page.waitForFunction(() => !document.getElementById("send").disabled, null, { timeout: 20000 });
  assert.equal(runs, 0, "control: nothing was sent to the model as a message");
  await page.evaluate(() => document.getElementById("scroll").dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true })));
  await row(page, "A long answer to open again").waitFor({ timeout: 20000 });
  await row(page, "A long answer to open again").click();
  await page.waitForFunction((css) => document.querySelectorAll(css).length >= 1, REPLIES, { timeout: 20000 });
  await page.waitForTimeout(500);
  assert.ok((await gap(page)) <= 80, `opened at the newest message (${await gap(page)} px above the bottom)`);
  assert.deepEqual(errors, []);
});

// NAS de61b26: the failed-first-send third of f050949's LOW had no test. A first send that fails ends in the send's
// `finally`, so the flag clears and the next conversation opened from Recents starts at its newest message.
test("a first send that fails leaves no send under way: Recents still opens at the newest message", async (t) => {
  const { page, errors } = await fixture(t, { name: "scripted", async complete() { return { content: long, toolCalls: [] }; } });
  await send(page, "A long answer after a failed send.");
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  let refused = 0;
  await page.route("**/api/run", (route) => { refused += 1; return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "The service is not answering." }) }); });
  await page.locator("#prompt").fill("This first send fails.");
  await page.locator("#prompt").press("Enter");
  await page.waitForFunction(() => /not answering/.test(document.getElementById("conversation").textContent), null, { timeout: 20000 });
  await page.unroute("**/api/run");
  assert.equal(refused, 1, "control: the send was tried and refused");
  await page.waitForFunction(() => !document.getElementById("send").disabled, null, { timeout: 20000 });
  await page.evaluate(() => document.getElementById("scroll").dispatchEvent(new WheelEvent("wheel", { deltaY: -300, bubbles: true })));
  await row(page, "A long answer after a failed send").waitFor({ timeout: 20000 });
  await row(page, "A long answer after a failed send").click();
  await page.waitForFunction((css) => document.querySelectorAll(css).length >= 1
    && !/not answering/.test(document.getElementById("conversation").textContent), REPLIES, { timeout: 20000 });
  await page.waitForTimeout(500);
  assert.ok((await gap(page)) <= 80, `opened at the newest message (${await gap(page)} px above the bottom)`);
  assert.deepEqual(errors, []);
});
