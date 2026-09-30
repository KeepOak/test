/* Redesign: "How it moves" (the Trunk editor's None, Breathe and Sway, prototype.html st-anim) moves the 3D classic
   pebble (core/pebble.js) as it moves the flat one. None adds nothing to what the face acts out, Breathe adds the
   breathe scale to the rendered body, Sway the bob on the whole face. Read from what the browser computes (animation
   and transform), in the sidebar and in the editor's preview. Reduced motion, the computer's or the engine's Keep things
   still, makes every face a still. Headless, 127.0.0.1. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const scripted = { name: "scripted", async complete() { return { content: "Here it is.", toolCalls: [] }; } };
const LOOK = { face: "pattern", letters: "", emoji: "", shuffle: 0, colour: null, shape: "circle", depth: "flat" };
const MOTIONS = ["none", "breathe", "sway"];

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-pebble-motion-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const trunks = {};
  for (const motion of MOTIONS) {
    const { trunk } = await call("/api/trunks", { name: `Moves ${motion}`, title: "Test", description: "" });
    await call(`/api/trunks/${trunk.id}`, { look: { ...LOOK, motion } });
    trunks[motion] = trunk;
  }
  await app.trunks.introduced();
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { page, errors, trunks };
}

/* What the browser moves on a face: the face's own animation and transform (Sway), and its rendered body's (Breathe),
   plus whether its canvas plays what the Trunk is doing. It is read until both have moved, or until the face's own
   animations have run for half the slowest motion's period (Breathe, 3.2 s); a face with none is read for that long.
   The animations' own clock is used, not the wall's: under load an animation can wait many frames to start, and two
   readings a fixed time apart then read the same. */
const motionOf = (page, selector) => page.evaluate(async (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const body = () => el.querySelector(".pbl-cv") ?? el.querySelector(".pbl-f");
  const read = () => ({ face: getComputedStyle(el).transform, body: getComputedStyle(body()).transform });
  const animations = () => [el, body()].flatMap((node) => node.getAnimations());
  const clock = () => Math.max(0, ...animations().map((animation) => Number(animation.currentTime) || 0));
  const a = read(), wall = performance.now(), started = clock();
  let faceMoves = false, bodyMoves = false;
  while (!(faceMoves && bodyMoves)) {
    await new Promise((r) => setTimeout(r, 20));
    const b = read();
    faceMoves ||= a.face !== b.face;
    bodyMoves ||= a.body !== b.body;
    const ran = animations().length ? clock() - started : performance.now() - wall;
    if (ran >= 1600 || performance.now() - wall > 15000) break;
  }
  return { face: getComputedStyle(el).animationName, body: getComputedStyle(body()).animationName, faceMoves, bodyMoves, canvas: !!el.querySelector(".pbl-cv"), cls: el.className };
}, selector);
const side = (trunk) => `#side .av.pbl[data-pbl-id="${trunk.id}"]`;
const faceCount = (page) => page.evaluate(() => document.querySelectorAll("#side .av.pbl").length);

test("How it moves: None, Breathe and Sway each move the 3D pebble differently, in the sidebar and the editor's preview", async (t) => {
  const { page, errors, trunks } = await fixture(t);
  for (const motion of MOTIONS) await page.locator(side(trunks[motion])).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll("#side .av.pbl canvas").length >= 3, null, { timeout: 30000 });

  const none = await motionOf(page, side(trunks.none));
  assert.equal(none.face, "none", `None: the face itself doesn't move (${none.cls})`);
  assert.equal(none.body, "none", "None: nothing is added to the body");
  assert.ok(!none.faceMoves && !none.bodyMoves, "None: no transform changes");
  assert.ok(none.canvas, "None still plays what the Trunk is doing on its canvas");

  const breathe = await motionOf(page, side(trunks.breathe));
  assert.equal(breathe.body, "breathe", `Breathe: the rendered body breathes (${breathe.cls})`);
  assert.ok(breathe.bodyMoves, "Breathe: the body's transform changes over time");
  assert.equal(breathe.face, "none", "Breathe: the face itself doesn't bob");

  const sway = await motionOf(page, side(trunks.sway));
  assert.equal(sway.face, "bobav", `Sway: the whole face bobs (${sway.cls})`);
  assert.ok(sway.faceMoves, "Sway: the face's transform changes over time");
  assert.equal(sway.body, "none", "Sway: the body doesn't breathe");

  /* The editor's preview (Customize › Trunks › Edit) follows each choice before it is saved. */
  await page.locator('#side [data-act="view"][data-v="customize"]').first().click();
  await page.locator(`.prow [data-act="edit"][data-id="${trunks.none.id}"]`).click();
  await page.waitForSelector(".dlg .editor .big .av.pbl");
  const preview = ".dlg .editor .big .av.pbl";
  const seen = {};
  for (const motion of ["sway", "breathe", "none"]) {
    await page.locator(`.dlg [data-act="st-anim"][data-v="${motion}"]`).click();
    await page.waitForFunction(({ sel, motion }) => {
      const el = document.querySelector(sel);
      return el && (motion === "sway" ? el.classList.contains("anim-bob") : motion === "breathe" ? el.classList.contains("anim-breathe") : !/anim-/.test(el.className));
    }, { sel: preview, motion });
    seen[motion] = await motionOf(page, preview);
  }
  assert.deepEqual([seen.none.face, seen.none.body], ["none", "none"], "preview, None");
  assert.deepEqual([seen.breathe.face, seen.breathe.body, seen.breathe.bodyMoves], ["none", "breathe", true], "preview, Breathe");
  assert.deepEqual([seen.sway.face, seen.sway.body, seen.sway.faceMoves], ["bobav", "none", true], "preview, Sway");
  assert.deepEqual(errors, []);
});

test("reduced motion, the computer's or Keep things still, makes every 3D pebble a still, Breathe and Sway included", async (t) => {
  const { page, errors, trunks } = await fixture(t);
  for (const motion of MOTIONS) await page.locator(side(trunks[motion])).waitFor({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll("#side .av.pbl canvas").length >= 3, null, { timeout: 30000 });
  const allStill = async () => {
    for (const motion of MOTIONS) {
      const m = await motionOf(page, side(trunks[motion]));
      assert.deepEqual({ face: m.face, body: m.body, faceMoves: m.faceMoves, bodyMoves: m.bodyMoves, canvas: m.canvas },
        { face: "none", body: "none", faceMoves: false, bodyMoves: false, canvas: false }, `${motion}: ${m.cls}`);
    }
  };

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForFunction(() => document.querySelectorAll("#side .av.pbl canvas").length === 0, null, { timeout: 5000 });
  await allStill();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForFunction(() => document.querySelectorAll("#side .av.pbl canvas").length >= 3, null, { timeout: 5000 });

  await page.evaluate(async () => { await (await import("/app/shell/look.js")).savePrefs({ reduceMotion: true }); (await import("/app/core/dom.js")).render(); });
  await page.waitForFunction(() => document.querySelectorAll("#side .av.pbl canvas").length === 0, null, { timeout: 5000 });
  await allStill();
  await page.evaluate(async () => { await (await import("/app/shell/look.js")).savePrefs({ reduceMotion: false }); (await import("/app/core/dom.js")).render(); });
  await page.waitForFunction(() => document.querySelectorAll("#side .av.pbl canvas").length >= 3, null, { timeout: 5000 });
  const sway = await motionOf(page, side(trunks.sway));
  assert.equal(sway.face, "bobav", "Sway moves again once motion is allowed");
  assert.ok((await faceCount(page)) >= 3);
  assert.deepEqual(errors, []);
});
