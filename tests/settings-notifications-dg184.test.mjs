/* DG-184: Settings › Notifications is the approved sample's page: its one section, When Branch gets your attention,
   with Hold messages overnight, Where you are told and Sound on show at Regular and "5 more with Advanced" for the
   rest; its cards read as that section's rows, with no titles of their own (DG-008, DG-024), and every choice is
   saved the moment it changes, with no Save button (DG-025). The same at 1440 and 400 px, with Show everything on
   and off, and in French. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, readComfort } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { settingsWindow, openSettingsPage, setLevel } from "./settings-window.mjs";

const REGULAR = ["hold-overnight", "comfort-method", "comfort-sound"];
const ADVANCED = ["hold-from", "hold-until", "holidays", "quiet-switch-news", "heartbeat-second"];

/* The new window: Settings › Notifications is the prototype's page, the same at 1440 and 400 px and at every level: its
   title, "Tell me when…" and "Updates"; every choice is saved the moment it is pressed, with no Save button; and what it
   says about quiet hours is what the engine keeps. */
test("DG-184 Notifications has the prototype's sections at 1440 and 400 px and every level, with no Save button", async (t) => {
  const { page, errors } = await settingsWindow(t, { name: "notifications" });
  for (const width of [1440, 400]) {
    await page.setViewportSize({ width, height: 950 });
    for (const one of ["regular", "advanced", "technical"]) {
      await openSettingsPage(page, "notifications");
      await setLevel(page, one);
      const col = page.locator(".set-col");
      const headings = await col.locator("h1, h2, h3, h4").evaluateAll((all) => all.filter((node) => node.checkVisibility()).map((node) => node.textContent.trim()));
      // The prototype's page has "Quiet" (days off) after "Tell me when…".
      assert.deepEqual(headings, ["Notifications", "Tell me when…", "Quiet", "Updates"], `${width} px, ${one}`);
      assert.equal(await col.getByRole("button", { name: /^Save/ }).count(), 0, "saved as you go");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, `${width} px: no sideways scrolling`);
    }
  }
  assert.deepEqual(errors, []);
});

test("DG-184 each choice on Notifications is saved the moment it is pressed", async (t) => {
  const { app, page, errors } = await settingsWindow(t, { name: "notifications" });
  await openSettingsPage(page, "notifications");
  const col = page.locator(".set-col");
  const press = async (group, choice, key, value) => {
    await col.getByRole("group", { name: group, exact: true }).getByRole("button", { name: choice, exact: true }).click();
    for (let tries = 0; tries < 50 && readComfort(app.store, "local", "notify")[key] !== value; tries++) await page.waitForTimeout(100);
    assert.equal(readComfort(app.store, "local", "notify")[key], value, `${group} › ${choice}`);
    await col.getByRole("group", { name: group, exact: true }).getByRole("button", { name: choice, exact: true, pressed: true }).waitFor();
  };
  await press("Play a sound", "A chime", "sound", "chime");
  await press("Notifications", "In the app", "method", "window");
  await press("Check for updates", "Daily", "autoUpdate", "check");
  /* The release channel keeps its choices exactly: Stable and Beta, the two channels since #420. */
  assert.deepEqual((await col.getByRole("group", { name: "Release channel", exact: true }).getByRole("button").allInnerTexts()).map((w) => w.trim()),
    ["Stable", "Beta"]);
  assert.deepEqual(errors, []);
});

