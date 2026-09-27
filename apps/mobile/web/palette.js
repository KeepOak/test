/**
 * The one place the phone apps get a colour from. Native pieces cannot read CSS, so the splash
 * screen, the status bar, the lock screen, the share sheet and notifications take the few colours
 * they need from the same theme table the window uses (public/theme-catalogue.js), through this
 * function. Nothing on the phone writes a colour down by hand.
 */

/**
 * The theme the native pieces wear when nothing else is known: the splash screen, the launch colour,
 * the app icon's ground, and the first paint before the window says which theme it shows. The same
 * default the window used (web/theme-bridge.js DEFAULT_THEME, the phone's copy; redesign phase 1: Slate).
 */
export const NATIVE_THEME = "slate";

/** The KeepOak token each native role reads, in the table's own names. */
export const NATIVE_ROLES = Object.freeze({
  ground: "--ground",
  text: "--text",
  muted: "--text-2",
  line: "--line",
  accent: "--copper",
  onAccent: "--on-copper",
  good: "--ok",
  bad: "--bad",
});

const hexPattern = /^#([0-9a-f]{6})$/i;
const rgbaPattern = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+)\s*)?\)$/i;
const two = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0").toUpperCase();

/**
 * A theme colour as opaque #RRGGBB. A see-through colour is laid over `under` first, because a
 * native surface has nothing behind it to show through.
 */
export function opaque(value, under = "#000000") {
  const text = String(value ?? "").trim();
  if (hexPattern.test(text)) return text.toUpperCase();
  const match = rgbaPattern.exec(text);
  if (!match) throw new Error(`Not a colour the phone can use: ${text}`);
  const alpha = match[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(match[4])));
  const base = opaque(under, "#000000");
  const channel = (index) => {
    const from = parseInt(base.slice(1 + index * 2, 3 + index * 2), 16);
    return from + (Number(match[index + 1]) - from) * alpha;
  };
  return `#${two(channel(0))}${two(channel(1))}${two(channel(2))}`;
}

/** Android writes colours as #AARRGGBB; iOS and the web as #RRGGBB. */
export const androidColour = (hex) => `#FF${opaque(hex).slice(1)}`;

/**
 * The native palette for one theme in one mode: { ground, text, muted, … } as #RRGGBB, plus
 * `statusBar` ("light" text on a dark ground, "dark" on a light one).
 */
export function nativePalette(catalogue, themeId = NATIVE_THEME, mode = "dark") {
  const { THEMES, TOKEN_NAMES } = catalogue;
  const theme = THEMES.find((entry) => entry[0] === themeId) ?? THEMES[0];
  const values = theme[3][mode === "light" ? "light" : "dark"];
  const token = (name) => values[TOKEN_NAMES.indexOf(name)];
  const ground = opaque(token("--ground"));
  const palette = { theme: theme[0], mode: mode === "light" ? "light" : "dark" };
  for (const [role, name] of Object.entries(NATIVE_ROLES)) palette[role] = role === "ground" ? ground : opaque(token(name), ground);
  palette.statusBar = palette.mode === "light" ? "dark" : "light";
  return palette;
}

/** Both modes at once, which is what a build-time file (splash, launch colour) needs. */
export const nativePalettes = (catalogue, themeId = NATIVE_THEME) =>
  ({ dark: nativePalette(catalogue, themeId, "dark"), light: nativePalette(catalogue, themeId, "light") });
