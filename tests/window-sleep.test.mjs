/* Everything that moves falls asleep when it is left alone, and wakes when you come back (core/sleep.js). A face sleeps
   two minutes after it was last in focus (its conversation open while you use the window, or its row hovered) and, when
   its conversation is not open, lies still twenty seconds later; the
   window's own motion two minutes after your last input, and after ten minutes every sleeping loop holds still. A face
   at work never sleeps. Headless, against 127.0.0.1, with the page's clock moved forward (Playwright clock). */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { waitInPage } from "./wait-in-page.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const MIN = 60 * 1000;
/* A wait with no limit of its own (an engine promise, or a read inside the page) fails after `ms`, naming what it waited
   for, instead of holding the file until the test runner ends it at 360 s with nothing said (seen on CI, on the base too). */
async function bounded(what, promise, ms = 60000) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${typeof what === "function" ? what() : what} did not finish within ${ms / 1000} s`)), ms); });
  try { return await Promise.race([promise, late]); } finally { clearTimeout(timer); }
}

/* The engine's picture read and drawn once more before the clock is moved: the last coherent snapshot, with nothing of
   the setup left to arrive after the jump. The page's clock is Playwright's and does not move by itself here, so nothing
   in this may wait on a page timer: a read that failed on the network would wait for one that never fires (api.js
   backAgain, CI #664: "the setup's refresh and draw in the page did not finish within 60 s"). Quiet, a failed read fails
   at once and the refresh is asked again. Every request is answered by the held route, whatever happens to its own
   fetch, and a step that runs past its limit names the reads still in flight. */
async function syncSetup(page, delayRefresh) {
  let release = () => {}, received = () => {}, finished = false, routeError = null;
  const held = new Promise((resolve) => { release = resolve; });
  const captured = new Promise((resolve) => { received = resolve; });
  const pending = new Map();
  const track = (request) => { const path = new URL(request.url()).pathname; if (path.startsWith("/api/") && path !== "/api/events/stream") pending.set(request, `${request.method()} ${path}`); };
  const done = (request) => pending.delete(request);
  page.on("request", track); page.on("requestfinished", done); page.on("requestfailed", done);
  const inFlight = () => `in flight: ${[...pending.values()].join(", ") || "nothing"}${routeError ? `; the held route failed: ${routeError.message}` : ""}`;
  const delayed = async (route) => {
    try {
      const response = await bounded("the held engine refresh's own answer", route.fetch());
      received(); await held; await route.fulfill({ response });
    } catch (error) { routeError = error; await route.continue().catch(() => {}); }
  };
  if (delayRefresh) await page.route("**/api/state", delayed, { times: 1 });
  const ready = page.evaluate(async () => {
    const [{ refresh, E }, { renderNow }, { link }] = await Promise.all([import("/app/core/state.js"), import("/app/core/dom.js"), import("/app/core/api.js")]);
    const quiet = link.quiet;
    link.quiet = true;
    try {
      for (let tries = 1; ; tries++) {
        try { await refresh(); break; } catch (error) { if (tries >= 5) throw error; }
      }
    } finally { link.quiet = quiet; }
    renderNow();
    if ((E.state?.runs ?? []).some((run) => ["running", "queued"].includes(run.status))) throw new Error("Sleep fixture still has setup tasks running");
  }).then(() => { finished = true; });
  try {
    if (delayRefresh) {
      let timeout;
      try { await Promise.race([captured, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Setup refresh was never captured; ${inFlight()}`)), 30000); })]); }
      finally { clearTimeout(timeout); }
      assert.equal(finished, false, "clock readiness waits for the deliberately held engine refresh");
      release();
    }
    await bounded(() => `the setup's refresh and draw in the page (${inFlight()})`, ready);
  } finally {
    release();
    if (delayRefresh) await bounded("letting go of the held engine refresh", page.unroute("**/api/state", delayed));
    page.off("request", track); page.off("requestfinished", done); page.off("requestfailed", done);
  }
}

