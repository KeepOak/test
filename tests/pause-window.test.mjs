/**
 * Batch B (shell and pausing): pausing Trunks from the window, 1:1 with the prototype's pass 17c, against a real engine
 * in a headless browser. Every click is read back through the engine (GET /api/trunks, the runs as each Trunk).
 *
 * - Pause all, while a Trunk works, asks "When the current task ends" or "Now" and pauses only on Pause (pausedo17c).
 * - A Trunk held paused while its task still runs is "will pause when this task ends": its conversation's note offers
 *   Keep going (resume) and Pause now (stops the task); a paused Trunk's note offers Resume.
 * - The status bar's "N paused" / "All Trunks paused" chip opens the Paused list (pzlist17c).
 * - None of it asks the browser dashboard, which ships off.
 * - Lockdown's banner is drawn above Settings too; and the shell's greyed controls say why (window.why.*), while
 *   "Start something in the background" works once the shared commands are on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { brain } from "./trunks-helpers.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const en = JSON.parse(await readFile(new URL("../public/locales/en.json", import.meta.url), "utf8"));

async function until(check, timeout = 20000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value || Date.now() > end) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture(t) {
  const hold = { release: null };
  const slow = ({ request, last }) => (/SLOW7610/.test(String(last?.content ?? ""))
    ? new Promise((resolve, reject) => {
      hold.release = () => resolve({ content: "Finished SLOW7610.", toolCalls: [] });
      request.signal.addEventListener("abort", () => reject(request.signal.reason ?? new Error("aborted")), { once: true });
    }) : null);
  const root = await mkdtemp(join(tmpdir(), "branch-pause-window-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: brain([slow]) });
  app.store.save("settings", app.runtime.owner, "conversation-mode-settings", { newConversation: "follow" });
  app.trunks.setMode("trunks", { mode: "on" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { hold.release?.(); await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return response.json();
  };
  await call("/api/onboarding", { done: true });
  await call("/api/deployment/suggestion", { id: "updates", answer: "never" }).catch(() => undefined);
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [], dashboard = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/dashboard")) dashboard.push(request.url()); });
  const open = async () => {
    await page.goto(server.url + "/");
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#statusbar [data-act=\"tasks10\"]").waitFor({ timeout: 120000 });
  };
  return { app, call, page, errors, dashboard, open, hold };
}

const trunk = (app, id) => app.trunks.records.find(id);
const runs = (app, id) => app.runtime.runsOfTrunk(id).length;
const toastSays = (page, words) => page.locator(".toast", { hasText: words }).first().waitFor({ timeout: 10000 });
async function startSlow(f, id) {
  f.hold.release = null;
  const said = f.app.trunks.say(id, "SLOW7610").catch((error) => ({ status: "failed", error }));
  assert.ok(await until(() => f.hold.release), "the slow task started");
  return { said }; // wrapped, so awaiting the start never waits for the task itself
}
async function openChat(page, sessionId) {
  await page.locator(`#side .row[data-id="${sessionId}"]`).click();
  await page.waitForFunction((id) => document.querySelector(`#side .row[data-id="${id}"]`)?.getAttribute("aria-current") === "true", sessionId);
}
async function pausetrunkFromCustomize(page, id) {
  await page.locator('#side .nav[data-v="customize"]').first().click();
  await page.locator(`#main [data-act="pausetrunk"][data-id="${id}"]`).click();
}

test("pausing from the window: ask while working, the paused chip and list, the conversation's note, never the dashboard", async (t) => {
  const f = await fixture(t);
  const { app, page } = f;
  const fi = app.trunks.create({ name: "Fi" }), jo = app.trunks.create({ name: "Jo" });
  await app.trunks.introduced();
  const { said: first } = await startSlow(f, fi.id);
  await f.open();
  const chip = page.locator("#statusbar .pzsb17c");
  assert.equal(await chip.count(), 0, "no chip while nothing is paused");

  // Pause all from the running popover: Fi is working, so it asks, and nothing changes until Pause.
  await page.locator('#statusbar [data-act="tasks10"]').click();
  await page.locator('.pop [data-act="pauseall"]').click();
  const dlg = page.locator(".dlg");
  assert.equal(await dlg.locator(".dlg-h h2").textContent(), en["window.flows.pause.q-all"]);
  assert.equal((await dlg.locator(".lede").textContent()).trim(), en["window.flows.pause.is-working"].replace("{names}", "Fi"));
  assert.ok(await dlg.locator("#pz-after17c").isChecked(), "When the current task ends is picked first");
  assert.equal(await dlg.locator("#pz-now17c").isDisabled(), false);
  assert.ok(!trunk(app, fi.id).paused && !trunk(app, jo.id).paused, "nothing is paused before Pause");
  await dlg.locator('[data-act="pausedo17c"]').click();
  await toastSays(page, en["window.flows.pause.working-end"]);
  assert.ok(trunk(app, fi.id).paused && trunk(app, jo.id).paused, "both are paused");
  assert.equal(runs(app, fi.id), 1, "Fi's task still runs");
  await chip.filter({ hasText: en["window.flows.pause.all-chip"] }).waitFor();

  // Fi's conversation ends with "will pause when this task ends"; Keep going resumes it and its task carries on.
  await openChat(page, fi.chatSessionId);
  const note = page.locator("#conversation .pz17c");
  await note.filter({ hasText: en["window.flows.pause.will-pause-note"].replace("{name}", "Fi") }).waitFor();
  await note.locator('[data-act="pausekeep17c"]').click();
  await toastSays(page, en["window.flows.pause.keeps-going"].replace("{name}", "Fi"));
  assert.equal(trunk(app, fi.id).paused, undefined, "Fi is no longer paused");
  assert.equal(runs(app, fi.id), 1, "and its task still runs");
  await note.waitFor({ state: "detached" });
  const remaining = app.trunks.records.list().filter(one => one.paused);
  assert.ok(remaining.some(one => one.id === jo.id), "Jo remains paused when only Fi resumes");
  await chip.filter({ hasText: en["window.flows.pause.count-chip"].replace("{count}", String(remaining.length)) }).waitFor();

  // The Paused list contains every remaining Trunk, including the idle default, with its own Resume.
  await chip.click();
  const row = page.locator(".pop .pzrow17c");
  assert.deepEqual((await row.locator('[data-act="pausetrunk"]').evaluateAll(nodes => nodes.map(node => node.dataset.id))).sort(), remaining.map(one => one.id).sort());
  const joRow = row.filter({ has: page.locator(`[data-id="${jo.id}"]`) });
  assert.match(await joRow.textContent(), /Jo/);
  assert.match(await joRow.textContent(), new RegExp(en["window.flows.pause.nothing-new-row"]));
  await joRow.locator('[data-act="pausetrunk"]').click();
  assert.ok(await until(() => !trunk(app, jo.id).paused), "Jo resumed");
  for (const one of remaining.filter(one => one.id !== jo.id)) {
    await chip.click(); // each Resume closes its menu, as the existing single-row action did
    await row.locator(`[data-act="pausetrunk"][data-id="${one.id}"]`).click();
    assert.ok(await until(() => !trunk(app, one.id).paused), `${one.name} resumed by its own control`);
  }
  await chip.waitFor({ state: "detached" });

  // Pause Fi while it works, choosing Now: its task is stopped, and its note says it is paused, with Resume.
  await pausetrunkFromCustomize(page, fi.id);
  assert.equal(await dlg.locator(".dlg-h h2").textContent(), en["window.flows.pause.q-one"].replace("{name}", "Fi"));
  await dlg.locator("#pz-now17c").check();
  await dlg.locator('[data-act="pausedo17c"]').click();
  assert.notEqual((await first).status, "completed", "the running task was stopped");
  assert.ok(trunk(app, fi.id).paused && runs(app, fi.id) === 0);
  await toastSays(page, en["window.flows.pause.now-paused"].replace("{name}", "Fi"));
  await openChat(page, fi.chatSessionId);
  await note.filter({ hasText: en["window.flows.pause.is-paused"].replace("{name}", "Fi") }).waitFor();
  await note.locator('[data-act="pausetrunk"]').click();
  assert.ok(await until(() => !trunk(app, fi.id).paused), "Resume in the note resumes Fi");
  await note.waitFor({ state: "detached" });

  // Paused with its task still running (a plain pause): Pause asks "Keep going or Pause now"; the note offers the same.
  const { said: second } = await startSlow(f, fi.id);
  await f.call(`/api/trunks/${fi.id}/pause`, {});
  await note.filter({ hasText: en["window.flows.pause.will-pause-note"].replace("{name}", "Fi") }).waitFor();
  await pausetrunkFromCustomize(page, fi.id);
  assert.equal(await dlg.locator(".dlg-h h2").textContent(), en["window.flows.pause.after-title"].replace("{name}", "Fi"));
  await dlg.locator('[data-act="dlg-close"]').first().click();
  await openChat(page, fi.chatSessionId);
  await note.locator('[data-act="pausenow17c"]').click();
  assert.notEqual((await second).status, "completed", "Pause now stopped the task");
  assert.ok(trunk(app, fi.id).paused && runs(app, fi.id) === 0);
  await note.filter({ hasText: en["window.flows.pause.is-paused"].replace("{name}", "Fi") }).waitFor();

  // From the list: Pause all Trunks (nobody works, so at once), then Resume all Trunks.
  await chip.click();
  await page.locator('.pop [data-act="pauseall17c"]').click();
  assert.ok(await until(() => trunk(app, fi.id).paused && trunk(app, jo.id).paused), "all paused");
  await chip.filter({ hasText: en["window.flows.pause.all-chip"] }).waitFor();
  await chip.click();
  assert.equal((await page.locator('.pop [data-act="pauseall17c"]').textContent()).trim(), en["window.places.overview.resume-all-trunks"]);
  await page.locator('.pop [data-act="pauseall17c"]').click();
  assert.ok(await until(() => !trunk(app, fi.id).paused && !trunk(app, jo.id).paused), "all resumed");
  await chip.waitFor({ state: "detached" });

  assert.deepEqual(f.dashboard, [], "pausing never asks the browser dashboard");
  assert.deepEqual(f.errors, []);
});

test("the shell: Lockdown's banner above Settings, greyed controls say why, and /bg once the shared commands are on", async (t) => {
  const f = await fixture(t);
  const { page } = f;
  await f.call("/api/commands/settings", { mode: "off" });
  await f.open();
  const tip = (selector) => page.locator(selector).first().getAttribute("data-tip");

  // In the browser, Minimise and Quit say why they stay greyed.
  assert.equal(await tip('.win [data-act="win-min"]'), en["window.why.win-min"]);
  assert.equal(await tip('.win [data-act="quit"]'), en["window.why.quit"]);
  // The workspace switcher's only workspace. The update popover offers Remind me tomorrow only when the desktop app has an
  // update ready (tests/wire-greyed-update-remind-ui.test.mjs), so a browser's has none.
  await page.locator('#statusbar [data-act="machines"]').click();
  assert.equal(await tip('.pop [data-act="ws"]'), en["window.why.ws"]);
  await page.keyboard.press("Escape");
  await page.locator('#statusbar [data-act="updmenu"]').click();
  await page.locator(".pop").first().waitFor();
  assert.equal(await page.locator('.pop [data-act="upd-snooze"]').count(), 0);
  await page.keyboard.press("Escape");

  // /bg: greyed with its reason while the shared commands are off; once on, it puts /bg in the message box.
  await page.locator('#statusbar [data-act="tasks10"]').click();
  assert.equal(await tip('.pop [data-act="bg-new-off"]'), en["window.why.bg-new-off"]);
  await page.keyboard.press("Escape");
  await f.call("/api/commands/settings", { mode: "on" });
  await page.locator('#statusbar [data-act="tasks10"]').click();
  const bg = page.locator('.pop [data-act="bg-new"]');
  assert.equal(await bg.getAttribute("aria-disabled"), null, "Start something in the background is live");
  await bg.click();
  assert.equal(await page.locator("#prompt").inputValue(), "/bg ");

  // Lockdown on: Settings carries the red banner, and its Turn it off switches Lockdown off.
  await f.call("/api/lockdown", { on: true });
  await page.locator('#side [data-act="view"][data-v="settings"]').first().click();
  const banner = page.locator("#main > .lock-banner");
  await banner.waitFor({ state: "visible", timeout: 15000 });
  assert.ok(await page.locator("#main > .lock-banner + .settings").count(), "the banner sits above the Settings page");
  const box = await banner.boundingBox(), set = await page.locator("#main .settings").boundingBox();
  assert.ok(set.y >= box.y + box.height - 1, "the page starts under the banner");
  await banner.locator('[data-act="lock"]').click();
  assert.ok(await until(async () => (await f.call("/api/lockdown")).on === false), "Turn it off switched Lockdown off");
  await banner.waitFor({ state: "hidden" });
  assert.deepEqual(f.errors, []);
});
