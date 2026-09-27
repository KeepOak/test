import { posix, win32 } from "node:path";

/**
 * The names of the downloads attached to every GitHub release, in one place. The Windows name must
 * never change: the updater already on owners' computers looks for it by exact name. The packaging
 * scripts write these same names, and each download has a `<name>.sha256` file beside it.
 */
export const releaseAssets = [
  { platform: "win32", arch: "x64", name: "Branch-Agent-windows-x64.zip" },
  { platform: "darwin", arch: "arm64", name: "Branch-Agent-macos-arm64.zip" },
  { platform: "darwin", arch: "x64", name: "Branch-Agent-macos-x64.zip" },
  { platform: "linux", arch: "x64", name: "Branch-Agent-linux-x64.tar.gz" },
] as const;

/** The download for this kind of computer, or null when no download is published for it. */
export function releaseAssetName(platform: string, arch: string): string | null {
  return releaseAssets.find((asset) => asset.platform === platform && asset.arch === arch)?.name ?? null;
}

export function checksumAssetName(assetName: string): string {
  return `${assetName}.sha256`;
}

/** The macOS app bundle's folder name. */
export const macAppBundleName = "Branch Agent.app";

/**
 * What the updater looks for inside an unpacked download: the Windows program file, the macOS app
 * bundle folder, or the Linux program file.
 */
export function appEntryName(platform: string): string {
  if (platform === "win32") return "Branch Agent.exe";
  if (platform === "darwin") return macAppBundleName;
  return "branch-agent";
}

/**
 * The folder an update replaces, worked out from the running program's own path. Windows and Linux
 * replace the folder holding the program; macOS replaces the whole `.app` bundle around it. Answers
 * null when the program is not inside an app bundle on macOS (running from source, for instance).
 */
export function installTarget(platform: string, executablePath: string): string | null {
  if (platform === "win32") return win32.dirname(executablePath);
  if (platform !== "darwin") return posix.dirname(executablePath);
  const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(executablePath);
  return match?.[1] ?? null;
}

/**
 * Linux copies installed from the .deb or run as an AppImage (scripts/package-installers.mjs) carry
 * `resources/package-type` naming which. Their files belong to the package manager or sit in a
 * read-only image, so the updater leaves them to the newest .deb or AppImage instead of replacing them.
 */
export type PackageType = "deb" | "appimage";
export function packageTypeOf(platform: string, installDir: string | null, read: (path: string) => string): PackageType | null {
  if (platform !== "linux" || !installDir) return null;
  let text: string;
  try { text = read(posix.join(installDir, "resources", "package-type")); } catch { return null; }
  const kind = text.trim();
  return kind === "deb" || kind === "appimage" ? kind : null;
}
