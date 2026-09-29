/* UI-033 / UI-202: the window tells the engine what it saw that earns an achievement (shell/notices.js), and the engine's
   own achievements say so (GET /api/delight/achievements): the theme worn, the oak's season behind the glass, Keep things
   still, a change of language, and every part Settings › Appearance can hide, hidden ("It's lonely over here"); and the
   old window's three, re-mapped: the tree at the foot of the list, turning the season yourself, and choosing Technical.
   Mutation: in public/app/main.js drop initNotices() and every case goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";
import { openSettingsPage } from "./settings-window.mjs";
import { pickGsel } from "./gsel.mjs";

const SEASON = ["winter", "winter", "spring", "spring", "spring", "summer", "summer", "summer", "autumn", "autumn", "autumn", "winter"][new Date().getMonth()];

test("what the window sees earns its achievements", async (t) => {
  const { page, call, errors } = await newWindow(t, { width: 1280, height: 900 });
  await call("/api/preferences", { appearance: "daylight" }); // the oak shows in Daylight; Moonlight (as shipped) shows the night grove
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const got = async (id) => !!(await call("/api/delight/achievements")).list?.find((a) => a.id === id)?.got; // the day it was earned
  const until = async (id) => { for (let i = 0; i < 60; i++) { if (await got(id)) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

  assert.ok(await until("noticed:theme:light:slate:1"), "Branch Slate by daylight: the theme worn");
  assert.ok(await until(`noticed:season:${SEASON}:1`), `the oak in ${SEASON}, behind the glass`);

  assert.ok(await until("noticed:flag:acorn-shown:1"), "Keeper of the tree: the tree at the foot of the list");
  await openSettingsPage(page, "appearance");
  const other = ["spring", "summer", "autumn", "winter"].find((v) => v !== SEASON);
  assert.equal(await got("noticed:flag:acorn-turned:1"), false, "not before the season is turned");
  await page.locator(`[data-act="season"][data-v="${other}"]`).first().click();
  assert.ok(await until("noticed:flag:acorn-turned:1"), "Turn of the season");
  await page.locator('[data-act="setlevel"][data-v="technical"]').click();
  assert.ok(await until("noticed:flag:everything:1"), "Everything, everywhere: Technical chosen");
  await page.locator("#a-still").check();
  assert.ok(await until("noticed:flag:still:1"), "Still life");

  for (const id of ["h-usage", "h-gateway", "h-pet", "h-projects", "h-notes", "h-statusbar"]) {
    const box = page.locator(`#${id}`);
    if (await box.count() && await box.isChecked()) { await box.uncheck(); await page.waitForTimeout(150); }
  }
  assert.ok(await until("noticed:flag:lonely:1"), "It's lonely over here");
  assert.equal(await got("noticed:flag:language:1"), false, "no language change yet");

  await pickGsel(page.locator("#lang"), "de");
  await page.waitForFunction(() => document.documentElement.lang === "de", null, { timeout: 30000 });
  assert.ok(await until("noticed:flag:language:1"), "Multilingual");
  assert.deepEqual(errors, []);
});
