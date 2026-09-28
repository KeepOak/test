/* DG-160: Appearance's day-or-night control reads as the approved sample's does (design/Branch-Grown-Up.html, the
   live `lookHTML`): "Day or night", then Follow this computer, ☾ Moonlight and ☀ Daylight, with the note "Every theme
   has both. Switching keeps the theme you chose." across the row beneath. The signs are pictures only; the word is
   each choice's name. The saved value is still dark or light. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/* Redesign: Settings › Appearance's "Light or dark" (settings/pages/appearance.js), 1:1 with prototype.html: a live
   mirror of the window in light, one in dark, and "Match this computer" (data-act="themeset"). The old "Day or night"
   row's words and signs are replaced by it; what it does is checked: the window switches, keeps the theme chosen, the
   engine keeps the choice (preferences: daylight or forest, followSystem) and it is still chosen after a reload. */
async function appearance(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-day-night-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), {
    method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }),
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0; // what failed before the key was given is the login page's business
  await openAppearance(page);
  const preferences = async () => (await (await fetch(new URL("/api/state", server.url), { headers: { authorization: `Bearer ${server.token}` } })).json()).preferences;
  return { page, errors, app, preferences };
}
async function openAppearance(page) {
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator('[data-act="setpage"][data-v="appearance"]').click();
  await page.locator('.set-col [data-act="themeset"]').first().waitFor();
}
const choice = (page, v) => page.locator(`.set-col .mirrors [data-act="themeset"][data-v="${v}"]`);
const pressedChoices = (page) => page.locator('.set-col .mirrors [data-act="themeset"][aria-pressed="true"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.v));

test("DG-160: the three choices are the prototype's light mirror, dark mirror and Match this computer, one of them chosen", async (t) => {
  const { page, errors } = await appearance(t);
  assert.deepEqual(await page.locator('.set-col .mirrors [data-act="themeset"]').evaluateAll((nodes) => nodes.map((node) => node.dataset.v)), ["light", "dark", "system"]);
  assert.match(await choice(page, "light").locator("b").innerText(), /^Light · live mirror of/); // its caption; the miniature shows the latest conversation
  assert.match(await choice(page, "dark").locator("b").innerText(), /^Dark · live mirror of/); // its caption; the miniature shows the latest conversation
  assert.equal((await choice(page, "system").innerText()).trim(), "Match this computer");
  assert.equal((await pressedChoices(page)).length, 1, "exactly one is chosen");
  assert.deepEqual(errors, []);
});

test("DG-160: Light really switches the window, keeps the theme, and is still chosen after a reload", async (t) => {
  const { page, errors, preferences } = await appearance(t);
  const palette = await page.evaluate(() => document.documentElement.dataset.palette);
  await choice(page, "light").click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.palette), palette, "switching keeps the theme you chose");
  assert.deepEqual(await pressedChoices(page), ["light"]);
  let saved = await preferences();
  for (let i = 0; i < 20 && saved.appearance !== "daylight"; i++) { await page.waitForTimeout(150); saved = await preferences(); }
  assert.deepEqual({ appearance: saved.appearance, followSystem: saved.followSystem }, { appearance: "daylight", followSystem: false }, "the engine keeps it");
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await openAppearance(page);
  await page.waitForFunction(() => document.querySelector('.mirrors [data-act="themeset"][aria-pressed="true"]')?.dataset.v === "light");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  await choice(page, "system").click();
  await page.waitForFunction(() => document.querySelector('.mirrors [data-act="themeset"][aria-pressed="true"]')?.dataset.v === "system");
  saved = await preferences();
  for (let i = 0; i < 20 && saved.followSystem !== true; i++) { await page.waitForTimeout(150); saved = await preferences(); }
  assert.equal(saved.followSystem, true, "following is the real setting, not only a pressed button");
  assert.deepEqual(errors, []);
});

/* The old window's row, for the skipped bodies below. */
const control = (page) => page.evaluate(() => {
  const host = document.getElementById("lx-mode"), row = host.closest(".lx-look-row"), group = host.querySelector(".seg");
  return {
    label: row.querySelector(".lx-look-label").textContent,
    group: document.getElementById(group.getAttribute("aria-labelledby"))?.textContent,
    shown: [...group.children].map((choice) => choice.textContent),
    pressed: [...group.children].filter((choice) => choice.getAttribute("aria-pressed") === "true").map((choice) => choice.textContent),
    signsHidden: [...group.querySelectorAll(".seg-sign")].every((sign) => sign.getAttribute("aria-hidden") === "true"),
    note: row.querySelector(".lx-look-note")?.textContent,
    noteBelow: row.querySelector(".lx-look-note")?.getBoundingClientRect().top >= group.getBoundingClientRect().bottom,
    /* Across the row, as the sample's `.cn` (grid-column 1 / -1): from the label's left edge, on one line. */
    noteAcross: (() => {
      const note = row.querySelector(".lx-look-note"), box = note?.getBoundingClientRect();
      return Boolean(box) && Math.abs(box.left - row.querySelector(".lx-look-label").getBoundingClientRect().left) < 1
        && box.height < parseFloat(getComputedStyle(note).lineHeight) * 1.5;
    })(),
  };
});

// Redesign: Coming soon (sw:lang), checked at e5b8a610.
test.skip("DG-160: in French the words change and the signs stay", async (t) => {
  const { page, errors } = await appearance(t);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  await page.waitForFunction(() => document.querySelector("#lx-mode .segmented-option:nth-child(2)")?.textContent === "☾ Nuit");
  const words = await control(page);
  assert.equal(await page.getByRole("group", { name: "Jour ou nuit", exact: true }).count(), 1, "the choices' name follows the language");
  assert.deepEqual({ label: words.label, group: words.group, shown: words.shown, note: words.note },
    { label: "Jour ou nuit", group: "Jour ou nuit", shown: ["Comme cet ordinateur", "☾ Nuit", "☀ Jour"], note: "Chaque thème a les deux. Changer garde le thème que vous avez choisi." });
  assert.deepEqual(errors, []);
});