async function fixture(t, { delayRefresh = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-sleep-"));
  let release = () => {};
  const held = new Promise((resolve) => { release = resolve; });
  /* A reply that "Busy" asks for is held until the test ends, so its task stays running. */
  const provider = { name: "scripted", async complete(request) {
    if (JSON.stringify(request.messages ?? request).includes("keep working")) await held;
    return { content: "Done.", toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  /* Ending the test is bounded too: a report comes only once it has ended, so a stuck close looked like a silent hang. */
  t.after(async () => {
    release();
    await bounded("closing the browser", browser.close());
    await bounded("closing the server", server.close());
    await bounded("closing the engine", app.close());
    await discardTemp(root);
  });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  await call("/api/onboarding", { done: true });
  await call("/api/trunks/switch", { part: "trunks", mode: "on" });
  const trunks = {};
  for (const [name, character] of [["Ledger", "ember"], ["Scout", "kite"], ["Busy", "tide"], ["Quill", null]]) {
    const { trunk } = await call("/api/trunks", { name, description: "Helps" });
    if (character) await call(`/api/trunks/${trunk.id}`, { character });
    trunks[name] = trunk;
  }
  await bounded("the Trunks' introductions", app.trunks.introduced()); // creation returns before its model task completes; a late reply correctly wakes the window
  await call("/api/delight/settings", { pets: { on: true, kind: "fennec" }, background: { on: true } });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, reducedMotion: "no-preference", serviceWorkers: "block" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install();
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator("#side .keeper .petbox").waitFor({ state: "attached" });
  /* Finish the last coherent engine snapshot and draw before ageing it. Sidebar visibility alone precedes live
     refreshes; a response arriving after fastForward is new activity at that time. Keep rAF running for real decoding. */
  await syncSetup(page, delayRefresh);
  await page.evaluate(async () => {
    const { E, S } = await import("/app/core/state.js"), { afterDraw } = await import("/app/core/dom.js");
    const { windowRest } = await import("/app/core/sleep.js");
    const trace = [];
    const snapshot = (event) => ({ event, at: Date.now(), rest: windowRest(), classes: document.documentElement.className,
      chat: S.chat, runs: (E.state?.runs ?? []).map(({ id, status }) => [id, status]) });
    const record = (event) => { trace.push(snapshot(event)); if (trace.length > 30) trace.shift(); };
    for (const event of ["focus", "pointermove", "pointerdown", "keydown"]) addEventListener(event, () => record(event));
    afterDraw(() => record("draw"));
    window.sleepTestDiagnostic = () => ({ now: snapshot("failure"), trace,
      videos: [...document.querySelectorAll("video")].map((video) => ({ source: video.getAttribute("src") ?? video.dataset.held17, held: !!video.dataset.held17, paused: video.paused,
        key: video.closest("[data-rk]")?.dataset.rk, classes: video.closest("[data-rk]")?.className })) });
  });
  const work = () => { app.runtime.run({ prompt: "keep working", sessionId: trunks.Busy.chatSessionId }).catch(() => {}); };
  return { page, errors, trunks, work };
}

const face = (page, trunk) => page.locator(`#side [data-rk="t:${trunk.id}"]`).first();
/* A face read in one call in the page: its loop (a face held still has let its file go, core/held.js, and data-held17
   names the loop it shows), whether it rests, or whether its loop is paused. The side list is drawn again as the
   engine's reads land, and a face found first and read after (locator.evaluate) could be the row just replaced, whose
   loop had already moved to the new row: that read "" for a Trunk at work on a busy runner. */
const onFace = (page, trunk, what) => page.evaluate(([id, what]) => {
  const el = document.querySelector(`#side [data-rk="t:${id}"]`), v = el?.querySelector("video");
  if (what === "rest") return !!el?.classList.contains("rest18");
  if (what === "paused") return !!v?.paused;
  return v?.getAttribute("src") ?? v?.dataset.held17 ?? el?.querySelector("img")?.getAttribute("src") ?? "";
}, [trunk.id, what]);
const loopOf = (page, trunk) => onFace(page, trunk, "loop");
const playing = (page) => page.evaluate(() => [...document.querySelectorAll("video")].filter((v) => !v.paused).length);
async function waitFor(page, predicate, arg) {
  try { await page.waitForFunction(predicate, arg); }
  catch (error) {
    const detail = `\nSleep diagnostic: ${JSON.stringify(await page.evaluate(() => window.sleepTestDiagnostic()).catch(() => ({ unavailable: true })))}`;
    error.message += detail;
    error.stack += detail;
    throw error;
  }
}
const open = (page, trunk) => bounded(`opening ${trunk.name}'s conversation in the page`, page.evaluate(async (id) => {
  const { openConversation } = await import("/app/chat/chat.js");
  await openConversation(id); // finish its message/extras reads before advancing the clock
}, trunk.chatSessionId));
/* Waits (no fixed sleep) until a face's loop matches, and, with still, until that loop is paused. */
const settled = (page, trunk, pattern, still = false) => waitFor(page, ([id, source, still]) => {
  const el = document.querySelector(`#side [data-rk="t:${id}"]`), v = el?.querySelector("video");
  const src = v?.getAttribute("src") ?? v?.dataset.held17 ?? el?.querySelector("img")?.getAttribute("src") ?? "";
  return new RegExp(source).test(src) && (!still || !!v?.paused);
}, [trunk.id, pattern.source, still]);
/* The owner at the window: a pointer move now and then. */
async function busy(page, ms) {
  for (let t = 0; t < ms; t += 30000) { await page.mouse.move(600 + (t / 30000) % 50, 500); await page.clock.fastForward(30000); }
}

test("left alone, every face, the pet and the scene fall asleep; after ten minutes nothing plays", async (t) => {
  const { page, errors, trunks } = await fixture(t, { delayRefresh: true });
  await page.clock.fastForward(2 * MIN + 5000);
  await waitFor(page, () => document.documentElement.classList.contains("doze18") && !!document.querySelector("#side .petbox.zz11"));
  await settled(page, trunks.Ledger, /ember\/sleep/);
  assert.match(await loopOf(page, trunks.Ledger), /ember\/sleep/, "a character plays its sleeping loop");
  assert.equal(await onFace(page, trunks.Ledger, "rest"), true);
  assert.equal(await page.locator("#side .petbox.zz11").count(), 1, "the pet naps");
  assert.equal(await page.locator("#bgLayer .paint11").evaluate((el) => el.getAnimations().every((a) => a.playState === "paused")), true, "the scene's drift holds");
  await page.clock.fastForward(8 * MIN + 5000);
  await waitFor(page, () => document.documentElement.classList.contains("still18")
    && [...document.querySelectorAll("video")].every((v) => v.paused) && !document.getAnimations().some((a) => a.playState === "running"));
  assert.equal(await playing(page), 0, "no loop plays after the long sleep");
  // Held still, a loop gives back its decoder: none has a frame loaded, and those that had played keep their loop's name.
  const decoders = await page.evaluate(() => [...document.querySelectorAll("video")].map((v) => ({ loop: v.getAttribute("src") ?? v.dataset.held17, ready: v.readyState, held: !!v.dataset.held17 })));
  assert.deepEqual(decoders.filter((v) => v.ready !== 0), [], "no held loop keeps a decoder");
  assert.ok(decoders.some((v) => v.held), "the loops that played were held, not only paused");
  // Named, so a failure says what still moves (a transition of the pet's box slid it in on a redraw while it slept).
  const running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running")
    .map((a) => `${a.animationName ?? a.transitionProperty ?? "animation"} on .${[...a.effect?.target?.classList ?? []].join(".")}`));
  assert.deepEqual(running, [], "no CSS animation runs");
  assert.deepEqual(errors, []);
});

test("only the open conversation's Trunk stays awake while you use the window; hovering a row wakes its face", async (t) => {
  const { page, errors, trunks } = await fixture(t);
  await open(page, trunks.Ledger);
  await busy(page, 2.5 * MIN);
  await settled(page, trunks.Scout, /kite\/sleep/, true);
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains("doze18")), false, "the window is awake while you use it");
  assert.match(await loopOf(page, trunks.Ledger), /ember\/idle/, "the open conversation's face stays awake");
  assert.match(await loopOf(page, trunks.Scout), /kite\/sleep/, "a face whose conversation is not open sleeps");
  assert.equal(await onFace(page, trunks.Scout, "paused"), true, "and, fallen asleep, lies still");
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("#side [data-rk] video")].filter((v) => !v.paused).map((v) => v.closest("[data-rk]").dataset.rk).every((k, _, all) => k === all[0])), true, "only the open conversation's face moves in the list");
  await face(page, trunks.Scout).hover();
  await settled(page, trunks.Scout, /kite\/idle/);
  assert.match(await loopOf(page, trunks.Scout), /kite\/idle/, "hovering its row wakes it");
  assert.deepEqual(errors, []);
});

