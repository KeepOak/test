/* DG-076: the Settings nav's group headings ("General", "Your assistant", "Safety", "Care") are the prototype's
   (design/redesign/prototype.html pass 17, `.set-nav .grp`): 10.5px at weight 500 in the quiet text colour, slightly
   spaced, their words 17px below the page link above (21px below the search box for the first) and 5.6px above the one
   below, 10px in from the links' own edge, as the prototype renders them. On a phone the prototype folds them away with
   the rest of the nav, and so does the window. Headless. */
import test from "node:test";
import assert from "node:assert/strict";
import { openSettingsPage, settingsWindow } from "./settings-window.mjs";

async function settings(t, width) {
  const { page, errors } = await settingsWindow(t, { name: "nav-groups", width, height: 950 });
  errors.length = 0; // what failed before the key was given is the login page's business
  await openSettingsPage(page, "general");
  return { page, errors };
}

/** Light or dark, the way a person picks it: Settings › Appearance, then back to the page the headings are read on. */
async function wear(page, mode) {
  await openSettingsPage(page, "appearance");
  await page.locator(`.set-col [data-act="themeset"][data-v="${mode}"]`).click();
  await page.waitForFunction((value) => document.documentElement.dataset.theme === value, mode);
  await openSettingsPage(page, "general");
}

/** Each shown group heading: its type, its colour against the theme's quiet text, and where its words sit. */
const headings = (page) => page.evaluate(() => {
  const probe = document.createElement("i");
  probe.style.color = "var(--ink-3)";
  document.body.append(probe);
  const quiet = getComputedStyle(probe).color;
  probe.remove();
  return [...document.querySelectorAll(".settings .grp")].filter((el) => el.getClientRects().length).map((el) => {
    const style = getComputedStyle(el), words = document.createRange();
    words.selectNodeContents(el);
    const text = words.getBoundingClientRect(), above = el.previousElementSibling, below = el.nextElementSibling.getBoundingClientRect();
    return { name: el.textContent.trim(), size: style.fontSize, weight: style.fontWeight, line: style.lineHeight, tracking: style.letterSpacing,
      quiet: style.color === quiet, first: above.classList.contains("set-search"), above: text.top - above.getBoundingClientRect().bottom,
      below: below.top - text.bottom, indent: text.left - below.left };
  });
});

for (const width of [1440, 1024]) {
  test(`DG-076 at ${width} px the nav's group headings are the prototype's, in size, colour and spacing`, async (t) => {
    const { page, errors } = await settings(t, width);
    for (const mode of ["dark", "light"]) {
      await wear(page, mode);
      const seen = await headings(page);
      assert.deepEqual(seen.map((h) => h.name), ["General", "Your assistant", "Safety", "Care"], `${mode}: the group headings show`);
      for (const heading of seen) {
        const where = `${mode}, ${heading.name}`;
        assert.equal(heading.size, "10.5px", `${where}: 10.5px`);
        assert.equal(heading.weight, "500", `${where}: weight 500`);
        assert.equal(heading.line, "12.6px", `${where}: the prototype's line`);
        assert.equal(heading.tracking, "0.735px", `${where}: the prototype's letter spacing`);
        assert.equal(heading.quiet, true, `${where}: in the theme's quiet text colour`);
        const gap = heading.first ? 21 : 17;
        assert.ok(Math.abs(heading.above - gap) <= 0.5, `${where}: ${gap}px below what is above (${heading.above})`);
        assert.ok(Math.abs(heading.below - 5.59) <= 0.5, `${where}: 5.6px above the link below (${heading.below})`);
        assert.ok(Math.abs(heading.indent - 10) <= 0.5, `${where}: 10px in from the links' edge (${heading.indent})`);
      }
    }
    assert.deepEqual(errors, []);
  });
}

test("DG-076 on a phone the group headings fold away with the nav, as the prototype's do", async (t) => {
  const { page, errors } = await settings(t, 390);
  assert.deepEqual(await headings(page), [], "no group heading shows at 390 px");
  assert.ok(await page.locator(".settings .grp").count() >= 4, "they are there, folded away, not missing");
  assert.deepEqual(errors, []);
});
