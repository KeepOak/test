/* parity-b2: the window reads This computer's screen (GET /api/panels/screen, src/local-screen.ts) only while the owner
   has the computer view open on it: nothing before, and the stream is let go, and the engine's reader with it, once the
   view is closed, switched to the browser, hidden or locked. computer-control: opening the view shows the main display
   by itself, and a view shown again shows what the owner last chose. All screens never reads This computer when This
   computer is not one of the screens it draws. The screen is the stand-in of tests/local-screen-fixture.mjs, which
   counts its frames and whether it was let go. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { installScreenStandIn } from "./local-screen-fixture.mjs";
import { openChat } from "./open-chat.mjs"; // trunk-one-row: one row per Trunk

const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const TOWER = "a1b2c3d4e5f60718", LAPTOP = "0f1e2d3c4b5a6978";

async function windowWith(t, prepare) {
  const root = await mkdtemp(join(tmpdir(), "branch-live-screen-window-"));
  const quiet = { name: "scripted", async complete() { return { content: "Here it is.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const run = app.store.createRun(app.runtime.owner, "Look at my screen");
  app.store.message(run.sessionId, { role: "user", content: run.prompt });
  app.store.message(run.sessionId, { role: "assistant", content: "Here it is." });
  app.store.finish(run.id, "completed", "Here it is.");
  const seen = installScreenStandIn(app);
  const taken = { get count() { return seen.captured; }, get open() { return seen.opened - seen.closed; } };
  prepare?.(app);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return { page, taken, seen, errors, run, server, open: async () => {
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await openChat(page, run.sessionId);
    await page.locator("#conversation .b").first().waitFor({ timeout: 30000 });
  } };
}
/* The owner chooses the stand-in's app window in the view. */
async function choose(page) {
  await page.locator("#native-target option").filter({ hasText: "Fixture editor" }).waitFor({ state: "attached", timeout: 15000 });
  await page.locator("#native-target").selectOption({ label: "Fixture editor" });
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await page.locator("#stage7 .livescr-img[src^='data:image/jpeg']").waitFor({ timeout: 15000 });
}
/* The frames taken after the window has had a moment to let go, over `ms`, and whether the reader is still open. */
async function flatFor(taken, ms = 1500) {
  await pause(700);
  const settled = taken.count;
  await pause(ms);
  return { more: taken.count - settled, open: taken.open };
}

test("This computer's screen streams only while its view is open and showing, and is let go otherwise", async (t) => {
  const w = await windowWith(t);
  await w.open();
  const { page, taken, errors } = w;
  assert.deepEqual(await flatFor(taken), { more: 0, open: 0 }, "nothing is read before the view opens");
  const open = page.locator('.head [data-act="stage"][data-v="computer"]').first();
  const live = () => page.locator("#stage7 .livescr-img[src^='data:image/jpeg']").waitFor({ timeout: 15000 });
  await open.click();
  await live();
  assert.ok(w.seen.kinds.length >= 1 && w.seen.kinds.every((kind) => kind === "monitor"), "the main display opens by itself");
  const started = taken.count;
  await pause(1000);
  assert.ok(taken.count - started >= 3, `several frames a second while open (${taken.count - started} in a second)`);

  await page.locator('#stage7 [data-act="stage-close"]').click();
  assert.deepEqual(await flatFor(taken), { more: 0, open: 0 }, "closed: it stops, and the reader is let go");

  await open.click();
  await live();
  await choose(page);
  assert.equal(w.seen.kinds.at(-1), "window");
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  assert.deepEqual(await flatFor(taken), { more: 0, open: 0 }, "hidden: it stops");
  const opened = w.seen.opened;
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: false, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await live();
  const shown = taken.count;
  await pause(1500);
  assert.ok(taken.count > shown, "shown again: it starts again");
  assert.deepEqual([w.seen.opened - opened, w.seen.kinds.at(-1)], [1, "window"], "with the window the owner chose, not the display");

  await page.locator('#stage7 .st7-sw [data-act="stage"][data-v="browser"]').click();
  assert.deepEqual(await flatFor(taken), { more: 0, open: 0 }, "switched to the browser: it stops");
  await page.locator('#stage7 .st7-sw [data-act="stage"][data-v="computer"]').click();
  await live();
  await page.evaluate(() => document.getElementById("app").classList.add("locked-b17"));
  assert.deepEqual(await flatFor(taken), { more: 0, open: 0 }, "Branch locked: it stops");
  assert.deepEqual(errors, []);
});

