/* The bars and notes at the top of a conversation or a place (the gateway's and the update suggestion, Lockdown's banner,
   a place's own) start below the floating title row at every width, with Lockdown on or off, and after a theme of your
   own is made in Settings › Appearance and Settings is left; that theme's colours are the ones the conversation wears.
   The title row's height is measured (public/app/shell/shell.js measureTitleRow, --tb-h), so a taller row keeps them
   clear too. The engine's suggestion answers "background" here; nothing is installed. Pass 18 (one frame): the suggestion
   shows only on Overview and Inbox, never over a conversation. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t, width = 1440) {
  const root = await mkdtemp(join(tmpdir(), "branch-banners-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  await call("/api/onboarding", { done: true });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/deployment/suggestion", (route) => (route.request().method() === "GET" ? route.fulfill({ json: { bar: "background" } }) : route.continue()));
  await page.goto(server.url);
  const key = page.getByLabel("Session token", { exact: true });
  await key.waitFor({ timeout: 60000 });
  await key.fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { call, page, errors };
}

/* Every shown bar before the view's scroller, the gateway's bar wherever it is, and a place's first block: each one's
   top is at or below the title row's bottom, and what is drawn at its top edge is the bar, not the row over it. */
function overlaps(page) {
  return page.evaluate(() => {
    const row = document.querySelector(".titlebar").getBoundingClientRect();
    const main = document.querySelector("#main"), box = main.querySelector(":scope>.main") ?? main;
    const before = [];
    for (const el of box.children) { if (el.matches(".scroll") || el.querySelector(".scroll")) break; before.push(el); }
    const place = main.querySelector(".place")?.firstElementChild;
    const bars = [...new Set([...before, ...main.querySelectorAll(".recbar"), ...(place ? [place] : [])])];
    return bars.map((el) => ({ el, r: el.getBoundingClientRect() })).filter(({ r }) => r.height > 0 && r.width > 0).map(({ el, r }) => {
      const hit = document.elementFromPoint(r.left + r.width / 2, Math.max(r.top, 0) + 2);
      return { what: el.className || el.tagName, top: Math.round(r.top), row: Math.round(row.bottom), covered: !(hit && el.contains(hit)) };
    }).filter((x) => x.top < x.row || x.covered);
  });
}

async function clearOfRow(page, where) {
  let bad = [];
  for (let i = 0; i < 20; i++) { bad = await overlaps(page); if (!bad.length) return; await page.waitForTimeout(100); }
  assert.deepEqual(bad, [], `${where}: a bar lies under the title row`);
}

const PLACES = ["overview", "inbox", "automations", "library", "team", "customize"];
const WITH_BAR = ["overview", "inbox"];
async function everyView(page, where) {
  await page.locator('#side [data-act="newmenu"]').click();
  await page.locator('.pop [data-act="newconv"]').click();
  await page.locator("#main #composer").waitFor({ timeout: 15000 });
  await clearOfRow(page, `${where}, conversation`);
  assert.equal(await page.locator("#main .recbar").count(), 0, `${where}: no suggestion over a conversation (pass 18)`);
  for (const place of PLACES) {
    const nav = page.locator(`#side [data-act="view"][data-v="${place}"]`).first();
    if (!(await nav.isVisible())) continue;
    await nav.click();
    await page.locator("#main .place").first().waitFor({ timeout: 15000 });
    if (WITH_BAR.includes(place)) await page.locator("#main .recbar").waitFor({ timeout: 15000 });
    await clearOfRow(page, `${where}, ${place}`);
  }
}
/* The suggestion's own place: Overview. */
async function overview(page) {
  await page.locator('#side [data-act="view"][data-v="overview"]').first().click();
  await page.locator("#main .recbar").waitFor({ timeout: 15000 });
}

for (const width of [1440, 1100, 900, 761]) {
  test(`at ${width}px every bar at the top of a conversation or place is below the title row, Lockdown off and on`, async (t) => {
    const f = await fixture(t, width);
    await everyView(f.page, `${width}px`);
    assert.equal((await f.call("/api/lockdown", { on: true })).status, 200);
    await f.page.locator("#app.locked").waitFor({ timeout: 15000 });
    await everyView(f.page, `${width}px locked`);
    assert.equal((await f.call("/api/lockdown", { on: false })).status, 200);
    assert.deepEqual(f.errors, []);
  });
}

