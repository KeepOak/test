/**
 * Puts the owner's look on the phone's own screens: which of the 44 themes the paired Branch wears
 * (GET /api/look "theme") and light or dark (GET /api/state preferences: "daylight", or the phone's own
 * setting while the window follows its computer). Written under Branch's own token names with the phone's
 * copy of the window's theme bridge (web/theme-bridge.js), and handed to the native side so the status
 * bar and the next launch match.
 */
import { themeById, tokensFor, wearTokens } from "/theme-bridge.js";

/** Light or dark from the engine's preferences; "follow the system" follows this phone. */
export function modeOf(preferences) {
  if (!preferences) return null;
  if (preferences.followSystem) return globalThis.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  return preferences.appearance === "daylight" ? "light" : "dark";
}

export function applyTheme(look = {}) {
  const theme = themeById(look.theme);
  const mode = look.mode === "light" ? "light" : "dark";
  const root = document.documentElement;
  if (mode === "light") root.dataset.theme = "daylight"; else delete root.dataset.theme;
  root.dataset.mode = mode;
  wearTokens(root, theme, tokensFor(theme, mode, look.contrast === "more" ? "more" : "standard"));
  return { theme: theme[0], mode };
}
