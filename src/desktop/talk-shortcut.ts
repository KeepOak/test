import type { BrowserWindow, GlobalShortcut, IpcMain, IpcMainInvokeEvent } from "electron";
import { keyCombo } from "../comfort/settings.js";

export const talkShortcutChannel = "branch:talk-shortcut";
export const talkShortcutTakeChannel = "branch:talk-shortcut-take";
export const talkShortcutRefreshChannel = "branch:talk-shortcut-keys";
type TalkWindow = Pick<BrowserWindow, "webContents" | "on" | "removeListener" | "show" | "focus" | "isFocused" | "isDestroyed">;
interface TalkShortcutDeps {
  shortcuts: Pick<GlobalShortcut, "register" | "unregister">;
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  window: () => TalkWindow | null;
  open: () => Promise<void>;
  origin: string;
  keys: () => Promise<string>;
  log?: (line: string) => void;
}

/** Owner keys only, through the shell's authenticated client; a page cannot supply an accelerator. */
export async function talkShortcutKeys(url: string, token: string, call: typeof fetch = fetch): Promise<string> {
  const origin = new URL(url);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") return "";
  const response = await call(`${origin.origin}/api/comfort`, {
    headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return "";
  const body = await response.json() as { values?: { keys?: { talkLive?: unknown } } };
  const combo = body.values?.keys?.talkLive;
  return typeof combo === "string" && keyCombo.safeParse(combo).success ? combo : "";
}

/** Press-only Electron transport: this toggles Talk live, and never claims held-key capture. */
class TalkShortcut {
  private held: string | null = null;
  private pending = 0;
  private epoch = 0;
  private stopped = false;
  private bound: TalkWindow | null = null;
  constructor(private readonly deps: TalkShortcutDeps) {}

  private release = (): void => {
    ++this.epoch;
    if (this.held) this.deps.shortcuts.unregister(this.held);
    this.held = null;
  };
  private background = (): void => { void this.apply(); };
  private closed = (): void => { this.pending = 0; this.bind(); void this.apply(); };

  private bind(): void {
    const shown = this.deps.window();
    const next = shown && !shown.isDestroyed() ? shown : null;
    if (next === this.bound) return;
    this.bound?.removeListener("focus", this.release);
    this.bound?.removeListener("blur", this.background);
    this.bound?.removeListener("closed", this.closed);
    this.bound = next;
    next?.on("focus", this.release);
    next?.on("blur", this.background);
    next?.on("closed", this.closed);
  }

  private async apply(): Promise<boolean> {
    this.bind();
    const epoch = ++this.epoch;
    const combo = await this.deps.keys().catch(() => "");
    if (this.stopped || epoch !== this.epoch) return false;
    // In Branch itself Ctrl+Shift+V keeps the text box's paste behaviour and the ordinary window shortcut.
    const wanted = this.bound?.isFocused() || !combo || !keyCombo.safeParse(combo).success ? null
      : combo.split("+").map((part) => part === "Ctrl" ? "CommandOrControl" : part).join("+");
    if (wanted === this.held) return wanted !== null;
    this.release();
    if (!wanted) return false;
    try { if (this.deps.shortcuts.register(wanted, () => { void this.press(); })) this.held = wanted; }
    catch { this.deps.log?.("Talk live shortcut could not be registered"); }
    if (!this.held) this.deps.log?.("Talk live shortcut is unavailable; use Talk live in the window");
    return this.held !== null;
  }

  private async press(): Promise<void> {
    if (this.stopped || this.pending && Date.now() - this.pending < 15_000) return;
    const request = this.pending = Date.now();
    try { await this.deps.open(); } catch { this.pending = 0; return; }
    this.bind();
    const shown = this.bound;
    if (this.stopped || request !== this.pending || !shown) return;
    shown.show();
    shown.focus();
    shown.webContents.send(talkShortcutChannel);
  }

  private authorized(event: IpcMainInvokeEvent): void {
    const shown = this.deps.window();
    const frame = event.senderFrame;
    if (!shown || shown.isDestroyed() || event.sender !== shown.webContents ||
      !frame || frame !== shown.webContents.mainFrame ||
      new URL(frame.url).origin !== this.deps.origin) throw new Error("Talk live shortcut access denied");
  }

  start(): () => void {
    this.deps.ipc.handle(talkShortcutTakeChannel, (event) => {
      this.authorized(event);
      this.bind();
      if (this.bound?.isFocused()) this.release();
      const pending = this.pending;
      this.pending = 0;
      return pending > 0 && Date.now() - pending < 15_000;
    });
    this.deps.ipc.handle(talkShortcutRefreshChannel, async (event) => { this.authorized(event); return this.apply(); });
    void this.apply();
    return () => {
      this.stopped = true;
      this.pending = 0;
      this.release();
      this.bound?.removeListener("focus", this.release);
      this.bound?.removeListener("blur", this.background);
      this.bound?.removeListener("closed", this.closed);
      this.deps.ipc.removeHandler(talkShortcutTakeChannel);
      this.deps.ipc.removeHandler(talkShortcutRefreshChannel);
    };
  }
}

export const registerTalkShortcut = (deps: TalkShortcutDeps): (() => void) => new TalkShortcut(deps).start();
