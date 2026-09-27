/* DG-114: the side panel is the approved sample's card (design/Branch-Grown-Up.html, `.pane`): one card named
   "Side panel" with a close button and its tabs, floating over the conversation instead of taking a column,
   closed until asked for, never covering the message box, and never clipping what is in it. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const quiet = { name: "scripted", async complete() { return { content: "Here is a short answer.", toolCalls: [] }; } };

/* Redesign: the new window's side panel (chat/pane.js, #pane), 1:1 with prototype.html: a column beside the
   conversation on a wide window and a card over it on a narrow one (the prototype's own layout, in place of the old
   floating card), opened by the conversation header's side-panel button, with its six tabs inside and a close button. */
async function fixture(t, { width = 1440, height = 950 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-side-card-"));
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
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  if (width <= 760) await page.locator('[data-act="side"]').filter({ visible: true }).first().click();
  await page.locator(`#side [data-act="chat"][data-id="${run.sessionId}"]`).click();
  await page.locator("#conversation .b").first().waitFor();
  return { page, errors };
}

const shown = (page) => page.evaluate(() => document.getElementById("pane")?.hidden === false);
const toggle = (page) => page.locator('.head [data-act="pane"][data-p="activity"]').filter({ visible: true }).first();
async function openCard(page) {
  await toggle(page).click();
  await page.waitForFunction(() => document.getElementById("pane")?.hidden === false);
}

test("DG-114 the side panel is closed until asked for, holds its tabs, and its close button shuts it", async (t) => {
  const { page, errors } = await fixture(t);
  assert.equal(await shown(page), false, "closed until asked for");
  await openCard(page);
  // Pass 17 (patch17c): Timeline follows Activity, and Branches follows Timeline once the conversation has 2+ paths.
  assert.deepEqual(await page.locator("#pane .ptabs .ptab").allInnerTexts(), ["Activity", "Timeline", "Plan", "Files", "Memory", "Terminal"], "its tabs are inside it (parity B2: no Browser tab)");
  const box = await page.evaluate(() => { const r = document.getElementById("pane").getBoundingClientRect(); return { right: r.right, left: r.left, width: r.width }; });
  assert.ok(box.width > 200 && box.right <= 1440 + 0.5, "inside the window");
  /* Choosing a tab selects it. */
  await page.locator('#pane .ptab[data-p="plan"]').click();
  await page.locator('#pane .ptab[data-p="plan"][aria-selected="true"]').waitFor();
  /* Its close button shuts it and hands the keyboard back to the button that opens it again. */
  await page.getByRole("button", { name: "Close the side panel", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("pane")?.hidden === true);
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.act), "pane", "the keyboard goes back to the switch that opens it");
});

