/* The desktop app's minimise, maximise and close (Windows and Linux: Electron's titleBarOverlay, the browser's Window
   Controls Overlay) are drawn by the operating system over the title row's right end. Nothing of the page's may sit
   under them at any width or in any mode, and the row keeps moving the window (shell/shell.js reserveControls, app.css
   "title bar and the window's own controls"). The overlay is given to a headless page the way Chromium reports it
   (navigator.windowControlsOverlay); tests/desktop-window.test.mjs checks the same in the real desktop window.
   Also here: the "Branch <new> is ready" card's Install calls the desktop's install as the owner's press, says a wait
   in the updater's words, and is never drawn in a household person's window (chat/rec.js installNow).
   Mutations: drop the `.app .titlebar{padding-right:…}` rule and the first case goes red; drop the
   `.app:not(.merged14)` row rule and its 760 px case goes red; drop `|| !ownerHere()` from updateCard and the last does; make installNow
   call installUpdate(true) and the Install case does. */
import test from "node:test";
import assert from "node:assert/strict";
import { settingsWindow } from "./settings-window.mjs";
import { saveComfort } from "../dist/comfort/settings.js";
import { waitInPage } from "./wait-in-page.mjs";

const provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };
const CONTROLS = { width: 138, height: 44 }; // Windows 11's three buttons at 100 %, as Electron draws them (overlayHeight)

/* Chromium's own shape of the overlay: the title-bar area is the row left of the controls, and it moves with the window. */
const withOverlay = (controls) => (page) => page.addInitScript(({ width, height }) => {
  const listeners = new Set();
  const overlay = { visible: true, getTitlebarAreaRect: () => new DOMRect(0, 0, Math.max(0, innerWidth - width), height),
    addEventListener: (type, fn) => { if (type === "geometrychange") listeners.add(fn); }, removeEventListener: (type, fn) => listeners.delete(fn) };
  Object.defineProperty(Navigator.prototype, "windowControlsOverlay", { configurable: true, get: () => overlay });
}, controls);

/* Every visible button, field, picture or run of words in the window that reaches into the controls' corner. A box
   with tabindex -1 (the conversation, focusable by a click only) is a container, not a control. */
function hitsUnder({ width, height }) {
  const left = innerWidth - width, hits = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
    const box = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (!box.width || !box.height || style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
    const leaf = el.matches("button,a,input,select,textarea,[data-act],[tabindex]:not([tabindex='-1']),svg,img,video,canvas")
      || [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
    if (leaf && box.right > left + 0.5 && box.left < innerWidth && box.top < height && box.bottom > 0)
      hits.push(`${el.tagName.toLowerCase()}[${el.dataset.act ?? el.className?.baseVal ?? el.className}] ${Math.round(box.left)}–${Math.round(box.right)} × ${Math.round(box.top)}–${Math.round(box.bottom)}`);
  }
  return hits;
}
const underControls = (page) => page.evaluate(hitsUnder, CONTROLS);

async function show(page, view) {
  if (view === "chat") {
    const fresh = page.locator('[data-act="newconv"]:visible').first();
    if (await fresh.count()) await fresh.click(); else await page.keyboard.press("ControlOrMeta+n");
    await page.locator("#prompt").waitFor();
  } else if (view === "settings") {
    await page.keyboard.press("ControlOrMeta+Comma");
    await page.locator(".settings").waitFor();
  } else {
    const nav = page.locator(`#side [data-act="view"][data-v="${view}"]`).first();
    const menu = page.locator('.titlebar [data-act="side"]:visible'); // a narrow window slides its list in first
    if (await menu.count()) { await menu.first().click(); await page.locator("#app.side-open").waitFor(); }
    await nav.click();
    await page.locator("#main .place h1").first().waitFor();
  }
}

test("nothing sits under the window's own controls at any width, and the row still moves the window", async (t) => {
  const { page, errors } = await settingsWindow(t, { provider, route: withOverlay(CONTROLS), name: "titlebar-controls" });
  for (const width of [1440, 1024, 800, 760, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const view of ["chat", "overview", "settings"]) {
      await show(page, view);
      assert.deepEqual(await underControls(page), [], `${width} px, ${view}: nothing under the controls`);
      const row = await page.evaluate(({ width: w }) => {
        const header = document.querySelector("#app .titlebar");
        const at = document.elementFromPoint(innerWidth - w / 2, 20);
        return { reserved: parseFloat(getComputedStyle(header).paddingRight), drag: getComputedStyle(at).webkitAppRegion ?? getComputedStyle(at).getPropertyValue("-webkit-app-region"), inRow: header.contains(at) || at.classList.contains("drag17") };
      }, CONTROLS);
      assert.ok(row.reserved >= CONTROLS.width, `${width} px, ${view}: the row keeps the controls' width clear (${row.reserved})`);
      assert.ok(row.inRow, `${width} px, ${view}: the controls' corner is the title row's own`);
      assert.equal(row.drag, "drag", `${width} px, ${view}: and it moves the window`);
    }
  }
  /* Focus mode keeps a row of its own; it is never shorter than the controls. */
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 900 });
    await show(page, "chat");
    await page.keyboard.press("Control+Period"); // "Leave focus mode · Ctrl+." both ways
    await page.locator("#app.focus").waitFor();
    assert.deepEqual(await underControls(page), [], `${width} px, focus mode: nothing under the controls`);
    const rowHeight = await page.evaluate(() => document.querySelector("#app .titlebar").getBoundingClientRect().height);
    assert.ok(rowHeight >= CONTROLS.height, `${width} px, focus mode: the row is as tall as the controls (${rowHeight})`);
    await page.keyboard.press("Control+Period");
    await page.locator("#app:not(.focus)").waitFor();
  }
  assert.deepEqual(errors, []);
});

