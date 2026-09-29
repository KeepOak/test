/* phase2/delight in the window: the pet, achievements and your own background. Everything ships off.
   Redesign: in the new window (public/app/**) these are shell/scene.js (the pet at the foot of the list and the painted
   or own background behind the glass, shell/ownbg.js for the file), shell/celebrate.js (what the engine earned) and
   Settings › Appearance / Achievements. The pet and your own background are switched on with a real click in
   Appearance; achievements have no switch in prototype.html, so they are switched on through the engine's own route.
   The acorn corner, its 3D models and .glb reading are not in the design. Headless only, against 127.0.0.1. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { closeSettings, openSettingFor } from "./places.mjs"; // the old window's helpers, for the skipped bodies only
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { waitInPage } from "./wait-in-page.mjs";

/** A model that answers at once, or waits for `release()` when asked to sort the Downloads folder. */
function slowModel() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return { release: () => release(), provider: { name: "scripted", async complete(request) {
    const asked = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    if (String(asked).includes("Downloads")) await gate;
    return { content: "Done.", toolCalls: [] };
  } } };
}
async function fixture(t, { width = 1440, height = 950, reducedMotion = "no-preference", init, before } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-delight-ui-"));
  const model = slowModel();
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model.provider });
  await before?.(app, app.runtime.owner);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { model.release(); await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion, serviceWorkers: "block" });
  if (init) await page.addInitScript(init);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !/Failed to load resource|Content Security Policy/.test(message.text())) errors.push(message.text()); });
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, server, call, page, errors, model };
}
/** Turns a switch on the way a person does: Settings › Appearance, a real click, then back. (The old window's.) */
async function switchOn(page, id) {
  await openSettingFor(page, `#${id}`);
  await page.locator(`#${id}`).check();
  await closeSettings(page);
}