test("input wakes the window and the open conversation's face at once, gently", async (t) => {
  const { page, errors, trunks } = await fixture(t);
  const defaultId = await page.evaluate(async () => (await import("/app/core/state.js")).defaultTrunk()?.id);
  assert.ok(defaultId, "the empty chat belongs to the owner's default Trunk");
  assert.equal(await page.locator(".hero11 [data-rk]").getAttribute("data-rk"), `t:${defaultId}`);
  await page.clock.fastForward(10 * MIN + 5000);
  await waitFor(page, () => document.documentElement.classList.contains("still18"));
  await page.mouse.move(700, 400);
  // Read in the moment the window wakes: its wake class lasts 0.7 s, which a slow machine can spend between two reads.
  const woke = await (await page.waitForFunction(() => {
    const html = document.documentElement;
    return !html.classList.contains("doze18") && { wake: html.classList.contains("wake18"), hero: document.querySelector(".hero11 video")?.getAttribute("src") ?? "" };
  })).jsonValue();
  assert.equal(woke.wake, true, "the window plays its wake");
  assert.equal(await page.locator("#side .petbox.zz11").count(), 0, "the pet wakes");
  assert.match(woke.hero, /\/idle[./]/, "the visible default Trunk wakes with the empty chat, in the same moment");
  assert.ok(await playing(page) > 0, "loops play again");
  assert.match(await loopOf(page, trunks.Scout), /kite\/sleep/, "a Trunk whose conversation is not open sleeps on");
  assert.deepEqual(errors, []);
});

