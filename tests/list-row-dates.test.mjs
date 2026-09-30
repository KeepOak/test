/* UI-027: a list row's time says when, plainly: the hour today, the weekday within the last week, and past a week a
   date ("12 Sep"), with the year once it is another year's, in the window's language. A weekday alone was unclear
   past one week ("you say Saturday. I don't know what Saturday is").
   Mutation: in public/app/shell/shell.js when() drop the date branch and every older case goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";

test("list rows name the hour today, the weekday this week, and a date after that, in the window's language", async (t) => {
  const { page, errors } = await newWindow(t);
  const words = (lang) => page.evaluate(async (lang) => {
    await (await import("/i18n.js")).setLanguage(lang);
    const { when } = await import("/app/shell/shell.js");
    const now = new Date(2026, 8, 28, 15, 0); // Monday 28 Sept 2026, 15:00
    const at = (y, m, d, h = 9) => new Date(y, m, d, h, 30).toISOString();
    return { today: when(at(2026, 8, 28), now), yesterday: when(at(2026, 8, 27), now), sixDays: when(at(2026, 8, 22), now),
      eightDays: when(at(2026, 8, 20), now), lastYear: when(at(2025, 11, 30), now) };
  }, lang);
  const en = await words("en");
  assert.match(en.today, /9:30/);
  assert.equal(en.yesterday, "Sun");
  assert.equal(en.sixDays, "Tue", "within the week: the weekday");
  assert.equal(en.eightDays, "Sep 20", "past a week: the date");
  assert.equal(en.lastYear, "Dec 30, 2025", "another year's: with the year");
  const fr = await words("fr");
  assert.match(fr.eightDays, /^20 sept\.?$/, `French date (${fr.eightDays})`);
  assert.deepEqual(errors, []);
});
