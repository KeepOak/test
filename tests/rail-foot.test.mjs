/* DG-092, DG-093, DG-094, DG-095, DG-159, DG-161: the sidebar as in the approved sample. Overview is its first place; the foot
   is one line of icons (theme, pet, day/night, clear the view, the Settings cog) over the account row, whose name is
   never cut short. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/* Redesign: the new window's sidebar (shell/shell.js side()), 1:1 with prototype.html: the machine, Search and "+",
   the Places (Overview first), the conversations, the pet, and at the foot the person's row with the Settings cog. The
   old foot's icon line (theme, paw, day/night, eye) is not in the design: light or dark is the title bar's switch,
   clearing the view is Focus mode, the pet is in Settings › Appearance. */
async function signedIn(t, width, preferences = {}, before = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-rail-foot-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  await before(app);
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json" };
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers, body: JSON.stringify({ done: true }) });
  if (Object.keys(preferences).length) await fetch(new URL("/api/preferences", server.url), { method: "POST", headers, body: JSON.stringify(preferences) });
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#side .owner-row").waitFor({ state: "attached" });
  errors.length = 0;
  const state = async () => (await (await fetch(new URL("/api/state", server.url), { headers })).json());
  return { page, errors, app, state };
}

test("DG-094 the foot is the person's row with the Settings cog at its right edge", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  const box = await page.evaluate(() => {
    const row = document.querySelector("#side .owner-row").getBoundingClientRect(), side = document.getElementById("side").getBoundingClientRect();
    const owner = document.querySelector("#side .owner").getBoundingClientRect(), gear = document.querySelector('#side .owner-row [data-act="view"][data-v="settings"]').getBoundingClientRect();
    return { rowBottom: row.bottom, sideBottom: side.bottom, gearRight: gear.right, rowRight: row.right, ownerRight: owner.right, gearLeft: gear.left };
  });
  assert.ok(box.sideBottom - box.rowBottom < 24, "the person's row is the foot of the list");
  assert.ok(box.rowRight - box.gearRight < 16, "the cog at the right edge");
  assert.ok(box.gearLeft >= box.ownerRight - 1, "beside the person, not over it");
  await page.locator('#side .owner-row [data-act="view"][data-v="settings"]').click();
  await page.locator(".settings .set-nav").waitFor();
  assert.deepEqual(errors, []);
});

test("DG-159 light or dark is one switch in the title bar that switches the window and the engine keeps it", async (t) => {
  const { page, errors, state } = await signedIn(t, 1440);
  const flip = page.getByRole("button", { name: "Switch light or dark", exact: true });
  const before = await page.evaluate(() => document.documentElement.dataset.theme ?? "");
  await flip.click();
  await page.waitForFunction((was) => (document.documentElement.dataset.theme ?? "") !== was && document.documentElement.dataset.theme, before);
  const now = await page.evaluate(() => document.documentElement.dataset.theme);
  let prefs = (await state()).preferences;
  for (let i = 0; i < 20 && prefs.appearance !== (now === "light" ? "daylight" : "forest"); i++) { await page.waitForTimeout(150); prefs = (await state()).preferences; }
  assert.equal(prefs.appearance, now === "light" ? "daylight" : "forest", "the engine's words: daylight is light, forest is dark");
  await flip.click();
  await page.waitForFunction((was) => document.documentElement.dataset.theme !== was, now);
  assert.deepEqual(errors, []);
});

test("DG-094 Focus mode clears the view, says how to leave it, and Escape brings it back", async (t) => {
  // Redesign: the old foot's eye is the title bar's Focus mode (Ctrl+.): the list and the status bar step aside.
  const { page, errors } = await signedIn(t, 1440);
  await page.getByRole("button", { name: "Focus mode", exact: true }).click();
  await page.waitForFunction(() => document.getElementById("app").classList.contains("focus"));
  assert.equal(await page.locator("#side").isVisible(), false, "the list steps aside");
  assert.equal(await page.getByRole("button", { name: /^Leave focus mode/ }).isVisible(), true, "and the way back is named");
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.getElementById("app").classList.contains("focus"), null, { timeout: 5000 });
  assert.deepEqual(errors, []);
});

