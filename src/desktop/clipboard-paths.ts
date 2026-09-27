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

