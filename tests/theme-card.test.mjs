/* DG-166 / DG-040: Appearance's Theme card holds the approved sample's rows (design/Branch-Grown-Up.html, the live
   `lookHTML`), in its order: Day or night, the themes, Season, Contrast, Conversation width, Keep things still. The
   sample's proposals with no setting behind them in Branch (Behind the glass, Style, See-through) are not drawn.
   Each row is the one control for its setting: Conversation width and Keep things still are moved here, not
   copied. Contrast still reaches the terminal both ways. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { saveLook } from "../dist/terminal-theme.js";
import { openSettings } from "./places.mjs"; // the old window's helper, for the skipped bodies only
import { readFileSync } from "node:fs";

const FRENCH = JSON.parse(readFileSync(new URL("../public/locales/fr.json", import.meta.url), "utf8"));

/* Redesign: Settings › Appearance in the new window (settings/pages/appearance.js) is prototype.html's page: Light or
   dark, Theme (the one worn, Browse, Accent colour, More contrast), Agents, Background, Reading (Conversation width,
   Text size), The pet, What's shown (Keep things still) and Language. Its rows and words replace the old Theme card's;
   what the controls do is checked: contrast reaches the terminal both ways, and the conversation width is saved. */
async function appearance(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-theme-card-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body ? "POST" : "GET", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async () => {
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await page.locator('#side [data-act="view"][data-v="settings"]').click();
    await page.locator('[data-act="setpage"][data-v="appearance"]').click();
    await page.locator("#a-contrast").waitFor();
  };
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  errors.length = 0; // what failed before the key was given is the login page's business
  await open();
  return { app, page, errors, call, open };
}
const sections = (page) => page.$$eval(".set-col .sec > h2", (nodes) => nodes.map((node) => node.textContent));

test("DG-166/DG-040: Appearance has the prototype's sections, in its order", async (t) => {
  const { page, errors } = await appearance(t);
  assert.deepEqual(await sections(page), ["Light or dark", "Theme", "Agents", "Background", "Reading", "The pet", "What’s shown", "Language"]);
  assert.deepEqual(await page.getByRole("group", { name: "Conversation width", exact: true }).getByRole("button").allInnerTexts(), ["Comfortable", "Wide", "Full"]);
  assert.deepEqual(errors, []);
});

test("DG-166: More contrast reaches the terminal, and comes back from it", async (t) => {
  const { app, page, errors, call } = await appearance(t);
  const box = page.getByRole("checkbox", { name: "More contrast", exact: true });
  assert.equal(await box.isChecked(), false);
  await box.check();
  let look = await call("/api/look");
  for (let tries = 0; tries < 50 && look.contrast !== "more"; tries += 1) look = await page.waitForTimeout(100).then(() => call("/api/look"));
  assert.equal(look.contrast, "more", "the window's choice is written for the terminal");
  /* The terminal writes the look itself (the window's own route always says it came from the window). */
  await saveLook(app.store, app.runtime.owner, { contrast: "standard", changedBy: "terminal" });
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.waitForFunction(() => document.getElementById("a-contrast")?.checked === false, null, { timeout: 10000 })
    .catch(() => assert.fail("the terminal's change comes back to the open window"));
  assert.deepEqual(errors, []);
});

test("DG-166: Conversation width is saved, and comes back after a reload", async (t) => {
  const { page, errors, open, call } = await appearance(t);
  await page.getByRole("group", { name: "Conversation width", exact: true }).getByRole("button", { name: "Full", exact: true }).click();
  let prefs = (await call("/api/state")).preferences;
  for (let tries = 0; tries < 50 && prefs.conversationWidth !== "full"; tries += 1) prefs = await page.waitForTimeout(100).then(() => call("/api/state").then((s) => s.preferences));
  assert.equal(prefs.conversationWidth, "full");
  await page.reload();
  await open();
  assert.equal(await page.getByRole("group", { name: "Conversation width", exact: true }).getByRole("button", { name: "Full", exact: true }).getAttribute("aria-pressed"), "true");
  assert.deepEqual(errors, []);
});

