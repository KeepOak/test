/* The window's own words follow its language everywhere a verify run found English left in German or Spanish:
   - a feature picture's hover words (core/art17.js ART17, "A cloud computer at work" on Settings › Computer);
   - the splash's "Waking your Trunks", drawn before the engine says the owner's language, is said again once it does;
   and a label never cut short: a chat app's card note ("Zwei Minuten zum Einrichten") wraps instead of an ellipsis.
   Mutation: drop say() in fillArt, the splash's language listener, or the card note's wrap, and this goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

test("feature pictures, the splash and chat-app notes speak the window's language, whole", async (t) => {
  const { page, errors } = await newWindow(t, { width: 1440, height: 900 });
  const got = await page.evaluate(async () => {
    const i18n = await import("/i18n.js");
    await i18n.setLanguage("de");
    const { fill17 } = await import("/app/core/art17.js");
    const box = document.createElement("div");
    box.innerHTML = '<span data-art17="art17-cloud"></span>';
    document.body.append(box);
    fill17(box);
    const title = box.querySelector(".art17e")?.title;
    // The splash, as a new browser draws it before the owner's language is known, then told the language.
    document.body.insertAdjacentHTML("beforeend", '<div class="splash11"><b>Waking your Trunks</b></div>');
    document.dispatchEvent(new CustomEvent("branch-language", { detail: { language: "de" } }));
    const splash = document.querySelector(".splash11 b").textContent;
    document.querySelector(".splash11").remove();
    box.remove();
    return { title, splash, cloud: i18n.t("window.core.art17.a-cloud-computer-at-work"), waking: i18n.t("window.shell.shell.waking") };
  });
  assert.equal(got.title, got.cloud, "the picture's hover words are German");
  assert.notEqual(got.title, "A cloud computer at work");
  assert.equal(got.splash, got.waking, "the splash says it again in German");
  // Customize › Chat apps: each card's note wraps rather than ending in "…".
  await page.evaluate(async () => {
    const [{ S }, { renderNow }] = await Promise.all([import("/app/core/state.js"), import("/app/core/dom.js")]);
    S.view = "customize"; S.tabs.customize = "channels"; renderNow();
  });
  const note = page.locator("#main .ch12 small").first();
  await note.waitFor();
  const cut = await note.evaluate((el) => ({ over: el.scrollWidth - el.clientWidth, style: getComputedStyle(el).textOverflow, space: getComputedStyle(el).whiteSpace }));
  assert.ok(cut.style !== "ellipsis" && cut.space !== "nowrap" && cut.over <= 1, `the note is whole (${JSON.stringify(cut)})`);
  assert.deepEqual(errors, []);
});
