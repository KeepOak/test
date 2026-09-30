/* Q34: a menu that opens from inside the conversation (More, Lockdown, the label picker, "+") used to draw
   under the floating side-panel card. `main` is its own stacking context (z-index 1 with a backdrop filter),
   so nothing inside it could rise above the card (z-index 60), whatever its own z-index. While open, a menu
   now sits on the page itself, exactly where and as it was drawn, and goes back to its place when it closes.
   Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openChat } from "./open-chat.mjs"; // trunk-one-row: one row per Trunk

const quiet = { name: "scripted", async complete() { return { content: "Here is a short answer.", toolCalls: [] }; } };

/* Redesign: the new window (public/app/**) draws every menu on the window itself (core/ui.js openPop: one .pop on
   #app, z-index 60), above the side panel (#pane), so there is nothing to lift into the top layer: the old window's
   popover.js, its "lifted" state and its put-back are replaced. What the person sees is still checked: a menu opened
   from the conversation is not covered by the side panel, the keyboard is in it, Escape and an outside click close it. */
async function fixture(t, width, { everything = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-popovers-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const run = app.store.createRun(app.runtime.owner, "Compare the quotes");
  app.store.message(run.sessionId, { role: "user", content: run.prompt });
  app.store.message(run.sessionId, { role: "assistant", content: "Here is a short answer." });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  void everything; // Redesign: replaced by the new window (no "Show everything"; every control is always drawn)
  // The conversation is opened from its row in the list (on a narrow window the menu button slides the list in).
  if (width <= 760) await page.locator('[data-act="side"]').filter({ visible: true }).first().click();
  await openChat(page, run.sessionId);
  await page.locator("#conversation .b").first().waitFor();
  return { page, errors };
}

/* The side panel (the old floating card): the conversation header's side-panel button opens #pane. */
async function openCard(page) {
  if (await page.evaluate(() => document.getElementById("pane")?.hidden === false)) return;
  await page.locator('[data-act="pane"][data-p="activity"]').filter({ visible: true }).first().click();
  await page.waitForFunction(() => document.getElementById("pane")?.hidden === false);
}

/* How much of the open menu a click can reach: every point inside it must hit the menu, not the panel behind. */
const reach = (page, selector) => page.evaluate((sel) => {
  const menu = document.querySelector(sel), box = menu.getBoundingClientRect();
  const round = parseFloat(getComputedStyle(menu).borderTopLeftRadius) || 0;
  const corner = (x, y) => (x < box.left + round || x > box.right - round) && (y < box.top + round || y > box.bottom - round);
  let points = 0, covered = 0;
  const under = new Set();
  for (let x = box.left + 3; x < Math.min(box.right, innerWidth) - 3; x += 12)
    for (let y = Math.max(box.top, 0) + 3; y < Math.min(box.bottom, innerHeight) - 3; y += 12) {
      if (corner(x, y)) continue;
      points++;
      const hit = document.elementFromPoint(x, y);
      if (!menu.contains(hit)) { covered++; under.add(hit?.id || String(hit?.className) || hit?.tagName); }
    }
  const pane = document.getElementById("pane").getBoundingClientRect();
  const overPane = box.left < pane.right && box.right > pane.left && box.top < pane.bottom && box.bottom > pane.top;
  return { points, covered, under: [...under].slice(0, 4), overPane };
}, selector);

for (const width of [1440, 860, 400]) {
  test(`Q34 at ${width} px More opens over the side panel (none at 400 px), the keyboard is in it, and Escape or a click outside closes it`, async (t) => {
    const { page, errors } = await fixture(t, width);
    // At 480 px and under, prototype.html hides the header's side-panel button, so there More opens with no panel.
    const panel = width > 480;
    const listAway = await page.evaluate(() => !document.getElementById("app").classList.contains("side-open"));
    if (panel) await openCard(page);
    const more = page.locator('[data-act="chatmenu"]').filter({ visible: true }).first();
    await more.click();
    await page.locator(".pop").waitFor({ state: "visible" });
    const seen = await reach(page, ".pop");
    assert.ok(seen.points > 20, "the menu was measured");
    if (panel) assert.equal(seen.overPane, true, "the menu is drawn where the side panel is");
    assert.equal(seen.covered, 0, `nothing covers the menu (${seen.covered} of ${seen.points} points hit ${seen.under.join(", ")})`);
    assert.equal(await page.evaluate(() => document.querySelector(".pop").contains(document.activeElement)), true, "the keyboard is in it");
    await page.keyboard.press("Escape");
    await page.locator(".pop").waitFor({ state: "detached" });
    const afterEscape = await page.evaluate(() => document.activeElement?.dataset?.act ?? document.activeElement?.tagName);
    assert.equal(await more.getAttribute("aria-expanded"), "false", "closed, its button says so");
    /* An outside click still closes it, and it opens again the same way. */
    await more.click();
    await page.locator(".pop").waitFor({ state: "visible" });
    await page.mouse.click(5, 895);
    await page.locator(".pop").waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    // On a narrow window the list slides in to choose a conversation and away once one is chosen (prototype.html openChat).
    assert.equal(listAway, true, "choosing a conversation slides the list away");
    assert.equal(afterEscape, "chatmenu", "Escape hands the keyboard back to More");
  });
}

/* The old window's measures, for the skipped bodies below. */
/**
 * Records how a menu and everything in it look in their own place at the moment it is lifted into the top
 * layer (when `popover` is set on it), so the open menu can be compared with exactly that.
 */
const watchLifts = (page) => page.evaluate(() => {
  globalThis.__look = (menu) => [menu, ...menu.querySelectorAll("*")].filter((el) => el.getClientRects().length).map((el) => {
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return [el.id || el.className || el.tagName, Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height),
      s.color, s.backgroundColor, s.fontSize, s.fontWeight, s.fontFamily, s.borderTop, s.borderRadius, s.boxShadow,
      s.backdropFilter, s.padding].join(" | ");
  });
  globalThis.__home = new Map();
  const set = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (name === "popover") globalThis.__home.set(this, globalThis.__look(this));
    return set.call(this, name, value);
  };
});

