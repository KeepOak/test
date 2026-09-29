// Does an update's status redraw the open conversation? The owner saw the thread go blank during a background Beta
// build. This opens a long conversation in a hidden, offscreen window, sends the window the statuses a background
// build sends (every step, a pause for typing and one for a task), and counts what changed in the conversation.
// Run it with Electron: node_modules/electron/dist/electron.exe <this file>, with PORT, TOKEN and SESSION naming an
// engine of your own and a conversation with many messages in it. Nothing shows on the screen.
const { app, BrowserWindow } = require("electron");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const { PORT, TOKEN, SESSION } = process.env;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stageIds = ["fetching", "installing", "building", "checking", "copying", "swapping", "restarting"];
function status(stageId, paused) {
  const start = new Date(Date.now() - 60_000).toISOString(), k = stageIds.indexOf(stageId);
  return { phase: "downloading", message: "Building Branch on this computer…", installed: { version: "0.19.4", commit: null }, outcome: null,
    progress: null, release: null, bytes: null, updatedAt: new Date().toISOString(),
    stages: stageIds.map((id, j) => ({ id, state: j < k ? "done" : j === k ? "running" : "waiting", startedAt: j <= k ? start : null, endedAt: j < k ? start : null })),
    target: { version: null, commit: "e".repeat(40) }, failure: null, automatic: true, paused };
}

// The app's own bridge, as far as the update screen uses it: the window hears each status the updater sends.
const dir = mkdtempSync(join(tmpdir(), "quiet-dom-")), preload = join(dir, "preload.cjs");
writeFileSync(preload, `const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("branchDesktop", Object.freeze({
  updateStatus: () => Promise.resolve(null),
  onUpdateStatus: (callback) => { ipcRenderer.on("branch:update-changed", (_event, value) => callback(value)); },
}));`);

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1600, height: 1000, webPreferences: { offscreen: true, backgroundThrottling: false, preload } });
  const js = (code) => win.webContents.executeJavaScriptInIsolatedWorld(999, [{ code }]);
  await win.loadURL(`http://127.0.0.1:${PORT}/`);
  await wait(1500);
  await js(`(() => { const f = document.getElementById('token'); f.value = ${JSON.stringify(TOKEN)}; f.dispatchEvent(new Event('input', { bubbles: true }));
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Connect').click(); })()`);
  await wait(3000);
  await js(`document.querySelector('[data-id="${SESSION}"]')?.click()`);
  await wait(2500);
  const rows = await js(`document.getElementById('conversation')?.children.length ?? 0`);
  await js(`(() => { window.__conv = document.getElementById('conversation'); window.__changes = 0;
    new MutationObserver((list) => { for (const m of list) window.__changes += m.addedNodes.length + m.removedNodes.length; }).observe(window.__conv, { childList: true, subtree: true, characterData: true }); })()`);
  let events = 0, replaced = 0;
  const plan = [["fetching", null, 6], ["building", null, 6], ["building", "typing", 3], ["building", "task", 3], ["building", null, 3], ["checking", null, 3], ["copying", null, 3]];
  for (const [stage, paused, times] of plan) {
    for (let i = 0; i < times; i++) {
      win.webContents.send("branch:update-changed", status(stage, paused));
      events++;
      await wait(260);
      if (await js(`document.getElementById('conversation') !== window.__conv`)) { replaced++; await js(`window.__conv = document.getElementById('conversation')`); }
    }
  }
  const end = await js(`({ changes: window.__changes, bar: document.querySelector('.upd18-sb')?.textContent ?? null })`);
  const result = { rows, events, conversationReplaced: replaced, changesInConversation: end.changes, statusBar: end.bar };
  console.log(JSON.stringify(result));
  rmSync(dir, { recursive: true, force: true });
  app.exit(rows > 0 && replaced === 0 && end.changes === 0 ? 0 : 1);
});
