/* DG-176 / DG-177 in the real desktop app (Electron; build machines only, never an owner's desktop): the window
   has no system title bar, its top row moves it while its buttons still press, the window's own controls follow
   the light, and it opens filling the screen, then the way it was left. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { _electron } from "playwright";
import { connected, desktopOptions, onboarded } from "./fixtures/desktop-options.mjs";

const mainWindow = (electron, run) => electron.evaluate(({ BrowserWindow }, body) => {
  const win = BrowserWindow.getAllWindows().find((each) => each.getTitle() !== "" && !each.isDestroyed()) ?? BrowserWindow.getAllWindows()[0];
  return new Function("win", body)(win);
}, `return (${run.toString()})(win);`);

test("the desktop window has no system title bar, fills the screen first, and reopens as it was left", { timeout: 360000 }, async () => {
  const { options } = await desktopOptions();
  const electron = await _electron.launch(options);
  let left = null; // the window's size just before it closed
  try {
    const page = await electron.firstWindow();
    await onboarded(page);
    // Linux build machines draw windows with no window manager (Xvfb), and nothing can be maximised there;
    // the choice itself is tested in window-state.test.mjs.
    if (process.platform !== "linux")
      assert.equal(await mainWindow(electron, (win) => win.isMaximized()), true, "the first launch fills the screen");
    // Windows counts a frameless window's invisible resize borders in its outer size (16 px); a system title bar is 30 or more.
    const [outer, inner] = await mainWindow(electron, (win) => [win.getBounds().height, win.getContentBounds().height]);
    assert.ok(outer - inner < 24, `no title bar sits above the app's own top row (${outer} outside, ${inner} inside)`);
    assert.equal(await page.evaluate(() => window.branchDesktop.windowLook(false)), true);
    await assert.rejects(page.evaluate(() => window.branchDesktop.windowLook("#ff0000")), /Light or dark only/);
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
    const page = await again.firstWindow();
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
  const { options } = await desktopOptions();
  const electron = await _electron.launch(options);
  try {
    const page = await electron.firstWindow();
    await onboarded(page);
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
