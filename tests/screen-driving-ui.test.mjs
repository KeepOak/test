/**
 * The Trunk's cursor and "You're driving" in the window's full-size computer view (public/app/chat/stage.js), against an
 * engine whose screen is a stand-in: the frames are a picture this test makes and the clicks are written down, so nothing
 * reaches this computer's real screen, keyboard or windows. The browser is headless.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, crc32 } from "node:zlib";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { DesktopControl } from "../dist/integrations/desktop.js";
import { saveDesktopSettings } from "../dist/integrations/desktop-config.js";
import { signIn } from "./new-window-places.mjs";

/** A plain 16 × 10 picture (the screen's shape), as PNG bytes. */
function picture() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), sum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); sum.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(16, 0); head.writeUInt32BE(10, 4); head[8] = 8; head[9] = 2;
  const rows = Buffer.concat(Array.from({ length: 10 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(48, 0x55)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

test("the Trunk's cursor sits where it clicked; Take over says You're driving and holds its clicks until Hand back", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-driving-ui-"));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  // The task keeps working (its model call waits) so the view offers Take over, as it does while a Trunk works.
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "held", async complete(request) { await Promise.race([held, new Promise((r) => request.signal.addEventListener("abort", r, { once: true }))]); return { content: "Done.", toolCalls: [] }; } } });
  const calls = [], data = picture().toString("base64");
  const reader = { running: true, close() {}, async frame() { return { width: 16, height: 10, data, windows: [], after: [], screen: { x: 0, y: 0, w: 1280, h: 800 } }; } };
  const runner = { liveProcess: () => reader, async temporaryPng(name) { return join(root, `${name}.png`); }, async close() {},
    async run(action, payload) {
      calls.push(action);
      if (action === "windows") return { windows: [{ title: "Notes - Notepad", program: "stand-in", handle: 7, minimised: false }] };
      if (action === "click") return { how: "point", name: "", at: [100 + payload.x, 50 + payload.y] };
      return {};
    } };
  app.desktop = new DesktopControl(app.store, { runner, banner: { visible: false, show: async () => undefined, hide: async () => undefined } });
  saveDesktopSettings(app.store, app.runtime.owner, { enabled: true });
  const first = app.trunks.create({ name: "Cursor One" }, { chosenColour: "#336699" });
  const second = app.trunks.create({ name: "Cursor Two" }, { chosenColour: "#993366" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { release(); await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });

  let run;
  const started = new Promise((resolve) => { void app.runtime.run({ prompt: "Tidy my notes", onTextDelta: () => undefined, onStarted: (r) => { run = r; resolve(); } }).catch(() => undefined); });
  await started;
  const context = () => app.runtime.context({ runId: run.id });
  await app.desktop.click({ window: "Notepad", point: { x: 540, y: 350 } }, context()); // lands at 640, 400: the middle

  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await signIn(page, server);
  await page.locator(`#side [data-act="chat"][data-id="${run.sessionId}"]`).click();
  await page.locator('[data-act="stage"][data-v="computer"]').first().click();
  const cursor = page.locator("#stage7 .real-ag");
  await cursor.waitFor({ state: "visible", timeout: 20000 });
  const place = await page.evaluate(() => {
    const desk = document.querySelector("#stage7 .desk7"), mark = document.querySelector("#stage7 .real-ag");
    return { left: parseFloat(mark.style.left) / desk.clientWidth, top: parseFloat(mark.style.top) / desk.clientHeight, name: mark.textContent };
  });
  assert.ok(Math.abs(place.left - 0.5) < 0.01 && Math.abs(place.top - 0.5) < 0.01, `the cursor is where it clicked: ${JSON.stringify(place)}`);
  assert.ok(place.name.length > 0, "with the name of whoever is working");
  await app.desktop.click({ window: "Notepad", point: { x: 540, y: 350 } }, { ...context(), trunk: first.id });
  await cursor.locator("span").filter({ hasText: "Cursor One" }).waitFor();
  assert.equal(await cursor.evaluate((el) => getComputedStyle(el).getPropertyValue("--c").trim()), "#336699");
  await app.desktop.click({ window: "Notepad", point: { x: 540, y: 350 } }, { ...context(), trunk: second.id });
  await cursor.locator("span").filter({ hasText: "Cursor Two" }).waitFor();
  assert.equal(await cursor.evaluate((el) => getComputedStyle(el).getPropertyValue("--c").trim()), "#993366",
    "the actual Trunk's selected color follows the new click");

  await page.locator('#stage7 [data-act="takeover"][data-v="screen"]').click();
  await page.locator("#stage7 .you7").waitFor({ timeout: 10000 });
  assert.match(await page.locator("#stage7 .you7").innerText(), /^You’re driving · .+ is paused$/);
  assert.equal(app.desktop.isDriving(), true, "the engine holds every screen action now");
  assert.equal(await page.locator("#stage7 .real-ag").count(), 0, "no Trunk cursor while you drive");
  const before = calls.length;
  let clicked = false;
  const waiting = app.desktop.click({ window: "Notepad", point: { x: 1, y: 1 } }, context()).then(() => { clicked = true; });
  await page.locator('#stage7 [data-act="handback"][data-v="screen"]').waitFor();
  assert.equal(clicked, false);
  assert.equal(calls.length, before, "the Trunk's click waited while you drove");
  await page.locator('#stage7 [data-act="handback"][data-v="screen"]').click();
  await page.locator(".toast", { hasText: "Handed back." }).waitFor();
  await waiting;
  assert.equal(clicked, true, "handed back: its click happened");
  assert.equal(app.desktop.isDriving(), false);
  await page.locator("#stage7 .you7").waitFor({ state: "detached" });
  assert.deepEqual(errors, []);

  // Isolate incoming frames from the app's unrelated periodic redraws: a new Trunk must request its own redraw.
  const probe = await browser.newPage();
  await probe.route("**/cursor-probe", (route) => route.fulfill({ contentType: "text/html", body: '<div id="stage7"><div class="st7-screen"></div></div>' }));
  const lines = [first.id, second.id, second.id].map((trunk, i) => JSON.stringify({ frame: `data:image/png;base64,${data}`,
    cursor: { x: 0.5, y: 0.5, at: String(i), trunk }, driving: false })).join("\n") + "\n";
  await probe.route("**/api/panels/screen?*", (route) => route.fulfill({ contentType: "application/x-ndjson", body: lines }));
  await probe.goto(server.url + "/cursor-probe");
  await probe.evaluate(async () => {
    window.redraws = [];
    const screen = await import("/app/chat/stage-screen.js");
    screen.watchScreen(true, (redraw) => window.redraws.push(redraw));
  });
  await probe.waitForFunction(() => window.redraws.length === 3);
  assert.deepEqual(await probe.evaluate(() => window.redraws), [true, true, false],
    "the Trunk change redraws its label immediately; another frame of the same Trunk only paints coordinates");
  await probe.evaluate(async () => (await import("/app/chat/stage-screen.js")).watchScreen(false));
  await probe.close();
});
