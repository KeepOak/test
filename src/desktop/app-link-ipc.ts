import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { fromOwnPage } from "./clipboard-paths.js";
import { appLinkDetails } from "./app-link.js";

/** Native confirmation cannot be answered by the remote app or by the assistant's browser. */
export function registerAppLinkIpc(window: BrowserWindow, origin: string): void {
  let asking = false;
  ipcMain.handle("branch:open-app-link", async (event: IpcMainInvokeEvent, input: unknown) => {
    if (!fromOwnPage(event, window, origin)) throw new Error("App link access denied");
    const link = appLinkDetails(input);
    if (!link) throw new Error("Only a supported HTTPS app link can open here");
    const { url, name, kind, appUrl } = link;
    if (asking) throw new Error("Answer the open-listing question first");
    asking = true;
    try {
      const choice = await dialog.showMessageBox(window, { type: "question", title: `Open ${name} ${kind}?`,
        message: `Open this ${kind} in ${name} or your browser?`, detail: `${url}${appUrl ? `\nApp link: ${appUrl}` : ""}\nThe app keeps its own sign-in. Branch does not read it.`,
        buttons: ["Cancel", `Open ${kind}`], defaultId: 0, cancelId: 0, noLink: true });
      if (choice.response !== 1 || window.isDestroyed() || !fromOwnPage(event, window, origin)) return { opened: false };
      // The only native scheme is generated from a validated Spotify track ID; callers cannot supply a command URI.
      if (appUrl) {
        try { await shell.openExternal(appUrl); return { opened: true, destination: "app", url }; }
        catch { /* no registered app: the same public track opens on the web */ }
      }
      await shell.openExternal(url);
      return { opened: true, destination: "system", url };
    } finally { asking = false; }
  });
  window.on("closed", () => ipcMain.removeHandler("branch:open-app-link"));
}