/* ---------- the new window's ways in ---------- */
async function openSettingsPage(page, id) {
  if (await page.evaluate(() => innerWidth <= 760)) await page.locator('[data-act="side"]').filter({ visible: true }).first().click();
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator(`[data-act="setpage"][data-v="${id}"]`).click();
  await page.locator(`[data-act="setpage"][data-v="${id}"][aria-current="true"]`).waitFor();
}
const backToBranch = (page) => page.locator(".set-nav .set-back").click();
/** Appearance › The pet › Squirrel, then back to the conversation. */
async function petOn(page) {
  await openSettingsPage(page, "appearance");
  await page.locator('[data-act="petset"][data-v="squirrel"]').first().click();
  await page.locator('[data-act="petset"][data-v="squirrel"][aria-pressed="true"]').first().waitFor();
  await backToBranch(page);
  if (await page.evaluate(() => innerWidth <= 760)) await page.locator('[data-act="side"]').filter({ visible: true }).first().click();
  await page.locator("#side #pet-cv").waitFor();
}
/** Appearance › Background › Your own. */
async function ownBackground(page) {
  await openSettingsPage(page, "appearance");
  const own = page.locator('[data-act="bgset"][data-v="own"]');
  if (await own.getAttribute("aria-pressed") !== "true") await own.click();
  await page.locator("#bg-file6").waitFor({ state: "attached" });
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMAAAAwGAQFm2g5eAAAAAElFTkSuQmCC", "base64");
const stored = (page) => page.evaluate(async () => (await indexedDB.databases()).some((db) => db.name === "branch-delight"));
const status = (page, words) => page.getByRole("status").filter({ hasText: words }).first().waitFor();

test("a saved mascot pet displays a regular pet without changing its saved preferences", async (t) => {
  const f = await fixture(t, { reducedMotion: "reduce" });
  await f.call("/api/delight/settings", {
    pets: { on: true, kind: "sprout", name: "Maple", talks: false, tips: false },
    achievements: { on: false, quiet: true }, background: { on: false, scrim: 72 },
  });
  const before = (await f.call("/api/delight")).settings;
  assert.equal(before.pets.kind, "sprout", "the fixture must contain the legacy choice");
  await f.page.reload();
  await f.page.locator('#side .petbox[data-kind="fennec"]').waitFor();
  assert.match(await f.page.locator('#side .petbox img').getAttribute("src"), /\/pets\/fennec\.webp$/);
  assert.match(await f.page.locator('#side .petbox [data-act="pat"]').getAttribute("aria-label"), /Maple/);
  await openSettingsPage(f.page, "appearance");
  assert.equal(await f.page.locator('[data-act="petset"][data-v="sprout"]').count(), 0);
  await f.page.locator('[data-act="petset"][data-v="fennec"][aria-pressed="true"]').first().waitFor();
  assert.deepEqual((await f.call("/api/delight")).settings, before);
  await f.page.locator('[data-act="petset"][data-v="none"]').first().click();
  await f.page.locator('[data-act="petset"][data-v="none"][aria-pressed="true"]').first().waitFor();
  const after = (await f.call("/api/delight")).settings;
  assert.deepEqual(after, { ...before, pets: { ...before.pets, on: false } });
  assert.deepEqual(f.errors, []);
});

/** The window looks for what the engine earned when it redraws (shell/celebrate.js check, on each draw, at most every
    10 s). A person using the window redraws it all the time; here the Places fold is pressed twice now and
    then, which redraws it and changes nothing, until the celebration shows. (That nothing is looked for without a redraw
    is reported as a window bug with the port.) */
async function celebrated(page, selector, text) {
  const target = text ? page.locator(selector, { hasText: text }) : page.locator(selector);
  for (let i = 0; i < 40; i++) {
    if (await target.first().isVisible()) return;
    // Redesign: owner removed the toggle; the Places fold, pressed twice, redraws the same way and changes nothing
    await page.evaluate(() => { document.querySelector('[data-act="places14"]')?.click(); document.querySelector('[data-act="places14"]')?.click(); });
    await target.first().waitFor({ timeout: 1000 }).catch(() => undefined);
  }
  await target.first().waitFor({ timeout: 1000 });
}

/** Writes what the engine has earned while no window is open, then opens the window again. Written under an open
    window, its own look (a redraw, or its timer) could show it and tell the engine before the reload, and the reloaded
    window would then have nothing fresh to show. */
async function earnedWhileAway(f, progress) {
  const url = f.page.url();
  await f.page.goto("about:blank");
  f.app.store.save("settings", f.app.runtime.owner, "delight-achievements", progress);
  await f.page.goto(url);
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
}

/**
 * Notes every timer and animation frame asked for by a delight file, before the page's own scripts run,
 * and every request for the work (achievements, noticed) a delight file makes. In the new window the delight files
 * are shell/scene.js, shell/celebrate.js and shell/ownbg.js.
 */
function watchTimers() {
  const mine = /\/app\/shell\/(scene|celebrate|ownbg)\.js|delight/;
  const asked = (globalThis.__delightTimers = []);
  const fetched = (globalThis.__delightFetches = []);
  const realFetch = globalThis.fetch;
  globalThis.fetch = function (input, ...rest) {
    const from = (new Error().stack ?? "").split(/\r?\n/).slice(2).find((line) => mine.test(line));
    const url = String(input?.url ?? input);
    // Its own switch (/api/delight) is read at start; what it must not ask for while off is the work.
    if (from && /\/api\/(activity|delight\/(achievements|noticed))/.test(url)) fetched.push(`${url} ${from.trim()}`);
    return realFetch.call(this, input, ...rest);
  };
  for (const name of ["setInterval", "setTimeout", "requestAnimationFrame"]) {
    const real = globalThis[name];
    globalThis[name] = function (...args) {
      const from = (new Error().stack ?? "").split(/\r?\n/).slice(2).find((line) => mine.test(line));
      if (from) asked.push(`${name} ${from.trim()}`);
      return real.apply(this, args);
    };
  }
}

// The owner's rule (Q251, 2026-09-26, #327): the pet, achievements and your own background ship on; switched off,
// nothing of delight is drawn, asked for or ticking, and their choices wait in Settings.
test("they ship on, and switched off there is no pet, no own background, no achievements, and their choices wait in Settings", async (t) => {
  const f = await fixture(t, { init: watchTimers });
  const shipped = (await f.call("/api/delight")).settings;
  assert.deepEqual([shipped.pets.on, shipped.achievements.on, shipped.background.on], [true, true, true], "each ships on");
  await f.call("/api/delight/settings", { pets: { on: false }, achievements: { on: false }, background: { on: false } });
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const asked = [];
  f.page.on("request", (request) => { if (/\/api\/delight\/(achievements|noticed)/.test(request.url())) asked.push(new URL(request.url()).pathname); });
  await f.call("/api/run", { prompt: "one" });
  await f.page.waitForTimeout(2500);
  assert.equal(await f.page.locator("#pet-cv").count(), 0);
  assert.equal(await f.page.locator("#bgLayer .bg-media").count(), 0);
  assert.equal(await f.page.locator(".ach-toast, .ach-big").count(), 0);
  const settings = (await f.call("/api/delight")).settings;
  assert.deepEqual([settings.pets.on, settings.achievements.on, settings.background.on], [false, false, false], "each is off once switched off");
  await openSettingsPage(f.page, "appearance");
  assert.equal(await f.page.locator('[data-act="petset"][data-v="none"]').first().getAttribute("aria-pressed"), "true", "the pet waits in Appearance");
  assert.equal(await f.page.locator('[data-act="bgset"][data-v="own"]').getAttribute("aria-pressed"), "false", "your own background waits in Appearance");
  assert.equal(await f.page.locator('[data-act="petwhere15"]').count(), 0, "the pet's own choices wait until it is on");
  const timers = await f.page.evaluate(() => globalThis.__delightTimers), fetched = await f.page.evaluate(() => globalThis.__delightFetches);
  assert.deepEqual(asked, [], "switched off, nothing is asked of the server");
  assert.deepEqual(fetched, [], "not even by a delight file");
  assert.deepEqual(timers, [], "switched off, nothing of delight's ticks");
  assert.deepEqual(f.errors, []);
});

test("the pet walks at the foot of the list and says one thing at a time, inside the list", async (t) => {
  const f = await fixture(t);
  await petOn(f.page);
  assert.match(await f.page.locator("#pet-cv").getAttribute("aria-label"), /Hazel the squirrel/);
  await f.page.locator("#pet-cv").click();
  await f.page.locator("#pet-say:not([hidden])").waitFor();
  const seen = await f.page.evaluate(() => {
    const bubble = document.getElementById("pet-say").getBoundingClientRect(), side = document.getElementById("side").getBoundingClientRect();
    const say = document.getElementById("pet-say"), at = document.elementFromPoint(bubble.left + bubble.width / 2, bubble.top + bubble.height / 2);
    return { shown: document.querySelectorAll(".pet-say:not([hidden])").length, words: say.textContent,
      inside: bubble.left >= side.left - 0.5 && bubble.right <= side.right + 0.5,
      seen: !!at && (at === say || say.contains(at)) };
  });
  assert.equal(seen.shown, 1, "never two bubbles");
  assert.ok(seen.words.trim().length > 0, "it says something");
  assert.equal(seen.inside, true, "the bubble is never cut off by the list's edge");
  assert.equal(seen.seen, true, "and nothing clips or covers it");
  assert.equal((await f.call("/api/delight")).settings.pets.on, true, "the engine keeps the pet on");
  assert.deepEqual(f.errors, []);
});

test("the pet's own menu opens on right-click, never the browser's, and can hide it", async (t) => {
  // Redesign: right-click offers "Hide this" on any part marked data-hide while the engine's right-click-to-hide
  // preference is on (shell/shell.js hideMenu); the pet is marked data-hide="pet".
  const f = await fixture(t);
  const prefs = (await f.call("/api/state")).preferences;
  await f.call("/api/preferences", { ...prefs, rightClickHide: true });
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await petOn(f.page);
  const prevented = f.page.evaluate(() => new Promise((resolve) => document.addEventListener("contextmenu", (e) => setTimeout(() => resolve(e.defaultPrevented)), { once: true })));
  await f.page.locator("#pet-cv").click({ button: "right" });
  assert.equal(await prevented, true, "never the browser's menu");
  await f.page.getByRole("menuitem", { name: "Hide this" }).click();
  await f.page.locator("#pet-cv").waitFor({ state: "detached" });
  assert.deepEqual((await f.call("/api/state")).preferences.hidden, ["pet"]);
  assert.deepEqual(f.errors, []);
});

test("achievements: what a real task earns arrives as a seven-second note, once; Gold and above get a card", async (t) => {
  const f = await fixture(t);
  await f.call("/api/delight/settings", { achievements: { on: true } });
  await f.app.runtime.run({ prompt: "one" });
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await celebrated(f.page, ".ach-toast");
  const note = await f.page.locator(".ach-toast").textContent();
  assert.match(note, /Achievement unlocked/);
  // One at a time, the highest tier first (shell/celebrate.js); the one shown is told to the engine.
  const shown = note.split(" · ")[1];
  let fresh = [{ name: shown }];
  for (let i = 0; i < 20 && fresh.some((a) => a.name === shown); i++) { fresh = (await f.call("/api/delight/achievements")).fresh; await f.page.waitForTimeout(100); }
  assert.equal(fresh.some((a) => a.name === shown), false, "once shown, it is not shown again");
  const sprout = (await f.call("/api/delight/achievements")).list.find((a) => a.id === "tasks:1");
  assert.ok(sprout.got, "the finished task earned Sprout");
  /* A Diamond the engine has earned gets the card with the bigger party; it never covers the message box. */
  const progress = f.app.store.get("settings", f.app.runtime.owner, "delight-achievements");
  const diamond = (await f.call("/api/delight/achievements")).list.find((a) => a.tier === "Diamond");
  await earnedWhileAway(f, { ...progress, got: { ...progress.got, [diamond.id]: "2026-09-25" }, fresh: [diamond.id] });
  await celebrated(f.page, ".ach-big .card");
  const card = await f.page.locator(".ach-big .card").boundingBox(), box = await f.page.locator("#prompt").boundingBox();
  assert.ok(card.y + card.height <= box.y || card.y >= box.y + box.height, "the card never covers the message box");
  await f.page.getByRole("button", { name: "Nice", exact: true }).click();
  assert.equal(await f.page.locator(".ach-big").count(), 0);
  assert.deepEqual(f.errors, []);
});

test("Keep things still shows the card without falling leaves", async (t) => {
  // Redesign: the "Keep things still" switch is Coming soon (sw:a-still, checked at e5b8a610); the computer's own
  // reduced-motion setting, which the window follows too (shell/celebrate.js confetti), stands in for it here.
  const f = await fixture(t, { reducedMotion: "reduce" });
  await f.call("/api/delight/settings", { achievements: { on: true } });
  const high = (await f.call("/api/delight/achievements")).list.find((a) => a.tier === "Godly").id;
  await earnedWhileAway(f, { got: { [high]: "2026-09-25" }, fresh: [high] });
  await celebrated(f.page, ".ach-big .card");
  const ink = await f.page.locator(".ach-big canvas").evaluate((canvas) => canvas.width > 0 && canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data.some((value, i) => i % 4 === 3 && value > 0));
  assert.equal(ink, false, "no confetti falls");
  assert.deepEqual(f.errors, []);
});

test("a past kept from when achievements shipped off shows as earned, each with its day, and none of it pops up", async (t) => {
  // The owner's install kept { achievements: { on: false } } from before Q251 and the window has no switch to undo it:
  // days of tasks, and the page drew only "Keep achievements quiet". That "off" was never chosen, so it reads as on.
  const f = await fixture(t, {
    init: () => {
      window.__pops = [];
      new MutationObserver((changes) => { for (const c of changes) for (const n of c.addedNodes) {
        if (n.nodeType === 1 && (n.classList.contains("ach-toast") || n.classList.contains("ach-big"))) window.__pops.push(n.textContent);
      } }).observe(document, { childList: true, subtree: true });
    },
    before: async (app, owner) => {
      app.store.save("settings", owner, "delight", {
        pets: { on: false, kind: "squirrel", name: "Hazel", talks: true, tips: true }, achievements: { on: false, quiet: false },
        look: { style: "pixel" }, background: { on: false, scrim: 60, fit: "fill" },
      });
      for (let i = 0; i < 5; i++) await app.runtime.run({ prompt: `before the update ${i}` });
    },
  });
  await openSettingsPage(f.page, "achievements");
  await f.page.locator(".set-col .achs").waitFor();
  const view = await f.call("/api/delight/achievements?lang=en");
  const past = view.list.filter((a) => a.got && a.id.startsWith("tasks:")).map((a) => a.name);
  assert.ok(past.length >= 2, "the tasks done before the update are earned");
  for (const name of past) {
    const card = f.page.locator(".set-col .achs .ach:not(.locked)", { has: f.page.locator("b", { hasText: new RegExp(`^${name}$`) }) });
    assert.equal(await card.count(), 1, `${name} is drawn earned`);
    assert.match(await card.getAttribute("title"), /^Bronze · .*\d/, `${name} says its tier and the day it was earned`);
  }
  assert.match(await f.page.locator(".set-col .lede").innerText(), new RegExp(`${view.earned} of 505 unlocked`));
  await f.page.waitForTimeout(12000); // a look of the window's own, at least
  const pops = await f.page.evaluate(() => window.__pops);
  assert.deepEqual(pops.filter((text) => past.some((name) => text.includes(` · ${name} · `))), [], "the past arrives without a pop-up");
  assert.deepEqual(f.errors, []);
});

test("the achievements page lists all 505 and keeps the high ones secret", async (t) => {
  // Redesign: Settings › Achievements (settings/pages/achievements.js) in place of the old sheet: the whole list at
  // once, filtered by the engine's kinds; a locked Godly one has no name or words until it is earned.
  const f = await fixture(t);
  await f.call("/api/delight/settings", { achievements: { on: true } });
  await openSettingsPage(f.page, "achievements");
  await f.page.locator(".set-col .achs").waitFor();
  assert.match(await f.page.locator(".set-col .lede").innerText(), /of 505 unlocked/);
  assert.equal(await f.page.locator(".set-col .achs .ach").count(), 505);
  const godly = await f.page.locator('.set-col .achs .ach[title="Godly"]').evaluateAll((cards) => cards.map((card) => card.querySelector("b").textContent + card.querySelector("small").textContent));
  assert.ok(godly.length >= 60, "there are Godly ones");
  assert.deepEqual([...new Set(godly)], [""], "Godly ones are blank until earned");
  assert.deepEqual(f.errors, []);
});

test("your own background: kept in the window, behind a scrim, refused when too big or not a picture, gone when off", async (t) => {
  const f = await fixture(t);
  await ownBackground(f.page);
  await f.page.locator("#bg-file6").setInputFiles({ name: "tiny.png", mimeType: "image/png", buffer: PNG });
  await f.page.locator("#bgLayer .bg-media").waitFor({ state: "attached" });
  assert.equal(await f.page.locator("#bgLayer .bg-scrim").count(), 1, "behind a scrim");
  assert.equal((await f.call("/api/delight")).settings.background.scrim, 60);
  await f.page.locator(".set-col .ctl b", { hasText: "tiny.png" }).waitFor();
  await f.page.locator("#bg-file6").setInputFiles({ name: "huge.png", mimeType: "image/png", buffer: Buffer.alloc(9 * 1024 * 1024) });
  await status(f.page, /Keep it under 8 MB for a picture/);
  assert.equal(await f.page.locator(".set-col .ctl b", { hasText: "tiny.png" }).count(), 1, "the big file was not kept");
  await f.page.locator("#bg-file6").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hi") });
  await status(f.page, /can’t go behind the glass/);
  // A 3D model from anywhere is never read in this window: it is refused like any other file that is not a picture.
  await f.page.locator("#bg-file6").setInputFiles({ name: "model.glb", mimeType: "model/gltf-binary", buffer: Buffer.from("glTF\u0002\u0000\u0000\u0000garbage") });
  await status(f.page, /can’t go behind the glass/);
  assert.equal(await f.page.locator(".set-col .ctl b", { hasText: "tiny.png" }).count(), 1, "the picture is kept");
  await f.page.locator('[data-act="bgset"][data-v="none"]').click();
  await f.page.locator("#bgLayer .bg-media").waitFor({ state: "detached" });
  assert.equal((await f.call("/api/delight")).settings.background.on, false);
  assert.deepEqual(f.errors, []);
});

test("at phone width the pet stays inside the folded list and nothing scrolls sideways", async (t) => {
  // Reduced motion: the list slides in, and measuring mid-slide under load put the pet outside a list still moving.
  const f = await fixture(t, { width: 390, height: 844, reducedMotion: "reduce" });
  await f.call("/api/delight/settings", { pets: { on: true } });
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await f.page.locator('[data-act="side"]').filter({ visible: true }).first().click();
  await f.page.locator("#pet-cv").waitFor();
  const pet = await f.page.locator("#pet-cv").boundingBox(), side = await f.page.locator("#side").boundingBox();
  assert.ok(pet.x >= side.x && pet.x + pet.width <= side.x + side.width + 0.5);
  assert.equal(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(f.errors, []);
});

/** The smallest .glb there is: one triangle, no normals, one base colour. */
function tinyGlb() {
  const positions = new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]);
  const bin = Buffer.from(positions.buffer);
  const json = Buffer.from(JSON.stringify({
    asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, translation: [5, 0, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }], materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [2, 2, 0] }],
  }));
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12), jsonHead = Buffer.alloc(8), binHead = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + padded.length + 8 + bin.length, 8);
  jsonHead.writeUInt32LE(padded.length, 0); jsonHead.writeUInt32LE(0x4e4f534a, 4);
  binHead.writeUInt32LE(bin.length, 0); binHead.writeUInt32LE(0x004e4942, 4);
  return [...Buffer.concat([header, jsonHead, padded, binHead, bin])];
}

