/* wire-greyed: Settings › Notifications was half drawn: "A Trunk needs a yes", "A long task finishes" and "Days off" were
   greyed, and "Play a sound" and "And on the computer" were saved but nothing followed them. Now the notify card keeps
   needsYes and taskDone, quiet hours keep whole days off (quietHours.days), and the window's notification card follows
   all of them: a long task that ends in a conversation not on screen is announced, with the chosen sound and the
   computer's own notification while the window is out of sight, and nothing but the card during quiet hours.
   Mutation: in public/app/shell/notify.js drop onRender(watchDone), and the window case goes red. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, inQuietHours, quietUntil } from "../dist/index.js";
import { readComfort, saveComfort } from "../dist/comfort/settings.js";
import { startServer } from "../dist/server.js";

const quiet = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

test("whole days off are quiet all day, even with quiet hours off, and end at the next day's start", () => {
  const weekends = { enabled: false, from: "21:00", to: "07:00", timezone: "UTC", days: [6, 7] };
  assert.equal(inQuietHours(new Date("2026-10-03T12:00:00.000Z"), weekends), true, "a Saturday");
  assert.equal(inQuietHours(new Date("2026-10-05T12:00:00.000Z"), weekends), false, "a Monday");
  assert.equal(quietUntil(new Date("2026-10-03T12:00:00.000Z"), weekends), "2026-10-05T00:00:00.000Z", "past Sunday too");
  // With quiet hours on as well, the night after the days off still waits until morning.
  const both = { ...weekends, enabled: true };
  assert.equal(quietUntil(new Date("2026-10-04T12:00:00.000Z"), both), "2026-10-05T07:00:00.000Z");
  // Records written before days off existed read as before.
  assert.equal(inQuietHours(new Date("2026-10-03T12:00:00.000Z"), { enabled: false, from: "21:00", to: "07:00", timezone: "UTC" }), false);
});

test("both notices ship on, and an owner's off is kept", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-wire-notify-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  assert.deepEqual([readComfort(app.store, owner, "notify").needsYes, readComfort(app.store, owner, "notify").taskDone], [true, true]);
  saveComfort(app.store, owner, "notify", { taskDone: false });
  saveComfort(app.store, owner, "notify", { sound: "knock" });
  assert.deepEqual([readComfort(app.store, owner, "notify").needsYes, readComfort(app.store, owner, "notify").taskDone], [true, false]);
});

async function signedIn(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-wire-notify-ui-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: quiet });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const call = (path, body) => fetch(new URL(`/api/${path}`, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then((r) => r.json());
  await call("onboarding", { done: true });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, serviceWorkers: "block" });
  // Stand-ins that record what the window asks of the computer: its notification and its sound.
  await page.addInitScript(() => {
    window.__told = [];
    window.__sounds = 0;
    window.Notification = class { constructor(title, options) { window.__told.push([title, options?.body]); } static permission = "granted"; static requestPermission() { return Promise.resolve("granted"); } };
    window.AudioContext = class { constructor() { this.currentTime = 0; this.destination = {}; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (x) => x }; }
      createOscillator() { window.__sounds += 1; return { frequency: {}, connect: (x) => x, start() {}, stop() {} }; } };
    document.hasFocus = () => false;
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  return { app, page, call, errors };
}

async function openNotifications(page) {
  await page.keyboard.press("Control+,");
  await page.locator(".settings").waitFor();
  await page.locator('[data-act="setpage"][data-v="notifications"]').click();
  await page.locator("#n-need").waitFor();
  await page.waitForTimeout(800);
}

test("the page's three rows are live and saved by the engine", async (t) => {
  const { page, call, errors } = await signedIn(t);
  await openNotifications(page);
  for (const id of ["#n-need", "#n-done"]) {
    assert.equal(await page.locator(id).isDisabled(), false);
    assert.equal(await page.locator(id).isChecked(), true);
  }
  await page.locator("#n-done").click();
  await page.waitForTimeout(800);
  assert.equal((await call("comfort")).values.notify.taskDone, false);
  await page.locator('[data-act="n-day"][data-v="7"]').click();
  await page.locator('[data-act="n-day"][data-v="7"][aria-pressed="true"]').waitFor();
  assert.deepEqual((await call("calendar")).settings.quietHours.days, [7]);
  await page.locator('[data-act="n-day"][data-v="none"]').click();
  await page.locator('[data-act="n-day"][data-v="none"][aria-pressed="true"]').waitFor();
  assert.deepEqual((await call("calendar")).settings.quietHours.days, []);
  assert.deepEqual(errors, []);
});

test("a long task that ends out of sight is announced with the sound and the computer's notification", async (t) => {
  const { app, page, call, errors } = await signedIn(t);
  await call("comfort", { card: "notify", values: { sound: "knock", method: "system" } });
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const run = app.store.createRun(app.runtime.owner, "Tidy the survey notes");
  app.store.db.prepare("UPDATE tasks SET created_at=? WHERE id=?").run(new Date(Date.now() - 5 * 60000).toISOString(), run.id);
  app.store.event(run.id, "run.started", {}); // the window reads its state again on the engine's events
  await page.waitForTimeout(3000); // and sees the task running first
  app.store.db.prepare("UPDATE tasks SET status='completed', updated_at=? WHERE id=?").run(new Date().toISOString(), run.id);
  app.store.event(run.id, "run.completed", {});
  await page.locator(".notif", { hasText: "Done." }).waitFor({ timeout: 30000 });
  assert.ok(await page.evaluate(() => window.__sounds) > 0, "the knock played");
  const told = await page.evaluate(() => window.__told);
  assert.equal(told.length, 1);
  assert.match(told[0][1], /Done/);

  // Today made a whole day off: the next one still gets its card, but no sound and no computer notification.
  const today = [7, 1, 2, 3, 4, 5, 6][new Date().getUTCDay()];
  const calendar = (await call("calendar")).settings;
  await call("calendar", { ...calendar, quietHours: { ...calendar.quietHours, timezone: "UTC", days: [today] } });
  await page.locator('[data-act="notif-x"]').click();
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const second = app.store.createRun(app.runtime.owner, "Check the survey figures");
  app.store.db.prepare("UPDATE tasks SET created_at=? WHERE id=?").run(new Date(Date.now() - 5 * 60000).toISOString(), second.id);
  app.store.event(second.id, "run.started", {});
  await page.waitForTimeout(3000);
  app.store.db.prepare("UPDATE tasks SET status='failed', updated_at=? WHERE id=?").run(new Date().toISOString(), second.id);
  app.store.event(second.id, "run.failed", {});
  await page.locator(".notif", { hasText: "Stopped before it finished" }).waitFor({ timeout: 30000 });
  assert.deepEqual([await page.evaluate(() => window.__sounds), (await page.evaluate(() => window.__told)).length], [0, 0]);
  assert.deepEqual(errors, []);
});
