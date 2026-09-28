/* UI-091: Settings search reaches every switch, not only page names, and so does Ctrl K. The index is read from the
   pages' own drawings (public/app/settings/find.js) at every "How much to show" level and every Models tab, so a row is
   found with its page, card and least level; a found row opens its page (and tab) at a level that shows it, scrolled to
   and marked. Building the index draws only: it asks nothing of the engine and leaves the level as it was.
   Headless, one window, no sleeps.
   Mutation: in public/app/settings/find.js buildIndex, draw only at the current level (drop the S.level loop) and the
   Advanced row is not found; drop the Models tabs in settings.js indexPages and "Make short videos" is not found; drop
   `S.level = was` and the level check goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { settingsWindow, openSettingsPage } from "./settings-window.mjs";

const hits = (page) => page.locator(".set-found .set-hit b").allTextContents();

test("Settings search finds every row, with its page and level, and opens it marked; Ctrl K finds rows too", async (t) => {
  const { page, errors } = await settingsWindow(t, { name: "settings-search-rows" });
  await openSettingsPage(page, "appearance");
  const box = page.locator("#set-q");

  // A row two levels down (General › "Vim keys in the message box" is Advanced), from Regular.
  await box.fill("vim keys");
  await page.locator(".set-found .set-hit", { hasText: "Vim keys in the message box" }).waitFor({ timeout: 20000 });
  const vim = page.locator(".set-found .set-hit", { hasText: "Vim keys in the message box" });
  assert.match(await vim.locator("small").textContent(), /^General/, "the row says where it lives");
  assert.equal((await vim.locator(".pill").textContent()).trim(), "Advanced", "and that it is shown from Advanced");
  assert.equal(await page.locator('.set-nav [data-act="setpage"][data-v="general"]').count(), 1, "its page stays in the list");
  await vim.click();
  await page.locator('[data-act="setlevel"][data-v="advanced"][aria-pressed="true"]').waitFor();
  await page.locator('[data-act="setpage"][data-v="general"][aria-current="true"]').waitFor();
  const marked = page.locator(".set-col .ctl.found18");
  await marked.waitFor();
  assert.equal((await marked.locator(":scope > b").textContent()).trim(), "Vim keys in the message box");
  assert.ok(await marked.evaluate((row) => { const r = row.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), "the row is in view");
  assert.equal(await box.inputValue(), "", "the search is done");

  // Other words for the same thing: "dark mode" finds the theme rows.
  await box.fill("dark mode");
  await page.locator(".set-found .set-hit").first().waitFor();
  assert.ok((await page.locator(".set-found .set-hit small").allTextContents()).some((where) => where.startsWith("Appearance")), `dark mode finds Appearance (${await hits(page)})`);

  // A row on another Models tab opens that tab.
  await box.fill("make short videos");
  await page.locator(".set-found .set-hit", { hasText: "Make short videos" }).first().click();
  await page.locator('.set-col [data-act="mtab"][data-v="media"][aria-selected="true"]').waitFor();
  await page.locator(".set-col .ctl.found18", { hasText: "Make short videos" }).waitFor();

  // Nothing found says so, and Enter opens the best row.
  await box.fill("zzqx nothing like this");
  await page.locator(".set-col .set-none").waitFor();
  await box.fill("summarise older turns");
  await page.locator(".set-found .set-hit").first().waitFor();
  await box.press("Enter");
  await page.locator(".set-col .ctl.found18", { hasText: "Summarise older turns by themselves" }).waitFor();

  // Building the index only draws: no request to the engine, and the level is left as it was.
  const quiet = await page.evaluate(async () => {
    const settings = await import("/app/settings/settings.js");
    const { S } = await import("/app/core/state.js");
    const asked = [], real = window.fetch;
    window.fetch = (...args) => { asked.push(String(args[0])); return real(...args); };
    const before = S.level;
    try { return { rows: settings.findSettings("a").length, asked, kept: S.level === before }; } finally { window.fetch = real; }
  });
  assert.ok(quiet.rows > 150, `the index has every row (${quiet.rows} match "a")`);
  assert.deepEqual(quiet.asked, [], "no request while the index is built");
  assert.ok(quiet.kept, "the level is put back");

  // Ctrl K finds a row and opens it the same way.
  await page.keyboard.press("Escape");
  await page.keyboard.press("ControlOrMeta+k");
  await page.locator("#pal-in").fill("repair the history");
  const option = page.locator('#pal-list [data-act="pal"]', { hasText: "Repair the history before each call" });
  await option.waitFor();
  await option.click();
  await page.locator('[data-act="setlevel"][data-v="technical"][aria-pressed="true"]').waitFor();
  await page.locator(".set-col .ctl.found18", { hasText: "Repair the history before each call" }).waitFor();

  // Every row drawn on every page (and Models tab) at Technical is found on its page, read at the same moment.
  const pages = await page.locator('.set-nav [data-act="setpage"]').evaluateAll((all) => all.map((b) => b.dataset.v));
  const missing = [];
  for (const id of pages) {
    await openSettingsPage(page, id);
    const tabs = id === "models" ? await page.locator('.set-col [data-act="mtab"]').evaluateAll((all) => all.map((b) => b.dataset.v)) : [""];
    for (const tab of tabs) {
      if (tab) await page.locator(`.set-col [data-act="mtab"][data-v="${tab}"]`).click();
      missing.push(...await page.evaluate(async (id) => {
        const { findSettings } = await import("/app/settings/settings.js");
        const { ROWS, rowKey } = await import("/app/settings/find.js");
        return [...document.querySelectorAll(`.set-col :is(${ROWS})`)].filter((row) => row.getClientRects().length).flatMap((row) => {
          const [card, title] = rowKey(row).split("\u001f");
          if (!title) return []; // a row with no title of its own has nothing to be found by
          return findSettings(title).some((r) => r.page === id && r.title === title && r.card === card) ? [] : [`${id} › ${card} › ${title}`];
        });
      }, id));
    }
  }
  assert.deepEqual(missing, [], "every drawn row is in the index");
  assert.deepEqual(errors, []);
});
