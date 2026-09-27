import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The headers a desktop window's /api/ request goes out with: whatever authorization the page wrote (a stand-in, in
 * any letter case: dogfood F7) is dropped, and only the app's own key is sent. Kept apart from main.ts so a test can
 * check it without Electron.
 */
export function signedHeaders(headers: Record<string, string>, token: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() !== "authorization") out[name] = value;
  out.Authorization = `Bearer ${token}`;
  return out;
}

/**
 * The window's key as it is now. Removing a phone that was handed the key makes the engine save a new one over
 * `session-token` (src/remote/window-key.ts), so the desktop app reads the file again each time it signs something,
 * and keeps the last good key while the file cannot be read. Nothing is cached, so no request goes out with the old
 * key once the new one is saved.
 */
export function windowKeyReader(dataDir: string, first: string, read: (path: string) => string = (path) => readFileSync(path, "utf8")): () => string {
  let last = first;
  const path = join(dataDir, "session-token");
  return () => {
    try {
      const key = read(path).trim();
      if (/^[a-f0-9]{64}$/.test(key)) last = key;
    } catch { /* the last good key is kept */ }
    return last;
  };
}

/**
 * Whether a request is to the window's own address (`origin`, as http://host:port). A task's socket is asked for at the
 * same address as ws://, so it counts as the window's own too, to be let through and signed like any /api/ request.
 */
export function sameAppOrigin(target: string, origin: string): boolean {
  try {
    const url = new URL(target);
    const scheme = url.protocol === "ws:" ? "http:" : url.protocol === "wss:" ? "https:" : url.protocol;
    return new URL(`${scheme}//${url.host}`).origin === origin;
  } catch {
    return false;
  }
}
