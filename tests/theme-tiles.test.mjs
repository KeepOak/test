/* DG-037: the Appearance theme tiles are the approved sample's (design/Branch-Grown-Up.html, its live `tilesHTML`):
   a 70px window in miniature per theme, with its rail, a surface holding a strong and a quiet line of text, and its
   accent, then the name and the sample's words (Default on Slate, High contrast at 14:1 in the light shown). Columns
   are at least 180px wide, 140px under 760px, and nothing scrolls sideways. Headless only. */
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
import { TOKEN_NAMES } from "../public/theme-catalogue.js";

function contrast(theme, mode) {
  const token = (name) => theme[3][mode][TOKEN_NAMES.indexOf(name)];
  const light = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, index) => sum + c * [0.2126, 0.7152, 0.0722][index], 0);
  const [a, b] = [light(token("--text")), light(token("--ground"))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/* Redesign: the new window's theme cards are in prototype.html's Themes gallery (shell/themes.js card()): a swatch of the
   theme's own colours, its name and its group, named by the theme alone and pressed when worn. The old 70px miniature
   window, its measures and its "Default" / "High contrast" / "Easy in daylight" words are not in the design. */
async function gallery(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-theme-tiles-"));
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
  await page.locator('.dlg .themes6 [data-act="skin"]').first().waitFor();
  return { page, errors };
}

test("DG-037 each card shows its theme's own colours and its name, inside the window at three widths", async (t) => {
  for (const width of [1440, 860, 400]) {
    const { page, errors } = await gallery(t, width);
    const seen = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.dlg .themes6 [data-act="skin"]')], box = document.querySelector(".dlg").getBoundingClientRect();
      const fills = (card) => [...card.querySelectorAll("*")].map((node) => getComputedStyle(node).backgroundColor).filter((c) => c !== "rgba(0, 0, 0, 0)").join("|");
      return { named: cards.every((card) => card.querySelector(":scope > b")?.textContent.trim() === card.getAttribute("aria-label")),
        painted: cards.every((card) => fills(card).length > 0),
        distinct: new Set(cards.map(fills)).size > cards.length / 2,
        inside: cards.every((card) => { const r = card.getBoundingClientRect(); return r.width === 0 || (r.left >= box.left - 0.5 && r.right <= box.right + 0.5); }),
        over: document.documentElement.scrollWidth - innerWidth };
    });
    assert.equal(seen.named, true, `${width}: each card is named by its theme and shows the name`);
    assert.equal(seen.painted, true, `${width}: each card is painted`);
    assert.equal(seen.distinct, true, `${width}: in its own theme's colours, not one look for all`);
    assert.equal(seen.inside, true, `${width}: every card is inside the gallery`);
    assert.ok(seen.over <= 1, `${width}: the page is no wider than the window (${seen.over}px over)`);
    assert.deepEqual(errors, []);
  }
});

test("DG-037 the worn theme's card is pressed, and a card is named by its theme alone", async (t) => {
  const { page, errors } = await gallery(t, 1440);
  const pressedCards = () => page.$$eval('.dlg [data-act="skin"][aria-pressed="true"]', (cards) => cards.map((card) => card.dataset.v));
  assert.deepEqual(await pressedCards(), ["slate"], "Branch Slate is worn at first");
  assert.equal(await page.getByRole("button", { name: "Branch Slate", exact: true }).count(), 1);
  await page.getByRole("button", { name: "Forest", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.dlg [data-act="skin"][data-v="forest"]')?.getAttribute("aria-pressed") === "true");
  assert.deepEqual(await pressedCards(), ["forest"], "one pressed at a time");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.palette), "forest");
  assert.deepEqual(errors, []);
});

/* The old window's tiles, for the skipped bodies below. */
async function appearance(t, width) {
  const root = await mkdtemp(join(tmpdir(), "branch-theme-tiles-"));
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
  await page.locator("#lx-theme-gallery .lx-tile").first().waitFor();
  return { page, errors };
}

const measure = (page) => page.evaluate(() => {
  const tile = document.querySelector("#lx-theme-gallery .lx-tile"), grid = tile.parentElement;
  const box = (node) => node.getBoundingClientRect(), style = (node) => getComputedStyle(node);
  const mini = tile.querySelector(".lx-mini"), rail = mini.querySelector("u"), pane = mini.querySelector("i");
  const lines = [...pane.querySelectorAll("em")], accent = pane.querySelector("s"), name = tile.querySelector(".lx-tile-name");
  return {
    tile: { padding: style(tile).paddingTop, radius: style(tile).borderTopLeftRadius, border: style(tile).borderTopWidth },
    mini: { height: box(mini).height, radius: style(mini).borderTopLeftRadius },
    rail: { width: box(rail).width, height: box(rail).height },
    pane: { left: box(pane).left - box(mini).left, top: box(pane).top - box(mini).top, right: box(mini).right - box(pane).right, radius: style(pane).borderTopLeftRadius },
    lines: lines.map((line) => Math.round(box(line).width / box(pane).width * 100) / 100 > 0 && style(line).height),
    accent: { width: box(accent).width, height: box(accent).height },
    name: { size: style(name).fontSize, weight: style(name).fontWeight },
    column: box(tile).width,
    columns: style(grid).gridTemplateColumns.split(" ").length,
    track: box(grid).width,
    over: document.documentElement.scrollWidth - innerWidth,
  };
});

