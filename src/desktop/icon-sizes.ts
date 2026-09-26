/**
 * How big Branch's mascot has to be in each place it appears, kept apart from the window code
 * so every rule here is checked without opening anything.
 *
 * The three places want three different things, and one size for all of them was wrong:
 *  - the window (and with it the taskbar button on Windows and the dock on Linux) wants a big mark;
 *  - the menu bar on macOS wants a small one drawn from its shape alone, so it suits a light and a
 *    dark menu bar equally; the notification area on Windows and Linux wants a small ordinary one;
 *  - the dock on macOS is never taken from the window at all. It comes from the `.icns` inside the
 *    bundle (see scripts/package-macos.mjs), which is why nothing here sets it.
 */

/**
 * The window's icon, in pixels. It used to be 32, which a taskbar had to stretch; 512 is the largest
 * size any desktop asks for, and every smaller one is made from it by the system.
 */
export const WINDOW_ICON_SIZE = 512;

/** The menu-bar (macOS) or notification-area (Windows, Linux) size, in points. */
export function trayIconSize(platform: NodeJS.Platform): number {
  return platform === "darwin" ? 16 : 32;
}

/**
 * The scales that size is drawn at. A Retina menu bar draws at two pixels per point, so macOS gets
 * a second, sharper copy; Windows and Linux keep the single copy they have always had.
 */
export function trayIconScales(platform: NodeJS.Platform): number[] {
  return platform === "darwin" ? [1, 2] : [1];
}

/**
 * macOS draws a "template" menu-bar icon from its shape alone and colours it itself, so the mark
 * stays readable whether the menu bar is light or dark. No other system has the idea.
 */
export function isTemplateTrayIcon(platform: NodeJS.Platform): boolean {
  return platform === "darwin";
}
