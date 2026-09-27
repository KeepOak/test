import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, TitleBarOverlayOptions } from "electron";

/**
 * DG-176: the window has no operating-system title bar, as the approved sample has none; the app's own top row is
 * the top of the window. On Windows and Linux the minimise, maximise and close buttons are drawn over that row
 * (`titleBarOverlay`). Only this window's own page, at Branch's own address, may say what the row under them looks
 * like, and it can say nothing but light, dark, or the one colour the row is (#rrggbb, as the page measured it under
 * the controls: every theme, light or dark, following the computer's setting or not).
 *
 * The overlay's colour is that colour made fully see-through, so the row's own look (a see-through theme, a picture
 * behind the glass) shows under the buttons unchanged, while the system still shades a hovered button against it
 * (it shades toward black on a light colour and toward white on a dark one). The glyphs are drawn in whichever of the
 * app's own two glyph colours reads better on that colour, or in pure white or black when neither reaches the WCAG
 * AA ratio of 4.5:1 (one of those two always does).
 */
export const windowLookChannel = "branch:window-look";
export const overlayHeight = 44;
const LIGHT_GLYPH = "#e3eef3", DARK_GLYPH = "#23343e";
const GROUND = { dark: "#101b21", light: "#f4f7f8" } as const;
export const AA = 4.5;

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
/** The WCAG contrast ratio of two #rrggbb colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
/** The glyph colour for a row of this colour: the app's own light or dark glyph, or white or black for AA. */
export function glyphFor(ground: string): string {
  const own = [LIGHT_GLYPH, DARK_GLYPH].sort((a, b) => contrast(b, ground) - contrast(a, ground))[0]!;
  if (contrast(own, ground) >= AA) return own;
  return contrast("#ffffff", ground) >= contrast("#000000", ground) ? "#ffffff" : "#000000";
}

/** The overlay for the row's look: `true` dark, `false` light, or the row's own colour as #rrggbb. */
export function overlayFor(look: boolean | string): TitleBarOverlayOptions {
  const ground = (typeof look === "string" ? look : look ? GROUND.dark : GROUND.light).toLowerCase();
  return { color: `${ground}00`, symbolColor: glyphFor(ground), height: overlayHeight };
}

const isLook = (look: unknown): look is boolean | string => typeof look === "boolean" || (typeof look === "string" && /^#[0-9a-fA-F]{6}$/.test(look));

export function registerWindowLookIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  window: Pick<BrowserWindow, "webContents" | "on" | "setTitleBarOverlay">,
  origin: string,
  platform: NodeJS.Platform = process.platform,
): void {
  const authorized = (event: IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame ||
      new URL(event.senderFrame?.url ?? "about:blank").origin !== origin)
      throw new Error("Window look access denied");
  };
  ipc.handle(windowLookChannel, (event, look: unknown) => {
    authorized(event);
    if (!isLook(look)) throw new Error("Light, dark or one colour as #rrggbb only");
    if (platform !== "darwin") window.setTitleBarOverlay(overlayFor(look));
    return true;
  });
  window.on("closed", () => ipc.removeHandler(windowLookChannel));
}
