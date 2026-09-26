/**
 * mac7/app-icon: the mascot in the sizes a Linux menu asks for.
 *
 * A menu, a dock and an alt-tab switcher each draw the icon at a different size. Given one big
 * picture they all shrink it themselves, badly; given an icon theme they pick the size that was made
 * for them. The Linux download therefore carries a folder of ready-made sizes (written by
 * scripts/package-linux.mjs) and the installer copies each one into this person's own icon theme.
 *
 * Pure names and numbers only, so both the packager and the installer agree without importing either.
 */

/** The folder inside the Linux download that holds the ready-made sizes. */
export const LINUX_ICON_FOLDER = "icons";

/** The sizes every icon theme is expected to have; 512 is the largest any desktop asks for. */
export const LINUX_ICON_SIZES = [16, 32, 48, 64, 128, 256, 512];

/** The name one size is stored under, inside the download and inside the icon theme. */
export function iconFileName(program: string, size: number): string {
  return `${program}-${size}.png`;
}

/** The size a file in that folder holds, or null when the name is not one of ours. */
export function iconFileSize(program: string, name: string): number | null {
  const match = new RegExp(`^${program}-(\\d+)\\.png$`).exec(name);
  const size = match ? Number(match[1]) : NaN;
  return LINUX_ICON_SIZES.includes(size) ? size : null;
}

/** Where one size goes in an icon theme, as the freedesktop directories have it. */
export function iconThemePath(theme: string, program: string, size: number): string {
  return `${theme}/${size}x${size}/apps/${program}.png`;
}