test("All screens never reads This computer when This computer is not one of its screens", async (t) => {
  const device = (id, name, platform) => ({ id, name, platform, publicKey: "k".repeat(44), pairedAt: "2026-09-26T00:00:00.000Z", lastSeen: null, offers: [], enabled: [], folder: null, sharedWith: [] });
  const w = await windowWith(t, (app) => app.store.save("settings", app.runtime.owner, "devices-book",
    { mode: "off", requests: [], devices: [device(TOWER, "Tower", "linux"), device(LAPTOP, "Laptop", "darwin")] }));
  // The conversation may use Tower and Laptop only, as a Trunk allowed just those two would (GET /api/devices/pick).
  await w.page.route(`**/api/devices/pick/${w.run.sessionId}`, (route) => route.fulfill({ json: { sessionId: w.run.sessionId, picked: TOWER, allowed: [TOWER, LAPTOP] } }));
  await w.open();
  const { page, taken, errors } = w;
  await page.locator('.head [data-act="stage"][data-v="computer"]').first().click();
  await page.locator('#stage7 .st7-tabs [data-act="comp-grid"]').click();
  assert.equal(await page.locator("#stage7 .st7-grid .st7-cell").count(), 2, "Tower and Laptop, side by side");
  assert.deepEqual(await flatFor(taken), { more: 0, open: 0 }, "This computer is not drawn, so it is not read");
  assert.equal(await page.locator("#stage7 .livescr-img").count(), 0);
  assert.deepEqual(errors, []);
});

test("a paired computer's screen shows live in its own view, and the engine's refusal in its place", async (t) => {
  const device = (id, name, platform) => ({ id, name, platform, publicKey: "k".repeat(44), pairedAt: "2026-09-26T00:00:00.000Z", lastSeen: null, offers: [], enabled: [], folder: null, sharedWith: [] });
  const w = await windowWith(t, (app) => app.store.save("settings", app.runtime.owner, "devices-book",
    { mode: "off", requests: [], devices: [device(TOWER, "Tower", "linux")] }));
  await w.page.route(`**/api/devices/pick/${w.run.sessionId}`, (route) => route.fulfill({ json: { sessionId: w.run.sessionId, picked: TOWER, allowed: [TOWER] } }));
  const asked = [];
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  let refuse = false;
  await w.page.route("**/api/panels/screen/device?*", (route) => {
    asked.push(new URL(route.request().url()).searchParams.get("device"));
    route.fulfill({ contentType: "application/x-ndjson", body: refuse ? `${JSON.stringify({ refusal: "\"Take a picture of the screen\" is switched off for Tower.", status: 409 })}\n`
      : `${JSON.stringify({ frame: `data:image/png;base64,${png}`, device: TOWER, at: "now" })}\n` });
  });
  await w.open();
  const { page, taken, errors } = w;
  await page.locator('.head [data-act="stage"][data-v="computer"]').first().click();
  await page.locator("#stage7 .devscr-img[src^='data:image/png']").waitFor({ timeout: 15000 });
  assert.equal(asked[0], TOWER, "the view asks for that computer's screen");
  assert.equal(await page.locator("#native-target").count(), 0, "This computer's chooser is not shown for another computer");
  assert.deepEqual(await flatFor(taken, 500), { more: 0, open: 0 }, "This computer is not read");
  await page.locator('#stage7 [data-act="stage-close"]').click();
  refuse = true;
  await page.locator('.head [data-act="stage"][data-v="computer"]').first().click();
  await page.getByText("is switched off for Tower").waitFor({ timeout: 15000 });
  assert.deepEqual(errors, []);
});

