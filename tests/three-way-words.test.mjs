/* DG-017: every three-way switch reads Off · When needed · On, in that order, as the approved sample drew each one. The
   saved values do not change, so nothing migrates. In the new window (design/redesign/prototype.html pass 17) the
   three-ways are the Settings pages' segmented choices that offer "when-needed". Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openSettingsPage, setLevel, settingsWindow } from "./settings-window.mjs";
import { watchSettled } from "./page-settled.mjs";

const WORDS = { en: ["Off", "When needed", "On"], fr: ["Désactivé", "Au besoin", "Activé"] };

/* Redesign: the old window drew one three-way per setting, by id, from the sample's inventory. The new window draws the
   prototype's Settings pages, where a setting that can be off, on when needed, or on is a segmented choice (".seg")
   offering "when-needed"; every other setting is an on/off switch. So every such choice on every Settings page, at the
   Technical level where the most is shown, is read the way a person meets it. */
async function everySwitch(t) {
  const { page, errors } = await settingsWindow(t, { name: "three-way" });
  errors.length = 0;
  // A page draws its choices once the engine has answered what it reads, so each page is read when nothing is in flight.
  page.settled = watchSettled(page);
  await openSettingsPage(page, "general");
  await setLevel(page, "technical");
  const pages = await page.locator('button.nav[data-act="setpage"]').evaluateAll((links) => links.map((link) => link.dataset.v));
  assert.ok(pages.length >= 15, `the Settings pages are listed (${pages.length})`);
  return { page, errors, pages };
}

/** Each three-way on the open page: the words in the order shown, and the value each one saves. */
const read = (page) => page.evaluate(() => [...document.querySelectorAll(".set-col .seg")]
  .filter((group) => group.querySelector('[data-v="when-needed"]'))
  .map((group) => {
    const shown = [...group.querySelectorAll("button")];
    return { name: group.getAttribute("aria-label") ?? "", words: shown.map((one) => one.textContent.trim()), values: shown.map((one) => one.dataset.v) };
  }));

test("DG-017 every three-way reads Off · When needed · On in that order, saving the same values, in English and French", async (t) => {
  const { page, errors, pages } = await everySwitch(t);
  for (const language of ["en", "fr"]) {
    if (language !== "en") await page.evaluate(async (code) => (await import("/i18n.js")).setLanguage(code), language);
    const seen = [];
    for (const id of pages) {
      await page.locator(`button.nav[data-act="setpage"][data-v="${id}"]`).click(); // the page list; a page may also link to another
      await page.locator(".set-col h1").first().waitFor();
      await page.settled();
      seen.push(...(await read(page)).map((one) => ({ page: id, ...one })));
    }
    // Today: the browser sandbox (Computer & browser); a new one on any page is read too. Gateway is one on/off switch
    // now (tests/grown-up-controls.test.mjs), and Team › Signing in's three-way is read in tests/three-way-segments.test.mjs.
    for (const home of ["computer"]) assert.ok(seen.some((one) => one.page === home), `${language}: the three-way on ${home} was found`);
    const wrong = seen.filter((one) => one.words.join(" · ") !== WORDS[language].join(" · ") || one.values.join(" ") !== "off when-needed on");
    assert.deepEqual(wrong, [], `${language}: ${wrong.length} of ${seen.length} switches read otherwise`);
  }
  assert.deepEqual(errors, []);
});

/* Words of the prototype's own that only look like an old position: "Join meetings from your calendar" (pass 17 part D,
   public/app/chat/calls17d.js) is a two-way choice, Only when I ask · Meetings I'm invited to, not a switch position. */
const NOT_A_POSITION = new Set(["window.p17d.only-when-ask"]);
test("DG-017 no words a person reads still name a position the switches no longer have", async () => {
  const old = /Only when it is needed|Only when needed|Only when unsure|Only when I ask for it|When I press Send|After tasks finish|Seulement si nécessaire|Seulement en cas de besoin|Seulement si besoin|Seulement en cas de doute|Seulement quand je le demande/;
  for (const file of ["en", "fr"]) {
    const words = JSON.parse(await readFile(new URL(`../public/locales/${file}.json`, import.meta.url), "utf8"));
    assert.deepEqual(Object.entries(words).filter(([key, value]) => old.test(value) && !NOT_A_POSITION.has(key)).map(([key]) => key), [], file);
  }
});