test("DG-092 Overview is the sidebar's first place, and opens the Overview", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  const first = page.locator('#side .side-nav [data-act="view"]').first();
  assert.equal(await first.getAttribute("data-v"), "overview");
  assert.equal(await first.isVisible(), true);
  assert.equal((await first.innerText()).trim(), "Overview");
  await first.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelector('#side .side-nav [data-v="overview"]').getAttribute("aria-current") === "true");
  await page.locator("h1", { hasText: "Overview" }).waitFor();
  assert.deepEqual(errors, []);
});

for (const width of [1440, 1024, 390]) {
  test(`DG-095 at ${width} px a long owner line never pushes the window sideways`, async (t) => {
    const { page, errors } = await signedIn(t, width);
    // Redesign: replaced by the new window (prototype.html's person row ends a long name with an ellipsis, .who14 b).
    await page.evaluate(() => { document.querySelector("#side .owner .who14 b").textContent = "Grandmother's workshop on the hill behind the orchard"; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "nothing scrolls sideways");
    assert.equal(await page.evaluate(() => { const row = document.querySelector("#side .owner-row").getBoundingClientRect(), side = document.getElementById("side").getBoundingClientRect(); return side.width === 0 || row.right <= side.right + 0.5; }), true, "the row stays inside the list");
    assert.deepEqual(errors, []);
  });
}

test("DG-093 a Trunk's conversation offers a new conversation with it, and New conversation still starts plainly", async (t) => {
  // Redesign: prototype.html has no chevron beside New conversation; a new conversation with a Trunk is its
  // conversation row's own menu (right-click), "New conversation with <name>".
  const { page, errors, app } = await signedIn(t, 1440, {}, async (app) => {
    app.trunks.setMode("trunks", { mode: "on" });
    app.trunks.setMode("conversations", { mode: "on" });
    await app.trunks.create({ name: "Ada" });
  });
  const ada = app.trunks.records.list()[0];
  const row = page.locator(`#side .row[data-id="${ada.chatSessionId}"]`);
  await row.waitFor();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "New conversation with Ada" }).click();
  await page.waitForFunction((own) => { const id = document.querySelector('#side .row[aria-current="true"]')?.dataset.id; return id && id !== own; }, ada.chatSessionId);
  const session = await page.evaluate(() => document.querySelector('#side .row[aria-current="true"]').dataset.id);
  const chosen = new Map(app.trunks.conversations.chosen());
  assert.equal(chosen.get(session), ada.id, "Ada answers in the new conversation");
  // trunk-one-row: inside Ada's timeline New conversation starts fresh with Ada: a new line in the same timeline, no new row.
  const rows = await page.locator("#side .row").count();
  await page.locator('#side [data-act="newmenu"]').click();
  await page.getByRole("menuitem", { name: /^New conversation(?! with)/ }).click();
  await page.locator(`#scroll .tl-sep19[data-tl="${session}"]`).waitFor();
  assert.equal(await page.locator('#side .row[aria-current="true"]').getAttribute("data-line"), ada.id, "still Ada's timeline");
  assert.equal(await page.locator("#side .row").count(), rows, "no new row");
  assert.equal(await page.locator("#conversation .b, #conversation .u").count(), 0, "a fresh conversation");
  assert.deepEqual(errors, []);
});

test("DG-093 without Trunks a conversation's menu offers no Trunk to start with", async (t) => {
  const { page, errors } = await signedIn(t, 1440, {}, async (app) => { app.trunks.setMode("trunks", { mode: "off" }); await app.runtime.run({ prompt: "Plain one" }); });
  const row = page.locator("#side .row[data-id]").first();
  await row.waitFor();
  await row.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Open" }).waitFor();
  assert.equal(await page.getByRole("menuitem", { name: /^New conversation with/ }).count(), 0);
  assert.deepEqual(errors, []);
});

