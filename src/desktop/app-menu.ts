import type { MenuItemConstructorOptions } from "electron";

/**
 * The app's menu bar (src/desktop/main.ts setAppMenu), on every system. Its Edit › Paste is the app's own (`paste`): it
 * tells the paste check a person pasted before it pastes, so Paste chosen with the mouse from the menu reads copied
 * files exactly as the keys do (src/desktop/clipboard-paths.ts PasteGate), never a paste the check did not see.
 * - macOS: the menu bar every Mac app has: the app menu (Cmd+Q), Edit with its usual items and keys, and Window.
 * - Windows and Linux: what Electron gives them by itself, hidden until Alt (`autoHideMenuBar`): File, Edit, View and
 *   Window. Electron's Help menu, which only links to Electron's own website, is left out.
 */
export function appMenuTemplate(platform: NodeJS.Platform, paste: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  if (platform === "darwin") return [
    { role: "appMenu" },
    { role: "editMenu", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, paste, { role: "pasteAndMatchStyle" }, { role: "delete" }, { role: "selectAll" },
    ] },
    { role: "windowMenu" },
  ];
  return [
    { role: "fileMenu" },
    { role: "editMenu", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, paste, { role: "delete" }, { type: "separator" }, { role: "selectAll" },
    ] },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
}
