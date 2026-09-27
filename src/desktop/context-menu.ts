import type { BrowserWindow, ContextMenuParams, MenuItemConstructorOptions } from "electron";

/**
 * Owner-reported 2026-09-23: "no copy and paste". A desktop app built on Electron has no right-click menu of its
 * own, so right-clicking text or the message box did nothing. This gives what every desktop app gives, where it
 * applies: Cut, Copy, Paste and Select all in a field; Copy on selected text. A right-click the page handles
 * itself (the strip, hiding a part of the window) never reaches here.
 */
export function editMenuFor(params: Pick<ContextMenuParams, "isEditable" | "selectionText" | "editFlags">): MenuItemConstructorOptions[] {
  const { isEditable, selectionText, editFlags } = params;
  if (isEditable) return [
    { role: "cut", enabled: editFlags.canCut },
    { role: "copy", enabled: editFlags.canCopy },
    { role: "paste", enabled: editFlags.canPaste },
    { type: "separator" },
    { role: "selectAll", enabled: editFlags.canSelectAll },
  ];
  if (selectionText.trim()) return [{ role: "copy" }];
  return [];
}

/**
 * `paste`, when given, stands in for the Paste item: attach-anything's clipboard files are read only for a paste the
 * main process saw the person make (src/desktop/clipboard-paths.ts `PasteGate`), and a menu's Paste is one.
 */
export function registerEditMenu(window: BrowserWindow, build: (template: MenuItemConstructorOptions[]) => { popup(options: { window: BrowserWindow }): void },
  paste?: (enabled: boolean) => MenuItemConstructorOptions): void {
  window.webContents.on("context-menu", (_event, params) => {
    const template = editMenuFor(params).map((item) => paste && item.role === "paste" ? paste(item.enabled ?? true) : item);
    if (template.length) build(template).popup({ window });
  });
}
