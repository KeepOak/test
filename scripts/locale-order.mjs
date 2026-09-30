// The window's four locale files (public/locales/<lang>.json), kept in one order: every key on its own line, sorted
// by key (plain code-unit order, the same on every machine). Parallel pull requests used to append their keys at the
// end of all four files and conflict with each other every time; sorted, two new keys land in different places, and
// scripts/merge-json-keys.mjs merges key additions from both sides by itself.
//   node scripts/locale-order.mjs          sorts all four files in place
//   node scripts/locale-order.mjs --check  fails (exit 1) naming each file that is not in order
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCALE_FILES = ["en", "fr", "es", "de"].map((lang) => `public/locales/${lang}.json`);

/** A flat string table as the one text every locale file is kept in: "{", one sorted key per line, "}". */
export function localeText(table) {
  const entries = Object.entries(table).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, value] of entries) if (typeof value !== "string") throw new Error(`${key}: a locale value is always text`);
  return `{\n${entries.map(([key, value]) => `  ${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(",\n")}\n}\n`;
}

/** The files, of those given, whose text is not already in that order. */
export function unsorted(root, files = LOCALE_FILES) {
  return files.filter((file) => {
    const text = readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
    return text !== localeText(JSON.parse(text));
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  if (process.argv.includes("--check")) {
    const bad = unsorted(root);
    for (const file of bad) console.error(`${file} is not sorted by key: run node scripts/locale-order.mjs`);
    process.exit(bad.length ? 1 : 0);
  }
  for (const file of LOCALE_FILES) writeFileSync(join(root, file), localeText(JSON.parse(readFileSync(join(root, file), "utf8"))));
  console.log(`sorted ${LOCALE_FILES.length} locale files`);
}
