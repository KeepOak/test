import { clipboard, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { createReadStream, statSync } from "node:fs";
import { Readable } from "node:stream";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * attach-anything: files copied in Explorer or Finder, pasted into the message box. A page is never handed the files on
 * the clipboard, so the desktop app reads the list itself and sends each file to the engine the same way the page sends
 * one (POST /api/attachments/upload, streamed). The page asks with no argument at all: it can never name a path for the
 * app to read, so the only files that can be sent are the ones the person copied. Only the main window's own page, on
 * the app's own address, may ask.
 */

/** Paths in the clipboard's own file list: Windows' FileNameW (UTF-16, NUL-separated), a macOS file URL, or a Linux URI list. */
export async function clipboardPaths(platform: NodeJS.Platform, raw: (format: string) => Promise<Buffer>): Promise<string[]> {
  if (platform === "win32") {
    const list = await raw("FileNameW");
    return list.length ? list.toString("utf16le").split("\u0000").map((one) => one.trim()).filter(Boolean) : [];
  }
  const urls = (await raw(platform === "darwin" ? "public.file-url" : "text/uri-list")).toString("utf8").split("\u0000").join("");
  return urls.split(/\r?\n/).map((one) => one.trim()).filter((one) => one.startsWith("file://"))
    .map((one) => { try { return fileURLToPath(one); } catch { return ""; } }).filter(Boolean);
}

/** The ordinary files among them (a folder or a device is left out), at most `limit`. */
export function sendablePaths(paths: readonly string[], limit: number, stat: (path: string) => { isFile(): boolean } = statSync): string[] {
  return paths.filter((path) => { try { return stat(path).isFile(); } catch { return false; } }).slice(0, limit);
}

/** One of the system clipboard's own formats, raw, through Electron's "osclipboard" type; nothing when it is not there. */
async function osClipboard(format: string): Promise<Buffer> {
  const type = `electron application/osclipboard;format="${format}"`;
  if (!(await clipboard.has(type))) return Buffer.alloc(0);
  for (const item of await clipboard.read()) {
    if (!item.types.includes(type)) continue;
    const blob = await item.getType(type) as Blob;
    return Buffer.from(await blob.arrayBuffer());
  }
  return Buffer.alloc(0);
}

/** Whether a request came from the main window's own page on the app's own address. */
export function fromOwnPage(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">, window: Pick<BrowserWindow, "webContents">, origin: string): boolean {
  const frame = event.senderFrame;
  return event.sender === window.webContents && frame === window.webContents.mainFrame && !!frame && new URL(frame.url).origin === origin;
}

export function registerClipboardFilesIpc(window: BrowserWindow, origin: string, key: () => string): void {
  ipcMain.handle("branch:clipboard-files", async (event) => {
    if (!fromOwnPage(event, window, origin)) throw new Error("Clipboard files access denied");
    const paths = sendablePaths(await clipboardPaths(process.platform, osClipboard), 20);
    const sent: unknown[] = [];
    for (const path of paths) {
      const answer = await fetch(`${origin}/api/attachments/upload?name=${encodeURIComponent(basename(path))}&type=application%2Foctet-stream`, {
        method: "POST",
        headers: { authorization: `Bearer ${key()}`, "content-type": "application/octet-stream", "x-branch-origin": "window" },
        body: Readable.toWeb(createReadStream(path)) as ReadableStream, duplex: "half",
      } as RequestInit);
      const data = await answer.json().catch(() => ({})) as { error?: string };
      if (!answer.ok) throw new Error(data.error ?? String(answer.status));
      sent.push(data);
    }
    return sent;
  });
  window.on("closed", () => ipcMain.removeHandler("branch:clipboard-files"));
}
