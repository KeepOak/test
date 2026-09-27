import { z } from "zod";
import type { Store } from "./store.js";
import { FeatureModeSchema, type FeatureMode } from "./feature-switches.js";

/**
 * The terminal wears the same 44 themes as the window. Nothing here writes a colour down: the
 * finished colours come from `public/theme-catalogue.js`, the file the window reads, and this module
 * only turns them into what a terminal can show — true colour, the 256-colour table, or the sixteen
 * colours every terminal has — and keeps the owner's choice where the terminal and the window can
 * both find it.
 */
export type ColorDepth = "truecolor" | "ansi256" | "ansi16" | "none";
export type Rgb = readonly [number, number, number];
export type LookMode = "dark" | "light";

/** The roles the terminal draws with, each one taken from the window token that means the same. */
export interface TerminalPalette {
  theme: string;
  name: string;
  mode: LookMode;
  ground: Rgb;
  panel: Rgb;
  raised: Rgb;
  text: Rgb;
  muted: Rgb;
  faint: Rgb;
  line: Rgb;
  accent: Rgb;
  accentText: Rgb;
  onAccent: Rgb;
  accentTint: Rgb;
  ok: Rgb;
  warn: Rgb;
  bad: Rgb;
}
export type PaletteRole = Exclude<keyof TerminalPalette, "theme" | "name" | "mode">;

/** One theme as the catalogue lists it: id, name, group, and each side's values in TOKEN_NAMES order. */
export type CatalogueTheme = [string, string, string, Record<string, string[]>];
export interface ThemeCatalogue {
  TOKEN_NAMES: string[];
  THEME_GROUPS: [string, string][];
  THEMES: CatalogueTheme[];
}

let catalogue: Promise<ThemeCatalogue> | undefined;
/** The window's own theme table, read from where the window reads it. */
export function loadThemeCatalogue(): Promise<ThemeCatalogue> {
  catalogue ??= import(new URL("../public/theme-catalogue.js", import.meta.url).href) as Promise<ThemeCatalogue>;
  return catalogue;
}

const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
/** `#rrggbb` or `rgba(r,g,b,a)` as a colour and how much of it shows. */
export function parseColour(value: string): { rgb: Rgb; alpha: number } | null {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (hex) return { rgb: [0, 2, 4].map((at) => parseInt(hex[1]!.slice(at, at + 2), 16)) as unknown as Rgb, alpha: 1 };
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(value.trim());
  if (!rgba) return null;
  const [r, g, b] = [rgba[1], rgba[2], rgba[3]].map((part) => clamp(Number(part)));
  return { rgb: [r!, g!, b!], alpha: rgba[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(rgba[4]))) };
}
/** A see-through colour as it looks laid over a solid one; a terminal cell cannot be see-through. */
export function over(value: string | undefined, under: Rgb): Rgb {
  const parsed = value ? parseColour(value) : null;
  if (!parsed) return under;
  return parsed.rgb.map((channel, index) => clamp(channel * parsed.alpha + under[index]! * (1 - parsed.alpha))) as unknown as Rgb;
}

/** The terminal palette for one theme, light or dark, at standard or more contrast. */
export function paletteFor(
  table: ThemeCatalogue, themeId: string, mode: LookMode, contrast: "standard" | "more" = "standard",
): TerminalPalette {
  const theme = table.THEMES.find((entry) => entry[0] === themeId)
    ?? table.THEMES.find((entry) => entry[0] === DEFAULT_THEME) ?? table.THEMES[0]!;
  const values = theme[3][`${mode}${contrast === "more" ? "-more" : ""}`] ?? theme[3][mode]!;
  const token = (name: string): string | undefined => values[table.TOKEN_NAMES.indexOf(name)];
  const ground = over(token("--ground"), mode === "dark" ? [0, 0, 0] : [255, 255, 255]);
  const panel = over(token("--glass-2"), ground);
  const solid = (name: string, under: Rgb = ground): Rgb => over(token(name), under);
  return {
    theme: theme[0], name: theme[1], mode, ground, panel,
    raised: solid("--press", panel), text: solid("--text"), muted: solid("--text-2"), faint: solid("--text-3"),
    line: solid("--line-2"), accent: solid("--copper"), accentText: solid("--copper-text"),
    onAccent: solid("--on-copper", solid("--copper")), accentTint: solid("--copper-tint", panel),
    ok: solid("--ok"), warn: solid("--warn"), bad: solid("--bad"),
  };
}

