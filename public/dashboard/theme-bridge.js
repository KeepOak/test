/* The dashboard's own copy of what was public/theme-bridge.js before the old window was removed (#291), served at /dashboard/theme-bridge.js. */
/* One KeepOak theme's colours, handed to Branch's own token names. Shared by the window
   (public/layout.js) and the dashboard (public/dashboard/look.js), so both wear a theme the same way.
   What each page does with the result (its opaque --surface, the oak) stays with that page. */
import { THEMES, TOKEN_NAMES } from "/theme-catalogue.js";

/* Branch's own token names (public/tokens.css), each taken from the KeepOak token that means the same. */
export const BRIDGE = {
  "--panel": "--glass-2", "--panel-2": "--glass", "--muted": "--text-2", "--faint": "--text-3",
  "--line-strong": "--line-2", "--selected": "--press", "--good": "--ok", "--good-tint": "--ok-tint",
  "--danger": "--bad", "--copper-low": "--copper-lo", "--rail-hover": "--press", "--bubble": "--copper-tint",
  "--composer-bg": "--glass-2", "--step-bg": "--well", "--border": "--line", "--text-dim": "--text-3",
};
/* The theme a new install wears until somebody picks one (owner decision, redesign phase 1: Slate). */
export const DEFAULT_THEME = "slate";
export const themeById = (id) => THEMES.find((theme) => theme[0] === id)
  ?? THEMES.find((theme) => theme[0] === DEFAULT_THEME) ?? THEMES[0];
/** One theme's colours for light or dark, as { "--token": value }. */
export function tokensFor(theme, mode, contrast = "standard") {
  const values = theme[3][`${mode}${contrast === "more" ? "-more" : ""}`];
  return Object.fromEntries(TOKEN_NAMES.map((name, index) => [name, values[index]]).filter(([name, value]) => value && name !== "--blur"));
}
const rgbOf = (hex) => /^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16)) : null;
/** An opaque colour a step from `ground` toward `toward`, for menus and cards that must not show through. */
export function solid(ground, toward, amount) {
  const from = rgbOf(ground), to = rgbOf(toward);
  if (!from || !to) return ground;
  return `rgb(${from.map((value, index) => Math.round(value + (to[index] - value) * amount)).join(", ")})`;
}
/** Writes a theme's tokens and their Branch names onto the page, and marks which theme it is. */
export function wearTokens(root, family, tokens) {
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
  for (const [name, from] of Object.entries(BRIDGE)) if (tokens[from]) root.style.setProperty(name, tokens[from]);
  root.dataset.palette = family[0];
}
