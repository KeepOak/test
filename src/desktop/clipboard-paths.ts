import type { BrowserWindow, Input, IpcMainInvokeEvent } from "electron";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/* attach-anything: the pure half of reading files copied in Explorer or Finder (src/desktop/clipboard-files-ipc.ts). */

/** Paths in the clipboard's own file list: Windows' FileNameW (UTF-16, NUL-separated), a macOS file URL, or a Linux URI list. */
export async function clipboardPaths(platform: NodeJS.Platform, raw: (format: string) => Promise<Buffer>): Promise<string[]> {
  if (platform === "win32") {
    const list = await raw("FileNameW");
    return list.length ? list.toString("utf16le").split("\u0000").map((one) => one.trim()).filter(Boolean) : [];
  }
  const urls = (await raw(platform === "darwin" ? "public.file-url" : "text/uri-list")).toString("utf8").split("\u0000").join("");
  return urls.split(/\r?\n/).map((one) => one.trim()).filter((one) => one.startsWith("file://"))
    .map((one) => { try { return fileURLToPath(one, { windows: false }); } catch { return ""; } }).filter(Boolean);
}

/** The ordinary files among them (a folder or a device is left out), at most `limit`. */
export function sendablePaths(paths: readonly string[], limit: number, stat: (path: string) => { isFile(): boolean } = statSync): string[] {
  return paths.filter((path) => { try { return stat(path).isFile(); } catch { return false; } }).slice(0, limit);
}


/** How long after a real paste (the keys, or a menu's Paste) the page may ask for the files on the clipboard. */
export const pasteGateMs = 2000;

/**
 * The clipboard's files are read only for a paste the person really made: the main process sees the keys (or the
 * menu's Paste) itself, before the page does, and opens this for one ask, briefly. A page asking at any other time,
 * or asking twice for one paste, is refused, so no script in the page can read what was copied on its own.
 */
export class PasteGate {
  private until = 0;
  constructor(private readonly now: () => number = Date.now) {}
  arm(): void { this.until = this.now() + pasteGateMs; }
  /** Whether a paste was just made; a yes is used up by the ask it answers. */
  take(): boolean {
    const open = this.now() < this.until;
    this.until = 0;
    return open;
  }
}

/** Whether a key press is Paste: Ctrl+V (Cmd+V on a Mac) on any keyboard layout, or Shift+Insert off the Mac. */
export function isPasteKeys(input: Pick<Input, "type" | "key" | "code" | "control" | "meta" | "shift" | "alt">, platform: NodeJS.Platform): boolean {
  if (input.type !== "keyDown" || input.alt) return false;
  const v = input.code === "KeyV" || input.key.toLowerCase() === "v";
  if (platform === "darwin") return input.meta && !input.control && v;
  if (input.meta) return false;
  return (input.control && v) || (input.shift && !input.control && (input.code === "Insert" || input.key === "Insert"));
}

/** Whether a request came from the main window's own page on the app's own address. */
export function fromOwnPage(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">, window: Pick<BrowserWindow, "webContents">, origin: string): boolean {
  const frame = event.senderFrame;
  return event.sender === window.webContents && frame === window.webContents.mainFrame && !!frame && new URL(frame.url).origin === origin;
}

/**
 * What an ask for the clipboard's files gets: "read" for the main window's own page just after a real paste; "nothing"
 * for that page at any other time (a paste the check did not see, or a second ask for one paste: no file is read, and
 * the page is told there are none rather than handed an error); "refused" for anything else asking.
 */
export type ClipboardAsk = "read" | "nothing" | "refused";
export function clipboardAsk(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">, window: Pick<BrowserWindow, "webContents">,
  origin: string, gate: Pick<PasteGate, "take">): ClipboardAsk {
  if (!fromOwnPage(event, window, origin)) return "refused";
  return gate.take() ? "read" : "nothing";
}
/** The whole check before the clipboard's files are read: the main window's own page, just after a real paste. */
export function mayReadClipboardFiles(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">, window: Pick<BrowserWindow, "webContents">,
  origin: string, gate: Pick<PasteGate, "take">): boolean {
  return clipboardAsk(event, window, origin, gate) === "read";
}
