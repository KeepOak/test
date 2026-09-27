import { clipboard, ipcMain, type BrowserWindow } from "electron";
import { createReadStream } from "node:fs";
import { clipboardPaths, mayReadClipboardFiles, sendablePaths, type PasteGate } from "./clipboard-paths.js";
import { Readable } from "node:stream";
import { basename } from "node:path";

/**
 * attach-anything: files copied in Explorer or Finder, pasted into the message box. A page is never handed the files on
 * the clipboard, so the desktop app reads the list itself and sends each file to the engine the same way the page sends
 * one (POST /api/attachments/upload, streamed). The page asks with no argument at all: it can never name a path for the
 * app to read, so the only files that can be sent are the ones the person copied. Only the main window's own page, on
 * the app's own address, may ask, and only just after the person pasted (`PasteGate`, armed by the main process).
 */

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

export function registerClipboardFilesIpc(window: BrowserWindow, origin: string, key: () => string, gate: Pick<PasteGate, "take">): void {
  ipcMain.handle("branch:clipboard-files", async (event) => {
    if (!mayReadClipboardFiles(event, window, origin, gate)) throw new Error("Clipboard files access denied");
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
