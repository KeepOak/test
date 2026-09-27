/* The look, 1:1 with the prototype's themes: the engine keeps the theme (GET/POST /api/look, one of the themes in
   /theme-catalogue.js, the table the terminal shares) and its contrast; light or dark stays in the preferences. What the
   engine cannot hold stays in this window (FEATURE-AUDIT: acc-set, ce-*, my-*): the themes you made and an accent of
   your own. Slate is Branch Slate, the window's own colours, so wearing it sets nothing. Paper is not a theme the
   engine knows, so it is not offered. */

import { renderNow } from "../core/dom.js";
import { E } from "../core/state.js";
import { api } from "../core/api.js";
import { toast } from "../core/ui.js";
import { noticed } from "./scene.js";
import { followLook } from "./language.js";

const KEY = "branch-looks";
export const BASE = "slate";
export const L = { look: null, cat: null, my: [], mine: null, accent: null, asked: false, key: "" };

/* ---------- colours ---------- */
function rgbaOf(c) {
  const s = String(c ?? "").trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) { const p = m[1].split(",").map(parseFloat); return [p[0], p[1], p[2], p[3] == null || Number.isNaN(p[3]) ? 1 : p[3]]; }
  return [128, 128, 128, 1];
}
const hexOf = ([r, g, b]) => "#" + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("").toUpperCase();
export const mixC = (a, b, t) => { const A = rgbaOf(a), B = rgbaOf(b); return hexOf(A.map((v, i) => v + (B[i] - v) * t)); };
const overC = (c, bg) => { const A = rgbaOf(c), B = rgbaOf(bg); return hexOf(A.slice(0, 3).map((v, i) => B[i] + (v - B[i]) * A[3])); };
const lumC = (c) => { const [r, g, b] = rgbaOf(c).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrastC = (a, b) => { const x = lumC(a), y = lumC(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
export const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v || "");

/* The thirteen colours a person can pick, and the window's own (Branch Slate) in each mode. */
export const EF = [["bg", "Background"], ["side", "Sidebar"], ["raise", "Cards and menus"], ["ink", "Text"], ["ink2", "Softer text"], ["ink3", "Faint text"], ["line", "Lines"], ["accent", "Accent: things that want you"], ["btn", "Buttons"], ["onBtn", "Button text"], ["ok", "Good"], ["warn", "Careful"], ["bad", "Problem"]];
export const BRANCH_EF = {
  light: { bg: "#F6F8F9", side: "#EDF1F3", raise: "#FFFFFF", ink: "#141D24", ink2: "#3A4751", ink3: "#5F6C76", line: "#DFE5E9", accent: "#D8612A", btn: "#141D24", onBtn: "#F6F8F9", ok: "#2F8F5B", warn: "#A86E12", bad: "#C2412D" },
  dark: { bg: "#0F1418", side: "#0B0F12", raise: "#161D22", ink: "#E6ECF0", ink2: "#AEBAC3", ink3: "#85929B", line: "#1D262C", accent: "#E7753F", btn: "#E6ECF0", onBtn: "#0F1418", ok: "#5CC08A", warn: "#E0AF3B", bad: "#F0806C" },
}; /* pass 17's Slate: kept in step with the "pass 17 look" tokens in app.css */

/* One catalogue theme, one mode, as those thirteen colours (the catalogue lists each side in TOKEN_NAMES order). */
function themeEF(row, mode, more) {
  const side = row[3][mode + (more ? "-more" : "")] ?? row[3][mode] ?? [];
  const at = (name) => side[L.cat.TOKEN_NAMES.indexOf(name)];
  const dark = mode === "dark", G = at("--ground"), T = at("--text");
  const bg = dark ? mixC(G, T, 0.045) : mixC(G, "#FFFFFF", 0.62);
  return { bg, side: dark ? G : mixC(G, "#FFFFFF", 0.3), raise: dark ? mixC(G, T, 0.085) : mixC(G, "#FFFFFF", 0.88), ink: T,
    ink2: overC(at("--text-2"), bg), ink3: overC(at("--text-3"), bg), line: overC(at("--line"), bg), accent: at("--copper"),
    btn: T, onBtn: bg, ok: at("--ok"), warn: at("--warn"), bad: at("--bad"), accentText: at("--copper-text") };
}
/* Everything else follows from the thirteen. */
export function varsFromEF(c, mode) {
  const dark = mode === "dark", bg = c.bg, T = c.ink;
  return { "--bg": bg, "--side": c.side, "--raise": c.raise, "--title": dark ? mixC(c.side, "#000000", 0.3) : mixC(c.side, T, 0.06),
    "--ink": T, "--ink-2": c.ink2, "--ink-3": c.ink3, "--line": c.line, "--line-2": mixC(c.line, T, 0.14), "--fill": mixC(bg, T, dark ? 0.07 : 0.05), "--fill-2": mixC(bg, T, dark ? 0.12 : 0.09),
    "--accent": c.accent, "--accent-ink": c.accentText || mixC(c.accent, dark ? "#FFFFFF" : "#000000", 0.22), "--accent-tint": mixC(bg, c.accent, dark ? 0.2 : 0.13), "--brand-tint": mixC(bg, c.ok, 0.16),
    "--btn": c.btn, "--on-btn": c.onBtn, "--ok": c.ok, "--ok-tint": mixC(bg, c.ok, 0.14), "--warn": c.warn, "--warn-tint": mixC(bg, c.warn, 0.14), "--bad": c.bad, "--bad-tint": mixC(bg, c.bad, 0.14) };
}
const VAR_KEYS = Object.keys(varsFromEF(BRANCH_EF.light, "light"));
/* "Fill in the rest": sidebar, cards, softer text, lines and button text from background, text and accent. */
export function deriveEF(c, mode) {
  const dark = mode === "dark", bg = c.bg, T = c.ink;
  return { ...c, side: dark ? mixC(bg, "#000000", 0.28) : mixC(bg, T, 0.04), raise: dark ? mixC(bg, T, 0.05) : mixC(bg, "#FFFFFF", 0.7), ink2: mixC(T, bg, 0.28), ink3: mixC(T, bg, 0.5), line: mixC(bg, T, 0.12), btn: T,
    onBtn: contrastC(T, "#FFFFFF") > contrastC(T, "#111111") ? "#FFFFFF" : "#111111" };
}

/* ---------- which looks there are ---------- */
export const effMode = () => { const t = document.documentElement.dataset.theme; return t === "dark" || t === "light" ? t : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"; };
export const more = () => L.look?.contrast === "more";
const GROUP = { keepoak: "KeepOak", editors: "Editors & terminals" };
/* Every look as [id, name, group, custom]: Branch Slate first, the engine's catalogue, then yours. */
export function looks() {
  const rows = (L.cat?.THEMES ?? []).filter((t) => t[0] !== BASE).map((t) => [t[0], t[1], GROUP[t[2]] ?? t[2], null]);
  return [[BASE, "Branch Slate", "Branch", null], ...rows, ...L.my.map((x) => ["my-" + x.id, x.name, "Yours", x])];
}
export const wornId = () => (L.mine && L.my.some((x) => x.id === L.mine) ? "my-" + L.mine : L.look?.theme ?? BASE);
export const lookOf = (id) => looks().find((x) => x[0] === id) ?? looks()[0];
export function lookEF(id, mode) {
  const x = lookOf(id);
  if (x[3]) return { ...x[3][mode] };
  const row = L.cat?.THEMES.find((t) => t[0] === id);
  return row && id !== BASE ? themeEF(row, mode, more()) : { ...BRANCH_EF[mode] };
}
export function withAccent(c, mode) { return L.accent ? { ...c, accent: L.accent, accentText: mixC(L.accent, mode === "dark" ? "#FFFFFF" : "#000000", 0.22) } : c; }

/* ---------- wearing it ---------- */
export function clearVars() { for (const k of VAR_KEYS) document.documentElement.style.removeProperty(k); }
export function setVars(c, mode) { clearVars(); for (const [k, v] of Object.entries(varsFromEF(c, mode))) document.documentElement.style.setProperty(k, v); }
export function applyLook() {
  const id = wornId(), mode = effMode();
  if (id === BASE && !L.accent && !more()) clearVars(); else setVars(withAccent(lookEF(id, mode), mode), mode);
  document.documentElement.dataset.palette = id;
  document.documentElement.classList.toggle("contrast17", more()); /* More contrast keeps full-strength lines (app.css) */
}

export function saveLocal() {
  try { localStorage.setItem(KEY, JSON.stringify({ my: L.my, mine: L.mine, accent: L.accent })); } catch (error) { toast(error.message); }
}
function loadLocal() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch (error) { toast(error.message); }
  if (!saved) return;
  L.my = (Array.isArray(saved.my) ? saved.my : []).filter((x) => x && x.id && x.light && x.dark && EF.every(([k]) => isHex(x.light[k]) && isHex(x.dark[k])));
  L.mine = typeof saved.mine === "string" ? saved.mine : null;
  L.accent = isHex(saved.accent) ? saved.accent.toUpperCase() : null;
}

/* Light or dark from the engine's preferences. */
function applyMode() {
  const prefs = E.state?.preferences;
  if (!prefs) return;
  if (prefs.followSystem) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = prefs.appearance === "daylight" ? "light" : "dark";
}

/* Once the engine has let the window in: its theme and the catalogue, and light or dark from its preferences. After
   that, the look is read again whenever the window refreshes (a new E.state: the engine's events refresh it) and when
   the window comes back into view, so a theme changed in the terminal (`branch theme`) reaches an open window. The
   engine sends no event of its own for the look. */
let seenState = null;
export async function loadLook() {
  if (!E.loaded) return;
  if (L.asked) { if (E.state !== seenState) rereadLook(); return; }
  L.asked = true;
  seenState = E.state;
  loadLocal();
  try {
    [L.look, L.cat] = await Promise.all([api("look"), import("/theme-catalogue.js")]);
  } catch (error) { toast(error.message); }
  await followLook(L.look); /* rw4-language: the engine's saved language (shell/language.js) */
  applyMode();
  applyLook();
  renderNow();
}
async function rereadLook() {
  seenState = E.state;
  const was = JSON.stringify(L.look), mode = document.documentElement.dataset.theme;
  try { L.look = await api("look"); } catch (error) { toast(error.message); return; }
  const spoke = await followLook(L.look);
  applyMode();
  if (!spoke && JSON.stringify(L.look) === was && document.documentElement.dataset.theme === mode) return;
  applyLook();
  renderNow();
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && L.asked) rereadLook(); });

