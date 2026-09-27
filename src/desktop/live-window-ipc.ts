import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, NativeImage, Rectangle } from "electron";

/**
 * Live updates (hot-update), the window's side in main.
 *
 * Main tells the open page what a live update changed (`branch:window-updated`): only stylesheets, which the page swaps in
 * place with nothing reloaded, or modules, which it cannot swap, so it saves what the owner has open (the conversation,
 * the typed words, where it was scrolled, the open panels) and asks main to reload it (`branch:reload-live`).
 *
 * The owner is photosensitive, so the reload must never show a blank, white or half-drawn frame. Main first takes a
 * picture of the window as it is and lays it exactly over the window, drawn before it is shown; only then is the page
 * reloaded underneath. The picture comes away only once the reloaded page says it has put everything back and drawn it
 * (`branch:window-restored`), so the one change the owner can see is whatever the update itself changed. A window
 * nobody can see (minimised, in the tray, a hidden test window) is reloaded without the picture. It also tells the page
 * when its engine is being handed over (`engine: true`), so the page stays quiet while it reconnects.
 */
export const windowUpdatedChannel = "branch:window-updated";
export const reloadLiveChannel = "branch:reload-live";
export const windowRestoredChannel = "branch:window-restored";

/** What main tells the page. */
export type WindowUpdate = { engine: true } | { commit: string; styles: string[]; reload: boolean };

/** The page's own files a live build changed: stylesheets alone are swapped in place; anything else needs the reload. */
export function windowPlan(commit: string, changed: string[]): WindowUpdate | null {
  const shown = changed.filter((name) => name === "index.html" || name === "app.css" || /^(app|art|locales|fonts)\//.test(name) || /\.(css|js)$/.test(name));
  if (!shown.length) return null;
  const styles = shown.filter((name) => name.endsWith(".css"));
  return { commit, styles, reload: styles.length !== shown.length };
}

export interface Cover { show(image: NativeImage, bounds: Rectangle): Promise<void>; close(): void }

export interface LiveWindowOptions {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  window: Pick<BrowserWindow, "webContents" | "on" | "isVisible" | "isMinimized" | "getContentBounds" | "isDestroyed">;
  origin: string;
  /** Lays the picture over the window, shown only once drawn (a child window of the app's own); tests hand in their own. */
  cover: () => Cover;
  /** How long the picture may stay if the page never says it is back (it then comes away; the page is drawn by then). */
  restoreMs?: number;
}

export function registerLiveWindowIpc(options: LiveWindowOptions): { tell: (update: WindowUpdate) => void } {
  const { ipc, window, origin } = options;
  const authorized = (event: IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame?.url ?? "about:blank").origin !== origin)
      throw new Error("Live update access denied");
  };
  let restored: (() => void) | null = null;
  let reloading = false;
  ipc.handle(reloadLiveChannel, async (event) => {
    authorized(event);
    if (reloading) return false;
    reloading = true;
    let cover: Cover | null = null;
    try {
      // Nobody sees a hidden or minimised window: it is simply reloaded.
      if (window.isVisible() && !window.isMinimized()) {
        const image = await window.webContents.capturePage();
        cover = options.cover();
        await cover.show(image, window.getContentBounds());
      }
      const back = new Promise<void>((resolve) => {
        restored = resolve;
        setTimeout(resolve, options.restoreMs ?? 15_000).unref?.();
      });
      window.webContents.reloadIgnoringCache();
      await back;
      return true;
    } finally {
      restored = null;
      cover?.close();
      reloading = false;
    }
  });
  ipc.handle(windowRestoredChannel, (event) => {
    authorized(event);
    restored?.();
    return true;
  });
  window.on("closed", () => { ipc.removeHandler(reloadLiveChannel); ipc.removeHandler(windowRestoredChannel); });
  return {
    tell: (update) => {
      if (window.isDestroyed()) return;
      const at = (() => { try { return new URL(window.webContents.getURL()).origin; } catch { return null; } })();
      if (at === origin) window.webContents.send(windowUpdatedChannel, update);
    },
  };
}
