/* parity-b2: the window reads This computer's screen (GET /api/panels/screen) only while the owner has the computer
   view open on it: nothing before it opens, nothing once it is closed, switched to the browser, hidden or locked, and
   it starts again when it is shown again. The capture is a stand-in that counts, so every read the window makes is a
   frame the engine would have taken. design/redesign/tools/mutate-live-screen.mjs breaks each stop in turn (public/app)
   and expects this file to go red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==", "base64");
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function windowWith(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-live-screen-window-"));
  const quiet = { name: "scripted", async complete() { return { content: "Here it is.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const run = app.store.createRun(app.runtime.owner, "Look at my screen");
  app.store.message(run.sessionId, { role: "user", content: run.prompt });
  app.store.message(run.sessionId, { role: "assistant", content: "Here it is." });
  app.store.finish(run.id, "completed", "Here it is.");
  const taken = { count: 0 };
  app.desktop.liveFrame = async () => { taken.count += 1; return { bytes: JPEG, type: "image/jpeg", width: 1, height: 1 }; };
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  await fetch(new URL("/api/onboarding", server.url), { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  await page.locator(`[data-act="chat"][data-id="${run.sessionId}"]`).first().click();
  await page.locator("#conversation .b").first().waitFor({ timeout: 30000 });
  return { page, taken, errors };
}
/* The count after the window has had time to read a few more times, less one read that was already on its way. */
async function flatFor(taken, ms = 2600) {
  await pause(700);
  const settled = taken.count;
  await pause(ms);
  return taken.count - settled;
}

test("This computer's screen is read only while its view is open and showing, and never otherwise", async (t) => {
  const { page, taken, errors } = await windowWith(t);
  assert.equal(await flatFor(taken), 0);
  assert.equal(taken.count, 0, "nothing is read before the view opens");
  const open = page.locator('.head [data-act="stage"][data-v="computer"]').first();
  await open.click();
  await page.locator("#stage7 .livescr-img[src^='data:image/jpeg']").waitFor({ timeout: 15000 });
  const started = taken.count;
  await pause(2600);
  assert.ok(taken.count - started >= 2, `it keeps reading while open (${taken.count - started} more)`);

  await page.locator('#stage7 [data-act="stage-close"]').click();
  assert.equal(await flatFor(taken), 0, "closed: it stops");

  await open.click();
  await page.locator("#stage7 .livescr-img[src^='data:image/jpeg']").waitFor({ timeout: 15000 });
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  assert.equal(await flatFor(taken), 0, "hidden: it stops");
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: false, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  const shown = taken.count;
  await pause(2600);
  assert.ok(taken.count > shown, "shown again: it starts again");

  await page.locator('#stage7 .st7-sw [data-act="stage"][data-v="browser"]').click();
  assert.equal(await flatFor(taken), 0, "switched to the browser: it stops");
  await page.locator('#stage7 .st7-sw [data-act="stage"][data-v="computer"]').click();
  await page.locator("#stage7 .livescr-img").waitFor({ timeout: 15000 });
  await page.evaluate(() => document.getElementById("app").classList.add("locked-b17"));
  assert.equal(await flatFor(taken), 0, "Branch locked: it stops");
  assert.deepEqual(errors, []);
});
