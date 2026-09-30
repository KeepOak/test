import test from "node:test";
import assert from "node:assert/strict";
import { registerLiveWindowIpc, windowUpdatedChannel, reloadLiveChannel, windowRestoredChannel, windowResultChannel } from "../dist/desktop/live-window-ipc.js";

const commit = "a".repeat(40);
const delay = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
function fixture(t, options = {}) {
  const handles = new Map(), sent = [], closeListeners = [];
  let closed = 0, reloaded = 0, recovery;
  const webContents = { mainFrame: { url: "http://localhost:45001/" }, getURL: () => "http://localhost:45001/",
    send: (channel, update) => sent.push({ channel, update }), capturePage: async () => ({}), reloadIgnoringCache: () => { reloaded++; }, loadURL: async (url) => { reloaded++; recovery = new URL(url).searchParams.get("_branch_live_restore"); } };
  const window = { webContents, on: (_, callback) => closeListeners.push(callback), isVisible: () => true,
    isMinimized: () => false, getContentBounds: () => ({}), isDestroyed: () => false };
  const live = registerLiveWindowIpc({ ipc: { handle: (channel, callback) => handles.set(channel, callback), removeHandler: (channel) => handles.delete(channel) },
    window, origin: "http://localhost:45001", cover: () => ({ show: async () => {}, close: () => { closed++; } }),
    restoreMs: 30, applyMs: 150, retryMs: 5, ...options });
  t.after(() => closeListeners.forEach((callback) => callback()));
  const event = { sender: webContents, senderFrame: webContents.mainFrame };
  return { ...live, sent, get closed() { return closed; }, get reloaded() { return reloaded; }, get recovery() { return recovery; },
    call: (channel, value, from = event) => handles.get(channel)(from, value), event };
}

test("a stylesheet update is pending until its exact commit is acknowledged", async (t) => {
  const f = fixture(t); let settled = false;
  const applied = f.tell({ commit, styles: ["app.css"], reload: false }).then(() => { settled = true; });
  await delay(); assert.equal(settled, false);
  assert.equal(f.call(windowResultChannel, { commit: "b".repeat(40), ok: true }), false);
  assert.equal(f.call(windowResultChannel, { commit, ok: true }), true);
  await applied; assert.equal(settled, true);
});
test("a deferred snapshot retries automatically and a reload requires a real painted commit", async (t) => {
  const f = fixture(t);
  const applied = f.tell({ commit, styles: [], reload: true });
  assert.equal(f.call(windowResultChannel, { commit, ok: false, deferred: true, message: "wait for session" }), true);
  await delay(12); assert.equal(f.sent.filter((item) => item.channel === windowUpdatedChannel).length, 2);
  const reload = f.call(reloadLiveChannel, commit); await delay();
  assert.equal(f.call(windowResultChannel, { commit, ok: true }), false);
  assert.equal(f.call(windowRestoredChannel, "old"), false);
  assert.equal(f.closed, 0);
  assert.equal(f.call(windowRestoredChannel, commit), true);
  assert.equal(await reload, true); await applied; assert.equal(f.closed, 1);
});
test("a never-restored page times out without revealing it; recovery waits for the old page to paint", async (t) => {
  const f = fixture(t);
  const applied = f.tell({ commit, styles: [], reload: true });
  const failed = assert.rejects(applied, /did not restore and draw/);
  await assert.rejects(f.call(reloadLiveChannel, commit), /did not restore and draw/); await failed;
  assert.equal(f.closed, 0, "the safe old picture stays over the failed page");
  const recovered = f.recover(); await delay();
  assert.equal(f.reloaded, 2); assert.equal(f.closed, 0);
  assert.equal(f.call(windowRestoredChannel, commit), false, "a late failed-page acknowledgment cannot uncover recovery");
  assert.equal(f.call(windowRestoredChannel, f.recovery), true);
  await recovered; assert.equal(f.closed, 1);
});
test("an unacknowledged stylesheet is deferred, and an unauthorized frame cannot acknowledge it", async (t) => {
  const f = fixture(t, { applyMs: 20 });
  const applied = f.tell({ commit, styles: ["app.css"], reload: false });
  assert.throws(() => f.call(windowResultChannel, { commit, ok: true }, { ...f.event, senderFrame: { url: "http://localhost:45001/" } }), /access denied/);
  await assert.rejects(applied, /did not confirm/);
});

test("a reload near the snapshot deadline uses its own paint deadline without overlapping recovery", async (t) => {
  const f = fixture(t, { applyMs: 20, restoreMs: 100 });
  const applied = f.tell({ commit, styles: [], reload: true });
  const rejected = applied.then(() => false, () => true);
  const reload = f.call(reloadLiveChannel, commit);
  await delay(35);
  assert.equal(f.closed, 0);
  assert.equal(f.call(windowRestoredChannel, commit), true);
  assert.equal(await reload, true); assert.equal(await rejected, false);
});