/**
 * The open menu, measured: whether it was lifted, how much of it a click can reach, and how it and everything in
 * it compare with how they looked in their own place.
 */
const measure = (page, selector) => page.evaluate((sel) => {
  const menu = document.querySelector(sel), box = menu.getBoundingClientRect();
  /* Points in a rounded corner are outside the menu's own shape, so the page behind rightly answers there. */
  const round = parseFloat(getComputedStyle(menu).borderTopLeftRadius) || 0;
  const corner = (x, y) => (x < box.left + round || x > box.right - round) && (y < box.top + round || y > box.bottom - round);
  let points = 0, covered = 0;
  const under = new Set();
  for (let x = box.left + 3; x < Math.min(box.right, innerWidth) - 3; x += 12)
    for (let y = Math.max(box.top, 0) + 3; y < Math.min(box.bottom, innerHeight) - 3; y += 12) {
      if (corner(x, y)) continue;
      points++;
      const hit = document.elementFromPoint(x, y);
      if (!menu.contains(hit)) { covered++; under.add(hit?.id || String(hit?.className) || hit?.tagName); }
    }
  /* Its looks are compared without the keyboard in it: the focus ring comes after it opens, not from where it is. */
  const focused = menu.contains(document.activeElement) ? document.activeElement : null;
  focused?.blur();
  const shown = globalThis.__look(menu);
  focused?.focus();
  return { lifted: menu.matches(":popover-open"), points, covered, under: [...under].slice(0, 4),
    shown, home: globalThis.__home.get(menu) ?? null };
}, selector);