test("DG-184 Notifications says only what the engine keeps about quiet hours", async (t) => {
  const { page, errors, call } = await settingsWindow(t, { name: "notifications" });
  const quiet = (await call("/api/calendar")).settings.quietHours;
  assert.equal(quiet.enabled, false, "a fresh install holds nothing overnight");
  await openSettingsPage(page, "notifications");
  await page.locator(".set-col").getByRole("heading", { name: "Tell me when…", exact: true }).waitFor();
  assert.doesNotMatch(await page.locator(".set-col").innerText(), /Quiet hours are/, "quiet hours are off, so the page must not say when they are");
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (public/settings-buckets.js is gone; the prototype's sections are checked above).
test.skip("DG-184 Notifications has the sample's one section, days off first, every card kept", async () => {
  const { BUCKETS } = await import("../public/settings-buckets.js");
  assert.deepEqual(BUCKETS.notifications.map((bucket) => bucket[2]), ["When Branch gets your attention"]);
  assert.deepEqual(BUCKETS.notifications[0][4].map(([card]) => card), ["lx-collab-days-off", "comfort-notify-card", "quiet-interruptions"]);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-notifications-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body ? "POST" : "GET", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  errors.length = 0;
  await page.locator("body.sg-ready").waitFor({ state: "attached" });
  await page.keyboard.press("ControlOrMeta+Comma");
  await page.locator("#settings-window").waitFor({ state: "visible" });
  await page.evaluate(() => globalThis.branchLayout.go("settings:notifications"));
  await page.locator("#heartbeat-second").waitFor({ state: "attached" });
  await page.locator("#hold-overnight").waitFor({ state: "attached" });
  await page.locator("#comfort-sound").waitFor({ state: "attached" });
  await settled(page);
  return { app, page, call, errors };
}
/* The cards come from three modules that each draw when their data arrives. Settings levels a redrawn card's rows in
   the same turn and puts the page in order and counts it on the next frame, so one frame after the last card is
   there (requestAnimationFrame runs in the order asked) the page is settled. */
const settled = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done())));
/* Choosing a level applies it, rows and "N more" count included, before the next task: the level on <html> is the signal. */
const level = (page, value) => page.evaluate((one) => globalThis.branchSettingsLevel.set(one), value)
  .then(() => page.waitForFunction((one) => document.documentElement.dataset.settingsLevel === one, value))
  .then(() => settled(page));
/** What the page shows: its headings, its "N more" line, the settings on show, and any Save button. */
const shown = (page) => page.evaluate((ids) => {
  const box = document.getElementById("lx-page-notifications");
  const seen = (node) => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== "hidden";
  const text = (node) => node.textContent.trim().replace(/\s+/g, " ");
  return {
    headings: [...box.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter(seen).map(text),
    more: [...box.querySelectorAll(".sg-more")].filter(seen).map(text),
    controls: ids.filter((id) => { const node = document.getElementById(id); return node && box.contains(node) && seen(node); }),
    saves: [...box.querySelectorAll("button")].filter(seen).filter((button) => /^(Save|Enregistrer)$/.test(text(button))).length,
    wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
}, [...REGULAR, ...ADVANCED]);

// Redesign: replaced by the new window (the prototype's sections, re-pointed above; it has no "N more" line, no Show
// everything, and no days off, overnight hold or holidays rows).
test.skip("DG-184 the page's sections, counts and rows match the sample at 1440 and 400, Show everything on and off", async (t) => {
  const { page, errors } = await fixture(t);
  for (const width of [1440, 400]) {
    await page.setViewportSize({ width, height: 950 });
    for (const everything of ["off", "on"]) {
      await page.evaluate((one) => { document.documentElement.dataset.everything = one; }, everything);
      const where = `${width} px, Show everything ${everything}`;
      await level(page, "regular");
      const regular = await shown(page);
      assert.deepEqual(regular.headings, ["Notifications", "When Branch gets your attention"], where);
      assert.deepEqual(regular.more, ["5 more with Advanced"], where);
      assert.deepEqual(regular.controls, REGULAR, where);
      assert.equal(regular.saves, 0, `${where}: saved as you go`);
      assert.ok(regular.wide <= 0, `${where}: no sideways scrolling`);
      await level(page, "advanced");
      const advanced = await shown(page);
      assert.deepEqual(advanced.headings, ["Notifications", "When Branch gets your attention"], where);
      assert.deepEqual(advanced.more, [], where);
      assert.deepEqual(advanced.controls, [...REGULAR, ...ADVANCED], where);
      assert.equal(advanced.saves, 0, where);
    }
  }
  assert.deepEqual(errors, []);
});

// Redesign: replaced by the new window (its choices are segments, re-pointed above; the prototype has no overnight hold
// switch or news gate on this page).
test.skip("DG-184 each choice on the page is saved the moment it changes", async (t) => {
  const { app, page, call, errors } = await fixture(t);
  await level(page, "advanced");
  await page.locator("#comfort-sound").selectOption("chime");
  await page.waitForFunction(() => document.querySelector("#comfort-notify-card [role=status]")?.textContent.trim().length > 0);
  assert.equal(readComfort(app.store, "local", "notify").sound, "chime");
  await page.locator("#hold-overnight").check();
  await page.waitForFunction(() => document.getElementById("hold-overnight")?.checked);
  await page.waitForTimeout(500);
  assert.equal((await call("/api/calendar")).settings.quietHours.enabled, true);
  await page.locator("#quiet-switch-news").selectOption("on");
  await page.waitForTimeout(800);
  assert.equal((await app.scheduler.overview("local")).switches.notifyGate, "on");
  assert.deepEqual(errors, []);
});

// Redesign: Coming soon (sw:lang), checked at fc541c24.
test.skip("DG-184 in French the page keeps its one section and its rows speak French", async (t) => {
  const { page, errors } = await fixture(t);
  await page.evaluate(async () => (await import("/i18n.js")).setLanguage("fr"));
  await page.waitForTimeout(500);
  await level(page, "regular");
  const regular = await shown(page);
  assert.equal(regular.headings.length, 2);
  assert.equal(regular.headings[1], "Quand Branch attire votre attention");
  assert.deepEqual(regular.controls, REGULAR);
  await level(page, "advanced");
  const words = await page.evaluate(() => ["hold-overnight", "hold-from", "hold-until", "holidays"]
    .map((id) => document.getElementById(id).labels[0].textContent.trim()));
  assert.deepEqual(words, ["Retenir les messages la nuit", "Retenir les messages à partir de", "Retenir les messages jusqu’à", "Jours fériés de"]);
  assert.deepEqual(errors, []);
});
