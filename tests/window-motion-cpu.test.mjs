/* The idle window with motion on used most of a CPU core: every moving thing (the painted scene under the glass, the
   faces breathing and blinking, the pet) made the window draw 60 times a second. app.css (area: motion-cpu) steps the
   same eased curves a few times a second, and a hidden window pauses its loops and its pet. These tests hold that:
   the scene, a face and the pet change only a few times a second; each stepped value stays on the eased curve it
   came from; a loop is paused while the window is hidden and plays again when it is shown. Headless, against 127.0.0.1.
   Measuring the CPU itself: design/redesign/tools/verify-motion-cpu.cjs. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-motion-cpu-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  for (const name of ["Ledger", "Scout", "Quill"]) await call("/api/trunks", { name, description: "Keeps the numbers" });
  await call("/api/delight/settings", { pets: { on: true, kind: "squirrel" }, background: { on: true } });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, reducedMotion: "no-preference", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#bgLayer .paint11.drift11").waitFor({ state: "attached" });
  /* A small face (core/pebble.js draws faces this small as the flat pebble that breathes and blinks), put where it is
     seen: the Trunks' own faces on this screen are the 3D pebbles. */
  await page.evaluate(() => {
    const face = Object.assign(document.createElement("span"), { className: "av probe-cpu", innerHTML: '<span class="peb"></span><span class="eye l"></span><span class="eye r"></span>' });
    // Keep the CSS probe outside regions redrawn by live state refreshes.
    document.body.append(face);
  });
  await page.locator("#main .av.pbl.pbl-live").first().waitFor({ state: "attached", timeout: 30000 });
  await page.locator("#side .keeper .petbox").waitFor({ state: "attached" });
  await page.waitForTimeout(1000);
  return { page, errors };
}

/* How many different values each animation draws over `ms` of its own time, read every millisecond with the animation
   paused at that moment: a property of the stylesheet, not of how busy the computer is. Every frame at 60 a second
   would be ~120 values in 2 s. */
const drawn = (page, selector, ms) => page.evaluate(([selector, ms]) => {
  const el = document.querySelector(selector), a = el.getAnimations()[0], seen = new Set();
  a.pause();
  for (let t = 0; t < ms; t++) { a.currentTime = 20000 + t; seen.add(getComputedStyle(el).transform); }
  a.play();
  return seen.size;
}, [selector, ms]);

test("idle motion on: the scene, a face and the pet move, a few times a second rather than every frame", async (t) => {
  const { page, errors } = await fixture(t);
  const scene = await drawn(page, "#bgLayer .paint11", 2000), face = await drawn(page, ".probe-cpu .peb", 2000);
  const eye = await drawn(page, ".probe-cpu .eye", 5200);
  // Stepped: the scene 2 a second, a face 7 a second, a blink 3 steps to close and 3 to open.
  assert.ok(scene >= 2 && scene <= 6, `the scene drifts in a few steps (${scene} values in 2 s)`);
  assert.ok(face >= 8 && face <= 20, `a face breathes in a few steps (${face} values in 2 s)`);
  assert.ok(eye >= 3 && eye <= 8, `an eye blinks in a few steps (${eye} values in one 5.2 s blink)`);
  const walk = await page.evaluate(() => getComputedStyle(document.querySelector("#side .keeper .petbox")).transitionTimingFunction);
  assert.equal(walk, "steps(6)", "the pet's 6px step is drawn as six 1px moves");
  assert.deepEqual(errors, []);
});

/* The moments any 3D pebble face was drawn again over `ms`, read from core/pebble.js's own count of drawings. */
const drawMoments = (page, ms) => page.evaluate(async (ms) => {
  const { pebbleStats } = await import("/app/core/pebble.js");
  let last = pebbleStats.draws, moments = 0, draws = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 2));
    if (pebbleStats.draws !== last) { moments++; draws += pebbleStats.draws - last; last = pebbleStats.draws; }
  }
  return { moments, draws };
}, ms);

test("3D pebble faces turn their frames together, at most 24 times a second, so the window draws once for all of them", async (t) => {
  const { page, errors } = await fixture(t);
  const live = await page.locator(".av.pbl.pbl-live").count();
  assert.ok(live >= 3, `several faces move (${live})`);
  const seen = await drawMoments(page, 3000);
  // Each face was drawn at its own moments, up to 35 passes a second; now every face turns its frame at the same moment.
  assert.ok(seen.draws >= live * 12, `the faces keep moving (${seen.draws} drawings of ${live} faces in 3 s)`);
  assert.ok(seen.moments <= 75, `at most 24 passes a second (${seen.moments} moments in 3 s)`);
  assert.ok(seen.draws / seen.moments >= live * 0.8, `the faces are drawn together (${(seen.draws / seen.moments).toFixed(1)} of ${live} a moment)`);
  assert.deepEqual(errors, []);
});

