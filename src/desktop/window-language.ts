import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";

/**
 * PLAT-192: the language the owner chose in the window (kept by the page), told to main so the tray's notifications
 * speak it before the window has been opened. Only a language the window ships is kept.
 */
export const windowLanguages = ["en", "fr", "es", "de"] as const;
const file = (dir: string) => join(dir, "window-language.json");

export function readWindowLanguage(dir: string): string {
  try {
    const saved = (JSON.parse(readFileSync(file(dir), "utf8")) as { language?: unknown }).language;
    return typeof saved === "string" && (windowLanguages as readonly string[]).includes(saved) ? saved : "en";
  } catch { return "en"; }
}

export function saveWindowLanguage(dir: string, language: unknown): boolean {
  if (typeof language !== "string" || !(windowLanguages as readonly string[]).includes(language)) return false;
  writeFileSync(file(dir), JSON.stringify({ language }));
  return true;
}

/** Only the window's own page, at the app's own address, may say which language it speaks. */
export function registerWindowLanguageIpc(ipcMain: Pick<IpcMain, "handle" | "removeHandler">, window: BrowserWindow, origin: string, dir: string): void {
  const authorized = (event: IpcMainInvokeEvent) => {
    if (window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || new URL(event.senderFrame?.url ?? "about:blank").origin !== origin)
      throw new Error("Window language access denied");
  };
  // Replaced by the next window's own; the window already holds as many "closed" listeners as Node allows unwarned.
  ipcMain.removeHandler("branch:window-language");
  ipcMain.handle("branch:window-language", (event, language: unknown) => { authorized(event); return saveWindowLanguage(dir, language); });
}

/**
 * One word from the window's words (public/locales/<language>.json), English when the language lacks it. Only that
 * entry is read out of the file: the whole list is most of a megabyte, and main needs two of its words.
 */
export function localeWord(dir: string, language: string, key: string): string {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const entry = new RegExp(`"${escaped}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`);
  for (const each of [language, "en"]) {
    try {
      const found = entry.exec(readFileSync(join(dir, `${each}.json`), "utf8"));
      if (found?.[1]) return JSON.parse(found[1]) as string;
    } catch { /* that language has no words on file */ }
  }
  return key;
}
