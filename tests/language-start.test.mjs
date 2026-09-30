/* UP-UI-064: at first start the window speaks the computer's language when Branch has it, until the person chooses one. */
import test from "node:test";
import assert from "node:assert/strict";
import { initialLanguage } from "../public/i18n.js";

test("a first start follows the computer's languages in order, regional tags included, and a saved choice wins", () => {
  assert.equal(initialLanguage(null, ["fr-CA", "en-US"]), "fr", "fr-CA is French");
  assert.equal(initialLanguage(null, ["ja-JP", "de_AT", "fr"]), "de", "the first one on file, in the computer's order");
  assert.equal(initialLanguage(null, ["ja", "zh-Hans"]), "en", "none on file: English");
  assert.equal(initialLanguage(null, []), "en");
  assert.equal(initialLanguage("es", ["fr-FR"]), "es", "a saved choice comes first");
  assert.equal(initialLanguage("xx", ["DE-de"]), "de", "a saved language no longer on file falls through");
});
