/* DG-035/DG-036: Appearance has the approved sample's theme tools (design/Branch-Grown-Up.html, `.theme-tools`):
   a search over the themes' names with the real count in its placeholder, and one row of filter chips (All, each
   theme group Branch really has, Easy in daylight, High contrast). Typing and choosing narrow the tiles without
   false matches, a screen reader hears how many are left, and none matching says so. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openSettings } from "./places.mjs"; // the old window's helper, for the skipped bodies only
import { THEMES, TOKEN_NAMES } from "../public/theme-catalogue.js";

/* The sample's measure, worked out here from the catalogue itself rather than read back from the page. */
function contrast(theme, mode) {
  const token = (name) => theme[3][mode][TOKEN_NAMES.indexOf(name)];
  const light = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index], 0);
  const [a, b] = [light(token("--text")), light(token("--ground"))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function appearance(t, width = 1440) {
  const root = await mkdtemp(join(tmpdir(), "branch-theme-search-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  await openSettings(page, "appearance");
  await page.locator("#lx-theme-search").waitFor();
  return { page, errors };
}
const shownThemes = (page) => page.$$eval("#lx-theme-gallery .lx-tile", (tiles) => tiles.map((tile) => tile.dataset.family));

/* Redesign: the new window's theme tools are in prototype.html's Themes gallery (shell/themes.js), opened from Settings ›
   Appearance › "Browse all … themes": a search over the themes' names with the real count in its placeholder, and tabs
   by group (All, Branch, KeepOak, Editors & terminals, Yours). Branch Slate is the Branch group's one theme; the
   catalogue's own Slate is not listed twice. The old "Easy in daylight" and "High contrast" chips and the spoken count
   are not in the design. */
const GALLERY = [["slate", "Branch Slate", "Branch"], ...THEMES.filter((theme) => theme[0] !== "slate")
  .map((theme) => [theme[0], theme[1], theme[2] === "keepoak" ? "KeepOak" : "Editors & terminals"])];
async function gallery(t, width = 1440) {
  const root = await mkdtemp(join(tmpdir(), "branch-theme-search-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  if (width <= 760) await page.locator('[data-act="side"]').filter({ visible: true }).first().click();
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator('[data-act="setpage"][data-v="appearance"]').click();
  await page.locator('.set-col [data-act="skins"]').click();
  await page.getByRole("dialog", { name: "Themes" }).waitFor();
  return { page, errors };
}
const galleryThemes = (page) => page.$$eval('.dlg .themes6 [data-act="skin"]', (cards) => cards.map((card) => card.dataset.v));

test("DG-035 the theme search names the real count and narrows the themes to names that match, and only those", async (t) => {
  const { page, errors } = await gallery(t);
  const search = page.getByLabel("Search themes", { exact: true });
  assert.equal(await search.getAttribute("placeholder"), `Search ${GALLERY.length} themes`);
  assert.deepEqual((await galleryThemes(page)).sort(), GALLERY.map(([id]) => id).sort(), "nothing typed: every theme");
  await search.fill("OC");
  const expected = GALLERY.filter(([, name]) => name.toLowerCase().includes("oc")).map(([id]) => id);
  assert.ok(expected.length > 0 && expected.length < GALLERY.length, "the probe word matches some themes, not all");
  await page.waitForFunction((n) => document.querySelectorAll('.dlg .themes6 [data-act="skin"]').length === n, expected.length);
  assert.deepEqual((await galleryThemes(page)).sort(), expected.sort(), "exactly the names containing the words, whatever their case");
  await page.getByLabel("Search themes", { exact: true }).fill("zzqq");
  await page.waitForFunction(() => document.querySelectorAll('.dlg .themes6 [data-act="skin"]').length === 0);
  assert.equal((await page.locator(".dlg .themes6 .hint").textContent()).trim(), "No theme has that name.", "none matching says so");
  await page.getByLabel("Search themes", { exact: true }).fill("");
  await page.waitForFunction((n) => document.querySelectorAll('.dlg .themes6 [data-act="skin"]').length === n, GALLERY.length);
  assert.deepEqual(errors, []);
});

test("DG-036 the group tabs show one group each, one chosen at a time, and choosing a theme keeps the search", async (t) => {
  const { page, errors } = await gallery(t);
  const tabs = page.locator('.dlg [data-act="skinf"]');
  assert.deepEqual(await tabs.evaluateAll((nodes) => nodes.map((node) => node.dataset.v)), ["All", "Branch", "KeepOak", "Editors & terminals", "Yours"]);
  assert.deepEqual(await page.locator('.dlg [data-act="skinf"][aria-selected="true"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.v)), ["All"]);
  for (const group of ["Branch", "KeepOak", "Editors & terminals"]) {
    await page.locator(`.dlg [data-act="skinf"][data-v="${group}"]`).click();
    const expected = GALLERY.filter(([, , g]) => g === group).map(([id]) => id).sort();
    await page.waitForFunction((n) => document.querySelectorAll('.dlg .themes6 [data-act="skin"]').length === n, expected.length);
    assert.deepEqual((await galleryThemes(page)).sort(), expected, group);
    assert.deepEqual(await page.locator('.dlg [data-act="skinf"][aria-selected="true"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.v)), [group]);
  }
  /* The tab and the words combine, and choosing a theme keeps both. */
  await page.locator('.dlg [data-act="skinf"][data-v="All"]').click();
  await page.getByLabel("Search themes", { exact: true }).fill("fo");
  await page.waitForFunction(() => [...document.querySelectorAll('.dlg .themes6 [data-act="skin"]')].every((card) => /fo/i.test(card.getAttribute("aria-label"))));
  const before = await galleryThemes(page);
  await page.locator('.dlg .themes6 [data-act="skin"]').first().click();
  await page.waitForFunction((id) => document.querySelector(`.dlg [data-act="skin"][data-v="${id}"]`)?.getAttribute("aria-pressed") === "true", before[0]);
  assert.deepEqual(await galleryThemes(page), before, "choosing a theme redraws the cards but keeps the search");
  assert.equal(await page.getByLabel("Search themes", { exact: true }).inputValue(), "fo");
  assert.deepEqual(errors, []);
});

test("DG-035/036 the gallery fits a phone without sideways scrolling", async (t) => {
  for (const width of [1440, 860, 400]) {
    const { page, errors } = await gallery(t, width);
    const over = await page.evaluate(() => ({ page: document.documentElement.scrollWidth - innerWidth,
      dialog: (() => { const box = document.querySelector(".dlg").getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth + 0.5; })() }));
    assert.ok(over.page <= 1, `${width}: the page is no wider than the window (${over.page}px over)`);
    assert.equal(over.dialog, true, `${width}: the gallery is inside the window`);
    assert.deepEqual(errors, []);
  }
});

// Redesign: replaced by the new window (the gallery's search is checked live above; its spoken count, group headings
// and "No theme matches" words are not in prototype.html; French is Coming soon, sw:lang).
test.skip("DG-035 the theme search names the real count and narrows the tiles to names that match, and only those", async (t) => {
  const { page, errors } = await appearance(t);
  const search = page.getByRole("searchbox", { name: "Search themes" });
  assert.equal(await search.getAttribute("placeholder"), `Search ${THEMES.length} themes`);
  assert.equal((await shownThemes(page)).length, THEMES.length, "nothing typed: every theme");
  await search.fill("OC");
  const expected = THEMES.filter((theme) => theme[1].toLowerCase().includes("oc")).map((theme) => theme[0]);
  assert.ok(expected.length > 0 && expected.length < THEMES.length, "the probe word matches some themes, not all");
  assert.deepEqual((await shownThemes(page)).sort(), expected.sort(), "exactly the names containing the words, whatever their case");
  assert.equal(await page.locator("#lx-theme-results").textContent(), `${expected.length} themes`, "a screen reader hears how many");
  /* A group with nothing left says nothing: no heading over an empty row. */
  const groupsLeft = new Set(THEMES.filter((theme) => expected.includes(theme[0])).map((theme) => theme[2]));
  assert.equal(await page.locator("#lx-theme-gallery .lx-eyebrow").count(), groupsLeft.size);
  await search.fill("zzqq");
  assert.deepEqual(await shownThemes(page), []);
  assert.equal(await page.locator("#lx-theme-gallery .lx-eyebrow").count(), 0, "no group heading over nothing");
  assert.equal(await page.locator(".lx-theme-none").textContent(), "No theme matches. Try All, or a shorter name.");
  assert.equal(await page.locator("#lx-theme-results").textContent(), "0 themes");
  /* In French, none left is singular ("0 thème"), as French counts it. */
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  await page.waitForFunction(() => document.getElementById("lx-theme-results").textContent === "0 thème");
  assert.equal(await page.getByRole("searchbox", { name: "Chercher un thème" }).getAttribute("placeholder"), `Chercher parmi ${THEMES.length} thèmes`);
  await page.locator("#lx-theme-search").fill("");
  assert.equal((await shownThemes(page)).length, THEMES.length);
  assert.equal(await page.locator("#lx-theme-results").textContent(), `${THEMES.length} thèmes`);
  assert.deepEqual(errors, []);
});

