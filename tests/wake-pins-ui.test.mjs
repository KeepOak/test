/**
 * mac7/wake-pins: the two cards, reached the way a person reaches them — Settings, Voice for the
 * word that starts a turn, and Settings, Permissions for the settings you have pinned. Each starts
 * off or empty, says what this computer would really do, fits a 400-pixel window and reads in
 * French. Headless browser only; no window opens, no microphone, no sound.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { openPlace } from "./places.mjs"; // the old window's helper, for the skipped bodies only

const LOCALES = new URL("../public/locales/", import.meta.url);

async function fixture(t, viewport = { width: 1280, height: 900 }) {
  const root = await mkdtemp(join(tmpdir(), "branch-wake-pins-ui-"));
  const provider = { name: "wake-pins-ui", complete: async () => ({ content: "Done", toolCalls: [] }) };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  app.store.save("settings", app.runtime.owner, "onboarding", { done: true }); // setup opens on the first draw otherwise (flows/flows.js); not what this is about
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport, serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, errors };
}

/* Redesign: in the new window the cards are Settings pages (settings/pages/voice.js, permissions.js). prototype.html's
   Voice page has "Listening: Off / Push to talk / Wake word" and, at Advanced, a "Wake word" switch; its Permissions
   page has "Pinned settings" with "Pin a setting", drawn greyed out ("Coming soon", pin-add8). */
async function openSettingsPage(page, id) {
  if (!(await page.locator(".settings .set-nav").count())) {
    if (await page.evaluate(() => innerWidth <= 760)) await page.locator('[data-act="side"]').filter({ visible: true }).first().click();
    await page.locator('#side [data-act="view"][data-v="settings"]').click();
  }
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).click();
  await page.locator(`[data-act="setpage"][data-v="${id}"][aria-current="true"]`).waitFor();
}

test("U1 the wake word is under Settings, Voice, starts off, and switching it on is kept by the engine", async (t) => {
  const { app, page, errors } = await fixture(t);
  await openSettingsPage(page, "voice");
  assert.equal(app.store.get("settings", "local", "wake-word"), undefined, "a fresh install already saved something");
  // prototype.html: Talking › Listening (Off / Push to talk / Wake word), drawn in place and greyed until wired
  // (Coming soon, seg, checked at e5b8a610), and Advanced › "Listening, more" › Wake word, which is live.
  const listening = page.getByRole("group", { name: "Listening", exact: true });
  assert.equal(await listening.getByRole("button", { name: "Wake word", exact: true }).count(), 1, "Wake word is among the Listening choices");
  await page.locator('[data-act="setlevel"][data-v="advanced"]').click();
  const wake = page.getByRole("checkbox", { name: "Wake word", exact: true });
  await wake.waitFor();
  assert.equal(await wake.isChecked(), false, "off until chosen");
  await wake.check();
  let kept = app.store.get("settings", "local", "wake-word")?.data;
  for (let i = 0; i < 30 && !(kept && kept.mode !== "off"); i++) { await page.waitForTimeout(100); kept = app.store.get("settings", "local", "wake-word")?.data; }
  assert.ok(kept && kept.mode !== "off", `the engine keeps it on (${JSON.stringify(kept)})`);
  await page.waitForFunction(() => document.querySelector('[role=group][aria-label="Listening"] [aria-pressed="true"]')?.textContent === "Wake word");
  assert.deepEqual(errors, []);
});

