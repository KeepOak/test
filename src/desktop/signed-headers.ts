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