test("in a browser, with no controls drawn over the page, the title row keeps its own edge", async (t) => {
  const { page, errors } = await settingsWindow(t, { provider, name: "titlebar-browser" });
  await show(page, "overview");
  const row = await page.evaluate(() => ({ pad: getComputedStyle(document.querySelector("#app .titlebar")).paddingRight }));
  assert.equal(row.pad, "0px");
  assert.deepEqual(errors, []);
});

/* The update screen (shell/updating.js) covers the whole window while an install the owner pressed runs. */
test("the update screen leaves the controls' corner clear", async (t) => {
  const route = async (page) => {
    await withOverlay(CONTROLS)(page);
    await page.addInitScript(() => {
      window.branchDesktop = { updateStatus: async () => null, onUpdateStatus: (heard) => { window.heardUpdate = heard; } };
    });
  };
  const { page, errors } = await settingsWindow(t, { provider, route, name: "titlebar-update-screen" });
  /* An install the owner pressed, as the updater reports its first step. */
  await page.evaluate(() => {
    const at = new Date().toISOString();
    window.heardUpdate({ phase: "downloading", message: "", automatic: false, updatedAt: at, outcome: null, failure: null,
      release: { channel: "stable", latestVersion: "0.99.0", available: true }, target: { version: "0.99.0", commit: null },
      stages: [{ id: "downloading", state: "running", startedAt: at }, { id: "checking", state: "waiting" }, { id: "copying", state: "waiting" }, { id: "swapping", state: "waiting" }, { id: "restarting", state: "waiting" }] });
  });
  await page.locator("#upd18.upd18:not([hidden])").waitFor({ timeout: 15000 });
  for (const [width, height] of [[1440, 900], [760, 520], [390, 700]]) {
    await page.setViewportSize({ width, height });
    // The layout for the new width lands a frame or so after the resize: the window is given until it has settled, and
    // what is still under the controls then is what the failure names.
    await page.waitForFunction(`(${hitsUnder})(${JSON.stringify(CONTROLS)}).length === 0`, undefined, { timeout: 5000 }).catch(() => undefined);
    assert.deepEqual(await underControls(page), [], `${width} by ${height}: nothing under the controls`);
  }
  assert.deepEqual(errors, []);
});

/* The desktop's updater and install call, as preload.cts exposes them; each install call is kept for the test to read. */
const withUpdater = (answer) => (page) => page.addInitScript((refuse) => {
  window.installCalls = [];
  window.statusCalls = 0;
  window.branchDesktop = {
    updateStatus: async () => (window.statusCalls += 1, { phase: "available", release: { available: true, latestVersion: "0.99.0-test", notes: "- A line" } }),
    installUpdate: async (...args) => {
      window.installCalls.push(args);
      if (refuse) throw new Error(`Error invoking remote method 'branch:update-install': UpdateDeferredError: ${refuse}`);
      return { phase: "applying" };
    },
  };
}, answer);

async function card(page) {
  await show(page, "overview");
  const found = page.locator("#main .place .upd18c");
  await found.waitFor({ timeout: 15000 });
  return found;
}

test("Install on the ready card installs as the owner's press, and says a wait in the updater's words", async (t) => {
  const WAIT = "An update is ready, but Branch will wait until every task finishes or is answered.";
  // Updating by itself ships on (the ship-on rule) and would install the ready update by itself; this test is about the
  // owner's own press, so the owner switches it off first.
  const { page, errors } = await settingsWindow(t, { provider, route: withUpdater(WAIT), name: "titlebar-install",
    before: (app) => { saveComfort(app.store, app.runtime.owner, "notify", { autoUpdate: "off" }); } });
  const install = (await card(page)).locator('[data-act="install"]');
  assert.notEqual(await install.getAttribute("aria-disabled"), "true", "Install is live in the desktop app");
  await install.click();
  await page.locator(".toast", { hasText: WAIT }).waitFor({ timeout: 10000 });
  assert.deepEqual(await page.evaluate(() => window.installCalls), [[false]], "one call, as the owner's press, naming no other change");
  assert.equal(await page.locator("#main .upd18c").count(), 1, "the card stays while the update waits");
  assert.deepEqual(errors, []);
});

test("a household person's window never draws the ready card or its Install", async (t) => {
  const { page, errors } = await settingsWindow(t, { provider, route: async (p) => {
    await withUpdater(null)(p);
    await p.route("**/api/profiles", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), isOwner: false } });
    });
  }, name: "titlebar-household" });
  await waitInPage(page, async () => (await import("/app/core/state.js")).E.profiles?.isOwner === false);
  await show(page, "overview");
  assert.equal(await page.locator(".upd18c, [data-act='install']").count(), 0);
  assert.equal(await page.evaluate(() => window.statusCalls), 0, "the updater is not even asked in a household person's window");
  assert.deepEqual(await page.evaluate(() => window.installCalls), []);
  assert.deepEqual(errors, []);
});
