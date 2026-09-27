/* The phone's own copy of what was public/i18n.js before the old window was removed (#291); the desktop engine does not serve it. */
/**
 * The words the app says, in one place. English is the source of truth; another language file only
 * has to answer the same keys. Anything without a translation falls back to English, so a partly
 * translated file never leaves a blank on the screen.
 *
 * The words come from two files per language, merged: the window's own (public/locales, copied into the
 * app at build time, so a word the window already has is the same word here) and the phone's own
 * (web/phone-locales, the words only the phone apps say). The language is the one the owner's Branch
 * uses (GET /api/look "language"), or this phone's own language while that says "auto" or nothing is paired.
 */
export const LANGUAGES = [
  { id: "en", label: "English" },
  { id: "fr", label: "Français" },
  { id: "es", label: "Español" },
  { id: "de", label: "Deutsch" },
];
let dictionary = {};
let english = {};
let current = "en";

async function file(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`No words on file at ${path}`);
  return response.json();
}
/** The window's words and the phone's own for one language, the phone's winning where both have a key. */
async function load(language) {
  const [window, own] = await Promise.all([file(`/locales/${language}.json`).catch(() => ({})), file(`/phone-locales/${language}.json`).catch(() => ({}))]);
  const words = { ...window, ...own };
  if (!Object.keys(words).length) throw new Error(`No words on file for ${language}`);
  return words;
}
/** The word for a key, with {name} places filled in. Missing keys fall back to English, then the key. */
export function t(key, values) {
  const raw = dictionary[key] ?? english[key] ?? key;
  return values
    ? raw.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole))
    : raw;
}
export const language = () => current;
export const speaks = (code) => LANGUAGES.some((l) => l.id === code);
/** This phone's own language, when it is one the app speaks. */
export const phoneLanguage = () => {
  const own = String(globalThis.navigator?.language ?? "en").slice(0, 2).toLowerCase();
  return speaks(own) ? own : "en";
};
/** Dates and numbers follow the chosen language, never a hand-rolled format. */
export const formatNumber = (value, options) => new Intl.NumberFormat(current, options).format(value);
export const formatDate = (value, options = { dateStyle: "medium", timeStyle: "short" }) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value ?? "") : new Intl.DateTimeFormat(current, options).format(date);
};
/** Writes every marked string on the page (or inside one node) in the language now chosen. */
export function applyLanguage(root = document) {
  for (const node of root.querySelectorAll("[data-t]")) {
    const words = t(node.dataset.t);
    if (node.textContent !== words) node.textContent = words;
  }
  const attributes = { tLabel: "aria-label", tPlaceholder: "placeholder", tTitle: "title" };
  for (const [dataKey, attribute] of Object.entries(attributes))
    for (const node of root.querySelectorAll(`[data-${dataKey.replace(/([A-Z])/g, "-$1").toLowerCase()}]`)) {
      const words = t(node.dataset[dataKey]);
      if (node.getAttribute(attribute) !== words) node.setAttribute(attribute, words);
    }
  document.documentElement.lang = current;
}
let applied = null;
/** Switches language and redraws the marked words; the screens draw again on the "branch-language" event. */
export async function setLanguage(next) {
  const chosen = speaks(next) ? next : "en";
  if (applied === chosen) return chosen;
  dictionary = chosen === "en" ? english : await load(chosen).catch(() => ({}));
  current = chosen;
  /* A language whose words never arrived is not applied, so asking for it again tries again. */
  applied = chosen === "en" || Object.keys(dictionary).length > 0 ? chosen : null;
  applyLanguage();
  document.dispatchEvent(new CustomEvent("branch-language", { detail: { language: chosen } }));
  return chosen;
}
/** Loads English once, then the phone's own language until the paired Branch says which one it uses. */
export async function initLanguage() {
  english = await load("en").catch(() => ({}));
  dictionary = english;
  applied = null;
  return setLanguage(phoneLanguage());
}
/** The language the owner's Branch uses ("auto" follows this phone). */
export const followLook = (look) => setLanguage(speaks(look?.language) ? look.language : phoneLanguage());
