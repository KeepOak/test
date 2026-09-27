/* DG-177: how the desktop window opens (src/desktop/window-state.ts). No window is opened here. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openingFor, readWindowState, restoreBounds, writeWindowState } from "../dist/desktop/window-state.js";

const laptop = [{ x: 0, y: 0, width: 1920, height: 1040 }];
const twoScreens = [...laptop, { x: 1920, y: 0, width: 2560, height: 1400 }];

test("the first launch fills the screen", () => {
  assert.deepEqual(openingFor(undefined, laptop), { maximized: true });
  assert.deepEqual(openingFor({ nonsense: true }, laptop), { maximized: true }, "an unreadable file is a first launch");
});

test("later launches open the way the owner left the window", () => {
  assert.deepEqual(openingFor({ maximized: true, bounds: { x: 100, y: 80, width: 1200, height: 800 } }, laptop),
    { maximized: true, bounds: { x: 100, y: 80, width: 1200, height: 800 } });
  assert.deepEqual(openingFor({ maximized: false, bounds: { x: 100, y: 80, width: 1200, height: 800 } }, laptop),
    { maximized: false, bounds: { x: 100, y: 80, width: 1200, height: 800 } });
});

test("a place on a screen that is gone, or a size below the minimum, is not reused", () => {
  const onSecond = { maximized: false, bounds: { x: 2400, y: 100, width: 1200, height: 800 } };
  assert.deepEqual(openingFor(onSecond, twoScreens).bounds, onSecond.bounds);
  assert.deepEqual(openingFor(onSecond, laptop), { maximized: false }, "the second monitor was unplugged");
  assert.deepEqual(openingFor({ maximized: false, bounds: { x: 10, y: 10, width: 300, height: 200 } }, laptop), { maximized: false });
});

/* A stand-in for a window on a display scaled to 150 %, as measured on Windows with Electron: a size set reads back one
   wider than it was set (900 reads 901, 901 reads 902). */
function scaledWindow() {
  let set = null;
  return {
    setBounds(bounds) { set = { ...bounds }; },
    getBounds() { return { ...set, width: set.width + 1 }; },
  };
}

test("reopening at 150 % scaling restores the size that was saved, again and again, instead of growing", () => {
  const window = scaledWindow();
  window.setBounds({ x: 60, y: 60, width: 900, height: 640 });
  let saved = window.getBounds();
  assert.deepEqual([saved.width, saved.height], [901, 640]);
  for (let reopen = 0; reopen < 3; reopen++) {
    const again = scaledWindow();
    restoreBounds(again, saved);
    assert.deepEqual(again.getBounds(), saved, `reopen ${reopen + 1} reads the saved size`);
    saved = again.getBounds();
  }
  const exact = { setBounds(bounds) { this.bounds = bounds; this.calls = (this.calls ?? 0) + 1; }, getBounds() { return this.bounds; } };
  restoreBounds(exact, { x: 0, y: 0, width: 1000, height: 700 });
  assert.equal(exact.calls, 1, "a display that reads back what was set is set once");
});

test("the state is written whole and read back, and a bad write changes nothing", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-window-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "window-state.json");
  assert.equal(readWindowState(file), undefined);
  writeWindowState(file, { maximized: false, bounds: { x: 5, y: 6, width: 1000, height: 700 } });
  assert.deepEqual(readWindowState(file), { maximized: false, bounds: { x: 5, y: 6, width: 1000, height: 700 } });
  writeWindowState(file, { maximized: "yes", bounds: { x: 0, y: 0, width: 1, height: 1 } });
  assert.deepEqual(readWindowState(file), { maximized: false, bounds: { x: 5, y: 6, width: 1000, height: 700 } });
});