/*
 * Colour distance in Lab space (CIE76), so a theme colour lands on the table entry that looks
 * nearest rather than the one whose numbers are nearest. The approach follows Codex CLI's
 * `codex-rs/tui/src/color.rs` (Apache-2.0); see THIRD_PARTY_NOTICES.md.
 */
function lab([r, g, b]: Rgb): [number, number, number] {
  const linear = (c: number): number => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f((lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047);
  const fy = f(lr * 0.2126 + lg * 0.7152 + lb * 0.0722);
  const fz = f((lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
export function perceptualDistance(a: Rgb, b: Rgb): number {
  const [l1, a1, b1] = lab(a), [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/*
 * The reference tables a terminal's own numbered colours are matched against. These are not design
 * colours: they are xterm's documented defaults, the fixed grid every 256-colour terminal shares,
 * used only to decide which numbered colour stands in for a theme colour.
 */
const CUBE = [0, 95, 135, 175, 215, 255];
const XTERM_16: Rgb[] = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0], [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0], [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
];
function table256(index: number): Rgb {
  if (index < 16) return XTERM_16[index]!;
  if (index >= 232) { const v = 8 + (index - 232) * 10; return [v, v, v]; }
  const n = index - 16;
  return [CUBE[Math.floor(n / 36)]!, CUBE[Math.floor(n / 6) % 6]!, CUBE[n % 6]!];
}
const nearestCache = new Map<string, number>();
function nearest(colour: Rgb, from: number, to: number): number {
  const key = `${from}:${colour.join(",")}`;
  const known = nearestCache.get(key);
  if (known !== undefined) return known;
  let best = from, distance = Infinity;
  for (let index = from; index <= to; index++) {
    const d = perceptualDistance(colour, table256(index));
    if (d < distance) { distance = d; best = index; }
  }
  if (nearestCache.size < 4096) nearestCache.set(key, best);
  return best;
}
/** The numbered colour that stands in for a theme colour; 16 to 255 on a 256-colour terminal. */
export const nearest256 = (colour: Rgb): number => nearest(colour, 16, 255);
/** One of the sixteen colours every terminal has. */
export const nearest16 = (colour: Rgb): number => nearest(colour, 0, 15);

/** The SGR parameters for a colour as text (`fg`) or as the cell behind it (`bg`), at this depth. */
export function colourCode(depth: ColorDepth, colour: Rgb, layer: "fg" | "bg"): string {
  if (depth === "none") return "";
  if (depth === "truecolor") return `${layer === "fg" ? 38 : 48};2;${colour[0]};${colour[1]};${colour[2]}`;
  if (depth === "ansi256") return `${layer === "fg" ? 38 : 48};5;${nearest256(colour)}`;
  const index = nearest16(colour);
  const base = layer === "fg" ? (index < 8 ? 30 : 90) : (index < 8 ? 40 : 100);
  return String(base + (index % 8));
}

/** A Windows build number from `os.release()` ("10.0.19045" gives 19045), or 0. */
const windowsBuild = (release: string): number => Number(/^10\.0\.(\d+)/.exec(release)?.[1] ?? 0);
const TRUECOLOR_PROGRAMS = new Set(["iTerm.app", "WezTerm", "vscode", "Hyper", "ghostty", "Tabby", "rio"]);
/** An explicit choice first: FORCE_COLOR (0–3) or BRANCH_COLOR (truecolor, 256, 16, none). */
function chosenDepth(env: NodeJS.ProcessEnv): ColorDepth | undefined {
  const named: Record<string, ColorDepth> = { truecolor: "truecolor", "24bit": "truecolor", "256": "ansi256", "16": "ansi16", none: "none" };
  if (env.BRANCH_COLOR && named[env.BRANCH_COLOR]) return named[env.BRANCH_COLOR];
  if (env.FORCE_COLOR === undefined) return undefined;
  const forced: Record<string, ColorDepth> = { "0": "none", false: "none", "1": "ansi16", true: "ansi16", "": "ansi16", "2": "ansi256", "3": "truecolor" };
  return forced[env.FORCE_COLOR];
}
/**
 * How many colours this terminal shows, from the environment alone. Windows Terminal sets
 * WT_SESSION and shows true colour; the Windows console itself has shown true colour since
 * build 14931, and 256 colours since 10586, which is the rule Node itself uses.
 */
export function detectDepth(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, release = ""): ColorDepth {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "none";
  const chosen = chosenDepth(env);
  if (chosen) return chosen;
  const term = env.TERM ?? "";
  if (term === "dumb") return "none";
  if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")) return "truecolor";
  if (env.WT_SESSION || TRUECOLOR_PROGRAMS.has(env.TERM_PROGRAM ?? "") || /direct|truecolor|kitty|ghostty/.test(term)) return "truecolor";
  if (/-256(color)?$/.test(term) || env.TERM_PROGRAM === "Apple_Terminal") return "ansi256";
  if (platform === "win32" && !term) {
    const build = windowsBuild(release);
    return build >= 14931 ? "truecolor" : build >= 10586 ? "ansi256" : "ansi16";
  }
  if (/^(xterm|screen|tmux|vt1\d\d|vt2\d\d|rxvt|ansi|cygwin|linux|konsole|putty|alacritty)/.test(term) || env.CI) return "ansi16";
  return term ? "ansi16" : "none";
}
/**
 * Whether box lines, the dot and the ellipsis will show as themselves. Node writes to the Windows
 * console as UTF-16, so the console's code page does not matter there; elsewhere the locale says.
 * BRANCH_ASCII=1 asks for plain ASCII anywhere.
 */
export function detectUnicode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  if (env.BRANCH_ASCII === "1") return false;
  if (env.BRANCH_ASCII === "0" || platform === "win32") return true;
  if (/^(linux|vt\d+|dumb)$/.test(env.TERM ?? "")) return false;
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return !locale || /utf-?8/i.test(locale);
}

/** A light or dark background the terminal itself reports (COLORFGBG="15;0" is light text on dark). */
export function terminalMode(env: NodeJS.ProcessEnv): LookMode | undefined {
  const background = Number(env.COLORFGBG?.split(";").at(-1));
  if (!Number.isInteger(background)) return undefined;
  return background === 7 || background >= 9 ? "light" : "dark";
}

/*
 * The owner's look, kept with the workspace so `branch theme` and Settings › Appearance are the
 * same setting. Light or dark stays where it always was (the preferences record the window saves);
 * the theme, the contrast and the language live here, beside a note of when they last changed so
 * the window can tell whether the terminal changed them since it last looked.
 */
export const THEME_ID = /^[a-z0-9-]{1,40}$/;
/* Redesign phase 1 (owner decision): a new install wears Slate. Forest and the rest stay. The window's
   copy of this name is DEFAULT_THEME in public/theme-bridge.js. */
export const DEFAULT_THEME = "slate";
/** The languages Branch has words on file for (public/locales), besides "auto" (follow this computer). */
export const LOOK_LANGUAGES = ["en", "fr", "es", "de"] as const;
export type LookLanguage = (typeof LOOK_LANGUAGES)[number];
export const LookSchema = z.object({
  theme: z.string().regex(THEME_ID).default(DEFAULT_THEME),
  contrast: z.enum(["standard", "more"]).default("standard"),
  language: z.enum(["auto", ...LOOK_LANGUAGES]).default("auto"),
  changedAt: z.string().max(40).default(""),
  changedBy: z.enum(["terminal", "window", ""]).default(""),
}).strict();
export type Look = z.infer<typeof LookSchema>;
const LookChangeSchema = z.object({
  theme: z.string().regex(THEME_ID).optional(),
  contrast: z.enum(["standard", "more"]).optional(),
  language: z.enum(["auto", ...LOOK_LANGUAGES]).optional(),
  changedBy: z.enum(["terminal", "window"]).default("terminal"),
}).strict();
const LOOK_KEY = "look";

export function readLook(store: Store, owner: string): Look {
  const saved = LookSchema.safeParse(store.get("settings", owner, LOOK_KEY)?.data ?? {});
  return saved.success ? saved.data : LookSchema.parse({});
}
/** Changes only what the change names. A theme must be one of the 44. */
export async function saveLook(store: Store, owner: string, input: unknown, now = new Date()): Promise<Look> {
  const change = LookChangeSchema.parse(input);
  if (change.theme) {
    const { THEMES } = await loadThemeCatalogue();
    if (!THEMES.some((theme) => theme[0] === change.theme))
      throw new Error(`There is no theme called ${change.theme}. \`branch theme list\` shows all ${THEMES.length}.`);
  }
  const current = readLook(store, owner);
  const next = LookSchema.parse({
    ...current,
    ...(change.theme ? { theme: change.theme } : {}),
    ...(change.contrast ? { contrast: change.contrast } : {}),
    ...(change.language ? { language: change.language } : {}),
    changedAt: now.toISOString(), changedBy: change.changedBy,
  });
  store.save("settings", owner, LOOK_KEY, next);
  return next;
}

/** Light or dark: the workspace's saved choice, or the terminal's own background when it follows. */
export function lookMode(store: Store, owner: string, env: NodeJS.ProcessEnv): LookMode {
  const saved = store.get("settings", owner, "preferences")?.data ?? {};
  if (saved.followSystem === true) return terminalMode(env) ?? "dark";
  return saved.appearance === "daylight" ? "light" : "dark";
}
/** Sets light or dark on the same record the window saves, keeping everything else in it. */
export function saveLookMode(store: Store, owner: string, mode: LookMode | "follow"): void {
  const saved = store.get("settings", owner, "preferences")?.data ?? {};
  const next = mode === "follow"
    ? { ...saved, followSystem: true }
    : { ...saved, followSystem: false, appearance: mode === "light" ? "daylight" : "forest" };
  store.save("settings", owner, "preferences", next);
}
/** The language the terminal speaks: the saved choice, or the computer's own when it is "auto". */
export function lookLanguage(look: Look, env: NodeJS.ProcessEnv): LookLanguage {
  if (look.language !== "auto") return look.language;
  const computer = (env.LC_ALL || env.LC_MESSAGES || env.LANG || "").slice(0, 2).toLowerCase();
  return LOOK_LANGUAGES.find((code) => code === computer) ?? "en";
}

/*
 * The terminal's own switches. Each is on, off or "when needed", and each starts off.
 * - mouse: on catches clicks and the wheel everywhere; when needed only while the palette or
 *   Settings is open (where a click picks something and nobody is selecting text); off never, so
 *   the terminal's own text selection always works.
 * - sidePane: on opens the side pane when the view starts (where it fits); when needed opens it by
 *   itself while a task works and folds it when the task ends; off leaves it to Ctrl+P.
 * - oak: on draws the oak on an empty conversation whenever it fits at all; when needed only when
 *   the window is tall enough to leave the greeting room; off never.
 */
export const TerminalSwitchSchema = FeatureModeSchema;
export type TerminalSwitch = FeatureMode;
export const TerminalSwitchesSchema = z.object({
  mouse: TerminalSwitchSchema.default("off"),
  sidePane: TerminalSwitchSchema.default("off"),
  oak: TerminalSwitchSchema.default("off"),
}).strict();
export type TerminalSwitches = z.infer<typeof TerminalSwitchesSchema>;
const SWITCHES_KEY = "terminal-switches";

export function terminalSwitches(store: Store, owner: string): TerminalSwitches {
  const saved = TerminalSwitchesSchema.safeParse(store.get("settings", owner, SWITCHES_KEY)?.data ?? {});
  return saved.success ? saved.data : TerminalSwitchesSchema.parse({});
}
export function saveTerminalSwitch(store: Store, owner: string, name: string, value: string): TerminalSwitches {
  const key = z.enum(["mouse", "sidePane", "oak"]).parse(name);
  const next = { ...terminalSwitches(store, owner), [key]: TerminalSwitchSchema.parse(value) };
  store.save("settings", owner, SWITCHES_KEY, next);
  return next;
}

/** `GET /api/look` and `POST /api/look`, so the window reads and saves the same choice the terminal does. */
export async function lookApi(store: Store, owner: string, method: string, body: () => Promise<unknown>): Promise<Look> {
  if (method === "GET") return readLook(store, owner);
  if (method !== "POST") throw Object.assign(new Error("Use GET or POST"), { status: 405 });
  const input = await body();
  return saveLook(store, owner, { ...(input && typeof input === "object" ? input : {}), changedBy: "window" });
}