/* Picks a look: a catalogue theme goes to the engine; one of yours is worn by this window. */
export async function wear(id) {
  if (id.startsWith("my-")) { L.mine = id.slice(3); saveLocal(); applyLook(); return; }
  try {
    L.look = await api("look", { theme: id });
    L.mine = null;
    saveLocal();
  } catch (error) { toast(error.message); }
  applyLook();
}
/* POST /api/preferences replaces the whole record, so every change is laid over what the engine last said. Turning on
   "follow the computer's light or dark" is told to the engine's achievements (the "follow-system" flag). */
export async function savePrefs(change) {
  const prefs = E.state?.preferences;
  if (!prefs) return;
  const follows = change.followSystem === true && !prefs.followSystem;
  try { E.state.preferences = await api("preferences", { ...prefs, ...change }); } catch (error) { toast(error.message); return; }
  if (follows) await noticed({ what: "flag", flag: "follow-system" });
}
export async function setContrast(on) {
  try { L.look = await api("look", { contrast: on ? "more" : "standard" }); } catch (error) { toast(error.message); }
  applyLook();
}

/* The swatch every theme card and the Theme row draw. Colours are checked hex before they reach markup. */
export function swatch(c) {
  const v = (k) => (isHex(c[k]) ? c[k] : "#808080");
  return `<span class="sw6" data-css="--a:${v("side")};--b:${v("bg")};--c:${v("raise")};--d:${v("ink")};--e:${v("accent")};--f:${v("btn")};--g:${v("line")}"><i class="s1"></i><i class="s2"><em></em><em></em><u></u><b></b></i></span>`;
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (!document.documentElement.dataset.theme) { applyLook(); renderNow(); } });
