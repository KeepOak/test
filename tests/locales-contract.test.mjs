import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { LANGUAGES } from "../public/i18n.js";

const localeUrl = (name) => new URL(`../public/locales/${name}.json`, import.meta.url);

async function readLocale(name) {
  const raw = await readFile(localeUrl(name), "utf8");
  const keys = [...raw.matchAll(/^  "((?:\\.|[^"\\])+)":/gm)].map((match) => JSON.parse(`"${match[1]}"`));
  assert.equal(new Set(keys).size, keys.length, `${name}.json has no duplicate keys hidden by JSON parsing`);
  return JSON.parse(raw);
}

const placeholders = (words) => [...words.matchAll(/\{[A-Za-z][A-Za-z0-9_.-]*\}/g)].map((match) => match[0]).sort();
/* Every language the window offers (public/i18n.js LANGUAGES), so a new one is checked the day it is listed. */
const others = LANGUAGES.filter((l) => l.id !== "en");

test("the window lists English first and at least one other language", () => {
  assert.equal(LANGUAGES[0]?.id, "en");
  assert.ok(others.length >= 1);
  assert.equal(new Set(LANGUAGES.map((l) => l.id)).size, LANGUAGES.length, "no language is listed twice");
});

for (const { id, draft } of others) {
  test(`${id}.json is valid, unique and keeps the same interpolation contract`, async () => {
    const [english, other] = await Promise.all([readLocale("en"), readLocale(id)]);
    for (const [key, words] of Object.entries(english)) {
      assert.equal(typeof other[key], "string", `${key} has ${id} words`);
      assert.ok(words.length > 0 && other[key].length > 0, `${key} is not blank`);
      assert.equal(placeholders(other[key]).length, placeholders(words).length, `${key} keeps its placeholder count`);
    }
  });
  /* A finished (not draft) language answers exactly English's keys, in English's order, with the very same {places}. */
  if (!draft) test(`${id}.json, a finished language, has exactly English's keys in English's order and the same {places}`, async () => {
    const [english, other] = await Promise.all([readLocale("en"), readLocale(id)]);
    assert.deepEqual(Object.keys(other), Object.keys(english));
    const moved = Object.keys(english).filter((key) => placeholders(other[key]).join() !== placeholders(english[key]).join());
    assert.deepEqual(moved, [], "every {place} keeps its English name");
  });
}