test("a taller title row (a theme's or text size's) is measured again and the bars move below it", async (t) => {
  const f = await fixture(t);
  await overview(f.page);
  /* The window's policy refuses a style tag; a constructed sheet is how a script in the page adds a rule. */
  await f.page.evaluate(() => { const sheet = new CSSStyleSheet(); sheet.replaceSync(".titlebar.merged14{height:76px}"); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; });
  assert.equal(await f.page.evaluate(() => document.querySelector(".titlebar").getBoundingClientRect().height), 76);
  await clearOfRow(f.page, "taller row");
  assert.deepEqual(f.errors, []);
});

/* Thirteen distinct colours, so each surface can be told apart. */
const MINE = { bg: "#3A1F4D", side: "#2A1438", raise: "#4B2E61", ink: "#F4E9FF", ink2: "#D9C8E6", ink3: "#B39BC4", line: "#5A3D70",
  accent: "#E07033", btn: "#F2D46B", onBtn: "#1A0F22", ok: "#58C28C", warn: "#E3B341", bad: "#EF7A66" };
const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`;

async function worn(page) {
  return page.evaluate(() => {
    const bg = (sel) => { const el = document.querySelector(sel); return el ? getComputedStyle(el).backgroundColor : null; };
    const root = getComputedStyle(document.documentElement);
    return { bgVar: root.getPropertyValue("--bg").trim().toUpperCase(), raiseVar: root.getPropertyValue("--raise").trim().toUpperCase(),
      body: bg("body"), main: bg("#main"), bar: bg("#main .recbar"), palette: document.documentElement.dataset.palette,
      mainFill: getComputedStyle(document.querySelector("#main")).backgroundImage,
      cutoff: getComputedStyle(document.querySelector("#app")).getPropertyValue("--tb-h").trim(),
      mainTop: document.querySelector("#main").getBoundingClientRect().top,
      rowTop: document.querySelector(".titlebar").getBoundingClientRect().top,
      rowHeight: document.querySelector(".titlebar").getBoundingClientRect().height };
  });
}

test("a theme of your own made in Settings › Appearance is worn after Settings is left, with Overview's bar in view", async (t) => {
  const f = await fixture(t);
  const { page } = f;
  await overview(page);
  await page.locator('#side [data-act="view"][data-v="settings"]').first().click();
  await page.locator('[data-act="setpage"][data-v="appearance"]').first().click();
  await page.locator('.set-page [data-act="ce-new"], #main [data-act="ce-new"]').first().click();
  for (const [k, v] of Object.entries(MINE)) await page.locator(`#ceh-${k}`).fill(v);
  await page.locator('[data-act="ce-save"]').click();
  await page.locator(".dlg .ced").waitFor({ state: "detached" });
  await page.locator(".set-back").click();
  await page.locator("#main #composer").waitFor({ timeout: 15000 });
  await overview(page);
  await clearOfRow(page, "after Settings with a theme of your own");
  const look = await worn(page);
  assert.match(look.palette, /^my-/, "the theme of your own is the one worn");
  assert.equal(look.bgVar, MINE.bg);
  assert.equal(look.raiseVar, MINE.raise);
  assert.equal(look.body, rgb(MINE.bg), "the window's ground is the theme's background");
  assert.match(look.mainFill, /linear-gradient/, "the toolbar strip lets the wallpaper through");
  assert.ok(look.mainFill.includes(`${rgb(MINE.bg)} ${look.cutoff}`), "solid content below the row retains the exact theme background");
  assert.equal(parseFloat(look.cutoff), Math.ceil(look.rowHeight), "the transparent strip stops at the measured toolbar height");
  assert.equal(look.mainTop, look.rowTop, "the view starts beneath the floating row without adding a content gap");
  assert.equal(look.bar, rgb(MINE.raise), "the bar is a card in the theme's colours");
  /* Light or dark flipped and flipped back: the theme stays on, the bar stays clear of the row. */
  await page.locator('[data-act="theme-flip"]').first().click();
  await page.locator('[data-act="theme-flip"]').first().click();
  await clearOfRow(page, "after flipping light and dark");
  const again = await worn(page);
  assert.ok(again.mainFill.includes(`${rgb(MINE.bg)} ${again.cutoff}`), "the solid theme background survives flipping modes");
  assert.equal(parseFloat(again.cutoff), Math.ceil(again.rowHeight));
  assert.equal(again.mainTop, again.rowTop);
  assert.equal(again.bar, rgb(MINE.raise));
  assert.deepEqual(f.errors, []);
});