/* The old window's card, for the skipped bodies below. */
const rows = (page) => page.$$eval("#lx-page-appearance .lx-look > *", (nodes) => nodes.map((node) =>
  node.matches(".lx-look-row") ? node.querySelector(".lx-look-label").textContent
    : node.matches(".lx-theme-tools") ? "(search)" : node.matches(".lx-gallery") ? "(themes)" : null).filter(Boolean));
const shown = (page, host) => page.$$eval(`#${host} .segmented-option`, (nodes) => nodes.map((node) => node.textContent));
const pressed = (page, host) => page.$eval(`#${host} [aria-pressed="true"]`, (node) => node.textContent);

// Redesign: replaced by the new window (prototype.html's Appearance sections and words, checked live above; its French
// is Coming soon, sw:lang).
test.skip("DG-166/DG-040: the Theme card has the sample's rows, words and notes, in the sample's order", async (t) => {
  const { page, errors } = await appearance(t);
  assert.deepEqual(await rows(page), ["Day or night", "(search)", "(themes)", "Season", "Contrast", "Conversation width",
    "Keep things still (no sliding or spinning)"]);
  assert.deepEqual(await shown(page, "lx-season"), ["Auto", "Spring", "Summer", "Autumn", "Winter"]);
  const season = await page.evaluate(async () => (await import("/grove.js")).seasonToday());
  assert.equal(await page.locator("#lx-season-note").textContent(),
    `Auto follows today's date, which means ${season} right now. The oak behind the window changes with it.`);
  assert.deepEqual(await shown(page, "lx-contrast"), ["Standard", "High contrast"]);
  assert.deepEqual(await shown(page, "lx-width"), ["Comfortable", "Wide", "Full width"]);
  for (const [name, group] of [["Season", "lx-season"], ["Contrast", "lx-contrast"], ["Conversation width", "lx-width"]])
    assert.equal(await page.getByRole("group", { name, exact: true }).getAttribute("class"), "seg", `${group} is named by its row`);
  assert.equal(await page.locator("#lx-page-appearance").getByText(/Behind the glass|See-through$|^Style$/).count(), 0, "no proposal is drawn");
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForFunction(() => document.documentElement.lang === "fr");
  assert.deepEqual(await rows(page), ["Jour ou nuit", "(search)", "(themes)", "Saison", "Contraste", "Largeur de la conversation", FRENCH["appearance.reduceMotion"]]);
  assert.match(await page.locator("#lx-season-note").textContent(), /^Auto suit la date du jour, c’est-à-dire \S+ en ce moment\./);
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (sw:a-still, "Keep things still"), checked at e5b8a610; Conversation width is checked live
// above.
test.skip("DG-166: Conversation width and Keep things still are this card's own controls, saved, and nowhere else", async (t) => {
  const { page, errors, open } = await appearance(t);
  assert.equal(await page.locator("#panels-onscreen .panels-width-row").count(), 0, "What's on screen no longer has its own width row");
  assert.equal(await page.locator("#appearance-motion").count(), 1);
  assert.equal(await page.locator(".lx-look #appearance-motion").count(), 1, "the one switch sits in the Theme card");
  assert.equal(await page.locator("#settings-form #appearance-motion").count(), 0);
  /* Each change is saved as it is made: the reload waits for the save that carries both. */
  const saved = page.waitForResponse((response) => response.url().endsWith("/api/preferences")
    && response.request().postDataJSON()?.conversationWidth === "full" && response.request().postDataJSON()?.reduceMotion === true);
  await page.locator("#lx-width").getByRole("button", { name: "Full width", exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.convw === "full");
  await page.getByLabel("Keep things still (no sliding or spinning)", { exact: true }).check();
  await page.waitForFunction(() => document.documentElement.dataset.motion === "reduced");
  assert.equal((await saved).ok(), true);
  await page.reload();
  await open();
  assert.equal(await pressed(page, "lx-width"), "Full width");
  assert.equal(await page.locator("#appearance-motion").isChecked(), true);
  assert.deepEqual(errors, []);
});