// Redesign: replaced by the new window (core/ui.js openPop draws every menu on #app above the side panel; nothing is
// lifted into the top layer or put back, so "where and as it always drew" and "back in its own place" have no
// counterpart; the live test above checks the rest).
for (const width of [1440, 860, 400]) {
  test.skip(`Q34 at ${width} px More opens over the side-panel card, where and as it always drew, and goes home on close`, async (t) => {
    const { page, errors } = await fixture(t, width);
    const place = await page.evaluate(() => { const menu = document.getElementById("lx-more-menu"); return { parent: menu.parentElement.tagName, before: menu.previousElementSibling?.id }; });
    await openCard(page);
    await page.locator("#lx-more").click();
    await page.locator("#lx-more-menu").waitFor({ state: "visible" });
    const seen = await measure(page, "#lx-more-menu");
    assert.ok(seen.points > 20, "the menu was measured");
    assert.equal(seen.covered, 0, `nothing covers the menu (${seen.covered} of ${seen.points} points hit ${seen.under.join(", ")})`);
    assert.equal(seen.lifted, true, "it is lifted above the card");
    assert.deepEqual(seen.shown, seen.home, "it and every row in it open where and as they always drew");
    /* Its keys still work, and a click on one of its rows still reaches it. */
    assert.equal(await page.evaluate(() => document.getElementById("lx-more-menu").contains(document.activeElement)), true, "the keyboard is in it");
    await page.keyboard.press("Escape");
    await page.locator("#lx-more-menu").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.id), "lx-more", "Escape hands the keyboard back to More");
    const home = await page.evaluate(() => { const menu = document.getElementById("lx-more-menu"); return { parent: menu.parentElement.tagName, before: menu.previousElementSibling?.id, inline: menu.getAttribute("style") ?? "" }; });
    assert.deepEqual({ parent: home.parent, before: home.before }, place, "closed, it is back in its own place");
    assert.equal(home.inline, "", "with nothing left on it from being open");
    /* An outside click still closes it, and it opens again the same way. */
    await page.locator("#lx-more").click();
    await page.locator("#lx-more-menu").waitFor({ state: "visible" });
    await page.mouse.click(5, 895);
    await page.locator("#lx-more-menu").waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  });
}

/* The message box sits in the scrolling conversation but is placed against `main`, so scrolling never moves it:
   its menus are lifted too (Codex's review of a789ac29 found them still under the card). */
test("Q34 at 1440 px the message box's menus open (the mode menu over the side panel), and nothing covers them", async (t) => {
  const { page, errors } = await fixture(t, 1440);
  await openCard(page);
  for (const act of ["modemenu2", "plusmenu"]) {
    const button = page.locator(`[data-act="${act}"]`).filter({ visible: true }).first();
    await button.click();
    await page.locator(".pop").waitFor({ state: "visible" });
    const seen = await reach(page, ".pop");
    assert.ok(seen.points > 20, `${act}'s menu was measured`);
    if (act === "modemenu2") assert.equal(seen.overPane, true, "the mode menu is drawn where the side panel is");
    assert.equal(seen.covered, 0, `nothing covers ${act}'s menu (${seen.covered} of ${seen.points} points hit ${seen.under.join(", ")})`);
    await page.keyboard.press("Escape");
    await page.locator(".pop").waitFor({ state: "detached" });
    assert.equal(await button.getAttribute("aria-expanded"), "false", `${act}'s menu is closed`);
  }
  assert.equal((await reach(page, "#pane")).points > 20, true, "the side panel is still open beside them");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the lifted #mode-menu / #lx-plus-menu of popover.js; and at 400 px
// prototype.html's side panel covers the whole conversation, so the message box is not reachable under it).
for (const [width, menus] of [[1440, [["#mode-chip", "#mode-menu"]]], [400, [["#mode-chip", "#mode-menu"], ["#lx-plus", "#lx-plus-menu"]]]]) {
  test.skip(`Q34 at ${width} px the message box's menus open over the side-panel card, where and as they always drew`, async (t) => {
    const { page, errors } = await fixture(t, width, { everything: true });
    await openCard(page);
    for (const [button, selector] of menus) {
      await page.locator(button).click();
      await page.locator(selector).waitFor({ state: "visible" });
      const seen = await measure(page, selector);
      assert.equal(seen.lifted, true, `${selector} is lifted above the card`);
      assert.ok(seen.points > 20, `${selector} was measured`);
      assert.equal(seen.covered, 0, `nothing covers ${selector} (${seen.covered} of ${seen.points} points hit ${seen.under.join(", ")})`);
      assert.deepEqual(seen.shown, seen.home, `${selector} and every row in it open where and as they always drew`);
      await page.keyboard.press("Escape");
      await page.locator(selector).waitFor({ state: "hidden" });
      assert.equal(await page.locator(selector).getAttribute("popover"), null, `${selector} is put back when it closes`);
    }
    assert.deepEqual(errors, []);
  });
}

