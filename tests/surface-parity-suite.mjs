import nodeTest from "node:test";
/* This file is split into parts so the build machines can run its minutes side by side: each
   tests/surface-parity-N.test.mjs runs every 3th test declared here, starting from its own. Nothing is
   skipped: the parts together declare every test, in the same order, with the same body. */
const part = globalThis.branchTestPart ?? { index: 0, of: 1 };
let declared = 0;
const test = (...args) => (declared++ % part.of === part.index ? nodeTest(...args) : undefined);
import assert from "node:assert/strict";
import { settingsWindow, openSettingsPage } from "./settings-window.mjs";

/* Redesign: the new window wears a catalogue theme as the prototype's thirteen colours (public/app/shell/look.js
   themeEF), and its opaque surface is the window's own background, --bg, which every place and Settings page sits on
   (.main). The theme is picked the way a person picks one: Settings › Appearance, Light or dark, More contrast, then a
   card in the theme gallery (data-act="skins", then data-act="skin"). */

// Grown-Up fullTokens' opaque surface: 4.5% toward text at night, 62% toward white by day.
// Compute the approved oracle independently, rather than calling the product's mixC() helper.
function expectedSurface(ground, text, mode) {
  const amount = mode === "dark" ? 0.045 : 0.62;
  const toward = mode === "dark" ? text : "#ffffff";
  const channels = [1, 3, 5].map((offset) => {
    const from = Number.parseInt(ground.slice(offset, offset + 2), 16);
    return Math.round(from * (1 - amount) + Number.parseInt(toward.slice(offset, offset + 2), 16) * amount);
  });
  return `rgb(${channels.join(", ")})`;
}
const rgbOf = (hex) => `rgb(${[1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(", ")})`;

for (const width of [1440, 860, 400]) {
  test(`DG-168 all themes share the approved opaque surface at ${width}px`, async (t) => {
    const { page, errors } = await settingsWindow(t, { name: "surface", width, height: 950 });
    await openSettingsPage(page, "appearance");
    await page.locator('.set-col [data-act="skins"]').waitFor();
    const catalogue = await page.evaluate(async () => {
      const { THEMES, TOKEN_NAMES } = await import("/theme-catalogue.js");
      return { themes: THEMES.map(([id, , , sides]) => [id, sides]), tokens: TOKEN_NAMES };
    });
    // Branch Slate is the window's own colours (look.js BASE), so it wears nothing from the catalogue.
    const themes = catalogue.themes.filter(([id]) => id !== "slate");
    assert.ok(catalogue.themes.length >= 44, "the real theme catalogue loaded");
    const at = (side, name) => side[catalogue.tokens.indexOf(name)];
    // With a picture behind the glass the window is see-through on purpose (the prototype's .app.has-bg); with none, the
    // surface is opaque, so the background is set to None the way a person does it.
    await page.locator('.set-col [data-act="bgset"][data-v="none"]').click();
    await page.waitForFunction(() => !document.getElementById("app").classList.contains("has-bg"));
    for (const mode of ["dark", "light"]) {
      await page.locator(`.set-col [data-act="themeset"][data-v="${mode}"]`).click();
      await page.waitForFunction((value) => document.documentElement.dataset.theme === value, mode);
      for (const contrast of [false, true]) {
        const box = page.locator(".set-col #a-contrast");
        if ((await box.isChecked()) !== contrast) await box.click();
        await page.waitForFunction((on) => document.documentElement.classList.contains("contrast17") === on, contrast);
        await page.locator('.set-col [data-act="skins"]').click();
        await page.locator('.dlg [data-act="skin"]').first().waitFor();
        for (const [id, sides] of themes) {
          // Dispatch through the gallery's own card; do not write the surface or call applyLook.
          await page.evaluate((family) => document.querySelector(`.dlg [data-act="skin"][data-v="${family}"]`).click(), id);
          await page.waitForFunction((family) => document.documentElement.dataset.palette === family, id);
          const seen = await page.evaluate(() => ({
            surface: document.documentElement.style.getPropertyValue("--bg").trim(),
            main: getComputedStyle(document.getElementById("main")).backgroundColor,
          }));
          const side = sides[mode + (contrast ? "-more" : "")] ?? sides[mode];
          const expected = expectedSurface(at(side, "--ground"), at(side, "--text"), mode);
          assert.equal(rgbOf(seen.surface), expected, `${id}/${mode}/${contrast}: shared token`);
          assert.equal(seen.main, expected, `${id}/${mode}/${contrast}: the real surface the window sits on`);
        }
        await page.keyboard.press("Escape");
        await page.locator('.dlg [data-act="skin"]').first().waitFor({ state: "detached" });
      }
    }
    assert.deepEqual(errors, []);
  });
}