test("DG-114 nothing in the panel is clipped at 1440, 1280, 1180, 860 and 400 wide", async (t) => {
  const { page, errors } = await fixture(t);
  await openCard(page);
  for (const [w, h] of [[1440, 1000], [1280, 900], [1180, 900], [860, 900], [400, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForFunction((width) => innerWidth === width
      && new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))), w);
    if (!(await shown(page))) {
      await toggle(page).click();
      await page.waitForFunction(() => document.getElementById("pane")?.hidden === false, null, { timeout: 5000 })
        .catch(() => assert.fail(`${w}: one press of the switch brings the panel back`));
    }
    const fit = await page.evaluate(() => {
      const panel = document.getElementById("pane"), card = panel.getBoundingClientRect(), slack = 0.5;
      const inside = (el) => { const r = el.getBoundingClientRect(); return r.left >= card.left - slack && r.right <= card.right + slack; };
      // The tab row scrolls sideways (.ptabs, overflow-x auto, as in the prototype): a tab past the edge is held by it,
      // not clipped. The row itself and the close button must sit inside the card.
      const row = panel.querySelector(".pane-h .ptabs"), scrolls = row && row.scrollWidth > row.clientWidth + 1;
      const tabs = [...panel.querySelectorAll(".pane-h .ptab")], buttons = [...panel.querySelectorAll(".pane-h .icon-btn")];
      const parts = [...tabs, ...buttons];
      const body = panel.querySelector(".pane-b"), style = getComputedStyle(body);
      return {
        inWindow: card.left >= 0 && card.right <= innerWidth + slack && card.top >= 0 && card.bottom <= innerHeight + slack,
        clipped: [...(row && !inside(row) ? [row] : []), ...buttons.filter((el) => el.getClientRects().length && !inside(el)),
          ...(scrolls ? [] : tabs.filter((el) => el.getClientRects().length && !inside(el)))]
          .map((el) => el.textContent || el.getAttribute("aria-label") || el.className),
        cut: parts.filter((el) => el.getClientRects().length && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent),
        reachable: body.scrollHeight <= body.clientHeight + 1 || /auto|scroll/.test(style.overflowY),
      };
    });
    assert.equal(fit.inWindow, true, `${w}: the panel is inside the window`);
    assert.deepEqual(fit.clipped, [], `${w}: its tabs and close button are all inside it`);
    assert.deepEqual(fit.cut, [], `${w}: every tab shows its whole name`);
    assert.equal(fit.reachable, true, `${w}: what is below the fold can be scrolled to`);
  }
  assert.deepEqual(errors, []);
});

/* The old window's card, for the skipped bodies below. */
const width = (page, id) => page.evaluate((el) => document.getElementById(el).getBoundingClientRect().width, id);

// Redesign: replaced by the new window (prototype.html's side panel is a column beside the conversation on a wide
// window, not a floating 16px card over it; checked live above).
test.skip("DG-114 the side panel is one card named Side panel, over the conversation, closed until asked for", async (t) => {
  const { page, errors } = await fixture(t);
  assert.equal(await shown(page), false, "closed until asked for");
  const before = await width(page, "chat");
  await openCard(page);
  assert.equal(await page.locator("#aside-toggle").getAttribute("aria-pressed"), "true");
  assert.equal(await page.locator("#context-panel .lx-pane-name").textContent(), "Side panel", "named Side panel, not for a tab");
  assert.equal(await page.locator("#context-panel .lx-pane-tab").count(), 6, "its six tabs are inside it");
  assert.equal(await width(page, "chat"), before, "it floats over the conversation instead of narrowing it");
  const card = await page.evaluate(() => {
    const panel = document.getElementById("context-panel"), style = getComputedStyle(panel), box = panel.getBoundingClientRect();
    return { position: style.position, radius: style.borderTopLeftRadius, right: box.right, bottom: box.bottom, left: box.left,
      box: document.getElementById("chat-form").getBoundingClientRect().top, grid: getComputedStyle(document.body).gridTemplateColumns.split(" ").at(-1) };
  });
  assert.equal(card.position, "fixed");
  assert.equal(card.radius, "16px", "the sample's rounded card");
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.querySelector("body > main")).borderTopRightRadius), "0px",
    "the conversation keeps its own corner beside it");
  assert.equal(card.grid, "0px", "no column is kept for it");
  assert.ok(card.right <= 1440, "inside the window");
  assert.ok(card.bottom <= card.box, `it stops above the message box (${card.bottom} over ${card.box})`);
  /* The handle that resizes it sits on the card's own edge. */
  const handle = page.locator('.panels-rz[data-rz="aside"]');
  await handle.waitFor({ timeout: 5000 }).catch(() => assert.fail("the resize handle shows on the open card"));
  const grip = await handle.boundingBox();
  assert.ok(Math.abs(grip.x + 5 - card.left) <= 1, `the resize handle is on the card's edge (${grip.x} for ${card.left})`);
  /* Choosing a tab keeps the card's name: the tabs say which one is chosen. */
  await page.locator('#context-panel .lx-pane-tab[data-pane="plan"]').click();
  assert.equal(await page.locator("#context-panel .lx-pane-name").textContent(), "Side panel", "never titled by its tab");
  /* Its close button shuts it and hands the keyboard back to the button that opens it again. */
  await page.locator("#lx-pane-close").click();
  await page.locator("#context-panel").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(() => document.activeElement?.id), "aside-toggle", "the keyboard goes back to the switch that opens it");
  assert.equal(await page.locator("#aside-toggle").getAttribute("aria-pressed"), "false");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (no "Show everything" full window in prototype.html).