// Redesign: replaced by the new window (no 3D acorn or pets in prototype.html; "The oak in 3D" background is Coming
// soon, bgset-oak3d; a .glb is refused, checked in "your own background" above).
test.skip("3D: the acorn and the pet turn in 3D when chosen, and a .glb of your own is read or refused in plain words", async (t) => {
  const f = await fixture(t);
  await f.call("/api/delight/settings", { pets: { on: true }, look: { style: "3d" } });
  await f.page.evaluate(() => globalThis.branchDelight.reload());
  await switchOn(f.page, "appearance-acorn");
  await f.page.locator("#acorn-3d").waitFor();
  await f.page.locator("#pet .pet-3d").waitFor();
  assert.equal(await f.page.locator("#keepoak-acorn").isVisible(), false, "the pixel acorn steps aside");
  const drawn = await f.page.locator("#acorn-3d").evaluate((canvas) => {
    const copy = document.createElement("canvas");
    copy.width = canvas.width; copy.height = canvas.height;
    const g = copy.getContext("2d");
    g.drawImage(canvas, 0, 0);
    return g.getImageData(0, 0, copy.width, copy.height).data.some((value, i) => i % 4 === 3 && value > 0);
  });
  assert.equal(drawn, true, "the 3D acorn is really drawn");
  const read = await f.page.evaluate(async (bytes) => {
    const { readGlb } = await import("/delight-3d.js");
    const parts = readGlb(new Uint8Array(bytes).buffer);
    let refused = "";
    try { readGlb(new Uint8Array(40).buffer); } catch (error) { refused = error.message; }
    return { count: parts.length, color: parts[0].color, x: Math.max(...parts[0].positions.filter((_, i) => i % 3 === 0)), refused };
  }, tinyGlb());
  assert.equal(read.count, 1);
  assert.deepEqual(read.color, [1, 0, 0]);
  assert.ok(Math.abs(read.x - 0.95) < 0.01, "moved to the middle and sized to fit, whatever its own units");
  assert.equal(read.refused, "That is not a .glb 3D model.");
  await f.call("/api/delight/settings", { look: { style: "pixel" } });
  await f.page.evaluate(() => globalThis.branchDelight.reload());
  await f.page.locator("#acorn-3d").waitFor({ state: "detached" });
  assert.equal(await f.page.locator("#keepoak-acorn").isVisible(), true, "pixel is back");
  assert.deepEqual(f.errors, []);
});

