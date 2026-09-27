import type { MenuItemConstructorOptions } from "electron";

/** attach-4: what the menu bar's Help opens in the window (public/app/shell/shell.js, through preload.cts onHelp). */
export type HelpItem = "whatcan" | "about";
export const helpItems: readonly (readonly [HelpItem, string])[] = [["whatcan", "What can Branch do"], ["about", "About Branch"]];
export const helpChannel = "branch:help";

/**
 * The app's menu bar (src/desktop/main.ts setAppMenu), on every system. Its Edit › Paste is the app's own (`paste`): it
 * tells the paste check a person pasted before it pastes, so Paste chosen with the mouse from the menu reads copied
 * files exactly as the keys do (src/desktop/clipboard-paths.ts PasteGate), never a paste the check did not see.
 * - macOS: the menu bar every Mac app has: the app menu (Cmd+Q), Edit with its usual items and keys, and Window.
 * - Windows and Linux: what Electron gives them by itself, hidden until Alt (`autoHideMenuBar`): File, Edit, View and
 *   Window. Electron's Help menu, which only links to Electron's own website, is left out.
 * - Once a window is open (`help`), Help on every system: "What can Branch do" and "About Branch", opened in the window.
 */
export function appMenuTemplate(platform: NodeJS.Platform, paste: MenuItemConstructorOptions, help?: (item: HelpItem) => void):
  MenuItemConstructorOptions[] {
  const helpMenu: MenuItemConstructorOptions[] = help
    ? [{ role: "help", submenu: helpItems.map(([item, label]) => ({ label, click: () => help(item) })) }]
    : [];
  if (platform === "darwin") return [
    { role: "appMenu" },
    { role: "editMenu", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, paste, { role: "pasteAndMatchStyle" }, { role: "delete" }, { role: "selectAll" },
    ] },
    { role: "windowMenu" },
    ...helpMenu,
  ];
  return [
    { role: "fileMenu" },
    { role: "editMenu", submenu: [
      { role: "undo" }, { role: "redo" }, { type: "separator" },
      { role: "cut" }, { role: "copy" }, paste, { role: "delete" }, { type: "separator" }, { role: "selectAll" },
    ] },
    { role: "viewMenu" },
    { role: "windowMenu" },
    ...helpMenu,
  ];
}
