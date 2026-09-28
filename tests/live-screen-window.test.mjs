/* parity-b2: the window reads This computer's screen (GET /api/panels/screen, src/local-screen.ts) only while the owner
   has the computer view open on it and has chosen what it shows: nothing before, and the stream is let go, and the
   engine's reader with it, once the view is closed, switched to the browser, hidden or locked. All screens never reads
   This computer when This computer is not one of the screens it draws. The screen is the stand-in of
   tests/local-screen-fixture.mjs, which counts its frames and whether it was let go. */
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
  return { page, taken, errors, run, server, open: async () => {
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
    await page.locator(`[data-act="chat"][data-id="${run.sessionId}"]`).first().click();
    await page.locator("#conversation .b").first().waitFor({ timeout: 30000 });
  } };
}
/* The owner chooses the stand-in's app window in the view (#610: nothing is shown before a choice). */
async function choose(page) {
  await page.locator("#native-target option").filter({ hasText: "Fixture editor" }).waitFor({ state: "attached", timeout: 15000 });
  await page.locator("#native-target").selectOption({ label: "Fixture editor" });
  await page.getByRole("button", { name: "Share selected window", exact: true }).click();
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
  await open.click();
  assert.deepEqual(await flatFor(taken, 800), { more: 0, open: 0 }, "open but nothing chosen: nothing is read");
  await choose(page);
  const started = taken.count;
  await pause(1000);
  assert.ok(taken.count - started >= 3, `several frames a second while open (${taken.count - started} in a second)`);

  await page.locator('#stage7 [data-act="stage-close"]').click();
  assert.deepEqual(await flatFor(taken), { more: 0, open: 0 }, "closed: it stops, and the reader is let go");

  await open.click();
  await choose(page);
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  assert.deepEqual(await flatFor(taken), { more: 0, open: 0 }, "hidden: it stops");
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: false, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await choose(page);
  const shown = taken.count;
  await pause(1500);
  assert.ok(taken.count > shown, "shown again and chosen: it starts again");

  await page.locator('#stage7 .st7-sw [data-act="stage"][data-v="browser"]').click();
  assert.deepEqual(await flatFor(taken), { more: 0, open: 0 }, "switched to the browser: it stops");
  await page.locator('#stage7 .st7-sw [data-act="stage"][data-v="computer"]').click();
  await choose(page);
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
