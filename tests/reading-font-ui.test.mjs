/* UP-UI-060 / UI-260: Settings › Appearance › Reading font puts an installed reading face in front of the theme's own
   font stack (so missing letters still come from the theme), is kept by the engine, and "Theme's font" takes it off.
   A headless window on a temporary Branch. Mutation: drop applyReadingFont from shell/look.js savePrefs: red. */
import test from "node:test";
import assert from "node:assert/strict";
import { openSettingsPage, settingsWindow } from "./settings-window.mjs";

const sans = (page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--sans").trim());
async function choose(page, words) {
  await page.locator("#reading-font").click();
  await page.locator('.gsel-pop [role="option"]', { hasText: words }).click();
}

test("UP-UI-060: a reading font goes in front of the theme's fonts, is kept, and can be taken off", { timeout: 180000 }, async (t) => {
  const { page, errors, call } = await settingsWindow(t, { name: "reading-font" });
  await openSettingsPage(page, "appearance");
  const theme = await sans(page);
  assert.equal(await page.locator("#reading-font").getAttribute("aria-disabled"), null, "the choice is live, not greyed");
  await choose(page, "Lexend");
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--sans").trim().startsWith('"Lexend"'));
  assert.equal(await sans(page), `"Lexend", ${theme}`, "the theme's stack stays behind it for missing letters");
  assert.equal((await call("/api/state")).preferences.readingFont, "Lexend");
  await page.reload();
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--sans").trim().startsWith('"Lexend"'), null, { timeout: 60000 });
  await openSettingsPage(page, "appearance");
  await choose(page, "Theme's font");
  await page.waitForFunction((was) => getComputedStyle(document.documentElement).getPropertyValue("--sans").trim() === was, theme);
  assert.equal((await call("/api/state")).preferences.readingFont, null);
  assert.deepEqual(errors, []);
});
