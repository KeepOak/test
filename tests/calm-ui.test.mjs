/* 0.18.1: the calm window. One question and one box by default; every other control is still on the
   page with its id, behind More or shown only when it matters; "Show everything" brings them back and
   is remembered for the person. (public/layout.js "the calm window", public/layout.css, public/appearance.js) */
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

/** A model that answers at once, or waits for `release()` when asked to sort the Downloads folder. */
function slowModel() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = {
    name: "scripted",
    async complete(request) {
      const asked = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      if (String(asked).includes("Downloads")) await gate;
      return { content: "Done. Nothing was deleted.", toolCalls: [] };
    },
  };
  return { provider, release: () => release() };
}

async function fixture(t, { provider, onboarded = false, width = 1440, height = 950 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-calm-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  /* Redesign phase 1: a conversation begun in the window starts on Ask first. These tests are about
     something else, so their conversations follow the setting as before (tests/conversation-mode.test.mjs
     covers Ask first). */
  saveConversationModeSettings(app.store, app.runtime.owner, { newConversation: "follow" });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width, height }, serviceWorkers: "block" });
  t.after(async () => {
    await context.close();
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  if (onboarded) await call("/api/onboarding", { done: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { page, server, call, errors, app };
}
const visible = (page, selector) => page.locator(selector).first().isVisible();
/**
 * Where things are, measured in one step inside the page once the layout has settled: the fonts are
 * in and two frames running draw every box in the same place. Reading boxes one call at a time, or
 * after a guessed pause, can catch the page between a font arriving and it being drawn again.
 */
async function settledBoxes(page, selectors) {
  // Not waitForFunction: it does not wait on a promise, so an async check "passes" at once with
  // whatever it resolves to, null included. Each try is one step inside the page; try until settled.
  const deadline = Date.now() + 15000;
  for (;;) {
    const boxes = await page.evaluate(async (names) => {
      await document.fonts.ready;
      const read = () => names.map((name) => {
        const box = [...document.querySelectorAll(name)].at(-1)?.getBoundingClientRect(); // the last one named
        return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
      });
      const frame = () => new Promise((done) => requestAnimationFrame(() => done()));
      await frame();
      const first = read();
      await frame();
      const second = read();
      return second.every(Boolean) && JSON.stringify(first) === JSON.stringify(second) ? second : null;
    }, selectors);
    if (boxes) return boxes;
    if (Date.now() > deadline) throw new Error(`the layout never settled for ${selectors.join(", ")}`);
  }
}
async function shown(page, selectors) {
  const out = {};
  for (const selector of selectors) out[selector] = await visible(page, selector);
  return out;
}

/* Redesign: the side panel (public/app/chat/pane.js, design doc 4.6) opens from the conversation's own button
   (data-act="pane"); its Activity tab shows the task running now and goes quiet when it finishes. Sliding in and out by
   itself is the old calm window's (replaced by the new window: the prototype opens it from the button). The allowed
   list is not in the prototype's panel (replaced). Stop in Send's place is read last. */
test("the activity panel slides in while a task runs and away when it finishes", async (t) => {
  const model = slowModel();
  t.after(() => model.release()); // registered before the fixture, so a failure never leaves the model holding Branch open
  const f = await fixture(t, { provider: model.provider, onboarded: true });
  assert.equal(await f.page.locator("#pane").isVisible(), false, "nothing running, no panel");
  /* A conversation first (the panel belongs to a conversation), then the slow task in it. */
  await f.page.locator("#prompt").fill("Hello first.");
  await f.page.locator("#send").click();
  await f.page.locator("#conversation .b .txt").first().waitFor({ timeout: 30000 });
  await f.page.waitForFunction(() => !document.getElementById("send").disabled);
  await f.page.locator("#prompt").fill("Sort my Downloads folder. Delete nothing.");
  await f.page.locator("#send").click();
  await f.page.locator('[data-act="pane"][data-p="activity"]').first().click();
  await f.page.locator("#pane").waitFor({ state: "visible", timeout: 15000 });
  await f.page.locator("#pane .tl .run").filter({ hasText: "Sort my Downloads folder" }).waitFor({ timeout: 15000 });
  const stop = await f.page.locator("#composer").getByRole("button", { name: "Stop", exact: true }).isVisible();
  model.release();
  await f.page.waitForFunction(() => !document.getElementById("send").disabled, null, { timeout: 60000 });
  await f.page.locator("#pane .tl .run").waitFor({ state: "detached", timeout: 15000 });
  assert.deepEqual(f.errors, []);
  assert.equal(stop, true, "the running task's Stop is in view");
});

/* Redesign: on a phone the new window's list is behind "Show conversations" (data-act="side"), where More was; it sits
   in the title bar's head over the conversation. */
test("the calm window fits a phone: no sideways scroll, More and Send in reach", async (t) => {
  const f = await fixture(t, { onboarded: true, width: 390, height: 844 });
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const more = '.titlebar [data-act="side"]';
  for (const selector of ["#prompt", "#send", more]) assert.equal(await visible(f.page, selector), true, selector);
  const box = await f.page.locator(more).boundingBox();
  assert.ok(box.x + box.width <= 390, "More is inside the screen");
  for (const selector of ["#prompt", "#send"]) {
    const b = await f.page.locator(selector).boundingBox();
    assert.ok(b.x >= 0 && b.x + b.width <= 390, `${selector} is inside the screen`);
  }
  assert.deepEqual(f.errors, []);
});

/* ---------- what must never hide in the calm window ---------- */

/** A model that writes a file when asked for a note (an approval question under "ask before changes"), and waits on Downloads. */
function askingModel() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = {
    name: "scripted",
    async complete(request) {
      const last = request.messages[request.messages.length - 1];
      const asked = String([...request.messages].reverse().find((m) => m.role === "user")?.content ?? "");
      if (last.role === "tool") return { content: "Written.", toolCalls: [] };
      if (asked.includes("Downloads")) { await gate; return { content: "Done.", toolCalls: [] }; }
      if (asked.includes("note")) return { content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hi" }) }] };
      return { content: "Hello.", toolCalls: [] };
    },
  };
  return { provider, release: () => release() };
}

/* Redesign: the new card is the action's verb (once), "Always allow" and "Don’t allow"; the waiting count is on Inbox in
   the sidebar. The yes "for this conversation" and the side panel's "What is allowed right now" are checked in the
   original below, skipped until the side panel is live. */
test("calm: an approval question, its answers and Inbox all show (the new window)", async (t) => {
  const model = askingModel();
  t.after(() => model.release());
  const f = await fixture(t, { provider: model.provider, onboarded: true });
  await f.call("/api/policy", { preset: "ask-before-changes" });
  await f.page.locator("#prompt").fill("write a note for me");
  await f.page.locator("#send").click();
  const card = f.page.locator("#live-ask");
  await card.waitFor({ state: "visible", timeout: 20000 });
  assert.equal(await card.locator(".btn.pri").isVisible(), true, "the action's own verb");
  for (const name of [/^Always allow/, /^Don’t allow$/])
    assert.equal(await card.getByRole("button", { name }).isVisible(), true, String(name));
  await f.page.locator('#side [data-act="view"][data-v="inbox"] .cnt').waitFor({ state: "visible", timeout: 15000 });
  await f.page.locator('#side [data-act="view"][data-v="inbox"]').click();
  await f.page.locator('#main [data-act="ask"][data-v="allow"]').first().waitFor({ state: "visible", timeout: 15000 });
  assert.deepEqual(f.errors, []);
});

// Redesign: Coming soon (lock: "Turn it off" on the Lockdown banner, and Settings › Permissions' "Turn Lockdown on"), checked
// at ef021c57. (Lockdown itself turns on and off from the mode menu: mode-menu-lockdown.test.mjs.)
test.skip("calm: Lockdown says so while it is on, and turns off from the banner", async (t) => {
  const f = await fixture(t, { onboarded: true });
  await f.page.locator("#lx-more").click();
  await f.page.getByRole("menuitemcheckbox", { name: "Lockdown: refuse commands" }).click();
  await f.page.locator("#lx-lockbanner").waitFor({ state: "visible", timeout: 10000 });
  assert.equal((await f.call("/api/lockdown")).on, true);
  assert.equal(await visible(f.page, "#lx-shield"), true, "the shield stays in the title bar while Lockdown is on");
  assert.equal(await f.page.locator("#lx-shield").getAttribute("aria-pressed"), "true");
  await f.page.locator("#lx-more").click();
  assert.equal(await f.page.getByRole("menuitemcheckbox", { name: "Lockdown: refuse commands" }).getAttribute("aria-checked"), "true");
  await f.page.keyboard.press("Escape");
  await f.page.locator("#lx-lockbanner").getByRole("button", { name: "Turn it off" }).click();
  await f.page.locator("#lx-lockbanner").waitFor({ state: "hidden", timeout: 10000 });
  assert.equal((await f.call("/api/lockdown")).on, false);
  assert.equal(await visible(f.page, "#lx-shield"), false, "and goes back under More once it is off");
  assert.deepEqual(f.errors, []);
});

test("calm: a goal keeps its Resume and Stop in view", async (t) => {
  const f = await fixture(t, { onboarded: true });
  await f.page.locator("#prompt").fill("hello");
  await f.page.locator("#send").click();
  await f.page.locator("#conversation .b").first().waitFor({ timeout: 30000 });
  await f.page.waitForFunction(() => !document.getElementById("send").disabled);
  const sessionId = await f.page.locator('#side [data-act="chat"][aria-current="true"]').getAttribute("data-id");
  f.app.store.save("settings", "local", `goal:${sessionId}`, {
    sessionId, objective: "Make the tests pass", status: "paused", round: 2, maxRounds: 6, score: 0.4, best: 0.4, flatRounds: 0,
    missing: [], reason: "Paused. Resume to carry on.", checks: null, startedAt: new Date().toISOString(), elapsedMs: 1000, activeSince: null, lastRunId: null,
  });
  // Redesign: the goal strip is the prototype's .goal6 (goalStrip()): Resume or Pause, Stop, and Undo (pass 17), which is
  // greyed with its reason for a goal like this one, saved before Branch kept which tasks were its rounds.
  await f.page.locator(`#side [data-act="chat"][data-id="${sessionId}"]`).click();
  const strip = f.page.locator("#main .goal6");
  await strip.waitFor({ state: "visible", timeout: 15000 });
  assert.deepEqual((await strip.locator("button").allTextContents()).map((text) => text.trim()), ["Resume", "Stop", "Undo"]);
  const undo = strip.locator("button", { hasText: "Undo" });
  assert.equal(await undo.isDisabled(), true, "an older goal cannot be undone in one step, so Undo is greyed");
  assert.match(await undo.getAttribute("title"), /before Branch kept which tasks were its rounds/);
  assert.deepEqual(f.errors, []);
});

/* The conversation the engine keeps for words the person sent from the window. */
async function conversationOf(f, words) {
  for (let tries = 0; tries < 200; tries++) {
    const found = f.app.store.recentSessions(f.app.runtime.owner, 20).sessions.find((s) => s.opening === words);
    if (found) return found.sessionId;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`no conversation began with ${words}`);
}

/* Redesign: Recents is the sidebar's conversation list. */
test("calm: a finished conversation is in Recents at once (the new window)", async (t) => {
  const f = await fixture(t, { onboarded: true });
  await f.page.locator("#prompt").fill("Tell me a joke");
  await f.page.locator("#send").dispatchEvent("click");
  // trunk-one-row: the conversation is its Trunk's, so the Trunk's one row opens it at once.
  const row = f.page.locator(`#side [data-act="chat"][data-id="${await conversationOf(f, "Tell me a joke")}"]`);
  await row.waitFor({ timeout: 10000 });
  await f.page.locator("#conversation .b").first().waitFor({ state: "visible", timeout: 60000 });
  assert.equal(await row.count(), 1);
  assert.deepEqual(f.errors, []);
});

test("the desktop restart channel answers only its own window's page, and relaunches once", async () => {
  const { registerRestartIpc, restartChannel } = await import("../dist/desktop/restart-ipc.js");
  const handlers = new Map(), closed = [];
  const ipc = { handle: (channel, run) => handlers.set(channel, run), removeHandler: (channel) => handlers.delete(channel) };
  const mainFrame = { url: "http://127.0.0.1:4000/?desktop=1" };
  const webContents = { mainFrame };
  const window = { webContents, on: (name, run) => closed.push([name, run]) };
  let relaunched = 0;
  registerRestartIpc(ipc, window, "http://127.0.0.1:4000", () => { relaunched += 1; });
  const ask = handlers.get(restartChannel);
  assert.throws(() => ask({ sender: {}, senderFrame: mainFrame }), /denied/, "another page is refused");
  assert.throws(() => ask({ sender: webContents, senderFrame: { url: "http://127.0.0.1:4000/" } }), /denied/, "a frame inside it is refused");
  assert.throws(() => ask({ sender: webContents, senderFrame: { ...mainFrame, url: "http://evil.test/" } }), /denied/);
  webContents.mainFrame = { url: "http://evil.test/" };
  assert.throws(() => ask({ sender: webContents, senderFrame: webContents.mainFrame }), /denied/, "another address is refused");
  webContents.mainFrame = mainFrame;
  assert.equal(ask({ sender: webContents, senderFrame: mainFrame }), true);
  assert.equal(ask({ sender: webContents, senderFrame: mainFrame }), true);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(relaunched, 1, "two presses, one relaunch");
  closed.find(([name]) => name === "closed")[1]();
  assert.equal(handlers.has(restartChannel), false, "the channel goes with its window");
});

test("calm: a running task reads under its message, with a real Stop, and its conversation is in Recents at once", async (t) => {
  const model = slowModel();
  t.after(() => model.release()); // registered before the fixture, so a failure never leaves the model holding Branch open
  const f = await fixture(t, { provider: model.provider, onboarded: true });
  await f.page.locator("#prompt").fill("Sort my Downloads folder. Delete nothing.");
  await f.page.locator("#send").click();
  /* Redesign: the working state is drawn under the person's message (the typing or thinking row), Stop takes Send's
     place (prototype: #send becomes "Stop" while working), and the conversation's row says Working. */
  await f.page.locator("#conversation .typing, #conversation .think").first().waitFor({ state: "visible", timeout: 15000 });
  const [mine, card] = await settledBoxes(f.page, ["#conversation .u", "#conversation .b:last-child"]);
  assert.ok(card.y > mine.y + mine.height - 1, "the working card is under the person's message");
  assert.ok(card.y - (mine.y + mine.height) < 80, "and right under it");
  assert.ok(card.height < 110, `the card is as tall as what it says (${card.height}px)`);
  const stopButton = f.page.locator("#composer").getByRole("button", { name: "Stop", exact: true });
  await stopButton.waitFor({ state: "visible", timeout: 10000 });
  // Redesign: the prototype's Stop is the round Send button (no border); a real button still means one of full size.
  const stop = await stopButton.evaluate((node) => { const box = node.getBoundingClientRect(); return { width: box.width, height: box.height }; });
  assert.ok(stop.width >= 30 && stop.height >= 30, "Stop is a button, not a small link");
  // trunk-one-row: the conversation's Trunk's one row opens it, and says Working while it works.
  const id = await conversationOf(f, "Sort my Downloads folder. Delete nothing."), row = f.page.locator(`#side [data-act="chat"][data-id="${id}"]`);
  await row.waitFor({ timeout: 10000 });
  await f.page.waitForFunction((id) => /Working/.test(document.querySelector(`#side [data-act="chat"][data-id="${id}"]`)?.innerText ?? ""), id, { timeout: 10000 });
  model.release();
  await f.page.waitForFunction(() => !document.getElementById("send").disabled, null, { timeout: 15000 });
  assert.equal(await row.count(), 1, "the task's own conversation remains exactly once after finishing");
  assert.deepEqual(f.errors, []);
});

/* Redesign: the prototype's message box: + on the left, one round Send that is quiet while the box is empty, the accent
   once there is something to send (prototype: class "ready"), and Stop in its place while the task works. The + menu is
   the prototype's POPS.plusmenu. The old sample's 48/34 px sizes, its placeholder and its "Your assistant" row are
   replaced by the new window (the prototype's placeholder is the new window's own). */
test("calm: the sample-height message box has + on the left and one round button: quiet, then the accent, then Stop (the new window)", async (t) => {
  const model = slowModel();
  t.after(() => model.release());
  const f = await fixture(t, { provider: model.provider, onboarded: true });
  const form = f.page.locator("#composer"), send = f.page.locator("#send");
  const settledColour = () => send.evaluate(async (node) => {
    await Promise.all(node.getAnimations().map((animation) => animation.finished.catch(() => undefined)));
    return getComputedStyle(node).backgroundColor;
  });
  assert.ok((await form.evaluate((node) => node.getBoundingClientRect().height)) <= 62, "the empty box is one line");
  assert.equal(await send.getAttribute("aria-label"), "Send");
  const plus = await f.page.locator('#composer [data-act="plusmenu"]').boundingBox(), box = await form.boundingBox();
  assert.ok(plus.x - box.x < 20, "+ is on the left");
  const shape = await send.evaluate((node) => { const b = node.getBoundingClientRect(); return { w: b.width, h: b.height, r: getComputedStyle(node).borderRadius }; });
  assert.ok(Math.abs(shape.w - shape.h) < 2 && (shape.r === "50%" || parseFloat(shape.r) >= shape.h / 2 - 1), "one round button");
  const quiet = await settledColour();
  await send.click();
  assert.equal(await f.page.locator("#conversation .u").count(), 0, "the quiet button sends nothing");
  await f.page.locator("#prompt").fill("Sort my Downloads folder.");
  const accent = await settledColour();
  await f.page.locator('#composer [data-act="plusmenu"]').click();
  const menu = f.page.locator("#app > .pop");
  await menu.waitFor({ state: "visible" });
  const rows = (await menu.getByRole("menuitem").allInnerTexts()).map((x) => x.replace(/\s+/g, " ").trim());
  assert.deepEqual(rows.slice(0, 5).map((x) => x.replace(/ [@/]$/, "")), ["Attach files", "Add a folder", "Take a screenshot", "Mention a Trunk", "Use a skill"]);
  await f.page.keyboard.press("Escape");
  await send.click();
  const stop = f.page.locator("#composer").getByRole("button", { name: "Stop", exact: true });
  const stopShown = await stop.waitFor({ state: "visible", timeout: 10000 }).then(() => true, () => false);
  model.release();
  await f.page.waitForFunction(() => !document.getElementById("send").disabled, null, { timeout: 30000 });
  assert.deepEqual(f.errors, []);
  assert.notEqual(accent, quiet, "the accent once there is something to send");
  assert.equal(stopShown, true, "while the task works, the same place holds Stop");
});

/* Redesign: the empty conversation is the prototype's emptyChat(): "What should Branch do?" and suggestion chips
   (data-act="sugg") that send immediately (POST /api/run). The chips' words are the design's; what they do is checked. */
test("calm: the empty screen offers three starting points that send as a run", async (t) => {
  const f = await fixture(t, { onboarded: true });
  await f.page.locator("#main .empty-chat h1").waitFor({ state: "visible", timeout: 10000 });
  assert.equal((await f.page.locator("#main .empty-chat h1").innerText()).trim(), "What should Branch do?");
  const chips = f.page.locator('#main .empty-chat [data-act="sugg"]');
  assert.ok(await chips.count() >= 3, "at least three starting points");
  const words = (await chips.first().innerText()).trim();
  const initialRuns = new Set(f.app.store.runs(f.app.runtime.owner).map(run => run.id));
  await chips.first().click();
  // Wait for the run to appear in the store
  await f.page.locator("#conversation .u").waitFor({ state: "visible", timeout: 10000 });
  const newRuns = f.app.store.runs(f.app.runtime.owner).filter(run => !initialRuns.has(run.id));
  assert.equal(newRuns.length, 1, "exactly one new run was sent");
  const lastRun = newRuns[0];
  assert.equal(lastRun.prompt, words, "the run has the chip's words as the prompt");
  assert.deepEqual(f.errors, []);
});

/** Opens a popover by its button, then checks every way it closes (public/popover.js). */
async function everyWayClosed(page, trigger, panel, label) {
  const shown = () => page.locator(panel).first().isVisible();
  const expanded = () => page.locator(trigger).getAttribute("aria-expanded");
  /* Some fill themselves from Branch first (the label picker), so opening waits for it to show. */
  const open = async () => { await page.locator(trigger).click(); await page.locator(panel).first().waitFor({ state: "visible", timeout: 5000 }); };
  await open();
  assert.equal(await expanded(), "true", `${label} says it is open`);
  await page.locator(trigger).click();
  assert.equal(await shown(), false, `${label} closes on its own button`);
  assert.equal(await expanded(), "false", `${label} says it is closed`);
  await open();
  await page.keyboard.press("Escape");
  assert.equal(await shown(), false, `${label} closes on Escape`);
  assert.equal(await page.evaluate((css) => document.activeElement === document.querySelector(css), trigger), true, `${label} gives the keyboard back to its button`);
  await open();
  await page.locator("#conversation").click({ position: { x: 5, y: 5 } });
  assert.equal(await shown(), false, `${label} closes on a click elsewhere`);
}

/* Redesign: the new window's popovers (public/app/core/ui.js openPop) work as the prototype's do: they close on their own
   button, on Escape and on a click elsewhere (prototype: document click outside popEl), one at a time. The prototype's
   closePop() gives no focus back to the button, so that check of the old window is replaced by the new window. */
async function everyWayClosedNew(page, trigger, panel, label) {
  const shown = () => page.locator(panel).first().isVisible();
  const expanded = () => page.locator(trigger).getAttribute("aria-expanded");
  const open = async () => { await page.locator(trigger).click(); await page.locator(panel).first().waitFor({ state: "visible", timeout: 5000 }); };
  await open();
  assert.equal(await expanded(), "true", `${label} says it is open`);
  await page.locator(trigger).click();
  assert.equal(await shown(), false, `${label} closes on its own button`);
  assert.equal(await expanded(), "false", `${label} says it is closed`);
  await open();
  await page.keyboard.press("Escape");
  assert.equal(await shown(), false, `${label} closes on Escape`);
  await open();
  // A spot of the conversation no popover covers (New opens over the conversation's top left corner).
  const box = await page.locator("#conversation").boundingBox();
  await page.locator("#conversation").click({ position: { x: box.width - 12, y: box.height - 12 } });
  assert.equal(await shown(), false, `${label} closes on a click elsewhere`);
}
test("every menu and popover closes on its own button, on Escape and on a click elsewhere, and one at a time (the new window)", async (t) => {
  const f = await fixture(t, { onboarded: true });
  await f.page.locator("#prompt").fill("hello");
  await f.page.locator("#send").click();
  await f.page.locator("#conversation .b").first().waitFor({ timeout: 30000 });
  /* The side panel's one switch closes and opens it; a tab inside the panel never closes it. */
  const toggle = f.page.locator('[data-act="pane"][data-p="activity"]').first();
  await toggle.click();
  await f.page.locator("#pane").waitFor({ state: "visible" });
  await toggle.click();
  await f.page.locator("#pane").waitFor({ state: "hidden" });
  await toggle.click();
  const planTab = f.page.locator('#pane [data-act="ptabp"][data-p="plan"]');
  await planTab.click();
  await planTab.click();
  assert.equal(await f.page.locator('#pane [data-act="ptabp"][data-p="plan"]').getAttribute("aria-selected"), "true", "a tab pressed twice keeps its panel open");
  await everyWayClosedNew(f.page, '#side [data-act="newmenu"]', "#app > .pop", "New");
  await everyWayClosedNew(f.page, '#side [data-act="owner"]', "#app > .pop", "the person's menu");
  await everyWayClosedNew(f.page, '#tbActions [data-act="guide"]', "#app > .pop", "Guide");
  await everyWayClosedNew(f.page, '#composer [data-act="plusmenu"]', "#app > .pop", "the + in the message box");
  await f.page.locator('#side [data-act="newmenu"]').click();
  await f.page.locator('#side [data-act="owner"]').click();
  assert.equal(await f.page.locator("#app > .pop").count(), 1, "one popover at a time");
  assert.equal(await f.page.locator('#side [data-act="newmenu"]').getAttribute("aria-expanded"), "false");
  await f.page.keyboard.press("Escape");
  assert.deepEqual(f.errors, []);
});

/* bugfix-10: the window redraws a region by replacing its markup, so a redraw can land while a popover is open and replace
   its button. The button drawn in its place says the popover is open, and pressing it closes the popover (the prototype's
   popovers close on their own button). The redraw is forced here the way the window's own draws do it. */
test("a popover whose button a redraw replaced closes when that button is pressed (the new window)", async (t) => {
  const f = await fixture(t, { onboarded: true });
  await f.page.locator("#prompt").fill("hello");
  await f.page.locator("#send").click();
  await f.page.locator("#conversation .b").first().waitFor({ timeout: 30000 });
  await f.page.waitForFunction(() => !document.getElementById("send").disabled);
  for (const [label, trigger] of [["the + in the message box", '#composer [data-act="plusmenu"]'], ["New", '#side [data-act="newmenu"]'], ["the model chip", '#composer [data-act="modelmenu2"]']]) {
    const button = f.page.locator(trigger);
    await button.click();
    await f.page.locator("#app > .pop").waitFor({ state: "visible", timeout: 5000 });
    const replaced = await f.page.evaluate(async (sel) => {
      const before = document.querySelector(sel);
      const main = document.querySelector("#main");
      main.replaceChild(main.firstElementChild.cloneNode(true), main.firstElementChild);
      // The shell's regions are drawn again only when their markup changed or something replaced what was drawn
      // (core/dom.js paintChanged): the button's own region is marked replaced too, so a draw that landed since the
      // click cannot leave this one with nothing to do.
      const region = before.closest("#side, #tbActions, #statusbar, .tb-head14");
      if (region?.firstChild) region.replaceChild(region.firstChild.cloneNode(true), region.firstChild);
      const { renderNow } = await import("/app/core/dom.js");
      renderNow();
      return before !== document.querySelector(sel);
    }, trigger);
    assert.equal(replaced, true, `${label}: the redraw replaced its button`);
    assert.equal(await button.getAttribute("aria-expanded"), "true", `${label}: the button drawn in its place says it is open`);
    await button.click();
    await f.page.waitForTimeout(300);
    assert.equal(await f.page.locator("#app > .pop").count(), 0, `${label}: pressing that button again closes the popover`);
    assert.notEqual(await button.getAttribute("aria-expanded"), "true", `${label}: and it no longer says it is open`);
  }
  assert.deepEqual(f.errors, []);
});