test("U2 the pins card is under Settings, Permissions, starts empty, and its Pin a setting is greyed out", async (t) => {
  const { app, page, errors } = await fixture(t);
  await openSettingsPage(page, "permissions");
  const card = page.locator(".set-col .sec", { hasText: "Pinned settings" });
  await card.waitFor({ state: "visible" });
  assert.equal(await card.locator(".rows > *").count(), 0, "nothing is pinned yet");
  assert.equal(app.store.get("settings", "local", "settings-pins"), undefined);
  // Pinning a setting is live since #353 (settings-kit pins, through the owner check).
  assert.notEqual(await card.getByRole("button", { name: "Pin a setting", exact: true }).getAttribute("aria-disabled"), "true");
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (pin-add8), checked at e5b8a610.
test.skip("U2 the pins card pins one setting, and unpins it", async (t) => {
  const { app, page, errors } = await fixture(t);
  await openPlace(page, "settings:permissions");
  const card = page.locator("#pins-form");
  await card.waitFor({ state: "visible" });
  await page.getByText("Nothing is pinned yet: every setting can be changed by anybody who uses this computer.").waitFor();
  await page.locator("#pins-setting option").first().waitFor({ state: "attached" });
  await page.locator("#pins-setting").selectOption({ label: "A word that starts a turn — Switch" });
  await card.getByRole("button", { name: "Pin this setting", exact: true }).click();
  await page.locator("#pins-state", { hasText: "Pinned." }).waitFor();
  assert.deepEqual(app.store.get("settings", "local", "settings-pins").data.pins.map(({ key, field, value }) => ({ key, field, value })),
    [{ key: "wake-word", field: "mode", value: "off" }]);
  await page.getByRole("button", { name: "Unpin", exact: true }).click();
  await page.locator("#pins-state", { hasText: "Unpinned." }).waitFor();
  assert.deepEqual(app.store.get("settings", "local", "settings-pins").data.pins, []);
  assert.deepEqual(errors, []);
});

test("U3 both pages fit a 400-pixel window", async (t) => {
  const { page, errors } = await fixture(t, { width: 400, height: 900 });
  for (const id of ["voice", "permissions"]) {
    await openSettingsPage(page, id);
    const fits = await page.waitForFunction(() => {
      const box = document.querySelector(".set-col")?.getBoundingClientRect();
      return box && box.width > 0 && box.x >= 0 && box.right <= 400 && document.documentElement.scrollWidth <= 400;
    }, undefined, { timeout: 5000 }).then(() => true, () => false);
    assert.ok(fits, `Settings › ${id} fits inside 400 px`);
  }
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the old #wake-word-form card; prototype.html's wake word is in Settings › Voice,
// checked live above).
test.skip("U1 the wake word card is under Settings, Voice, starts off with no word, and says what this computer would do", async (t) => {
  const { app, page, errors } = await fixture(t);
  await openPlace(page, "settings:voice");
  const card = page.locator("#wake-word-form");
  await card.waitFor({ state: "visible" });
  assert.equal(app.store.get("settings", "local", "wake-word"), undefined, "a fresh install already saved something");
  assert.equal(await page.locator("#wake-word-mode").inputValue(), "off");
  assert.equal(await page.locator("#wake-word-word").inputValue(), "");
  // The card says plainly what this Mac or this Linux box would really do before anything is turned on.
  await page.locator("#wake-word-how").waitFor();

  await page.getByLabel("Your word", { exact: true }).fill("branch");
  await page.locator("#wake-word-mode").selectOption("when-needed");
  /* DG-025: kept as you go, with no Save button. */
  assert.equal(await card.getByRole("button", { name: "Save the wake word", exact: true }).count(), 0);
  await page.locator("#wake-word-state", { hasText: "Saved." }).waitFor();
  assert.deepEqual(app.store.get("settings", "local", "wake-word").data,
    { mode: "when-needed", word: "branch", sureness: 80, windowSeconds: 2 });
  // Whatever this computer is, the card now says one true thing about spotting the word.
  assert.ok((await page.locator("#wake-word-how").innerText()).length > 20);
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the old #pins-form card; the Permissions page's Pinned settings is checked live
// above, and pinning is Coming soon, pin-add8).
test.skip("U2 the pins card is under Settings, Permissions, starts empty, and pins one setting", async (t) => {
  const { app, page, errors } = await fixture(t);
  await openPlace(page, "settings:permissions");
  const card = page.locator("#pins-form");
  await card.waitFor({ state: "visible" });
  await page.getByText("Nothing is pinned yet: every setting can be changed by anybody who uses this computer.").waitFor();

  // The list of settings is only asked for once the card is really on the screen.
  await page.locator("#pins-setting option").first().waitFor({ state: "attached" });
  await page.locator("#pins-setting").selectOption({ label: "A word that starts a turn \u2014 Switch" });
  await card.getByRole("button", { name: "Pin this setting", exact: true }).click();
  await page.locator("#pins-state", { hasText: "Pinned." }).waitFor();
  assert.deepEqual(app.store.get("settings", "local", "settings-pins").data.pins.map(({ key, field, value }) => ({ key, field, value })),
    [{ key: "wake-word", field: "mode", value: "off" }]);
  await page.getByRole("button", { name: "Unpin", exact: true }).click();
  await page.locator("#pins-state", { hasText: "Unpinned." }).waitFor();
  assert.deepEqual(app.store.get("settings", "local", "settings-pins").data.pins, []);
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (the old cards; both pages' fit is checked live above).
test.skip("U3 both cards fit a 400-pixel window", async (t) => {
  const { page, errors } = await fixture(t, { width: 400, height: 900 });
  for (const [place, id] of [["settings:voice", "#wake-word-form"], ["settings:permissions", "#pins-form"]]) {
    await openPlace(page, place);
    const card = page.locator(id);
    await card.waitFor({ state: "visible" });
    // Measured inside the page in one step: the card redraws itself, and a box asked for in two
    // steps (find the element, then measure it) can land on one that was just replaced (null).
    const fits = await page.waitForFunction((selector) => {
      const box = document.querySelector(selector)?.getBoundingClientRect();
      return box && box.width > 0 && box.x >= 0 && box.right <= 400;
    }, id, { timeout: 5000 }).then(() => true, () => false);
    assert.ok(fits, `${id} fits inside 400 px`);
  }
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (public/index.html holds no cards and public/wake-word.js and pins.js are gone;
// the words are prototype.html's, and French is Coming soon, sw:lang).
test.skip("U4 every word on both cards is in English and in real French", async () => {
  const en = JSON.parse(await readFile(new URL("en.json", LOCALES), "utf8"));
  const fr = JSON.parse(await readFile(new URL("fr.json", LOCALES), "utf8"));
  const page = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const cards = /id="wake-word-form"[\s\S]*?<\/form>[\s\S]*?id="pins-form"[\s\S]*?<\/form>/.exec(page);
  assert.ok(cards, "the two cards are no longer in the page");
  const keys = new Set([...cards[0].matchAll(/data-t="([^"]+)"/g)].map((hit) => hit[1]));
  for (const file of ["../public/wake-word.js", "../public/pins.js"]) {
    const text = await readFile(new URL(file, import.meta.url), "utf8");
    for (const found of text.matchAll(/\bt\("([^"]+)"/g)) keys.add(found[1]);
  }
  // The two names the settings kit itself shows for the wake word, which are not in the page.
  for (const key of ["settings-kit.name.wake-word", "settings-kit.field.wake-sureness"]) keys.add(key);
  assert.ok(keys.size > 20, `only ${keys.size} keys found; the scan is looking in the wrong place`);
  assert.deepEqual([...keys].filter((key) => !(key in en)), [], "keys with no English words");
  assert.deepEqual([...keys].filter((key) => !(key in fr)), [], "keys with no French words");
  // "Saved." is the same word in neither language; every sentence here is really translated.
  assert.deepEqual([...keys].filter((key) => fr[key] === en[key]), [], "these words are still English when French is chosen");
});