/* CSS ease-in-out, cubic-bezier(.42,0,.58,1): progress at time x. */
function ease(x) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 60; i++) {
    const t = (lo + hi) / 2, bx = 3 * (1 - t) ** 2 * t * 0.42 + 3 * (1 - t) * t * t * 0.58 + t ** 3;
    if (bx < x) lo = t; else hi = t;
  }
  const t = (lo + hi) / 2;
  return 3 * (1 - t) * t * t + t ** 3;
}

test("the stepped motions stay on the eased curves they replace: the look is the same", async (t) => {
  const { page, errors } = await fixture(t);
  /* Pause each animation at a moment and read what it draws, as the scale in its matrix. */
  const at = (selector, ms) => page.evaluate(([selector, ms]) => {
    const el = document.querySelector(selector);
    const a = el.getAnimations()[0];
    a.pause();
    a.currentTime = ms;
    const m = new DOMMatrix(getComputedStyle(el).transform);
    return { a: m.a, d: m.d, name: a.animationName, duration: a.effect.getTiming().duration, delay: a.effect.getTiming().delay };
  }, [selector, ms]);
  const face = await at(".probe-cpu .peb", 0);
  assert.equal(face.name, "breathe11");
  for (let i = 0; i <= 40; i++) {
    const ms = (face.duration * i) / 40, got = await at(".probe-cpu .peb", ms + face.delay);
    const x = ms / face.duration, want = x <= 0.5 ? 1 + 0.035 * ease(x * 2) : 1.035 - 0.035 * ease(x * 2 - 1);
    assert.ok(Math.abs(got.a - want) < 0.005, `breathe at ${Math.round(ms)} ms: ${got.a} is near ${want}`);
  }
  const scene = await at("#bgLayer .paint11", 0);
  assert.equal(scene.name, "drift11");
  for (let i = 0; i <= 40; i++) {
    const ms = (scene.duration * i) / 40, got = await at("#bgLayer .paint11", ms);
    const want = 1 + 0.06 * ease(ms / scene.duration);
    assert.ok(Math.abs(got.a - want) < 0.0025, `drift at ${Math.round(ms)} ms: ${got.a} is near ${want}`);
  }
  assert.deepEqual(errors, []);
});

test("a hidden window pauses its loops and its pet, and both carry on when it is shown again", async (t) => {
  const { page, errors } = await fixture(t);
  await page.locator("#main video").first().waitFor({ state: "attached" });
  await page.waitForFunction(() => !document.querySelector("#main video").paused);
  const flip = (hidden) => page.evaluate((hidden) => {
    Object.defineProperty(document, "visibilityState", { get: () => (hidden ? "hidden" : "visible"), configurable: true });
    Object.defineProperty(document, "hidden", { get: () => hidden, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
  await flip(true);
  assert.equal(await page.evaluate(() => document.querySelector("#main video").paused), true, "the loop is paused while hidden");
  /* A step already under way finishes its 0.32 s move (app.css .petbox transition). Waited for as itself, never as a
     time: on a busy runner a step written just before the hide began to move frames later, and was still moving 500 ms
     on ("the pet does not walk while hidden", 241 !== 238 on CI). */
  await page.waitForFunction(() => document.querySelector("#side .keeper .petbox").getAnimations().length === 0, null, { timeout: 10000 });
  const x0 = await page.evaluate(() => document.querySelector("#side .keeper .petbox").getBoundingClientRect().x);
  await page.waitForTimeout(1200);
  const x1 = await page.evaluate(() => document.querySelector("#side .keeper .petbox").getBoundingClientRect().x);
  assert.equal(x1, x0, "the pet does not walk while hidden");
  const hiddenDraws = await drawMoments(page, 1000);
  assert.equal(hiddenDraws.draws, 0, "no face is drawn while hidden");
  await flip(false);
  await page.waitForFunction(() => !document.querySelector("#main video").paused, null, { timeout: 5000 });
  await page.waitForFunction((x0) => document.querySelector("#side .keeper .petbox").getBoundingClientRect().x !== x0, x0, { timeout: 15000 });
  assert.deepEqual(errors, []);
});
