import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, NativeImage, Rectangle } from "electron";
import { randomUUID } from "node:crypto";

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
  /** How long to wait for a real painted acknowledgment; a timeout keeps the picture in place. */
  restoreMs?: number;
  applyMs?: number;
  retryMs?: number;
}

export const windowResultChannel = "branch:window-update-result";
export class WindowUpdateDeferred extends Error { override name = "WindowUpdateDeferred"; }
type PageUpdate = Exclude<WindowUpdate, { engine: true }>;
type Pending = { update: PageUpdate; resolve: () => void; reject: (error: Error) => void;
  timer: NodeJS.Timeout; retry?: NodeJS.Timeout; message: string };
type Paint = { commit: string | null; resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

class LiveWindow {
  private pending: Pending | null = null;
  private paint: Paint | null = null;
  private cover: Cover | null = null;
  private reloading = false;
  private hasReloaded = false;
  constructor(private readonly options: LiveWindowOptions) {
    const { ipc, window } = options;
    ipc.handle(reloadLiveChannel, (event, commit: unknown) => { this.authorized(event); return this.reload(commit); });
    ipc.handle(windowRestoredChannel, (event, commit: unknown) => { this.authorized(event); return this.restored(commit); });
    ipc.handle(windowResultChannel, (event, result: unknown) => { this.authorized(event); return this.result(result); });
    window.on("closed", () => this.close());
  }
  private authorized(event: IpcMainInvokeEvent): void {
    const { window, origin } = this.options;
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame?.url ?? "about:blank").origin !== origin) throw new Error("Live update access denied");
  }
  private send(update: WindowUpdate): void {
    const { window, origin } = this.options;
    let at: string | null = null;
    try { at = new URL(window.webContents.getURL()).origin; } catch { /* no page */ }
    if (window.isDestroyed() || at !== origin) throw new WindowUpdateDeferred("The window is not ready for this update yet.");
    window.webContents.send(windowUpdatedChannel, update);
  }
  tell(update: WindowUpdate): Promise<void> {
    if ("engine" in update) { this.send(update); return Promise.resolve(); }
    if (this.pending || this.cover) return Promise.reject(new WindowUpdateDeferred("The previous window update is still being restored."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.finish(new WindowUpdateDeferred(this.pending?.message ?? "The window did not confirm this update.")), this.options.applyMs ?? 120_000);
      this.pending = { update, resolve, reject, timer, message: "The window did not confirm this update." };
      try { this.send(update); } catch (error) { this.finish(error as Error); }
    });
  }
  private finish(error?: Error): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    clearTimeout(pending.retry);
    if (error) pending.reject(error); else pending.resolve();
  }
  private result(raw: unknown): boolean {
    if (!raw || typeof raw !== "object") return false;
    const result = raw as { commit?: unknown; ok?: unknown; deferred?: unknown; message?: unknown };
    const pending = this.pending;
    if (!pending || result.commit !== pending.update.commit) return false;
    if (result.ok === true) {
      if (pending.update.reload) return false; // A reload is confirmed only after its new page has painted.
      this.finish(); return true;
    }
    if (result.ok !== false) return false;
    pending.message = typeof result.message === "string" ? result.message.slice(0, 500) : "The window could not keep this update yet.";
    if (result.deferred !== true) { this.finish(new WindowUpdateDeferred(pending.message)); return true; }
    if (!pending.retry) pending.retry = setTimeout(() => {
      delete pending.retry;
      try { this.send(pending.update); } catch (error) { this.finish(error as Error); }
    }, this.options.retryMs ?? 1000);
    return true;
  }
  private waitPaint(commit: string | null, ms = this.options.restoreMs ?? 15_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.paint = null;
        reject(new WindowUpdateDeferred("The updated page did not restore and draw in time."));
      }, ms);
      this.paint = { commit, resolve, reject, timer };
    });
  }
  private restored(commit: unknown): boolean {
    const paint = this.paint;
    if (!paint || (paint.commit !== null && commit !== paint.commit)) return false;
    clearTimeout(paint.timer);
    this.paint = null;
    paint.resolve();
    return true;
  }
  private async reload(commit: unknown): Promise<boolean> {
    if (this.reloading || commit !== this.pending?.update.commit || !this.pending?.update.reload) return false;
    this.reloading = true;
    try {
      const { window } = this.options;
      if (window.isVisible() && !window.isMinimized()) {
        const image = await window.webContents.capturePage();
        this.cover = this.options.cover();
        await this.cover.show(image, window.getContentBounds());
      }
      clearTimeout(this.pending.timer); // The reload now owns its bounded paint wait, not the earlier snapshot deadline.
      const painted = this.waitPaint(this.pending.update.commit);
      this.hasReloaded = true;
      window.webContents.reloadIgnoringCache();
      await painted;
      this.closeCover();
      this.finish();
      return true;
    } catch (error) { if (!this.hasReloaded) this.closeCover(); this.finish(error as Error); throw error; }
    finally { this.reloading = false; }
  }
  /**
   * A shell update (shell-switch.ts): the new version's first page restores what the old one kept, and says so with
   * `token` as a live reload's page does. Armed before the page loads; answers whether it did within the wait.
   */
  expectRestore(token: string): Promise<boolean> {
    // The whole first load is in this wait (the engine joined, the page fetched), not only a reload's redraw.
    return this.waitPaint(token, Math.max(60_000, this.options.restoreMs ?? 0)).then(() => true, () => false);
  }
  /** Called only after the previous checked files have been restored by main. */
  async recover(): Promise<void> {
    if (!this.hasReloaded) return;
    this.reloading = true;
    try {
      const url = new URL(this.options.window.webContents.getURL());
      const recovery = randomUUID();
      url.searchParams.set("_branch_live_restore", recovery);
      const painted = this.waitPaint(recovery);
      void this.options.window.webContents.loadURL(url.href).catch((error: Error) => {
        if (this.paint) { clearTimeout(this.paint.timer); this.paint.reject(error); this.paint = null; }
      });
      await painted;
      this.closeCover();
    } finally { this.reloading = false; }
  }
  private closeCover(): void { this.cover?.close(); this.cover = null; this.hasReloaded = false; }
  private close(): void {
    this.finish(new WindowUpdateDeferred("The window closed before it confirmed the update."));
    if (this.paint) { clearTimeout(this.paint.timer); this.paint.reject(new WindowUpdateDeferred("The window closed.")); this.paint = null; }
    this.closeCover();
    for (const channel of [reloadLiveChannel, windowRestoredChannel, windowResultChannel]) this.options.ipc.removeHandler(channel);
  }
}

export function registerLiveWindowIpc(options: LiveWindowOptions): { tell: (update: WindowUpdate) => Promise<void>; recover: () => Promise<void>; expectRestore: (token: string) => Promise<boolean> } {
  const live = new LiveWindow(options);
  return { tell: (update) => live.tell(update), recover: () => live.recover(), expectRestore: (token) => live.expectRestore(token) };
}
