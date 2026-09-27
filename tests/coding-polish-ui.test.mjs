/**
 * mac7/r17-d: the coding polish card, the task's checklist in the side pane, and the @ picker,
 * opened the way a person opens them, at 400 px wide, in a headless browser against a scratch
 * workspace. Every word is behind a key with real French.
 *
 * Redesign: the old card (public/coding.js, #coding-card in Settings › Advanced) is replaced by prototype.html's
 * Settings › Computer & browser, whose Code and "On a computer, more" sections (Advanced) hold the coding switches
 * "Check and format files after editing" and "Review checks and a checklist per task" (public/app/settings/pages/
 * computer.js, POST /api/coding/switch). What went with the old card: the CI lines to paste ("Branch in CI" is a greyed
 * "Copy the setup" at Technical), the file @ picker (the prototype's @ in the message box calls a Trunk, "Call a Trunk
 * in a message") and the checklist block in the side pane (the prototype has none). The switches are checked below.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { newWindow, openSettings } from "./new-window-places.mjs";
import { setLevel } from "./settings-window.mjs";

const PUBLIC = new URL("../public/", import.meta.url);

test("every word on the coding polish screens has English and real French, and no colour is written down", async () => {
  const source = await readFile(new URL("app/settings/pages/computer.js", PUBLIC), "utf8");
  const en = JSON.parse(await readFile(new URL("locales/en.json", PUBLIC), "utf8"));
  const fr = JSON.parse(await readFile(new URL("locales/fr.json", PUBLIC), "utf8"));
  const keys = [...new Set([...source.matchAll(/\bt\("([A-Za-z0-9_.-]+)"/g)].map((m) => m[1]))];
  assert.ok(keys.length > 30);
  // "Code" is the same word in French.
  assert.deepEqual(keys.filter((key) => !en[key] || !fr[key] || (en[key] === fr[key] && key !== "window.settings.computer.code")), []);
  /* The switches are written in English and put in the chosen language through the locale files (core/words.js say):
     each coding switch's words have a key, and that key has French of its own. */
  const byEnglish = new Map(Object.entries(en).map(([key, words]) => [words, key]));
  for (const words of ["Check and format files after editing", "Review checks and a checklist per task",
    "Checks you write run before a task says it’s done; the checklist shows in the task."]) {
    assert.ok(source.includes(`"${words}"`), `the page draws "${words}"`);
    const key = byEnglish.get(words);
    assert.ok(key && fr[key] && fr[key] !== words, `"${words}" has French of its own`);
  }
  assert.ok(en["commands.init"] && fr["commands.init"] && en["commands.init"] !== fr["commands.init"]);
  assert.equal(/#[0-9a-f]{3,8}\b|rgba?\(/i.test(source), false, "no colour is written down");
});

test("the coding switches sit in Settings › Computer & browser at Advanced, and each one really switches the engine", async (t) => {
  const { app, page, errors, call } = await newWindow(t, { width: 400, height: 900 });
  const wide = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  const modes = async () => (await call("/api/coding")).modes;
  const until = async (check, what) => {
    for (let i = 0; i < 100; i++) { if (check(await modes())) return; await page.waitForTimeout(50); }
    assert.fail(what);
  };

  await openSettings(page);
  await setLevel(page, "advanced");
  await page.locator('[data-act="setpage"][data-v="computer"]').first().click();
  const format = page.locator("#f15-check-and-format-files-after-editing");
  const review = page.locator("#f15-review-checks-and-a-checklist-per-task");
  await format.waitFor({ timeout: 20000 });
  assert.equal(app.coding.modes()["format-on-edit"], "when-needed", "it ships on when needed");
  await page.waitForFunction(() => document.getElementById("f15-check-and-format-files-after-editing")?.checked === true, null, { timeout: 20000 });

  await format.click();
  await until((m) => m["format-on-edit"] === "off", "format on edit was switched off in the engine");
  await page.waitForFunction(() => document.getElementById("f15-check-and-format-files-after-editing")?.checked === false, null, { timeout: 20000 });
  await page.locator("#f15-check-and-format-files-after-editing").click();
  await until((m) => m["format-on-edit"] === "when-needed", "and on again, when needed");

  await page.waitForFunction(() => document.getElementById("f15-review-checks-and-a-checklist-per-task")?.checked === true, null, { timeout: 20000 });
  await review.click();
  await until((m) => m["review-checks"] === "off" && m.checklist === "off", "review checks and the checklist were switched off together");
  await page.waitForFunction(() => document.getElementById("f15-review-checks-and-a-checklist-per-task")?.checked === false, null, { timeout: 20000 });
  await page.locator("#f15-review-checks-and-a-checklist-per-task").click();
  await until((m) => m["review-checks"] === "when-needed" && m.checklist === "when-needed", "and both on again");
  assert.equal(await wide(), false, "no sideways scrolling in Settings");
  assert.deepEqual(errors, []);
});
