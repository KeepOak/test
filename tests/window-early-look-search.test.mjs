/* Two window fixes (audits/ui.md). UP-UI-051: the look worn last is on the page before the window's own code has run, so
   nobody off Slate, or off the computer's light, sees a flash of the default first. UP-UI-050: Settings search and Ctrl K
   draw their index once per search, not once per key, and a row drawn hidden is never found.
   Mutation: drop keepEarly() from shell/look.js applyLook() (or the look-early.js script tag) and the first test goes red;
   call buildIndex() straight from findSettings() again and the second does. Headless only, 127.0.0.1. */
import test from "node:test";
import assert from "node:assert/strict";
import { settingsWindow, openSettingsPage } from "./settings-window.mjs";
import { waitInPage } from "./wait-in-page.mjs";

const THEME = "nocturne";
const lookNow = (page) => page.evaluate(() => ({
  theme: document.documentElement.dataset.theme ?? null, palette: document.documentElement.dataset.palette ?? null,
  bg: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim().toUpperCase(),
}));

test("the look worn last is on the page before the window's code runs, and Slate is kept too", async (t) => {
  const f = await settingsWindow(t, { name: "early-look" });
  await f.page.emulateMedia({ colorScheme: "light" });
  /* A catalogue theme in dark, on a computer in light: the combination that flashed Slate light first. */
  await waitInPage(f.page, async () => !!(await import("/app/shell/look.js")).L.cat); // the catalogue is read
  await f.page.evaluate(async (id) => {
    const { wear } = await import("/app/shell/look.js");
    const { run } = await import("/app/core/actions.js");
    const button = document.createElement("button");
    button.dataset.v = "dark";
    run("themeset", button);
    await wear(id);
  }, THEME);
  const worn = await lookNow(f.page);
  assert.equal(worn.theme, "dark");
  assert.equal(worn.palette, THEME);
  assert.notEqual(worn.bg, "#0F1418", "the theme's own colours, not Slate's");
  const kept = await f.page.evaluate(() => JSON.parse(localStorage.getItem("branch-look-early")));
  assert.equal(kept.vars.dark["--bg"].toUpperCase(), worn.bg, "the colours kept are the ones worn");

  /* Only look-early.js runs: the window's own code never loads, so what shows is what the head put on. */
  await f.page.route("**/app/main.js", (route) => route.abort());
  await f.page.reload();
  assert.deepEqual(await lookNow(f.page), worn, "the first paint wears the chosen look in the chosen light");

  /* The control: with nothing kept, the same page is Slate in the computer's light. */
  await f.page.evaluate(() => localStorage.removeItem("branch-look-early"));
  await f.page.reload();
  const bare = await lookNow(f.page);
  assert.equal(bare.theme, null);
  assert.equal(bare.palette, null);
  assert.notEqual(bare.bg, worn.bg);

  /* Back to Slate: kept without colours, so the old look is never painted first. */
  await f.page.unroute("**/app/main.js");
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await f.page.evaluate(async () => { const { wear } = await import("/app/shell/look.js"); await wear("slate"); });
  const slate = await f.page.evaluate(() => JSON.parse(localStorage.getItem("branch-look-early")));
  assert.equal(slate.palette, "slate");
  assert.equal(slate.vars, undefined);
  assert.deepEqual(f.errors, []);
});

const builds = (page) => page.evaluate(async () => (await import("/app/settings/find.js")).builds);
/* Until the pages the first search started have answered: the count of draws holds still for most of a second. */
async function settled(page) {
  for (let last = -1, end = Date.now() + 20000; Date.now() < end;) {
    const now = await builds(page);
    if (now === last) return;
    last = now;
    await page.waitForTimeout(800);
  }
}

test("Settings search and Ctrl K draw the index once per search, and a hidden row is never found", async (t) => {
  const f = await settingsWindow(t, { name: "search-once" });
  await openSettingsPage(f.page, "general");
  const box = f.page.locator("#set-q");
  await box.click();
  await f.page.keyboard.type("a");
  await settled(f.page); // the first search starts every page; their answers may redraw the index once
  let before = await builds(f.page);
  await f.page.keyboard.type("ppea");
  await f.page.locator(".set-found").waitFor();
  assert.ok(await builds(f.page) - before <= 1, `Settings search drew the index ${await builds(f.page) - before} times for four keys`);

  await box.fill("");
  await f.page.keyboard.press("ControlOrMeta+k");
  await f.page.locator("#pal-in").waitFor({ state: "visible" });
  await f.page.keyboard.type("t");
  await settled(f.page);
  before = await builds(f.page);
  await f.page.keyboard.type("heme");
  await f.page.waitForTimeout(500);
  assert.ok(await builds(f.page) - before <= 1, `Ctrl K drew the index ${await builds(f.page) - before} times for four keys`);
  await f.page.keyboard.press("Escape");

  /* Appearance draws its row of pet buttons hidden (the gallery's cards are what a person presses): not a search result. */
  const hits = await f.page.evaluate(async () => (await import("/app/settings/settings.js")).findSettings("pet").map((row) => `${row.card}|${row.title}`));
  assert.equal(hits.includes("The pet|Pet"), false, `the hidden pet row is not found: ${hits.join(", ")}`);
  assert.deepEqual(f.errors, []);
});
