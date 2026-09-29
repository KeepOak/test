import { ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { fromOwnPage } from "./clipboard-paths.js";
import { keptPath, type KeptFile, type KeptFiles } from "./show-in-folder.js";

/**
 * dogfood-ux-3: Library › Made for you › Show in folder. Reveals one file a task kept in Explorer or Finder, selected
 * in its folder. Nothing is opened or run: `shell.showItemInFolder` only shows where the file is.
 *
 * The page names the file, but never the place it reveals: the app asks the engine for the files the assistant kept
 * (GET /api/artifacts, with the app's own key) and reveals only a path the engine lists, exactly as listed. So a page
 * can reveal nothing but a file Branch itself kept, and only the main window's own page on the app's own address asks.
 */

export function registerShowInFolderIpc(window: BrowserWindow, origin: string, key: () => string,
  reveal: (path: string) => void = (path) => shell.showItemInFolder(path), call: typeof fetch = fetch): void {
  const kept: KeptFiles = async () => {
    const answer = await call(`${origin}/api/artifacts`, { headers: { authorization: `Bearer ${key()}`, "x-branch-origin": "window" } });
    if (!answer.ok) throw new Error(`The files Branch kept could not be read (${answer.status})`);
    return ((await answer.json()) as { artifacts?: KeptFile[] }).artifacts ?? [];
  };
  ipcMain.handle("branch:show-in-folder", async (event: IpcMainInvokeEvent, asked: unknown) => {
    if (!fromOwnPage(event, window, origin)) throw new Error("Show in folder access denied");
    const path = await keptPath(asked, kept);
    if (!path) throw new Error("That file was not made by the assistant");
    reveal(path);
    return { shown: true };
  });
  window.on("closed", () => ipcMain.removeHandler("branch:show-in-folder"));
}
