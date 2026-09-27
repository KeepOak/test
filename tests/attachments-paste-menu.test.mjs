/**
 * attach-followups, attach-3 (desktop, no window opened): Paste chosen with the mouse from the menu bar, on a Mac and on
 * Windows and Linux (Electron's menu, shown with Alt), goes through the same paste check as the keys, and the page is
 * never handed a raw "Error invoking remote method" for a paste the check did not see. The right-click menu's Paste
 * already does (src/desktop/context-menu.ts). Pure halves only (src/desktop/app-menu.ts, src/desktop/clipboard-paths.ts);
 * the Electron wiring is in main.ts and clipboard-files-ipc.ts.
 * Mutations, each turns a test here red:
 * - src/desktop/app-menu.ts: put Electron's own { role: "paste" } back in Edit (either system): the app's checked Paste
 *   is not in the menu.
 * - src/desktop/clipboard-paths.ts clipboardAsk: answer "read" without the gate: a page reads copied files with no paste.
 * - src/desktop/clipboard-paths.ts clipboardAsk: answer "nothing" to another page: it is not refused.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { appMenuTemplate } from "../dist/desktop/app-menu.js";
import { editMenuFor, registerEditMenu } from "../dist/desktop/context-menu.js";
import { clipboardAsk, PasteGate, pasteGateMs } from "../dist/desktop/clipboard-paths.js";

const paste = { label: "Paste", accelerator: "CommandOrControl+V", click: () => undefined };
const editOf = (menu) => menu.find((one) => one.role === "editMenu").submenu;

test("the Mac menu bar's Edit › Paste is the app's own checked Paste, with the usual items around it", () => {
  const menu = appMenuTemplate("darwin", paste);
  assert.deepEqual(menu.map((one) => one.role), ["appMenu", "editMenu", "windowMenu"]);
  const edit = editOf(menu);
  assert.ok(edit.includes(paste), "Edit › Paste is the item that opens the paste check");
  assert.equal(edit.some((one) => one.role === "paste"), false, "and never a paste the check does not see");
  assert.deepEqual(edit.filter((one) => one.role).map((one) => one.role),
    ["undo", "redo", "cut", "copy", "pasteAndMatchStyle", "delete", "selectAll"], "the other Edit items stay as they were");
});

test("on Windows and Linux the menu bar Electron gives keeps its menus, and its Edit › Paste is the app's checked Paste", () => {
  for (const platform of ["win32", "linux"]) {
    const menu = appMenuTemplate(platform, paste);
    assert.deepEqual(menu.map((one) => one.role), ["fileMenu", "editMenu", "viewMenu", "windowMenu"], platform);
    const edit = editOf(menu);
    assert.ok(edit.includes(paste), `${platform}: Edit › Paste is the item that opens the paste check`);
    assert.equal(edit.some((one) => one.role === "paste"), false, `${platform}: never a paste the check does not see`);
    assert.deepEqual(edit.filter((one) => one.role).map((one) => one.role), ["undo", "redo", "cut", "copy", "delete", "selectAll"], platform);
  }
});

test("the right-click menu's Paste in a field is the app's checked Paste too", () => {
  let handler, shown;
  const window = { webContents: { on: (name, fn) => { if (name === "context-menu") handler = fn; } } };
  registerEditMenu(window, (template) => ({ popup: () => { shown = template; } }), (enabled) => ({ ...paste, enabled }));
  handler({}, { isEditable: true, selectionText: "", editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } });
  assert.ok(shown.some((one) => one.label === "Paste" && one.click === paste.click), "the app's Paste stands in");
  assert.equal(shown.some((one) => one.role === "paste"), false);
  assert.ok(editMenuFor({ isEditable: true, selectionText: "", editFlags: {} }).some((one) => one.role === "paste"), "control: the plain menu has Electron's");
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
