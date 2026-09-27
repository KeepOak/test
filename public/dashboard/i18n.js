/* The dashboard's own copy of what was public/i18n.js before the old window was removed (#291), served at /dashboard/i18n.js. */
/**
 * The words the app says, in one place. English is the source of truth; another language file only
 * has to answer the same keys. Anything without a translation falls back to English, so a partly
 * translated file never leaves a blank on the screen.
 *
 * Markup carries its words in `data-t` (text) and `data-t-label`, `data-t-placeholder`,
 * `data-t-title`, `data-t-aria-description` (attributes), so applying a language is one pass over the page.
 */
const STORAGE = "branch-language";
export const LANGUAGES = [
  { id: "en", label: "English", draft: false },
  { id: "fr", label: "Français (machine draft)", draft: true },
  { id: "es", label: "Español", draft: false },
  { id: "de", label: "Deutsch", draft: false },
];
let dictionary = {};
let english = {};
let current = "en";

async function load(language) {
  const response = await fetch(`/locales/${language}.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`No words on file for ${language}`);
  return response.json();
}
/** The word for a key, with {name} places filled in. Missing keys fall back to English, then the key. */
export function t(key, values) {
  const raw = dictionary[key] ?? english[key] ?? key;
  return values
    ? raw.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole))
    : raw;
}
export const language = () => current;
let byEnglish = new Map();
/**
 * mac7/residuals: English words the locale files hold, in the chosen language; null in English or when no
 * key has exactly those words. For text that arrives in English (Settings search's index of every setting).
 */
export function fromEnglish(words) {
  if (current === "en" || !words) return null;
  if (!byEnglish.size) for (const [key, value] of Object.entries(english)) if (typeof value === "string" && !byEnglish.has(value)) byEnglish.set(value, key);
  const key = byEnglish.get(words);
  return key && typeof dictionary[key] === "string" ? dictionary[key] : null;
}
/** Dates and numbers follow the chosen language, never a hand-rolled format. */
export const formatNumber = (value, options) => new Intl.NumberFormat(current, options).format(value);
export const formatDate = (value, options = { dateStyle: "medium", timeStyle: "short" }) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(current, options).format(date);
};
/**
 * Writes every marked string on the page (or inside one node) in the language now chosen. Words that
 * already read right are left alone: writing the same words again still counts as a change to the
 * page, and every part of the window that watches for changes (Settings putting its cards in order,
 * among others) would wake and do its work again for nothing.
 */
export function applyLanguage(root = document) {
  for (const node of root.querySelectorAll("[data-t]")) {
    const words = t(node.dataset.t);
    if (node.textContent !== words) node.textContent = words;
  }
  // mac7/r17-g integration review: descriptions read aloud (aria-description) follow the language too.
  const attributes = { tLabel: "aria-label", tPlaceholder: "placeholder", tTitle: "title", tAriaDescription: "aria-description" };
  for (const [dataKey, attribute] of Object.entries(attributes))
    for (const node of root.querySelectorAll(`[data-${dataKey.replace(/([A-Z])/g, "-$1").toLowerCase()}]`)) {
      const words = t(node.dataset[dataKey]);
      if (node.getAttribute(attribute) !== words) node.setAttribute(attribute, words);
    }
  document.documentElement.lang = current;
}
/** Switches language, remembers the choice, and redraws the page's words. */
/**
 * The language whose words are on the page now, or null when none has been put there yet.
 *
 * Choosing the language already in force used to rewrite the page and announce a change anyway.
 * applyLanguage itself is careful — it leaves text that already says the right thing alone — but the
 * announcement is answered by listeners that throw whole cards away and build them again, so a change
 * to nothing cost 2504 mutations and took the keyboard, an open explanation and a half-filled field
 * with it. Nothing to do now means nothing done and nobody told.
 */
let applied = null;
export async function setLanguage(next) {
  const chosen = LANGUAGES.some((l) => l.id === next) ? next : "en";
  if (applied === chosen) return chosen;
  dictionary = chosen === "en" ? english : await load(chosen).catch(() => ({}));
  current = chosen;
  try { localStorage.setItem(STORAGE, chosen); } catch { /* a private window simply forgets */ }
  /* A language whose words never arrived is not applied, so asking for it again tries again rather
     than sitting silently on an empty dictionary. */
  applied = chosen === "en" || Object.keys(dictionary).length > 0 ? chosen : null;
  applyLanguage();
  document.dispatchEvent(new CustomEvent("branch-language", { detail: { language: chosen } }));
  return chosen;
}
/** Loads English once, then whatever language was last chosen. */
export async function initLanguage() {
  english = await load("en").catch(() => ({}));
  dictionary = english;
  /* Starting up applies from scratch: the page may be showing whatever the HTML shipped with, so the
     "already in force" guard above must not skip the first pass. */
  applied = null;
  let saved = "en";
  try { saved = localStorage.getItem(STORAGE) || "en"; } catch { /* default to English */ }
  return setLanguage(saved);
}
