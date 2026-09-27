import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { policyPresets } from "../dist/policy.js";
import { presetLinesFor, presetWords } from "../dist/terminal-commands.js";
import { loadWords, wordsFrom } from "../dist/terminal-words.js";

const locale = (id) => JSON.parse(readFileSync(new URL(`../public/locales/${id}.json`, import.meta.url), "utf8"));

/* CL-05d/f: the terminal and the command line name an approval preset by the window's keys. The English there must be
   exactly the engine's own (src/policy.ts), or an English terminal would say something else than the window does. */
test("every approval preset's name and description in en.json are the engine's own words", () => {
  const en = locale("en");
  for (const preset of policyPresets()) {
    assert.equal(en[`settings-kit.value.policy.preset.${preset.id}`], preset.label, `${preset.id} name`);
    assert.equal(en[`policy.preset.${preset.id}.description`], preset.description, `${preset.id} description`);
  }
  assert.equal(typeof en["settings-kit.value.policy.preset.custom"], "string", "the owner's own rules have a name too");
});

test("each preset is named and described in the language in force, and in English without words", () => {
  const presets = policyPresets();
  assert.deepEqual(presetLinesFor(presets, "off"), presets.map((p) => `${p.id === "off" ? "*" : " "} ${p.id} — ${p.label}: ${p.description}`));
  for (const id of ["de", "es", "fr"]) {
    const words = loadWords(id), dict = locale(id);
    const lines = presetLinesFor(presets, "read-only", words);
    for (const [at, preset] of presets.entries()) {
      const name = dict[`settings-kit.value.policy.preset.${preset.id}`], said = dict[`policy.preset.${preset.id}.description`];
      assert.notEqual(name, preset.label, `${id} has its own name for ${preset.id}`);
      assert.equal(lines[at], `${preset.id === "read-only" ? "*" : " "} ${preset.id} — ${name}: ${said}`);
    }
    assert.equal(presetWords({ id: "custom" }, words).label, dict["settings-kit.value.policy.preset.custom"]);
  }
  // A preset with no words on file keeps the engine's English rather than showing a key.
  const bare = wordsFrom("de", {}, {});
  assert.deepEqual(presetWords({ id: "off", label: "No approvals", description: "D" }, bare), { label: "No approvals", description: "D" });
});