test.skip("DG-114 the full window's side panel is the same card, closed until asked for", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => (await import("/appearance.js")).changeAppearance({ showEverything: true }));
  await page.waitForFunction(() => document.documentElement.dataset.everything === "on");
  assert.equal(await shown(page), false, "no longer a column open by default");
  const before = await width(page, "chat");
  await openCard(page);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("context-panel")).position), "fixed");
  assert.equal(await width(page, "chat"), before, "it floats over the conversation instead of narrowing it");
  await page.locator("#aside-toggle").click();
  await page.locator("#context-panel").waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the old card's .lx-pane-* parts; the same promise is checked live above).
test.skip("DG-114 nothing in the card is clipped at 1440, 1280, 1180, 860 and 400 wide", async (t) => {
  const { page, errors } = await fixture(t);
  await openCard(page);
  for (const [w, h] of [[1440, 1000], [1280, 900], [1180, 900], [860, 900], [400, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    /* Read the card only once the window has taken the new width and drawn it, never the frame before. */
    await page.waitForFunction((width) => innerWidth === width
      && new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true)))), w);
    /* Crossing 1180 px the calm window puts the card away; one press of its switch must bring it back (it used to
       take two: the first only cleared a request the window still counted). */
    if (!(await shown(page))) {
      await page.locator("#aside-toggle").click();
      await page.locator("#context-panel").waitFor({ state: "visible", timeout: 5000 })
        .catch(() => assert.fail(`${w}: one press of the switch brings the card back`));
    }
    const fit = await page.evaluate(() => {
      const panel = document.getElementById("context-panel"), card = panel.getBoundingClientRect(), slack = 0.5;
      const inside = (el) => { const r = el.getBoundingClientRect(); return r.left >= card.left - slack && r.right <= card.right + slack; };
      const parts = [".lx-pane-name", "#lx-pane-close", ...[...panel.querySelectorAll(".lx-pane-tab")].map((_, i) => `.lx-pane-tab:nth-child(${i + 1})`)];
      const style = getComputedStyle(panel);
      return {
        inWindow: card.left >= 0 && card.right <= innerWidth && card.top >= 0 && card.bottom <= innerHeight,
        clipped: parts.filter((sel) => { const el = panel.querySelector(sel); return !el || el.getClientRects().length === 0 ? false : !inside(el); }),
        sideways: panel.scrollWidth > panel.clientWidth + 1,
        /* Every tab says its whole name: none is cut short with an ellipsis. */
        cut: [...panel.querySelectorAll(".lx-pane-tab .lx-words")].filter((word) => word.getClientRects().length && word.scrollWidth > word.clientWidth + 1)
          .map((word) => word.textContent),
        /* Whatever does not fit in its height can be scrolled to rather than cut off. */
        reachable: panel.scrollHeight <= panel.clientHeight + 1 || /auto|scroll/.test(style.overflowY),
      };
    });
    assert.equal(fit.inWindow, true, `${w}: the card is inside the window`);
    assert.deepEqual(fit.clipped, [], `${w}: its name, close button and tabs are all inside it`);
    assert.equal(fit.sideways, false, `${w}: nothing runs off its side`);
    assert.deepEqual(fit.cut, [], `${w}: every tab shows its whole name`);
    assert.equal(fit.reachable, true, `${w}: what is below the fold can be scrolled to`);
  }
  assert.deepEqual(errors, []);
});
