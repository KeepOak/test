import type { MenuItemConstructorOptions } from "electron";

/**
 * macOS only: the menu bar every Mac app has (src/desktop/main.ts setMacMenu). Edit keeps its usual items and keys, but
 * its Paste is the app's own (`paste`): it tells the paste check a person pasted before it pastes, so Edit › Paste chosen
 * with the mouse reads copied files exactly as Cmd+V does (src/desktop/clipboard-paths.ts PasteGate), instead of a
 * paste the check never saw. The app menu gives Cmd+Q; the window menu, the usual window items.
 */
export function macMenuTemplate(paste: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return [
    { role: "appMenu" },
    { role: "editMenu", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, paste, { role: "pasteAndMatchStyle" }, { role: "delete" }, { role: "selectAll" },
    ] },
    { role: "windowMenu" },
  ];
}
