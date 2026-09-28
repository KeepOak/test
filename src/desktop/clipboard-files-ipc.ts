import { clipboard, ipcMain, type BrowserWindow } from "electron";
import { createReadStream } from "node:fs";
import { clipboardAsk, clipboardPaths, sendablePaths, type PasteGate } from "./clipboard-paths.js";
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

/**
 * The page's own answer: the files sent ahead, and the engine's words when one was refused (a file too big, a full disk).
 * Never a thrown error to the page, which would reach it wrapped as "Error invoking remote method".
 */
export interface ClipboardFilesAnswer { sent: unknown[]; error: string | null }
export function registerClipboardFilesIpc(window: BrowserWindow, origin: string, key: () => string, gate: Pick<PasteGate, "take">, call: typeof fetch = fetch): void {
  ipcMain.handle("branch:clipboard-files", async (event): Promise<ClipboardFilesAnswer> => {
    const ask = clipboardAsk(event, window, origin, gate);
    if (ask === "refused") throw new Error("Clipboard files access denied");
    if (ask === "nothing") return { sent: [], error: null };
    const paths = sendablePaths(await clipboardPaths(process.platform, osClipboard), 20);
    const sent: unknown[] = [];
    for (const path of paths) {
      const answer = await call(`${origin}/api/attachments/upload?name=${encodeURIComponent(basename(path))}&type=application%2Foctet-stream`, {
        method: "POST",
        headers: { authorization: `Bearer ${key()}`, "content-type": "application/octet-stream", "x-branch-origin": "window" },
        body: Readable.toWeb(createReadStream(path)) as ReadableStream, duplex: "half",
      } as RequestInit).catch(() => null);
      const data = await answer?.json().catch(() => ({})) as { error?: string } | undefined;
      if (!answer?.ok) return { sent, error: data?.error ?? (answer ? String(answer.status) : null) };
      sent.push(data);
    }
    return { sent, error: null };
  });
  window.on("closed", () => ipcMain.removeHandler("branch:clipboard-files"));
}
