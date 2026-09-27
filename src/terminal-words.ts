import { readFileSync } from "node:fs";
import type { LookLanguage } from "./terminal-theme.js";

/**
 * The words the terminal says, from the same language files the window reads
 * (`public/locales/*.json`). English is the source of truth; every other language answers the same
 * keys and falls back to English wherever it does not, exactly as `public/i18n.js` does in the window.
 */
export type Language = LookLanguage;
export interface Words {
  language: Language;
  /** The word for a key, with {name} places filled in; the English given is the last fallback. */
  t(key: string, english: string, values?: Record<string, string | number>): string;
}
type Dictionary = Record<string, string>;

const cache = new Map<Language, Dictionary>();
/** One language file, read once. A missing or unreadable file is an empty dictionary. */
export function dictionary(language: Language): Dictionary {
  const known = cache.get(language);
  if (known) return known;
  let parsed: Dictionary = {};
  try {
    const raw = readFileSync(new URL(`../public/locales/${language}.json`, import.meta.url), "utf8");
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === "object") parsed = value as Dictionary;
  } catch { /* the English given in the code is the fallback */ }
  cache.set(language, parsed);
  return parsed;
}

const fill = (text: string, values?: Record<string, string | number>): string =>
  values ? text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in values ? String(values[name]) : whole)) : text;

/** The terminal's words in one language, built from two dictionaries so tests can hand in their own. */
export function wordsFrom(language: Language, chosen: Dictionary, english: Dictionary): Words {
  return {
    language,
    t: (key, fallback, values) => fill(chosen[key] ?? english[key] ?? fallback, values),
  };
}
export function loadWords(language: Language): Words {
  return wordsFrom(language, dictionary(language), dictionary("en"));
}
