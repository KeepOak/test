/**
 * R17-F: the "Learning, deeper" cards, opened the way a person opens them, at 400 px wide, in a
 * headless browser against a scratch workspace. Every word is behind a key with real French, and
 * every control has a label and a description.
 *
 * Redesign: the old cards (public/learning-more.js, in Library › Memory) are replaced by prototype.html's rows: at
 * Advanced, Library › Memory › "How it learns" has "What it learned, week by week" (the engine's timeline, GET
 * /api/learning-more/journey; public/app/places/library17.js), and Customize › Tools › Skills › "Keeping skills in shape"
 * has "Retire skills nobody uses" (GET /api/learning-more/curator; public/app/places/customize17.js). Each row opens a
 * dialog of the engine's own list. What went with the old cards: a switch card per part, the opt-in to learn from
 * Claude Code and Codex sessions, the provider, meaning search, expiry and read-back cards; the prototype draws none.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { newWindow, openPlace, openSettings } from "./new-window-places.mjs";
import { setLevel } from "./settings-window.mjs";

const PUBLIC = new URL("../public/", import.meta.url);

test("every word on the learning cards has English and real French, and the script is loaded", async () => {
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  const source = await readFile(new URL("app/places/library17.js", PUBLIC), "utf8");
  const keys = [...new Set([...source.matchAll(/\bt\("([A-Za-z0-9_.-]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length > 40);
  // The same words in French on purpose: "{documents} documents · {chunks} passages".
  const cognates = new Set(["window.places.library17.documents-documents-chunks-passages"]);
  assert.deepEqual(keys.filter((key) => !en[key] || !fr[key] || (en[key] === fr[key] && !cognates.has(key))), []);
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(source), false, "no colour is written down");
  // Loaded by the place that draws Library (public/app/places/library.js imports it).
  assert.match(await readFile(new URL("app/places/library.js", PUBLIC), "utf8"), /from "\.\/library17\.js"/);
});

test("the rows sit in their homes, open the engine's own lists once switched on, and nothing scrolls sideways", async (t) => {
  const { page, errors, call } = await newWindow(t, { width: 400, height: 900, seed: (branch) => {
    for (const part of ["journey", "curator"]) branch.learningMore.setMode(part, { mode: "on" });
    branch.store.save("memory", branch.runtime.owner, "oak", { text: "The owner keeps an oak by the gate", source: "owner" });
    branch.store.skills.install(branch.runtime.owner, { document: "---\nname: tidy-notes\ndescription: Tidies notes.\n---\nTidy the notes.\n" });
  } });
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  const dialogOf = (title) => page.locator(".dlg").filter({ hasText: title }).first();

  await openSettings(page);
  await setLevel(page, "advanced");
  await page.locator(".set-nav .set-back").click(); // back to the conversation, where the side list opens as usual

  // Library › Memory › How it learns › What it learned, week by week: the engine's timeline.
  const library = await openPlace(page, "library", "memory");
  await library.locator('[data-k="learnlog"]').click();
  const timeline = dialogOf("What it learned, week by week");
  await timeline.waitFor({ timeout: 20000 });
  const { entries } = await call("/api/learning-more/journey?limit=50");
  assert.ok(entries.length >= 1, "the engine has the fact on its timeline");
  await page.waitForFunction((n) => document.querySelectorAll(".dlg .demo-b17 .prow").length === n, entries.length, { timeout: 20000 });
  assert.equal(await timeline.locator(".demo-b17 .prow", { hasText: "The owner keeps an oak by the gate" }).count(), 1, "the fact, in the engine's words");
  assert.equal(await wide(), false, "no sideways scrolling with the timeline open");
  await timeline.locator('[data-act="dlg-close"]').last().click();

  // Customize › Tools › Skills › Retire skills nobody uses: the engine's look back.
  const customize = await openPlace(page, "customize", "tools");
  await customize.locator('[data-act="t9-kind"][data-v="skills"]').click();
  await customize.locator('[data-k="curator"]').click();
  const curator = dialogOf("Retire skills nobody uses");
  await curator.waitFor({ timeout: 20000 });
  const view = await call("/api/learning-more/curator");
  if (view.note) assert.ok((await curator.innerText()).includes(view.note), "the engine's own note leads the dialog");
  assert.ok(view.skills.some((s) => s.name === "tidy-notes"), "the engine looked at the skill");
  assert.equal(await curator.locator(".demo-b17 .prow").count(), view.skills.length, "one row for each skill it looked at");
  assert.match(await curator.locator(".demo-b17 .prow", { hasText: "tidy-notes" }).innerText(), /tidy-notes/);
  assert.equal(await wide(), false, "no sideways scrolling in Customize");
  assert.deepEqual(errors, []);
});
