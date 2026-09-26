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
  before?.(app, app.runtime.owner);
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

// Redesign: replaced by the new window (prototype.html has no acorn corner or rotation pause; the pet walks at the
// foot of the list).
test.skip("the acorn sits in the rail's corner without a caption, and its pause is an icon with a name", async (t) => {
  const f = await fixture(t);
  await switchOn(f.page, "appearance-acorn");
  const corner = await f.page.locator("#delight-corner").boundingBox(), rail = await f.page.locator("#conversation-rail").boundingBox();
  const foot = await f.page.locator(".rail-foot").boundingBox();
  assert.ok(corner.y + corner.height <= foot.y + 1 && corner.x >= rail.x, "just above the rail's foot, inside the rail");
  assert.equal(await f.page.locator("#acorn-hint").count(), 0, "no DRAG THE ACORN caption");
  assert.equal(await f.page.locator("#keepoak-acorn").getAttribute("title"), "Drag to turn");
  assert.equal((await f.page.locator("#delight-corner").innerText()).trim(), "", "no words under the acorn");
  // integration review: the owner's dithered acorn (#26, #57), drawn a pixel per screen pixel as in the sample.
  const art = await f.page.locator("#keepoak-acorn").evaluate((canvas) => {
    const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
    const drawn = (x, y) => data[(y * canvas.width + x) * 4 + 3] > 0;
    let holes = 0, ink = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 1; x < canvas.width - 1; x++) {
      if (drawn(x, y)) ink++;
      else if (drawn(x - 1, y) && drawn(x + 1, y)) holes++;
    }
    return { width: canvas.width, css: Math.round(canvas.getBoundingClientRect().width), pixelated: getComputedStyle(canvas).imageRendering, holes, ink };
  });
  assert.equal(art.width, art.css, "one pixel of the acorn per screen pixel, like the sample's corner tile");
  assert.equal(art.pixelated, "pixelated");
  assert.ok(art.ink > 150 && art.holes > 20, `the acorn is dithered, not a plain shape (${art.ink} lit, ${art.holes} dither holes)`);
  await f.page.getByRole("button", { name: "Pause rotation", exact: true }).click();
  await f.page.getByRole("button", { name: "Resume rotation", exact: true }).waitFor();
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
    return { shown: document.querySelectorAll(".pet-say:not([hidden])").length, words: document.getElementById("pet-say").textContent,
      inside: bubble.left >= side.left - 0.5 && bubble.right <= side.right + 0.5 };
  });
  assert.equal(seen.shown, 1, "never two bubbles");
  assert.ok(seen.words.trim().length > 0, "it says something");
  assert.equal(seen.inside, true, "the bubble is never cut off by the list's edge");
  assert.equal((await f.call("/api/delight")).settings.pets.on, true, "the engine keeps the pet on");
  assert.deepEqual(f.errors, []);
});

