import type { BrowserWindow, GlobalShortcut, IpcMain, IpcMainInvokeEvent } from "electron";
import { keyCombo, shortcutDefaults } from "../comfort/settings.js";

/** The page asks main to read the keys again after the owner changed them; it hands nothing over. */
export const quickAskRefreshChannel = "branch:quick-ask-keys";
/** Main tells the page to open or close the ask box. */
export const quickAskChannel = "branch:quick-ask";

/**
 * Pass 17, "Quick ask": the owner's keys (the engine's "keys" card, quickAsk; Ctrl Shift Space, or
 * ⌥ Space on a Mac) open the small ask box from any app, even with Branch in the background. The
 * keys are read from the local engine, never taken from the page, so the page can only ask for them
 * to be read again. The default is the same everywhere in the card; on a Mac it is registered as
 * ⌥ Space, which is what a Mac person expects and what the window shows there.
 */
export function toAccelerator(combo: string, platform: NodeJS.Platform = process.platform): string | null {
  if (!combo || !keyCombo.safeParse(combo).success) return null;
  const wanted = platform === "darwin" && combo === shortcutDefaults.quickAsk ? "Alt+Space" : combo;
  return wanted.split("+").map((part) => (part === "Ctrl" ? "CommandOrControl" : part)).join("+");
}

/** The owner's quick-ask keys, from the authenticated local engine (this app's own, or one it joined). */
export async function quickAskKeys(url: string, token: string, call: typeof fetch = fetch): Promise<string> {
  const origin = new URL(url);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") return "";
  const response = await call(`${origin.origin}/api/comfort`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) return "";
  const body = await response.json() as { values?: { keys?: { quickAsk?: unknown } } };
  return typeof body.values?.keys?.quickAsk === "string" ? body.values.keys.quickAsk : "";
}

export interface QuickAskDeps {
  shortcuts: Pick<GlobalShortcut, "register" | "unregister">;
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  window: Pick<BrowserWindow, "webContents" | "on" | "show" | "focus" | "isDestroyed">;
  origin: string;
  keys: () => Promise<string>;
  platform?: NodeJS.Platform;
  log?: (line: string) => void;
}

/**
 * Registers the keys system-wide and keeps them in step with the card. A press shows the window and
 * toggles the box in it. Keys another app already holds are left alone and said in the log; the box
 * still opens from the New menu. Returns a function that lets go of the keys.
 */
export function registerQuickAsk(deps: QuickAskDeps): () => void {
  let held: string | null = null;
  const letGo = () => { if (held) deps.shortcuts.unregister(held); held = null; };
  const press = () => {
    if (deps.window.isDestroyed()) return;
    deps.window.show();
    deps.window.focus();
    deps.window.webContents.send(quickAskChannel);
  };
  const apply = async () => {
    const accelerator = toAccelerator(await deps.keys().catch(() => ""), deps.platform);
    if (accelerator === held) return held;
    letGo();
    if (!accelerator) return null;
    if (deps.shortcuts.register(accelerator, press)) held = accelerator;
    else deps.log?.(`Quick ask: ${accelerator} is taken by another app`);
    return held;
  };
  const authorized = (event: IpcMainInvokeEvent) => {
    if (event.sender !== deps.window.webContents || event.senderFrame !== deps.window.webContents.mainFrame
      || new URL(event.senderFrame?.url ?? "about:blank").origin !== deps.origin)
      throw new Error("Quick ask access denied");
  };
  deps.ipc.handle(quickAskRefreshChannel, async (event) => { authorized(event); return (await apply()) !== null; });
  deps.window.on("closed", () => { deps.ipc.removeHandler(quickAskRefreshChannel); letGo(); });
  void apply();
  return letGo;
}
