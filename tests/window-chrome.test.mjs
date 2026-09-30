/* The desktop window's own minimise, maximise and close (src/desktop/window-chrome-ipc.ts): their glyphs read on the
   title row's colour at the WCAG AA ratio whatever that colour is, the overlay lets the row show through, and only
   the window's own page may set light, dark, #rrggbb, or request one bounded native pixel sample.
   The live window is checked in tests/desktop-window.test.mjs. */
import test from "node:test";
import assert from "node:assert/strict";
import { AA, contrast, glyphFor, overlayFor, registerWindowLookIpc, windowLookChannel } from "../dist/desktop/window-chrome-ipc.js";

test("the glyphs read on any row colour at the AA ratio, in the app's own colours where those reach it", () => {
  for (let v = 0; v <= 255; v += 5) {
    for (const ground of [[v, v, v], [v, 0, 0], [0, v, 0], [0, 0, v], [v, v, 0], [255 - v, v, 128]]) {
      const hex = `#${ground.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
      assert.ok(contrast(glyphFor(hex), hex) >= AA, `${glyphFor(hex)} on ${hex}: ${contrast(glyphFor(hex), hex).toFixed(2)}:1`);
    }
  }
  assert.equal(glyphFor("#101b21"), "#e3eef3", "a dark row keeps the app's light glyph");
  assert.equal(glyphFor("#f4f7f8"), "#23343e", "a light row keeps the app's dark glyph");
  assert.equal(glyphFor("#777777"), "#000000", "a mid grey neither of those reaches gets black or white");
  assert.equal(contrast("#ffffff", "#000000").toFixed(0), "21");
});

test("the overlay takes the row's colour fully see-through", () => {
  assert.deepEqual(overlayFor("#1A2B3C"), { color: "#1a2b3c00", symbolColor: "#e3eef3", height: 44 });
  assert.equal(overlayFor(true).color.slice(7), "00");
  assert.equal(overlayFor(false).symbolColor, "#23343e");
});

test("only the window's own page may set the look, and only as light, dark or #rrggbb", async () => {
  const handlers = new Map(), set = [];
  const mainFrame = { url: "http://127.0.0.1:4567/app/" };
  const webContents = { mainFrame };
  registerWindowLookIpc({ handle: (channel, fn) => handlers.set(channel, fn), removeHandler: () => {} },
    { webContents, on: () => {}, setTitleBarOverlay: (options) => set.push(options) }, "http://127.0.0.1:4567", "win32");
  const look = handlers.get(windowLookChannel);
  const own = { sender: webContents, senderFrame: mainFrame };
  assert.equal(look(own, "#203040"), true);
  assert.equal(look(own, false), true);
  assert.deepEqual(set.map((o) => o.color), ["#20304000", "#f4f7f800"]);
  for (const wrong of ["red", "#fff", "#2030401", "#203040; x", { dark: true }, null, 1])
    assert.throws(() => look(own, wrong), /Light, dark or one colour as #rrggbb only/);
  assert.throws(() => look({ sender: {}, senderFrame: mainFrame }, true), /access denied/);
  assert.throws(() => look({ sender: webContents, senderFrame: { url: mainFrame.url } }, true), /access denied/, "a frame inside the page");
  mainFrame.url = "http://127.0.0.1:9999/";
  assert.throws(() => look(own, true), /access denied/, "the window gone to another address");
  assert.equal(set.length, 2, "nothing refused reached the window");
});

test("the owned window samples its actual painted pixel and never returns it to the renderer", async () => {
  const handlers = new Map(), set = [], samples = [];
  const mainFrame = { url: "http://127.0.0.1:4567/app/" };
  const webContents = { mainFrame, capturePage: async (rect) => {
    samples.push(rect);
    return { toBitmap: () => Buffer.from([0x18, 0x2b, 0x48, 0xff]) };
  } };
  registerWindowLookIpc({ handle: (channel, fn) => handlers.set(channel, fn), removeHandler: () => {} },
    { webContents, on: () => {}, getContentBounds: () => ({ width: 900, height: 600 }), isDestroyed: () => false,
      setTitleBarOverlay: (options) => set.push(options) }, "http://127.0.0.1:4567", "win32");
  const look = handlers.get(windowLookChannel), own = { sender: webContents, senderFrame: mainFrame };
  assert.equal(await look(own, { sample: { x: 850, y: 2 } }), true);
  assert.equal(await look(own, { sample: { x: 850, y: 2 } }), true, "the moving wallpaper is sampled again");
  assert.deepEqual(samples, [{ x: 850, y: 2, width: 1, height: 1 }, { x: 850, y: 2, width: 1, height: 1 }]);
  assert.deepEqual(set.map((entry) => entry.color), ["#482b1800"]);
  for (const sample of [{ x: -1, y: 2 }, { x: 900, y: 2 }, { x: 1, y: 44 }, { x: 1.5, y: 2 }, { x: 1, y: 2, extra: true }])
    assert.throws(() => look(own, { sample }), /one colour|sample point/);
  assert.equal(samples.length, 2, "invalid points never capture the page");
});

test("an older sample cannot replace a newer look or survive a navigation", async () => {
  const handlers = new Map(), set = [];
  const mainFrame = { url: "http://127.0.0.1:4567/app/" };
  let finish;
  const webContents = { mainFrame, capturePage: () => new Promise((resolve) => { finish = resolve; }) };
  registerWindowLookIpc({ handle: (channel, fn) => handlers.set(channel, fn), removeHandler: () => {} },
    { webContents, on: () => {}, getContentBounds: () => ({ width: 900, height: 600 }), isDestroyed: () => false,
      setTitleBarOverlay: (options) => set.push(options) }, "http://127.0.0.1:4567", "win32");
  const look = handlers.get(windowLookChannel), own = { sender: webContents, senderFrame: mainFrame };
  const stale = look(own, { sample: { x: 850, y: 2 } });
  assert.equal(look(own, "#203040"), true);
  finish({ toBitmap: () => Buffer.from([0x18, 0x2b, 0x48, 0xff]) });
  assert.equal(await stale, true);
  assert.deepEqual(set.map((entry) => entry.color), ["#20304000"]);
  const navigated = look(own, { sample: { x: 850, y: 2 } });
  mainFrame.url = "http://127.0.0.1:9999/";
  finish({ toBitmap: () => Buffer.from([0x18, 0x2b, 0x48, 0xff]) });
  await assert.rejects(navigated, /access denied/);
  assert.equal(set.length, 1);
});
