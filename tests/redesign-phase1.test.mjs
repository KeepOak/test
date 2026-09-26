/* Redesign phase 1: the pieces of the approved sample the owner loved most, built into the real window.
   Slate by default, the usage ring and its popover, the save-progress prompt, the suggestion bars and
   update cards, the permission-mode chip, and the glass dropdown with its tooltips. Headless only. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { crossingsOf, shareLeft, tightestOf } from "../dist/usage-glance.js";

/* Redesign: in the new window (public/app/**) the look is the engine's (GET/POST /api/look, shell/look.js; Branch Slate
   is the window's own colours) and themes are picked in the gallery (shell/themes.js); the old usage ring is the status
   bar's connection button whose popover is "What each connection has left" (shell/usage.js), and the save-progress
   question is the prototype's offer (.ckpt-q) with its five-second ring. */
async function fixture(t, { provider, onboarded = true, width = 1440, height = 950 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-redesign-1-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => {
    await browser.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  const call = (path, body) => fetch(new URL(path, server.url), {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then((response) => response.json());
  if (onboarded) await call("/api/onboarding", { done: true });
  const context = await browser.newContext({ viewport: { width, height }, serviceWorkers: "block" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const open = async () => {
    await page.goto(server.url);
    await page.getByLabel("Session token", { exact: true }).fill(server.token);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  };
  await open();
  return { page, server, call, errors, app, open, context };
}
const signedInAgain = async (page) => {
  await page.reload();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
};
/** Settings › Appearance › "Browse all … themes", then a theme card. */
async function pickTheme(page, id) {
  await page.locator('#side [data-act="view"][data-v="settings"]').click();
  await page.locator('[data-act="setpage"][data-v="appearance"]').click();
  await page.locator('.set-col [data-act="skins"]').click();
  await page.locator(`.dlg [data-act="skin"][data-v="${id}"]`).click();
}

/* ---------------------------------------------------------------- 3. Slate by default */

test("a new window wears Slate, and a picked Forest is remembered over the new default", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.page.evaluate(() => document.documentElement.dataset.palette), "slate");
  assert.equal((await f.call("/api/look")).theme, "slate", "the shared record starts on Slate too");
  await pickTheme(f.page, "forest");
  await f.page.waitForFunction(() => document.documentElement.dataset.palette === "forest");
  // Redesign: the engine keeps the choice (the old window's own "branch-palette" note is replaced by it).
  assert.equal((await f.call("/api/look")).theme, "forest", "Forest is written down, not left as the default");
  await signedInAgain(f.page);
  await f.page.waitForFunction(() => document.documentElement.dataset.palette === "forest");
  assert.deepEqual(f.errors, []);
});

test("a Forest the workspace wrote down before Slate became the default is kept, not replaced", async (t) => {
  const f = await fixture(t);
  // What an older copy left behind: the choice in the shared record, nothing in this browser.
  await f.call("/api/look", { theme: "forest", changedBy: "window" });
  await signedInAgain(f.page);
  await f.page.waitForFunction(() => document.documentElement.dataset.palette === "forest");
  assert.equal((await f.call("/api/look")).theme, "forest");
  assert.deepEqual(f.errors, []);
});

test("dark mode is its own setting and does not move with the new default palette", async () => {
  const { PreferencesSchema } = await import("../dist/preferences.js");
  assert.equal(PreferencesSchema.parse({}).appearance, "forest", "the stored light-or-dark choice still means dark");
});

/* ---------------------------------------------------------------- 1. the usage ring and the question at 95% */

const win = (over) => ({ id: "requests", title: "Requests", kind: "requests", limit: 100, remaining: 50, resetAt: null,
  measuredAt: "2026-09-19T10:00:00.000Z", state: "measured", from: "from the headers", ...over });
const row = (over) => ({ connection: "a", connectionName: "Alpha", account: null, accountLabel: null, inUse: true,
  state: "measured", windows: [win()], note: "", ...over });

test("the ring picks the connection with the least left, and never makes a share out of money or silence", () => {
  assert.equal(shareLeft(win({ kind: "money", limit: 40, remaining: 1 })), null, "money is never a share");
  assert.equal(shareLeft(win({ remaining: null })), null, "a remainder nobody gave is not a share");
  assert.equal(shareLeft(win({ limit: null })), null);
  const rows = [row(), row({ connection: "b", connectionName: "Beta", windows: [win({ remaining: 12, resetAt: "2026-09-19T18:00:00.000Z" })] }),
    row({ connection: "c", connectionName: "Cash", windows: [win({ kind: "money", limit: 40, remaining: 0 })] })];
  const tight = tightestOf(rows);
  assert.equal(tight.connectionName, "Beta");
  assert.equal(tight.percentLeft, 12);
  assert.equal(tight.resetAt, "2026-09-19T18:00:00.000Z");
  assert.equal(tightestOf([row({ windows: [], state: "not_published" })]), null, "nothing reported, nothing drawn");
  assert.equal(tightestOf([row({ windows: [win({ remaining: 46, limit: 1000 })] })]).percentLeft, 4, "4.6% left reads as 4, never 5");
});

test("the question at 95% is only for measured windows, and is keyed by the window so it asks once", () => {
  const now = Date.parse("2026-09-19T12:00:00.000Z");
  const at = (remaining, over = {}) => crossingsOf([row({ windows: [win({ remaining, ...over })] })], now);
  assert.equal(at(6).length, 0, "94% used does not ask");
  assert.equal(at(5).length, 1, "95% used asks");
  assert.equal(at(5)[0].percentUsed, 95);
  assert.equal(at(1, { state: "estimated" }).length, 0, "an estimate never asks");
  assert.equal(at(1, { kind: "money", limit: 40 }).length, 0, "money never asks");
  assert.notEqual(at(1, { resetAt: "2026-09-19T13:00:00.000Z" })[0].key, at(1, { resetAt: "2026-09-19T18:00:00.000Z" })[0].key,
    "a new window is a new question");
  assert.equal(at(1)[0].key, at(2)[0].key, "the same window stays one question as it fills");
});

/** Makes the first connection say, on a header, that it has `remaining` of 100 requests left. */
function reportLeft(app, remaining) {
  const preset = [...app.runtime.models.presets.keys()][0];
  app.runtime.models.health.recordSuccess(preset, 50, new Headers({
    "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": String(remaining), "x-ratelimit-reset-requests": "2h0m0s",
  }));
  return app.runtime.models.presets.get(preset).name;
}
function slowModel() {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = {
    name: "scripted",
    async complete(request) {
      const asked = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      if (String(asked).includes("Downloads")) await gate;
      return { content: "Done.", toolCalls: [] };
    },
  };
  return { provider, release: () => release() };
}
const refreshRing = (page) => page.evaluate(() => globalThis.branchUsageGlance.refresh());
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const usageButton = (page) => page.locator('#statusbar [data-act="usagepop"]');
/** The offer is looked for when the window starts and every 20 seconds (shell/usage.js). */
const offer = (page) => page.getByRole("alertdialog", { name: "Save progress?" });

test("the connection button opens the glass list of what each connection has left, and closes on the same click", async (t) => {
  const f = await fixture(t, { provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const name = reportLeft(f.app, 12);
  await signedInAgain(f.page);
  const ring = usageButton(f.page);
  await ring.waitFor({ state: "visible" });
  // Redesign: replaced by the new window (the status bar names the connection in use; "12% left" and the low warning
  // are in the list it opens).
  assert.match(await ring.innerText(), new RegExp(escape(name)));
  await ring.click();
  const pop = f.page.locator(".pop");
  await pop.waitFor({ state: "visible" });
  assert.match(await pop.innerText(), /What each connection has left[\s\S]*Measured[\s\S]*12% left/i);
  assert.equal(await pop.locator(".lim-bar i").first().evaluate((node) => node.style.width), "12%");
  await f.page.keyboard.press("Escape");
  await pop.waitFor({ state: "detached" });
  await ring.click();
  await pop.waitFor({ state: "visible" });
  await ring.click();
  await pop.waitFor({ state: "detached", timeout: 5000 }).catch(() => assert.fail("the same click closes the list"));
  assert.equal(await ring.getAttribute("aria-expanded"), "false");
  assert.deepEqual(f.errors, []);
});

test("the connection button can be hidden in Settings, and nobody but the owner ever sees a number", async (t) => {
  // Redesign: Settings › Appearance › What's shown › "The usage ring" (preferences.hidden, as prototype.html).
  const f = await fixture(t, { provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  reportLeft(f.app, 12);
  await usageButton(f.page).waitFor({ state: "visible" });
  await f.page.locator('#side [data-act="view"][data-v="settings"]').click();
  await f.page.locator('[data-act="setpage"][data-v="appearance"]').click();
  await f.page.locator("#h-usage").uncheck();
  await usageButton(f.page).waitFor({ state: "detached" });
  assert.deepEqual((await f.call("/api/state")).preferences.hidden, ["usage"]);
  await f.page.locator("#h-usage").check();
  await usageButton(f.page).waitFor({ state: "visible" });
  const person = f.app.store.profiles.create({ name: "Sam", pin: "1234" });
  f.app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const seen = await fetch(new URL("/api/usage/glance", f.server.url), { headers: { authorization: `Bearer ${f.server.token}` } });
  assert.equal(seen.status, 200, "not an error");
  assert.deepEqual(await seen.json(), { available: false }, "and not a number");
  await signedInAgain(f.page);
  if (await usageButton(f.page).count()) {
    await usageButton(f.page).click();
    await f.page.locator(".pop").waitFor();
    assert.doesNotMatch(await f.page.locator(".pop").innerText(), /% left/, "Sam is shown no number");
  }
  f.app.store.profiles.switch({ profileId: null });
  assert.deepEqual(f.errors, []);
});

// Redesign: replaced by the new window (the old #usage-ring and its setting in /api/usage/glance/settings; the
// status bar's connection button and Appearance's "The usage ring" switch are checked live above).
test.skip("the ring shows the tightest connection, opens the glass list on click and closes on the same click", async (t) => {
  const f = await fixture(t, { provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
  const name = reportLeft(f.app, 12);
  await refreshRing(f.page);
  const ring = f.page.locator("#usage-ring");
  await ring.waitFor({ state: "visible" });
  assert.match(await ring.innerText(), new RegExp(`${escape(name)}.*12% left`));
  assert.equal(await ring.getAttribute("data-low"), "true", "under 15% the ring warns");
  await ring.click();
  const pop = f.page.locator("#usage-pop");
  await pop.waitFor({ state: "visible" });
  assert.match(await pop.innerText(), /What each connection has left[\s\S]*Measured[\s\S]*12% left/);
  assert.equal(await f.page.locator("#usage-pop .glance-bar i").first().evaluate((node) => node.style.width), "12%");
  await ring.click();
  await pop.waitFor({ state: "hidden" });
  assert.equal(await ring.getAttribute("aria-expanded"), "false");
  await ring.click();
  await f.page.keyboard.press("Escape");
  await pop.waitFor({ state: "hidden" });
  assert.deepEqual(f.errors, []);
});

// Redesign: replaced by the new window (the old #usage-ring and its setting in /api/usage/glance/settings; the
// status bar's connection button and Appearance's "The usage ring" switch are checked live above).
test.skip("the ring can be hidden in Settings, and nobody but the owner ever sees it", async (t) => {
  const f = await fixture(t);
  await refreshRing(f.page);
  await f.page.locator("#usage-ring").waitFor({ state: "visible" });
  assert.equal((await f.call("/api/usage/glance/settings", { ring: "hidden" })).settings.ring, "hidden");
  await refreshRing(f.page);
  await f.page.locator("#status-bar").waitFor({ state: "hidden" });
  await f.call("/api/usage/glance/settings", { ring: "shown" });
  const person = f.app.store.profiles.create({ name: "Sam", pin: "1234" });
  f.app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  const seen = await fetch(new URL("/api/usage/glance", f.server.url), { headers: { authorization: `Bearer ${f.server.token}` } });
  assert.equal(seen.status, 200, "not an error");
  assert.deepEqual(await seen.json(), { available: false }, "and not a number");
  await refreshRing(f.page);
  await f.page.locator("#status-bar").waitFor({ state: "hidden" });
  f.app.store.profiles.switch({ profileId: null });
  assert.deepEqual(f.errors, []);
});

async function runningTask(f) {
  void f.call("/api/run", { prompt: "Sort my Downloads folder." }).catch(() => undefined);
  let run;
  for (let tries = 0; tries < 200 && !run; tries += 1) {
    run = (await f.call("/api/state")).runs.find((one) => one.status === "running");
    if (!run) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(run, "the task is running");
  return run;
}

test("at 95% used it asks once; Save progress steers every running task to write down where it is", async (t) => {
  const model = slowModel();
  t.after(() => model.release());
  const f = await fixture(t, { provider: model.provider });
  const name = reportLeft(f.app, 3);
  const run = await runningTask(f);
  await signedInAgain(f.page);
  const box = offer(f.page);
  await box.waitFor({ state: "visible", timeout: 30000 });
  assert.match(await box.innerText(), new RegExp(`Almost out on ${escape(name)}\\. Ask running tasks to save their progress\\?`));
  assert.equal(await box.getAttribute("role"), "alertdialog");
  await box.getByRole("button", { name: "Save progress" }).click();
  // Redesign: the prototype's words for the same answer.
  await f.page.getByRole("status").filter({ hasText: "Asked 1 running task to save progress. Nothing was paused." }).waitFor();
  const events = (await f.call(`/api/runs/${run.id}`)).events;
  const steered = events.find((event) => event.kind === "run.steered");
  assert.ok(steered, "the task was steered through the ordinary channel");
  assert.match(steered.data.note, /checkpoint note/);
  assert.equal(events.some((event) => /cancel|paused/.test(event.kind)), false, "nothing was paused or stopped");
  await f.page.waitForTimeout(21000); // past the next look
  assert.equal(await box.count(), 0, "the same window is never asked about twice");
  model.release();
  assert.deepEqual(f.errors, []);
});

test("with saving progress off, or nothing running, it never asks; Not now changes nothing", async (t) => {
  const model = slowModel();
  t.after(() => model.release());
  const f = await fixture(t, { provider: model.provider });
  reportLeft(f.app, 1);
  await signedInAgain(f.page);
  await f.page.waitForTimeout(21000);
  assert.equal(await offer(f.page).count(), 0, "nothing running, nothing to ask");
  const run = await runningTask(f);
  await f.call("/api/usage/glance/settings", { saveProgress: "off" });
  await signedInAgain(f.page);
  await f.page.waitForTimeout(21000);
  assert.equal(await offer(f.page).count(), 0, "switched off, it never asks");
  await f.call("/api/usage/glance/settings", { saveProgress: "ask" });
  await signedInAgain(f.page);
  await offer(f.page).waitFor({ state: "visible", timeout: 30000 });
  await offer(f.page).getByRole("button", { name: "Not now" }).click();
  await offer(f.page).waitFor({ state: "detached" });
  assert.equal((await f.call(`/api/runs/${run.id}`)).events.some((event) => event.kind === "run.steered"), false, "Not now sends nothing");
  model.release();
  assert.deepEqual(f.errors, []);
});

test("saving progress and the ring's settings are the owner's alone", async (t) => {
  const f = await fixture(t);
  const person = f.app.store.profiles.create({ name: "Sam", pin: "1234" });
  f.app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  for (const [path, body] of [["/api/usage/save-progress", {}], ["/api/usage/glance/settings", { ring: "hidden" }]]) {
    const response = await fetch(new URL(path, f.server.url), { method: "POST",
      headers: { authorization: `Bearer ${f.server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.ok([400, 403].includes(response.status), `${path} is refused (${response.status})`);
  }
  f.app.store.profiles.switch({ profileId: null });
  assert.equal((await f.call("/api/usage/glance/settings")).settings.ring, "shown");
});

/* ---------------------------------------------------------------- integration review */

test("integration review: the connections list never covers the message box on a phone or a short laptop screen", async (t) => {
  for (const [width, height] of [[390, 844], [1024, 700]]) {
    const f = await fixture(t, { width, height, provider: { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } } });
    reportLeft(f.app, 12);
    await signedInAgain(f.page);
    await usageButton(f.page).click();
    await f.page.locator(".pop").waitFor({ state: "visible" });
    const boxes = await f.page.evaluate(() => {
      const pop = document.querySelector(".pop").getBoundingClientRect(), field = document.getElementById("prompt").getBoundingClientRect();
      const overlaps = pop.left < field.right && pop.right > field.left && pop.top < field.bottom && pop.bottom > field.top;
      const box = document.getElementById("composer");
      return { overlaps, stepsBack: box.classList.contains("under-pop") && getComputedStyle(box).pointerEvents === "none",
        inside: pop.top >= 0 && pop.bottom <= innerHeight };
    });
    assert.equal(boxes.inside, true, `the list stays on screen at ${width}x${height}`);
    // Redesign: the owner wants the popover beside its button; where it lands over the message box, the box steps back
    // (faded, taking no clicks) instead of the popover jumping away from what was pressed.
    if (boxes.overlaps) assert.equal(boxes.stepsBack, true, `the message box steps back under the list at ${width}x${height}`);
    assert.deepEqual(f.errors, []);
  }
});

test("integration review: the summary under the list says one connection and several in plain words", async () => {
  const { limitsSummary } = await import("../dist/usage-limits.js");
  assert.equal(limitsSummary(1, 1), "Your one connection reports a limit.");
  assert.equal(limitsSummary(0, 1), "Your one connection does not publish a limit.");
  assert.equal(limitsSummary(1, 3), "1 of 3 connections reports a limit. The other 2 do not publish one.");
  assert.equal(limitsSummary(2, 3), "2 of 3 connections report a limit. The other one does not publish one.");
  assert.equal(limitsSummary(0, 0), "No model connection is set up yet.");
});