test("the owner takes over a paired computer and clicks, right-clicks and types on its picture; greyed with the reason when its switch is off", async (t) => {
  const device = (id, name, platform) => ({ id, name, platform, publicKey: "k".repeat(44), pairedAt: "2026-09-26T00:00:00.000Z", lastSeen: null, offers: ["screen", "input"], enabled: ["screen"], folder: null, sharedWith: [] });
  const w = await windowWith(t, (app) => app.store.save("settings", app.runtime.owner, "devices-book",
    { mode: "off", requests: [], devices: [device(TOWER, "Tower", "linux")] }));
  await w.page.route(`**/api/devices/pick/${w.run.sessionId}`, (route) => route.fulfill({ json: { sessionId: w.run.sessionId, picked: TOWER, allowed: [TOWER] } }));
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  const state = { driving: false, note: "Switch on \"Let you use its screen and keyboard from Branch\" for Tower in Customize, Channels, Devices.", frames: 0 };
  const sent = [];
  await w.page.route("**/api/panels/screen/device?*", (route) => {
    state.frames += 1;
    route.fulfill({ contentType: "application/x-ndjson", body: `${JSON.stringify({ frame: `data:image/png;base64,${png}`, device: TOWER, frameId: `f${state.frames}`, driving: state.driving, inputNote: state.note, at: "now" })}\n` });
  });
  await w.page.route("**/api/panels/screen/device/drive", (route) => { const body = route.request().postDataJSON(); state.driving = body.on; sent.push(["drive", body.on]); route.fulfill({ json: { driving: body.on } }); });
  await w.page.route("**/api/panels/screen/device/input", (route) => { const body = route.request().postDataJSON(); sent.push([body.frameId, body.input]); route.fulfill({ json: { done: true } }); });
  await w.open();
  const { page, errors } = w;
  await page.locator('.head [data-act="stage"][data-v="computer"]').first().click();
  await page.locator("#stage7 .devscr-img[src^='data:image/png']").waitFor({ timeout: 15000 });
  const take = page.locator('#stage7 [data-act="device-control"]');
  assert.equal(await take.isDisabled(), true, "greyed while that computer's switch is off");
  assert.match(await take.getAttribute("title"), /Switch on "Let you use its screen and keyboard from Branch" for Tower/);
  await page.getByText("Switch on \"Let you use its screen").first().waitFor();
  state.note = null;
  await page.locator('#stage7 [data-act="device-control"]:not([disabled])').waitFor({ timeout: 15000 });
  await page.locator('#stage7 [data-act="device-control"]').click();
  await page.getByText("You're driving Tower").waitFor({ timeout: 15000 });
  const box = await page.locator("#stage7 .devscr-img").boundingBox();
  const seen = state.frames;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < 100 && sent.length < 2; i++) await page.waitForTimeout(50);
  const { x, y, ...click } = sent[1][1];
  assert.deepEqual(click, { action: "click", button: "left", count: 1 });
  assert.ok(Math.abs(x - 0.5) < 0.02 && Math.abs(y - 0.5) < 0.02, `the middle of the picture is the middle of that screen (${x}, ${y})`);
  // The next press waits for the next picture.
  for (let i = 0; i < 100 && state.frames === seen; i++) await page.waitForTimeout(50);
  await page.waitForTimeout(300);
  await page.mouse.click(box.x + box.width / 4, box.y + box.height / 4, { button: "right" });
  for (let i = 0; i < 100 && sent.length < 3; i++) await page.waitForTimeout(50);
  assert.equal(sent[2][1].button, "right");
  assert.notEqual(sent[2][0], sent[1][0], "each press names a newer picture");
  await page.locator("#device-text").fill("hello");
  await page.locator('form[data-form="device-text"] button').click();
  for (let i = 0; i < 100 && sent.length < 4; i++) await page.waitForTimeout(50);
  assert.deepEqual(sent[3], [sent[2][0], { action: "type", text: "hello" }], "text may follow a click on the same picture");
  await page.locator('#stage7 [data-act="device-control"]').click();
  for (let i = 0; i < 100 && sent.length < 5; i++) await page.waitForTimeout(50);
  assert.deepEqual(sent[0], ["drive", true]);
  assert.deepEqual(sent[4], ["drive", false]);
  assert.deepEqual(errors, []);
});

