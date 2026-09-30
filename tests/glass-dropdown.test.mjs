/* UI-100: every dropdown in the window is its own glass list (public/app/core/gsel.js), never the system's select with
   its blue highlight. The list is the window's popover: the choice in use is ticked, the arrows move through it, Escape
   closes it and hands the keyboard back, a pick saves as the select's change did, and a long list (time zones) narrows
   as you type, above the dialog it was opened from.
   Headless, one window, no sleeps.
   Mutation: in core/gsel.js pick(), drop the dispatched "change" and the language stays English; drop the narrowing box
   (LONG = Infinity) and the time-zone half goes red; drop `.pop.gsel-pop{z-index:80}` and the list opens under the
   profile dialog (the pick's click lands on the dialog). */
import test from "node:test";
import assert from "node:assert/strict";
import { newWindow } from "./new-window-places.mjs";
import { openSettingsPage } from "./settings-window.mjs";
import { gselChoices } from "./gsel.mjs";
import { waitInPage } from "./wait-in-page.mjs";

test("dropdowns are the window's glass list: ticked, keyboard, saves, narrows, above dialogs; no native select", async (t) => {
  const { page, call, errors } = await newWindow(t, { width: 1280, height: 900 });
  const selects = () => page.evaluate(() => document.querySelectorAll("select").length);

  await openSettingsPage(page, "appearance");
  const lang = page.locator("#lang");
  await lang.waitFor();
  assert.equal(await selects(), 0, "no system select on Appearance");
  // UP-UI-058: a selection control, as a screen reader should hear it (Hermes searchable-select, MIT, adapted).
  assert.equal(await lang.getAttribute("role"), "combobox");
  assert.equal(await lang.getAttribute("aria-haspopup"), "listbox");
  assert.equal(await lang.getAttribute("aria-controls"), "gsel-options");
  assert.equal(await lang.evaluate((el) => el.value), "en");

  // Open: the popover lists every language, English ticked and focused.
  await lang.click();
  const list = page.locator(".gsel-pop");
  await list.waitFor();
  assert.equal(await lang.getAttribute("aria-expanded"), "true");
  assert.equal(await list.locator('#gsel-options[role="listbox"]').count(), 1, "the list it controls is a named listbox");
  const items = list.locator('[role="option"]');
  assert.equal(await items.count(), (await gselChoices(lang)).length);
  assert.equal(await list.locator('[aria-selected="true"]').innerText(), "English");
  assert.equal(await list.locator('[aria-selected="true"]').count(), 1, "one choice is selected");
  assert.ok(await list.locator('[aria-selected="true"]').evaluate((el) => el === document.activeElement), "the choice in use has the keyboard");
  await page.keyboard.press("ArrowDown");
  assert.ok(await items.nth(1).evaluate((el) => el === document.activeElement), "ArrowDown moves to the next choice");
  await page.keyboard.press("Escape");
  await list.waitFor({ state: "detached" });
  assert.ok(await lang.evaluate((el) => el === document.activeElement), "Escape hands the keyboard back");

  // Pick French: the window and the engine both switch, as the select's change did.
  await lang.click();
  await list.locator('[role="option"]', { hasText: "Français" }).click();
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  assert.equal((await call("/api/look")).language, "fr", "the engine keeps the choice");
  await page.locator("#lang").click();
  await page.locator(".gsel-pop").waitFor();
  await page.locator('.gsel-pop [role="option"]', { hasText: "English" }).click();
  await page.waitForFunction(() => document.documentElement.lang === "en");

  // Your profile's time zone: a long list over a dialog, narrowed by typing, saved by the engine.
  await page.locator(".set-back").click(); // Settings stands in for the list; back to it for the owner's menu
  await page.locator('#side [data-act="owner"]').click();
  await page.locator('.pop [data-act="yp-open"]').click();
  const zone = page.locator(".dlg #yp-tz");
  await zone.waitFor();
  assert.equal(await selects(), 0, "no system select in Your profile");
  await zone.click();
  const narrow = page.locator(".gsel-pop .gsel-q input");
  await narrow.waitFor();
  assert.ok(await narrow.evaluate((el) => el === document.activeElement), "the narrowing box has the keyboard");
  assert.equal(await narrow.getAttribute("role"), "combobox", "the narrowing box is a combobox");
  assert.equal(await narrow.getAttribute("aria-controls"), "gsel-options", "that controls the listbox it narrows");
  await narrow.fill("tokyo");
  const shown = page.locator('.gsel-pop [role="option"]:not([hidden])');
  assert.deepEqual(await shown.allInnerTexts(), ["Asia/Tokyo"]);
  const onTop = await page.evaluate(() => { const r = document.querySelector('.gsel-pop [role="option"]:not([hidden])').getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".gsel-pop") !== null; });
  assert.ok(onTop, "the list is drawn above the dialog it came from");
  await page.keyboard.press("Enter");
  await page.locator(".gsel-pop").waitFor({ state: "detached" });
  assert.equal(await zone.evaluate((el) => el.value), "Asia/Tokyo");
  await waitInPage(page, async () => {
    const [{ api }, { profilePath }] = await Promise.all([import("/app/core/api.js"), import("/app/core/faces.js")]);
    return (await api(profilePath(null, "about"))).timezone === "Asia/Tokyo";
  }, null, { polling: 100 });
  assert.ok(await page.locator(".dlg").isVisible(), "the dialog stays open after a pick");
  assert.deepEqual(errors, []);
});
