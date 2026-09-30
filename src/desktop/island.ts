import { BrowserWindow, dialog, ipcMain, screen, type IpcMainInvokeEvent } from "electron";
import { cpus, freemem, totalmem } from "node:os";
import { open, lstat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromOwnPage } from "./clipboard-paths.js";

interface IslandState { scope: string }
interface IslandOptions { origin: string; call: typeof fetch; protect: (window: BrowserWindow) => void; open: () => void }
const sums = () => cpus().reduce((sum, cpu) => ({ idle: sum.idle + cpu.times.idle,
  total: sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0) }), { idle: 0, total: 0 });

/** Only a tray request creates this optional window; closing destroys its file grants. */
export function desktopIsland(options: IslandOptions): { show: () => void; close: () => void } {
  const island = new DesktopIsland(options);
  return { show: () => island.show(), close: () => island.close() };
}

class DesktopIsland {
  private window: BrowserWindow | null = null;
  private files: string[] = [];
  private droppedScope = "";
  private dropEpoch = 0;
  private previous = sums();
  private readonly channels = ["branch:island-stats", "branch:island-drop", "branch:island-copy", "branch:island-open", "branch:island-clear"];
  constructor(private readonly options: IslandOptions) {
    ipcMain.handle(this.channels[0]!, event => this.stats(event));
    ipcMain.handle(this.channels[1]!, (event, paths: unknown) => this.drop(event, paths));
    ipcMain.handle(this.channels[2]!, event => this.copy(event));
    ipcMain.handle(this.channels[3]!, event => { this.own(event); options.open(); });
    ipcMain.handle(this.channels[4]!, event => { this.own(event); this.clear(); });
  }
  private clear(): void { ++this.dropEpoch; this.files = []; this.droppedScope = ""; }
  private own(event: IpcMainInvokeEvent): BrowserWindow {
    if (!this.window || !fromOwnPage(event, this.window, this.options.origin)
      || new URL(event.senderFrame!.url).pathname !== "/desktop-island") throw new Error("Mini bar access denied");
    return this.window;
  }
  private async state(): Promise<IslandState> {
    const reply = await this.options.call(`${this.options.origin}/api/desktop/island`);
    if (!reply.ok) { this.clear(); throw new Error("Unlock Branch and switch to the owner's profile to use the mini bar."); }
    return reply.json() as Promise<IslandState>;
  }
  private async stats(event: IpcMainInvokeEvent) {
    this.own(event); await this.state(); this.own(event);
    const current = sums(), elapsed = current.total - this.previous.total;
    const cpu = elapsed > 0 ? Math.max(0, Math.min(100, 100 * (1 - (current.idle - this.previous.idle) / elapsed))) : null;
    this.previous = current;
    return { cpu, memoryUsed: totalmem() - freemem(), memoryTotal: totalmem() };
  }
  private async drop(event: IpcMainInvokeEvent, paths: unknown): Promise<void> {
    this.own(event); this.clear(); const epoch = this.dropEpoch;
    if (!Array.isArray(paths) || paths.length > 20 || paths.some(path => typeof path !== "string" || path.length > 4096)) throw new Error("Drop at most 20 local files.");
    const initial = await this.state(); this.own(event);
    if (epoch !== this.dropEpoch) return;
    this.files = paths as string[]; this.droppedScope = initial.scope;
  }
  private async copy(event: IpcMainInvokeEvent) {
    const target = this.own(event), initial = await this.state(); this.own(event);
    if (!this.files.length || initial.scope !== this.droppedScope) throw new Error("Drop the files again before copying.");
    const selected = [...this.files]; this.clear();
    const folder = await dialog.showOpenDialog(target, { title: "Copy dropped files into a folder", properties: ["openDirectory", "createDirectory"] });
    if (folder.canceled || !folder.filePaths[0]) return { copied: 0 };
    let copied = 0;
    for (const source of selected) {
      const before = await this.state(); this.own(event);
      if (before.scope !== initial.scope) throw new Error(`The person using Branch changed. ${copied} files copied before stopping.`);
      const bytes = await droppedBytes(source), fresh = await this.state(); this.own(event);
      if (fresh.scope !== initial.scope) throw new Error(`The person using Branch changed. ${copied} files copied before stopping.`);
      try { await writeFile(join(folder.filePaths[0], basename(source)), bytes, { flag: "wx" }); }
      catch { throw new Error(`${copied} files copied. The next file could not be copied; existing files are never replaced.`); }
      copied++;
    }
    return { copied };
  }
  show(): void {
    if (this.window && !this.window.isDestroyed()) {
      const bounds = this.window.getBounds(), area = screen.getDisplayMatching(bounds).workArea;
      const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
      this.window.setBounds({ width, height, x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
        y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)) });
      this.window.show(); this.window.focus(); return;
    }
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(480, area.width), height = Math.min(680, area.height);
    const shown = new BrowserWindow({ width, height, x: area.x + Math.max(0, area.width - width - 20),
      y: area.y + Math.max(0, Math.min(24, area.height - height)),
      title: "Branch mini bar", alwaysOnTop: true, skipTaskbar: true, autoHideMenuBar: true,
      webPreferences: { preload: fileURLToPath(new URL("./island-preload.cjs", import.meta.url)), nodeIntegration: false,
        contextIsolation: true, sandbox: true, webSecurity: true, partition: `branch-island-${randomUUID()}` } });
    this.window = shown; this.options.protect(shown);
    shown.on("closed", () => { if (this.window === shown) { this.window = null; this.clear(); } });
    void shown.loadURL(`${this.options.origin}/desktop-island`).catch(() => shown.destroy());
  }
  close(): void { this.window?.destroy(); this.window = null; this.clear(); for (const channel of this.channels) ipcMain.removeHandler(channel); }
}

/** A stable regular-file handle bounds bytes and prevents a link swap between checking and reading. */
async function droppedBytes(path: string): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 20 * 1024 * 1024) throw new Error("Drop regular files up to 20 MB, not folders or links.");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = await handle.stat();
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) throw new Error("The dropped file changed. Drop it again.");
    const bytes = Buffer.alloc(after.size + 1), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== after.size) throw new Error("The dropped file changed while copying.");
    return bytes.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
