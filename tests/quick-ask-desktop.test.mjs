/**
 * Pass 17, "Quick ask": the desktop app registers the owner's quick-ask keys (the engine's keys card) system-wide, and
 * a press opens the box in the window. Electron is replaced by small fakes; nothing here starts the desktop app.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { toAccelerator, registerQuickAsk, quickAskKeys, quickAskChannel, quickAskRefreshChannel } from "../dist/desktop/quick-ask.js";

test("keys are written as Electron accelerators; the default is ⌥ Space on a Mac; anything else is refused", () => {
  assert.equal(toAccelerator("Ctrl+Shift+Space", "win32"), "CommandOrControl+Shift+Space");
  assert.equal(toAccelerator("Ctrl+Shift+Space", "darwin"), "Alt+Space");
  assert.equal(toAccelerator("Alt+Shift+Q", "darwin"), "Alt+Shift+Q", "a Mac owner's own choice is kept");
  assert.equal(toAccelerator("Control+K", "darwin"), "Control+K");
  assert.equal(toAccelerator("", "win32"), null, "no keys, nothing registered");
  assert.equal(toAccelerator("Space", "win32"), null, "a key alone is not a shortcut");
  assert.equal(toAccelerator("Ctrl+Shift+Space\nrm", "win32"), null);
});

function fakes(keys) {
  const held = new Map(), handlers = new Map(), listeners = new Map(), sent = [];
  const webContents = { send: (channel) => sent.push(channel) };
  webContents.mainFrame = { url: "http://127.0.0.1:4567/?desktop=1" };
  const window = { webContents, shown: 0, on: (name, fn) => listeners.set(name, fn), show() { this.shown++; }, focus() {}, isDestroyed: () => false };
  const shortcuts = { taken: new Set(), register(acc, fn) { if (this.taken.has(acc)) return false; held.set(acc, fn); return true; }, unregister(acc) { held.delete(acc); } };
  const ipc = { handle: (name, fn) => handlers.set(name, fn), removeHandler: (name) => handlers.delete(name) };
  const state = { keys };
  const letGo = () => registerQuickAsk({ shortcuts, ipc, window, origin: "http://127.0.0.1:4567", keys: async () => state.keys, platform: "win32" });
  return { held, handlers, listeners, sent, window, shortcuts, state, letGo, event: { sender: webContents, senderFrame: webContents.mainFrame } };
}
const settle = () => new Promise((r) => setTimeout(r, 10));

test("a press shows the window and opens the box; changed keys are registered again, only when the page asks", async () => {
  const f = fakes("Ctrl+Shift+Space");
  f.letGo();
  await settle();
  assert.deepEqual([...f.held.keys()], ["CommandOrControl+Shift+Space"]);
  f.held.get("CommandOrControl+Shift+Space")();
  assert.equal(f.window.shown, 1);
  assert.deepEqual(f.sent, [quickAskChannel]);
  f.state.keys = "Alt+Q";
  assert.equal(await f.handlers.get(quickAskRefreshChannel)(f.event), true);
  assert.deepEqual([...f.held.keys()], ["Alt+Q"], "the old keys are let go");
  await assert.rejects(async () => f.handlers.get(quickAskRefreshChannel)({ sender: {}, senderFrame: {} }), /denied/, "only this window's own page may ask");
  f.listeners.get("closed")();
  assert.equal(f.held.size, 0, "closing the window lets go of the keys");
  assert.equal(f.handlers.size, 0);
});

test("keys another app holds are left alone, and none set means nothing registered", async () => {
  const f = fakes("Ctrl+Shift+Space");
  f.shortcuts.taken.add("CommandOrControl+Shift+Space");
  f.letGo();
  await settle();
  assert.equal(f.held.size, 0);
  f.state.keys = "";
  assert.equal(await f.handlers.get(quickAskRefreshChannel)(f.event), false);
});

test("the keys are read from the local engine only", async () => {
  const asked = [];
  const call = async (url, init) => { asked.push([url, init.headers.authorization]); return { ok: true, json: async () => ({ values: { keys: { quickAsk: "Alt+Q" } } }) }; };
  assert.equal(await quickAskKeys("http://127.0.0.1:4567", "t0k", call), "Alt+Q");
  assert.deepEqual(asked, [["http://127.0.0.1:4567/api/comfort", "Bearer t0k"]]);
  assert.equal(await quickAskKeys("http://example.com:4567", "t0k", call), "", "never somewhere else");
  assert.equal(asked.length, 1);
});
