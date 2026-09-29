/* UI-224: the system's high-contrast mode (forced-colors) is respected. In it the system draws every background in its
   own colours, so what the window says with a background alone is said again in system colours
   (public/app/styles/forced-colors.css): a switch on differs from one off, the choice pressed and the page you are on
   stand out from the rest, a dialog and a menu keep an edge, the keyboard's stop is ringed, and a status dot shows.
   Mutation: remove the forced-colors.css link from public/index.html and every check goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { settingsWindow, setLevel } from "./settings-window.mjs";

test("in the system's high-contrast mode, state is still told apart", async (t) => {
  const { page, errors } = await settingsWindow(t, { name: "forced-colors" });
  await page.emulateMedia({ forcedColors: "active" });
  await page.getByRole("button", { name: "Settings", exact: true }).first().click();
  await page.locator(".settings").waitFor();
  await setLevel(page, "advanced");
  await page.locator('[data-act="setpage"][data-v="appearance"]').first().click();
  await page.locator("#a-still").waitFor();

  const look = (sel) => page.locator(sel).first().evaluate((el) => { const s = getComputedStyle(el); return { bg: s.backgroundColor, color: s.color, border: s.borderTopWidth + " " + s.borderTopStyle, outline: s.outlineStyle }; });
  const knob = (sel) => page.locator(sel).first().evaluate((el) => getComputedStyle(el, "::after").backgroundColor);

  // A switch: off and on look different, and the knob is drawn.
  const off = await look("#a-still");
  await page.locator("#a-still").check();
  const on = await look("#a-still");
  assert.notEqual(on.bg, off.bg, "a switch on is not drawn like one off");
  assert.notEqual(await knob("#a-still"), "rgba(0, 0, 0, 0)", "its knob shows");

  // The page you are on, and the level pressed, stand out from the ones beside them.
  const here = await look('.set-nav [data-act="setpage"][aria-current="true"]');
  const other = await look('.set-nav [data-act="setpage"]:not([aria-current="true"])');
  assert.notEqual(here.bg, other.bg, "the page you are on stands out");
  assert.notEqual((await look('[data-act="setlevel"][aria-pressed="true"]')).bg, (await look('[data-act="setlevel"][aria-pressed="false"]')).bg, "the level pressed stands out");

  // A status dot shows, and the keyboard's stop is ringed.
  assert.notEqual((await look(".dot")).bg, "rgba(0, 0, 0, 0)", "a status dot shows");
  await page.locator("#set-q").focus();
  await page.keyboard.press("Tab");
  assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "none", "the keyboard's stop is ringed");

  // A menu keeps an edge.
  await page.locator('[data-act="setlevel"][data-v="regular"]').click();
  await page.locator(".set-back").click();
  await page.locator('#side [data-act="owner"]').click();
  await page.locator(".pop").waitFor();
  assert.equal((await look(".pop")).border, "1px solid", "a menu keeps its edge");
  assert.deepEqual(errors, []);
});
