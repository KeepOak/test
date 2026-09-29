/* DG-176 / DG-177 in the real desktop app (Electron; build machines only, never an owner's desktop): the window
   has no system title bar, its top row moves it while its buttons still press, the window's own controls follow
   the light, and it opens filling the screen, then the way it was left. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright";
import { connected, desktopOptions, onboarded, STARTUP_MS } from "./fixtures/desktop-options.mjs";

const mainWindow = (electron, run) => electron.evaluate(({ BrowserWindow }, body) => {
  const win = BrowserWindow.getAllWindows().find((each) => each.getTitle() !== "" && !each.isDestroyed()) ?? BrowserWindow.getAllWindows()[0];
  return new Function("win", body)(win);
}, `return (${run.toString()})(win);`);

/* The window of a hidden launch (fixtures/desktop-options.mjs): it must never be on the screen. */
const staysHidden = async (electron, when) =>
  assert.equal(await mainWindow(electron, (win) => win.isVisible()), false, `the test's window is not on the screen (${when})`);

/* Filling the screen needs a window on the screen, so this runs on build machines only (CI), never on a desktop
   someone is using. */
test("the desktop window has no system title bar, fills the screen first, and reopens as it was left", { timeout: 360000, skip: !process.env.CI && "it shows a window: build machines only" }, async () => {
  const { options } = await desktopOptions();
  const electron = await _electron.launch(options);
  let left = null; // the window's size just before it closed
  try {
    const page = await electron.firstWindow({ timeout: STARTUP_MS });
    await onboarded(page);
    // Linux build machines draw windows with no window manager (Xvfb), and nothing can be maximised there;
    // the choice itself is tested in window-state.test.mjs.
    if (process.platform !== "linux")
      assert.equal(await mainWindow(electron, (win) => win.isMaximized()), true, "the first launch fills the screen");
    // Windows counts a frameless window's invisible resize borders in its outer size (16 px); a system title bar is 30 or more.
    const [outer, inner] = await mainWindow(electron, (win) => [win.getBounds().height, win.getContentBounds().height]);
    assert.ok(outer - inner < 24, `no title bar sits above the app's own top row (${outer} outside, ${inner} inside)`);
    assert.equal(await page.evaluate(() => window.branchDesktop.windowLook(false)), true);
    assert.equal(await page.evaluate(() => window.branchDesktop.windowLook("#ff0000")), true, "or the row's own colour");
    for (const wrong of ["red", "#ff0000; color: red", "#fff", { dark: true }])
      await assert.rejects(page.evaluate((look) => window.branchDesktop.windowLook(look), wrong), /Light, dark or one colour as #rrggbb only/);
    await mainWindow(electron, (win) => { win.unmaximize(); win.setBounds({ x: 60, y: 60, width: 900, height: 640 }); return true; });
    await page.waitForTimeout(800);
    left = await mainWindow(electron, (win) => win.getNormalBounds());
    // Linux build machines have no window manager, which may not let a window be resized; elsewhere it must have been.
    // A display scaled by a fraction (150 %) reports a size set in points a pixel off (901 by 641 for 900 by 640); a
    // window still at its maximised size would be far off. Reopening, below, is held to the size read here exactly.
    if (process.platform !== "linux")
      assert.ok(Math.abs(left.width - 900) <= 2 && Math.abs(left.height - 640) <= 2,
        `the new size took, so reopening can prove it is kept (${left.width} by ${left.height})`);
  } finally {
    await electron.close();
  }
  const again = await _electron.launch(options);
  try {
    const page = await again.firstWindow({ timeout: STARTUP_MS });
    await connected(page);
    assert.equal(await mainWindow(again, (win) => win.isMaximized()), false, "it reopens the way it was left");
    const bounds = await mainWindow(again, (win) => win.getNormalBounds());
    assert.deepEqual([bounds.width, bounds.height], [left.width, left.height], "it reopens at the size it was left at");
  } finally {
    await again.close();
  }
});

/* Its own test, so the window's top row and the reopening above each report on their own. */
test("the desktop window's own top row moves it while its buttons still press", { timeout: 360000 }, async () => {
  const { options } = await desktopOptions({ hidden: true });
  const electron = await _electron.launch(options);
  try {
    const page = await electron.firstWindow({ timeout: STARTUP_MS });
    await onboarded(page);
    await staysHidden(electron, "opened");
    // Redesign: the old window marked the desktop frame with body.lx-desktop-frame and its top row was body.lx header.
    // The new window's top row is header.titlebar, drawn as the window's own frame (its window buttons, the Mac's
    // traffic lights) as in the prototype, so that is the row that must move the frameless window.
    const regions = await page.evaluate(() => ({
      header: getComputedStyle(document.querySelector("#app header.titlebar")).webkitAppRegion,
      button: getComputedStyle(document.querySelector("#app header.titlebar button")).webkitAppRegion,
    }));
    assert.deepEqual(regions, { header: "drag", button: "no-drag" }, "the top row moves the window; its buttons still press");
  } finally {
    await electron.close();
  }
});

/* What of the page reaches into the controls' corner, and whether that corner moves the window. */
const underControls = (page) => page.evaluate(() => {
  const area = navigator.windowControlsOverlay.getTitlebarAreaRect();
  const left = area.x + area.width, bottom = area.y + area.height, hits = [];
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
    const box = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (!box.width || !box.height || style.visibility === "hidden" || style.display === "none") continue;
    const leaf = el.matches("button,a,input,select,textarea,[data-act],[tabindex]:not([tabindex='-1']),svg,img,video,canvas")
      || [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
    if (leaf && box.right > left + 0.5 && box.left < innerWidth && box.top < bottom && box.bottom > 0) hits.push(el.dataset.act ?? el.tagName);
  }
  const corner = document.elementFromPoint(Math.min(innerWidth - 1, left + 1), Math.max(0, bottom / 2));
  return { visible: navigator.windowControlsOverlay.visible, width: innerWidth, left, hits, drag: getComputedStyle(corner).webkitAppRegion };
});

/* Windows and Linux draw minimise, maximise and close over the title row (titleBarOverlay). Whatever the window's width
   and whichever page shows, none of the page's buttons or words sits under them, and their corner still moves the
   window (shell/shell.js reserveControls; tests/titlebar-controls.test.mjs checks the same headless). The Mac draws its
   traffic lights on the left instead. */
test("nothing of the page sits under the desktop window's own controls", { timeout: 360000 }, async (t) => {
  if (process.platform === "darwin") return t.skip("the Mac's traffic lights sit on the left");
  const { options } = await desktopOptions({ hidden: true });
  const electron = await _electron.launch(options);
  try {
    const page = await electron.firstWindow({ timeout: STARTUP_MS });
    await connected(page);
    await staysHidden(electron, "opened");
    await page.locator(".ob9").waitFor(); // setup, over a fresh data folder
    assert.deepEqual((await underControls(page)).hits, [], "setup: nothing under the controls");
    await onboarded(page);
    // Linux build machines have no window manager and may keep the window's size, so there it is checked at the size it has.
    for (const width of process.platform === "linux" ? [null] : [1440, 1024, 760]) {
      if (width) {
        await electron.evaluate(({ BrowserWindow }, w) => {
          const win = BrowserWindow.getAllWindows().find((each) => each.getTitle() !== "" && !each.isDestroyed()) ?? BrowserWindow.getAllWindows()[0];
          win.setContentSize(w, 800);
          return true;
        }, width);
        // A screen smaller than asked keeps the window smaller: it is then checked at the width it took.
        await page.waitForFunction((w) => innerWidth === w, width, { timeout: 5000 }).catch(() => {});
        await staysHidden(electron, `at ${width} px`);
      }
      for (const view of ["overview", "settings"]) {
        if (view === "settings") await page.keyboard.press("Control+Comma");
        else await page.evaluate(() => document.querySelector('#side [data-act="view"][data-v="overview"]').click());
        await page.locator(view === "settings" ? ".settings" : "#main .place h1").first().waitFor();
        // The title row makes room once the overlay reports its new place (geometrychange), a frame or so after a resize
        // or a new page, so the reading is taken again until it settles.
        let found = await underControls(page);
        for (let tries = 0; tries < 50 && found.hits.length; tries++) { await page.waitForTimeout(100); found = await underControls(page); }
        assert.equal(found.visible, true, "the window's controls are drawn over the page");
        assert.ok(found.left < found.width, `${found.width} px: the controls take room at the right (${found.left})`);
        assert.deepEqual(found.hits, [], `${found.width} px, ${view}: nothing under the controls`);
        assert.equal(found.drag, "drag", `${found.width} px, ${view}: the controls' corner still moves the window`);
      }
    }
  } finally {
    await electron.close();
  }
});

/* The controls' glyphs follow the look (shell/controls.js followControlsLook, src/desktop/window-chrome-ipc.ts): for every
   shipped theme, light and dark, and for the computer's own light or dark, the overlay is told the colour the page
   really is under the controls (read from a capture of that pixel), its ground takes that colour fully see-through,
   and the glyphs read on it at the WCAG AA ratio or better. */
const hex = (c) => [1, 3, 5].map((at) => parseInt(c.slice(at, at + 2), 16));
const lum = (c) => { const [r, g, b] = hex(c).map((v) => v / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

async function cornerPixel(page, electron) {
  const at = await page.evaluate(() => { const area = navigator.windowControlsOverlay.getTitlebarAreaRect(); return { x: Math.min(innerWidth - 2, area.x + area.width + 2), y: area.y + 2 }; });
  return electron.evaluate(async ({ BrowserWindow }, { x, y }) => {
    const win = BrowserWindow.getAllWindows().find((each) => each.getTitle() !== "" && !each.isDestroyed()) ?? BrowserWindow.getAllWindows()[0];
    const image = await win.webContents.capturePage({ x, y, width: 1, height: 1 });
    const [b, g, r] = image.toBitmap(); // Skia's own order on Windows and Linux: blue, green, red, alpha
    return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  }, at);
}

test("the desktop window's own controls follow the look, in every shipped theme, light and dark", { timeout: 360000 }, async (t) => {
  if (process.platform === "darwin") return t.skip("the Mac's traffic lights are drawn by the Mac");
  const { options } = await desktopOptions({ hidden: true });
  const electron = await _electron.launch(options);
  try {
    const page = await electron.firstWindow({ timeout: STARTUP_MS });
    await onboarded(page);
    await staysHidden(electron, "opened");
    await mainWindow(electron, (win) => {
      globalThis.overlaysSeen = [];
      const set = win.setTitleBarOverlay.bind(win);
      win.setTitleBarOverlay = (options) => { globalThis.overlaysSeen.push(options); return set(options); };
      return true;
    });
    const lastOverlay = () => electron.evaluate(() => globalThis.overlaysSeen.at(-1) ?? null);
    /* The look has settled once the overlay names the colour a screenshot finds under the controls. */
    const followed = async (what, settled = () => true) => {
      let pixel = null, overlay = null;
      for (const started = Date.now(); Date.now() - started < 8000;) {
        [pixel, overlay] = [await cornerPixel(page, electron), await lastOverlay()];
        if (overlay && settled(pixel) && hex(overlay.color.slice(0, 7)).every((c, i) => Math.abs(c - hex(pixel)[i]) <= 3)) break;
        await page.waitForTimeout(50);
      }
      assert.ok(overlay, `${what}: the overlay was told`);
      assert.ok(settled(pixel), `${what}: the page took the change (${pixel})`);
      assert.ok(hex(overlay.color.slice(0, 7)).every((c, i) => Math.abs(c - hex(pixel)[i]) <= 3), `${what}: the overlay follows the row's colour ${pixel} (${overlay.color})`);
      assert.equal(overlay.color.slice(7), "00", `${what}: and lets the row show through`);
      assert.ok(ratio(overlay.symbolColor, pixel) >= 4.5, `${what}: the glyphs ${overlay.symbolColor} read on ${pixel} (${ratio(overlay.symbolColor, pixel).toFixed(2)}:1)`);
      return overlay;
    };
    const ids = await page.evaluate(async () => ["slate", ...(await import("/theme-catalogue.js")).THEMES.map((row) => row[0]).filter((id) => id !== "slate")]);
    assert.ok(ids.length >= 40, `every shipped theme (${ids.length})`);
    for (const id of ids) {
      await page.evaluate(async (theme) => { document.documentElement.dataset.theme = "light"; await (await import("/app/shell/look.js")).wear(theme); }, id);
      await followed(`${id}, light`);
      await page.evaluate(async () => { document.documentElement.dataset.theme = "dark"; (await import("/app/shell/look.js")).applyLook(); });
      await followed(`${id}, dark`);
    }
    /* Following the computer: its light or dark changes the page, and the controls with it. (Playwright holds the page's
       prefers-color-scheme itself, so the computer's change is given through it.) */
    await page.evaluate(async () => { delete document.documentElement.dataset.theme; await (await import("/app/shell/look.js")).wear("slate"); });
    const seen = [];
    for (const source of ["light", "dark", "light"]) {
      await page.emulateMedia({ colorScheme: source });
      await page.waitForFunction((s) => matchMedia(`(prefers-color-scheme: ${s})`).matches, source);
      // The page takes the computer's change in its own time: settled once the row itself is light or dark.
      seen.push((await followed(`the computer's ${source}`, (pixel) => (source === "dark" ? lum(pixel) < 0.2 : lum(pixel) > 0.4))).symbolColor);
    }
    assert.notEqual(seen[0], seen[1], "the glyphs changed with the computer's light or dark");
    assert.equal(seen[0], seen[2], "and changed back");
    await staysHidden(electron, "after every look");
  } finally {
    await electron.close();
  }
});