/* ---------- integration review: untrusted .glb files, storage, and what the window reports ---------- */

test("your own background: a full disk keeps nothing half-kept; choosing None keeps the file, Remove (after a yes) throws it away", async (t) => {
  const f = await fixture(t);
  await ownBackground(f.page);
  await f.page.evaluate(() => {
    const real = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { throw new DOMException("The quota has been exceeded.", "QuotaExceededError"); };
    globalThis.__roomAgain = () => { IDBObjectStore.prototype.put = real; };
  });
  await f.page.locator("#bg-file6").setInputFiles({ name: "tiny.png", mimeType: "image/png", buffer: PNG });
  // Redesign: the words are the browser's (the old window's own sentence is not in the design document).
  await status(f.page, /quota/i);
  assert.equal(await f.page.locator("#bgLayer .bg-media").count(), 0, "nothing half-kept is shown");
  await f.page.evaluate(() => globalThis.__roomAgain());
  await f.page.locator("#bg-file6").setInputFiles({ name: "tiny.png", mimeType: "image/png", buffer: PNG });
  await f.page.locator("#bgLayer .bg-media").waitFor({ state: "attached" });
  assert.equal(await stored(f.page), true);
  // mac7/residuals: switched off it is taken down but kept; switched on again it is back.
  await f.page.locator('[data-act="bgset"][data-v="none"]').click();
  await f.page.locator("#bgLayer .bg-media").waitFor({ state: "detached" });
  assert.equal(await stored(f.page), true, "switching off keeps the file");
  await f.page.locator('[data-act="bgset"][data-v="own"]').click();
  await f.page.locator("#bgLayer .bg-media").waitFor({ state: "attached" });
  await f.page.locator(".set-col .ctl b", { hasText: "tiny.png" }).waitFor();
  // Remove asks first; Keep it keeps it, Remove throws it away.
  await f.page.getByRole("button", { name: "Remove", exact: true }).click();
  const ask = f.page.getByRole("dialog", { name: "Remove your background?" });
  await ask.getByRole("button", { name: "Keep it", exact: true }).click();
  await ask.waitFor({ state: "detached" });
  assert.equal(await stored(f.page), true, "Keep it keeps the file");
  await f.page.getByRole("button", { name: "Remove", exact: true }).click();
  await ask.getByRole("button", { name: "Remove", exact: true }).click();
  await f.page.locator("#bgLayer .bg-media").waitFor({ state: "detached" });
  await waitInPage(f.page, async () => !(await indexedDB.databases()).some((db) => db.name === "branch-delight"));
  await status(f.page, "Removed. Nothing is kept.");
  assert.deepEqual(f.errors, []);
});

