/**
 * attach-followups (desktop, no window opened): Edit › Paste chosen with the mouse on a Mac goes through the same paste
 * check as Cmd+V, and the page is never handed a raw "Error invoking remote method" for a paste the check did not see.
 * Pure halves only (src/desktop/mac-menu.ts, src/desktop/clipboard-paths.ts); the Electron wiring is in main.ts and
 * clipboard-files-ipc.ts.
 * Mutations, each turns a test here red:
 * - src/desktop/mac-menu.ts: put Electron's own { role: "paste" } back in Edit: the app's checked Paste is not in the menu.
 * - src/desktop/clipboard-paths.ts clipboardAsk: answer "read" without the gate: a page reads copied files with no paste.
 * - src/desktop/clipboard-paths.ts clipboardAsk: answer "nothing" to another page: it is not refused.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { macMenuTemplate } from "../dist/desktop/mac-menu.js";
import { clipboardAsk, PasteGate, pasteGateMs } from "../dist/desktop/clipboard-paths.js";

test("the Mac Edit menu's Paste is the app's own checked Paste, with the usual items around it", () => {
  const paste = { label: "Paste", accelerator: "CommandOrControl+V", click: () => undefined };
  const menu = macMenuTemplate(paste);
  assert.deepEqual(menu.map((one) => one.role), ["appMenu", "editMenu", "windowMenu"]);
  const edit = menu.find((one) => one.role === "editMenu").submenu;
  assert.ok(edit.includes(paste), "Edit › Paste is the item that opens the paste check");
  assert.equal(edit.some((one) => one.role === "paste"), false, "and never a paste the check does not see");
  assert.deepEqual(edit.filter((one) => one.role).map((one) => one.role),
    ["undo", "redo", "cut", "copy", "pasteAndMatchStyle", "delete", "selectAll"], "the other Edit items stay as they were");
});

test("an ask for the clipboard's files: read only just after a paste, none otherwise, and refused for another page", () => {
  let now = 1000;
  const gate = new PasteGate(() => now);
  const contents = { mainFrame: { url: "http://127.0.0.1:43210/app/" } };
  const window = { webContents: contents };
  const own = { sender: contents, senderFrame: contents.mainFrame };
  const origin = "http://127.0.0.1:43210";
  assert.equal(clipboardAsk(own, window, origin, gate), "nothing", "a paste the check did not see: no files, and no error");
  gate.arm();
  assert.equal(clipboardAsk({ sender: {}, senderFrame: contents.mainFrame }, window, origin, gate), "refused", "another page is refused");
  assert.equal(clipboardAsk({ sender: contents, senderFrame: { url: "https://example.com/" } }, window, origin, gate), "refused");
  assert.equal(clipboardAsk(own, window, origin, gate), "read", "just after a paste");
  assert.equal(clipboardAsk(own, window, origin, gate), "nothing", "and only once for it");
  gate.arm();
  now += pasteGateMs;
  assert.equal(clipboardAsk(own, window, origin, gate), "nothing", "and not long after it");
});
