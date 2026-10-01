/* A deterministic scheduler regression, independent of graphics drivers and the live engine. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function fixture() {
  let id = 0, now = 0, rest = "awake", overlays = 0, notify, restChanged;
  const raf = new Map(), timers = new Map(), events = new Map(), delays = [];
  const document = { hidden: false, querySelector: () => overlays > 0,
    getElementById: () => ({}), addEventListener: (n, f) => events.set(n, f), removeEventListener: (n) => events.delete(n) };
  const context = vm.createContext({ document, performance: { now: () => now },
    windowRest: () => rest, onRest: (f) => { restChanged = f; },
    MutationObserver: class { constructor(f) { notify = f; } observe() {} disconnect() { notify = null; } },
    requestAnimationFrame: (f) => { raf.set(++id, f); return id; }, cancelAnimationFrame: (i) => raf.delete(i),
    setTimeout: (f, delay) => { delays.push(delay); timers.set(++id, f); return id; }, clearTimeout: (i) => timers.delete(i) });
  const source = (await readFile(new URL("../public/app/shell/procbg.js", import.meta.url), "utf8"))
    .replace(/^import .*;$/gm, "").replace(/^export /gm, "");
  vm.runInContext(source + "\nglobalThis.begin = loop;", context);
  const advance = () => {
    for (const [i, f] of [...timers]) { timers.delete(i); f(); }
    for (const [i, f] of [...raf]) { raf.delete(i); f(now += 63); }
  };
  return { context, document, raf, timers, events, advance, delays,
    spend(ms) { now += ms; },
    overlay(n) { overlays = n; notify?.(); },
    rest(value) { rest = value; restChanged(); },
    hidden(value) { document.hidden = value; events.get("visibilitychange")?.(); } };
}

test("procedural scenery parks behind overlays, resumes only after the last closes, and cleans up", async () => {
  const f = await fixture(); let draws = 0;
  const stop = f.context.begin(() => draws++, 16);
  f.advance(); assert.equal(draws, 1);
  assert.equal(f.raf.size, 0, "no every-display-frame RAF while waiting for the next drawing");
  assert.equal(f.timers.size, 1);
  f.overlay(2); f.advance(); assert.equal(draws, 1);
  assert.equal(f.raf.size + f.timers.size, 0);
  f.overlay(1); f.advance(); assert.equal(draws, 1);
  f.overlay(0); f.advance(); assert.equal(draws, 2);
  f.overlay(1); stop(); f.overlay(0); f.hidden(false); f.rest("awake"); f.advance();
  assert.equal(draws, 2, "stopping a parked loop cannot resurrect it");
  assert.equal(f.events.size, 0);
});

test("dismissal cannot wake hidden or resting scenery; visibility and rest wake without duplicate loops", async () => {
  const f = await fixture(); let draws = 0;
  const stop = f.context.begin(() => draws++, 16);
  f.advance(); f.overlay(1); f.hidden(true); f.overlay(0); f.advance(); assert.equal(draws, 1);
  f.rest("doze"); f.hidden(false); f.advance(); assert.equal(draws, 1);
  f.rest("awake"); f.overlay(0); f.hidden(false);
  assert.equal(f.raf.size, 1); f.advance(); assert.equal(draws, 2);
  stop(); assert.equal(f.raf.size + f.timers.size, 0);
});

test("procedural scenery timers preserve frame budgets and compensate drawing time", async () => {
  for (const fps of [16, 20]) {
    const f = await fixture(); let cost = 0;
    const stop = f.context.begin(() => f.spend(cost), fps);
    f.advance(); assert.equal(f.delays.at(-1), 1000 / fps);
    cost = 7.5; f.advance(); assert.equal(f.delays.at(-1), 1000 / fps - cost);
    cost = 100; f.advance(); assert.equal(f.delays.at(-1), 0, "over-budget drawing never schedules a negative timeout");
    assert.equal(f.raf.size, 0, "only a timer waits between drawing opportunities");
    stop();
  }
});

test("painted scenery freezes in place through nested overlays; modal motion and reduced-motion policy survive", async (t) => {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BRANCH_TEST_CHROMIUM ? { executablePath: process.env.BRANCH_TEST_CHROMIUM } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ reducedMotion: "no-preference" });
  await page.setContent('<div id="app"><div id="bgLayer"><div class="paint11 drift11"></div></div></div>');
  for (const file of ["app.css", "app/styles/modal-motion.css"])
    await page.addStyleTag({ content: await readFile(new URL(`../public/${file}`, import.meta.url), "utf8") });
  const status = () => page.evaluate(() => {
    const el = document.querySelector(".paint11"), a = el.getAnimations()[0];
    return { state: a?.playState, transform: getComputedStyle(el).transform };
  });
  assert.equal((await status()).state, "running");
  const before = await page.evaluate(() => {
    const scene = document.querySelector("#bgLayer .paint11");
    scene.getAnimations()[0].currentTime = 20200;
    const transform = getComputedStyle(scene).transform;
    const app = document.querySelector("#app");
    app.insertAdjacentHTML("beforeend", '<div class="ob9"></div><div class="scrim"><i class="paint11 drift11"></i></div>');
    return transform;
  });
  assert.notEqual(before, "matrix(1, 0, 0, 1, 0, 0)", "test starts partway through the drift");
  await page.waitForTimeout(50);
  const held = await status(); assert.equal(held.state, "paused");
  assert.equal(held.transform, before, "opening an overlay preserves the existing transformed frame");
  assert.equal(await page.locator(".scrim .paint11").evaluate((el) => el.getAnimations()[0].playState), "running");
  await page.waitForTimeout(600);
  assert.equal((await status()).transform, held.transform, "no snap to the start or drift behind the scrim");
  await page.locator(".scrim").evaluate((el) => el.remove());
  assert.equal((await status()).state, "paused", "setup still covers the scene");
  await page.locator(".ob9").evaluate((el) => el.remove());
  assert.equal((await status()).state, "running");
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal((await status()).state, undefined, "OS reduced motion is still respected");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => document.documentElement.setAttribute("data-still", ""));
  assert.equal((await status()).state, undefined, "Keep things still is still respected");
});