test("following the computer's light or dark is noticed, and a flag is told once", async (t) => {
  const f = await fixture(t);
  await f.call("/api/delight/settings", { achievements: { on: true } });
  const told = [];
  f.page.on("request", (request) => { if (request.url().endsWith("/api/delight/noticed")) told.push(request.postData() ?? ""); });
  await openSettingsPage(f.page, "appearance");
  const mode = (v) => f.page.locator(`.set-col .mirrors [data-act="themeset"][data-v="${v}"]`).click();
  await mode("system");
  await mode("dark");
  await mode("system");
  await f.page.waitForTimeout(500);
  assert.equal(told.filter((body) => body.includes("follow-system")).length, 1);
  const view = await f.call("/api/delight/achievements");
  assert.ok(view.list.find((a) => a.id === "noticed:flag:follow-system:1").got, "Follow the sun can really be earned");
  assert.deepEqual(f.errors, []);
});

/* The cheer when a task finishes is a pop-up: with "Show tips and pop-ups" off there is none. */
test("a finished task is cheered only while tips and pop-ups are on", async (t) => {
  for (const popups of [true, false]) {
    const f = await fixture(t);
    await f.call("/api/onboarding", { popups });
    await f.page.reload();
    await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    /** The next GET /api/state the window reads whose runs show one with `status`, listened for before anything happens. */
    const windowSees = (status) => f.page.waitForResponse(async (response) => {
      if (!response.url().includes("/api/state")) return false;
      const runs = (await response.json().catch(() => ({}))).runs ?? [];
      return runs.some((run) => run.prompt === "Sort the Downloads folder" && run.status === status);
    }, { timeout: 60000 });
    const running = windowSees("running");
    const finished = f.app.runtime.run({ prompt: "Sort the Downloads folder" });
    await running;
    // The window draws once the rest of that look (the people list is read last) has come back (core/state.js refresh).
    let lastState = Promise.resolve(false);
    const looked = new Promise((done) => f.page.on("response", (response) => {
      if (response.url().includes("/api/state")) lastState = response.json().then((state) =>
        (state.runs ?? []).some((run) => run.prompt === "Sort the Downloads folder" && run.status === "completed"), () => false);
      else if (response.url().includes("/api/profiles")) void lastState.then((completed) => { if (completed) done(); });
    }));
    f.model.release();
    await finished;
    await looked;
    await f.page.waitForTimeout(500);
    assert.equal(await f.page.locator(".cheer11").count(), popups ? 1 : 0, popups ? "control: the finished task is cheered" : "no cheer card while tips and pop-ups are off");
    assert.deepEqual(f.errors, []);
  }
});
