import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";

/** The one channel Talk live uses, just before it asks for the microphone for a call the owner started. */
export const talkLiveMicChannel = "branch:talk-live-mic";
/** How long one call's asking stays open for the microphone to be asked for. */
export const talkLiveMicMs = 15_000;

/**
 * The desktop window refuses every permission, except the microphone for Talk live: only for this window, only at
 * Branch's own address, only sound (never the camera), and only once per call, just after the owner pressed Talk live
 * and the conversation opened. Nothing turns the microphone on by itself.
 */
export class TalkLiveMic {
  private until = 0;

  constructor(private readonly origin: string, private readonly contentsId: number, private readonly now: () => number = Date.now) {}

  /** A call the owner started is about to ask for the microphone. */
  open(): void {
    this.until = this.now() + talkLiveMicMs;
  }

  /** Whether this one permission request is that call's; a yes is used up by the request it answers. */
  take(contentsId: number, permission: string, details: { requestingUrl?: string; mediaTypes?: readonly string[] }): boolean {
    const allowed = this.now() < this.until && contentsId === this.contentsId && permission === "media" &&
      originOf(details.requestingUrl) === this.origin &&
      (details.mediaTypes?.length ?? 0) > 0 && details.mediaTypes!.every((type) => type === "audio");
    if (allowed) this.until = 0;
    return allowed;
  }
}

function originOf(url: string | undefined): string {
  try { return new URL(url ?? "about:blank").origin; } catch { return "null"; }
}

/**
 * Only this window's own page, at Branch's own address, may say a call is asking for the microphone; nothing is taken
 * from the page but the request itself. `ipc` is Electron's ipcMain, handed in so this can be checked without Electron.
 */
export function registerTalkLiveMicIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  window: Pick<BrowserWindow, "webContents" | "on">,
  origin: string,
  mic: Pick<TalkLiveMic, "open">,
): void {
  const authorized = (event: IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame?.url ?? "about:blank").origin !== origin)
      throw new Error("Microphone access denied");
  };
  ipc.handle(talkLiveMicChannel, (event) => {
    authorized(event);
    mic.open();
    return true;
  });
  window.on("closed", () => ipc.removeHandler(talkLiveMicChannel));
}