test("two quick clicks on different spots of a paired computer's picture are never sent as one double-click", async (t) => {
  const device = { id: TOWER, name: "Tower", platform: "linux", publicKey: "k".repeat(44), pairedAt: "2026-09-26T00:00:00.000Z", lastSeen: null, offers: ["screen", "input"], enabled: ["screen", "input"], folder: null, sharedWith: [] };
  const w = await windowWith(t, (app) => app.store.save("settings", app.runtime.owner, "devices-book", { mode: "off", requests: [], devices: [device] }));
  await w.page.route(`**/api/devices/pick/${w.run.sessionId}`, (route) => route.fulfill({ json: { sessionId: w.run.sessionId, picked: TOWER, allowed: [TOWER] } }));
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  const state = { driving: false, frames: 0 };
  const clicks = [];
  await w.page.route("**/api/panels/screen/device?*", (route) => {
    state.frames += 1;
    route.fulfill({ contentType: "application/x-ndjson", body: `${JSON.stringify({ frame: `data:image/png;base64,${png}`, device: TOWER, frameId: `f${state.frames}`, driving: state.driving, inputNote: null, at: "now" })}\n` });
  });
  await w.page.route("**/api/panels/screen/device/drive", (route) => { state.driving = route.request().postDataJSON().on; route.fulfill({ json: { driving: state.driving } }); });
  await w.page.route("**/api/panels/screen/device/input", (route) => { const { input } = route.request().postDataJSON(); if (input.action === "click") clicks.push(input); route.fulfill({ json: { done: true } }); });
  await w.open();
  const { page, errors } = w;
  await page.locator('.head [data-act="stage"][data-v="computer"]').first().click();
  await page.locator("#stage7 .devscr-img[src^='data:image/png']").waitFor({ timeout: 15000 });
  await page.locator('#stage7 [data-act="device-control"]:not([disabled])').click();
  await page.getByText("You're driving Tower").waitFor({ timeout: 15000 });
  // The 1x1 picture is drawn as the largest square that fits, in the middle of its box: both spots are on it.
  const box = await page.locator("#stage7 .devscr-img").boundingBox();
  const side = Math.min(box.width, box.height), middle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.click(middle.x - side * 0.15, middle.y);
  await page.mouse.click(middle.x + side * 0.15, middle.y);
  for (let i = 0; i < 100 && !clicks.length; i++) await page.waitForTimeout(50);
  await page.waitForTimeout(600);
  assert.ok(clicks.length >= 1 && clicks.every((click) => click.count === 1), `each is a click of its own: ${JSON.stringify(clicks)}`);
  assert.ok(Math.abs(clicks[0].x - 0.35) < 0.02, `the first lands where it was aimed (${clicks[0].x})`);
  // The second waits for the next picture (one press per picture), so it may be refused here; it is never a double-click.
  assert.ok(clicks.slice(1).every((click) => Math.abs(click.x - 0.65) < 0.02));
  // A real double-click, on the next picture, is still sent as one.
  const seen = state.frames;
  for (let i = 0; i < 100 && state.frames === seen; i++) await page.waitForTimeout(50);
  await page.waitForTimeout(300);
  const before = clicks.length;
  await page.mouse.dblclick(middle.x, middle.y);
  for (let i = 0; i < 100 && clicks.length === before; i++) await page.waitForTimeout(50);
  await page.waitForTimeout(400);
  const doubled = clicks.slice(before);
  assert.equal(doubled.length, 1, `one press: ${JSON.stringify(doubled)}`);
  assert.equal(doubled[0].count, 2);
  assert.ok(Math.abs(doubled[0].x - 0.5) < 0.02 && Math.abs(doubled[0].y - 0.5) < 0.02);
  assert.deepEqual(errors, []);
});