// Redesign: replaced by the new window (prototype.html's pet says a tip when clicked and speaks up by itself only when
// a Trunk needs a yes; it has no "Working on it…" bubble while a task works).
test.skip("the pet lives in the corner, works while a task works, and says one thing at a time, inside the rail", async (t) => {
  const f = await fixture(t);
  await switchOn(f.page, "delight-pet-on");
  await f.page.locator("#pet").waitFor();
  assert.match(await f.page.locator("#pet").getAttribute("aria-label"), /Hazel the squirrel/);
  /* ci-flakes-4: the bubble is up only for the words' reading time (3 s for these), so the watching is
     set up in the page before the task starts and reads it every 100 ms from the moment the words
     appear. Measuring over Playwright round trips read a bubble that had already had its time on a busy
     Windows machine (boundingBox was null). Everything it proved is still proved, on every reading
     rather than on two. On a slow machine the page is over 20 s old by now, so a tip (one at a time,
     up to 8 s) may be showing when the task starts; the pet says it is working once the tip has had its time. */
  const watching = f.page.evaluate(() => new Promise((resolve) => {
    let began = 0, most = 0;
    const words = new Set(), cutOff = [];
    const read = () => {
      const bubble = document.getElementById("pet-say"), rail = document.getElementById("conversation-rail");
      most = Math.max(most, document.querySelectorAll(".pet-say:not([hidden])").length);
      if (bubble && !bubble.hidden && rail) {
        if (!began && bubble.textContent === "Working on it…") began = Date.now();
        if (began) {
          words.add(bubble.textContent);
          const box = bubble.getBoundingClientRect(), edge = rail.getBoundingClientRect();
          if (box.left < edge.left - 0.5 || box.right > edge.right + 0.5) cutOff.push([box.left - edge.left, box.right - edge.right]);
        }
      }
      if (began && Date.now() - began >= 1200) done();
    };
    const done = () => { clearInterval(timer); resolve({ began: began > 0, most, words: [...words], cutOff }); };
    const timer = setInterval(read, 100);
    setTimeout(done, 40000);
  }));
  void f.call("/api/run", { prompt: "Sort my Downloads folder." }).catch(() => undefined);
  const watched = await watching;
  assert.equal(watched.began, true, "the pet says 'Working on it…' while a task works");
  assert.equal(watched.most, 1, "never two bubbles");
  assert.deepEqual(watched.words, ["Working on it…"], "the words do not flicker while they are shown");
  assert.deepEqual(watched.cutOff, [], "the bubble is never cut off by the rail's edge");
  f.model.release();
  await f.page.waitForFunction(() => document.getElementById("pet-say")?.textContent !== "Working on it…", null, { timeout: 15000 });
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
  f.app.store.save("settings", f.app.runtime.owner, "delight-achievements", { ...progress, got: { ...progress.got, [diamond.id]: "2026-09-25" }, fresh: [diamond.id] });
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
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
  f.app.store.save("settings", f.app.runtime.owner, "delight-achievements", { got: { [high]: "2026-09-25" }, fresh: [high] });
  await f.page.reload();
  await f.page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await celebrated(f.page, ".ach-big .card");
  const ink = await f.page.locator(".ach-big canvas").evaluate((canvas) => canvas.width > 0 && canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data.some((value, i) => i % 4 === 3 && value > 0));
  assert.equal(ink, false, "no confetti falls");
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

// Redesign: replaced by the new window (prototype.html's pet has no rank-based tips; it speaks up by itself only when a
// Trunk needs a yes, at most every five minutes, shell/scene.js).
test.skip("tips get scarcer as the rank rises: Bronze every few minutes, Silver hourly, Gold and up never", async (t) => {
  const f = await fixture(t);
  const gaps = await f.page.evaluate(async () => {
    const { state } = await import("/delight-kit.js");
    const { tipGap } = await import("/delight-pet.js");
    return ["Bronze", "Silver", "Gold", "Diamond", "Godly"].map((rank) => { state.rank = rank; return tipGap(); });
  });
  assert.deepEqual(gaps, [180000, 3600000, Infinity, Infinity, Infinity]);
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

// Redesign: replaced by the new window (it never reads a .glb: shell/ownbg.js refuses one before reading it, checked
// in "your own background" above).
test.skip(".glb files from anywhere: truncated, garbage, huge counts, loops and too much detail fail cleanly and fast", async (t) => {
  const f = await fixture(t);
  const result = await f.page.evaluate(async () => {
    const { readGlb, view3d, GlbError, GLB_LIMITS } = await import("/delight-3d.js");
    function glb(json, bin, version = 2) {
      const text = new TextEncoder().encode(JSON.stringify(json)), jl = (text.length + 3) & ~3, bl = (bin.byteLength + 3) & ~3;
      const out = new Uint8Array(28 + jl + bl), view = new DataView(out.buffer);
      view.setUint32(0, 0x46546c67, true); view.setUint32(4, version, true); view.setUint32(8, out.length, true);
      view.setUint32(12, jl, true); view.setUint32(16, 0x4e4f534a, true); out.fill(0x20, 20, 20 + jl); out.set(text, 20);
      view.setUint32(20 + jl, bl, true); view.setUint32(24 + jl, 0x004e4942, true); out.set(new Uint8Array(bin), 28 + jl);
      return out.buffer;
    }
    const model = (count, extra = {}) => ({
      asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: count * 12 }],
      accessors: [{ bufferView: 0, componentType: 5126, count, type: "VEC3" }], ...extra,
    });
    const corners = (count) => { const p = new Float32Array(count * 3); for (let i = 0; i < p.length; i++) p[i] = Math.sin(i * 12.9898) * 3; return p.buffer; };
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const outcome = (buffer) => {
      const began = performance.now();
      try { const parts = readGlb(buffer); return { ok: true, parts: parts.length, ms: performance.now() - began }; }
      catch (error) { return { ok: false, clean: error instanceof GlbError && error.key.startsWith("delight.glb."), key: error.key, what: String(error), ms: performance.now() - began }; }
    };
    const good = glb(model(3), corners(3));
    const cases = {};
    cases.truncated = Array.from({ length: good.byteLength }, (_, n) => outcome(good.slice(0, n)));
    cases.garbage = Array.from({ length: 150 }, () => {
      const bytes = new Uint8Array(20 + Math.floor(random() * 400)).map(() => Math.floor(random() * 256));
      new DataView(bytes.buffer).setUint32(0, 0x46546c67, true);
      if (random() < 0.5) new DataView(bytes.buffer).setUint32(4, 2, true);
      return outcome(bytes.buffer);
    });
    cases.flipped = Array.from({ length: 150 }, () => {
      const bytes = new Uint8Array(good.slice(0));
      bytes[Math.floor(random() * bytes.length)] ^= 1 << Math.floor(random() * 8);
      return outcome(bytes.buffer);
    });
    cases.hugeCount = outcome(glb(model(3, { accessors: [{ bufferView: 0, componentType: 5126, count: 2 ** 31, type: "VEC3" }] }), corners(3)));
    cases.hugeView = outcome(glb(model(3, { bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 2 ** 32 }] }), corners(3)));
    const indexed = new ArrayBuffer(48);
    new Float32Array(indexed, 0, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    new Uint32Array(indexed, 36, 3).set([0, 1, 99]);
    cases.badIndex = outcome(glb(model(3, {
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 12 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" }, { bufferView: 1, componentType: 5125, count: 3, type: "SCALAR" }],
    }), indexed));
    cases.loop = outcome(glb(model(3, { nodes: [{ mesh: 0, children: [1] }, { mesh: 0, children: [0, 1] }] }), corners(3)));
    const fan = Array.from({ length: 40 }, (_, i) => ({ mesh: 0, children: i < 39 ? Array(50).fill(i + 1) : [] }));
    cases.fan = outcome(glb(model(3, { nodes: fan }), corners(3)));
    const every = (n) => Array.from({ length: n }, (_, i) => i);
    cases.manyNodes = outcome(glb(model(3, { scenes: [{ nodes: every(5000) }], nodes: every(5000).map(() => ({ mesh: 0 })) }), corners(3)));
    cases.instances = outcome(glb(model(3000, { scenes: [{ nodes: every(200) }], nodes: every(200).map(() => ({ mesh: 0 })) }), corners(3000)));
    const notJson = new Uint8Array(glb(model(3), corners(3)));
    notJson[20] = 0x7b; notJson[21] = 0x7b;
    cases.notJson = outcome(notJson.buffer);
    cases.tooBig = outcome(new ArrayBuffer(GLB_LIMITS.bytes + 1));
    const big = readGlb(glb(model(150_000), corners(150_000)));
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    document.body.append(canvas);
    let drawn = null;
    try { drawn = view3d(canvas, big, { still: () => true }) !== null; } catch (error) { drawn = String(error); }
    canvas.remove();
    return { cases, bigCorners: big.reduce((n, p) => n + p.positions.length / 3, 0), drawn };
  });
  const all = Object.values(result.cases).flat();
  for (const c of all) assert.ok(c.ok || c.clean, `refused in plain words, never a raw error: ${c.what}`);
  assert.ok(all.every((c) => c.ms < 1500), `each file is decided quickly (slowest ${Math.max(...all.map((c) => c.ms)).toFixed(0)} ms)`);
  assert.equal(result.cases.truncated.at(-1)?.ok, false, "a file one byte short is refused");
  assert.equal(result.cases.hugeCount.key, "delight.glb.broken");
  assert.equal(result.cases.hugeView.key, "delight.glb.broken");
  assert.equal(result.cases.badIndex.key, "delight.glb.broken");
  assert.equal(result.cases.loop.ok, true, "a node loop is walked once and ends");
  assert.equal(result.cases.loop.parts, 2);
  assert.equal(result.cases.fan.parts, 40, "a branch shared fifty times over is drawn once, not 50^40 times");
  assert.equal(result.cases.manyNodes.key, "delight.glb.tooDetailed");
  assert.equal(result.cases.instances.key, "delight.glb.tooDetailed", "one mesh placed 200 times counts 200 times toward the limit");
  assert.equal(result.cases.notJson.key, "delight.glb.broken");
  assert.equal(result.cases.tooBig.key, "delight.glb.tooBig");
  assert.equal(result.bigCorners, 150000);
  assert.equal(result.drawn, true, "a detailed model is drawn (its corners are copied, never spread into push)");
  assert.deepEqual(f.errors, []);
});

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
  await f.page.waitForFunction(async () => !(await indexedDB.databases()).some((db) => db.name === "branch-delight"));
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