test("the first press wakes the window and still opens the conversation it pressed", async (t) => {
  const { page, errors, trunks } = await fixture(t);
  const row = page.locator(`#side .row[data-id="${trunks.Ledger.chatSessionId}"]`);
  await row.waitFor(); // the sidebar may still be drawing its rows on a slow machine
  const box = await row.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.clock.fastForward(10 * MIN + 5000);
  await waitFor(page, () => document.documentElement.classList.contains("still18"));
  await page.evaluate(() => addEventListener("pointerdown", (event) => {
    window.sleepPressedTarget = event.target.closest(".row");
  }, { capture: true, once: true }));
  await page.mouse.down();
  assert.equal(await page.evaluate(() => window.sleepPressedTarget?.isConnected), true, "waking keeps the pressed row until its click");
  await page.mouse.up();
  await waitInPage(page, async (id) => (await import("/app/core/state.js")).S.chat === id,
    trunks.Ledger.chatSessionId, { timeout: 5000 });
  assert.deepEqual(errors, []);
});

test("a Trunk at work never sleeps", async (t) => {
  const { page, errors, trunks, work } = await fixture(t);
  work();
  await waitFor(page, (id) => document.querySelector(`#side [data-rk="t:${id}"]`)?.dataset.st === "work", trunks.Busy.id);
  await page.clock.fastForward(10 * MIN + 5000);
  await settled(page, trunks.Ledger, /ember\/sleep/);
  assert.match(await loopOf(page, trunks.Busy), /tide\/work/, "its working loop stays");
  assert.equal(await onFace(page, trunks.Busy, "rest"), false);
  assert.match(await loopOf(page, trunks.Ledger), /ember\/sleep/, "the others sleep");
  assert.deepEqual(errors, []);
});