/* The old window's foot, for the skipped bodies below. */
/** The icon line, left to right: each shown button's id and its accessible name. */
const footLine = (page) => page.evaluate(() => [...document.querySelectorAll("#lx-foot-line > button")]
  .filter((node) => node.checkVisibility())
  .map((node) => ({ id: node.id, label: node.getAttribute("aria-label") || node.textContent.trim() })));

// Redesign: replaced by the new window (prototype.html's foot is the person's row and the Settings cog; no icon line and
// no Show everything; checked live above).
for (const everything of [false, true]) {
  test.skip(`DG-094 the foot is one icon line over the account row (Show everything ${everything ? "on" : "off"})`, async (t) => {
    const { page, errors } = await signedIn(t, 1440, { showEverything: everything });
    const line = await footLine(page);
    assert.deepEqual(line.map((b) => b.id).slice(0, 4), ["lx-foot-theme", "lx-foot-pet", "lx-foot-mode", "lx-foot-eye"]);
    assert.equal(line.length, 5, "and the Settings cog closes it");
    assert.match(line[4].id, /^(lx-settings-row|rail-settings)$/);
    const box = await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      const gear = [...document.querySelectorAll("#lx-foot-line > .sg-gear")].find((node) => node.checkVisibility()).getBoundingClientRect();
      return { lineBottom: r("lx-foot-line").bottom, ownerTop: r("owner-menu-button").top, ownerRight: r("owner-menu-button").right, gearRight: gear.right,
        mode: r("lx-foot-mode").left, pet: r("lx-foot-pet").right, gearH: gear.height };
    });
    assert.ok(box.lineBottom <= box.ownerTop + 1, "the icons sit above the account row");
    assert.ok(Math.abs(box.gearRight - box.ownerRight) < 2, "the cog at the right edge");
    assert.ok(box.mode - box.pet > 40, "day/night, the eye and the cog are pushed to the right");
    assert.equal(Math.round(box.gearH), 30);
    assert.equal(await page.locator("#appearance-shortcut").isVisible(), false, "DG-159: the old half-moon is gone");
    assert.deepEqual(errors, []);
  });
}

// Redesign: replaced by the new window (prototype.html ends a long name with an ellipsis, .who14 b; no sideways scroll is
// checked live above).
for (const width of [1440, 1024, 390]) {
  test.skip(`DG-095 at ${width} px a long owner line is shown whole`, async (t) => {
    const { page, errors } = await signedIn(t, width);
    const clipped = await page.evaluate(() => {
      const name = document.getElementById("owner-name");
      name.textContent = "Grandmother's workshop on the hill behind the orchard";
      return name.scrollWidth > name.clientWidth + 1 || getComputedStyle(name).textOverflow === "ellipsis";
    });
    assert.equal(clipped, false);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "nothing scrolls sideways");
    assert.deepEqual(errors, []);
  });
}

// Redesign: Coming soon (sw:lang), checked at e5b8a610; and the icon line is replaced.
test.skip("DG-094 in French the icon line speaks French", async (t) => {
  const { page, errors } = await signedIn(t, 1440);
  await page.evaluate(async () => { await (await import("/i18n.js")).setLanguage("fr"); });
  await page.waitForFunction(() => document.getElementById("lx-foot-mode").getAttribute("aria-label") === "Forêt. Passer à Lumière du jour");
  assert.equal(await page.locator("#lx-foot-theme").getAttribute("aria-label"), "Thème · Forêt");
  assert.equal(await page.locator("#lx-foot-eye").getAttribute("aria-label"), "Dégager la vue");
  assert.equal((await page.locator('.lx-place-link[data-place="overview"]').innerText()).trim().length > 0, true);
  assert.deepEqual(errors, []);
});
