/* The plan meter in the status bar (prototype renderStatus, "the CodexBar"): a ring filled by what the active model's
   account has left, then "<connection> · N% left · resets at <time>", from the plan window ChatGPT reports on its own
   answers (x-codex-primary-used-percent, x-codex-primary-reset-at). The answers here come from a stand-in fetch; the
   rest is the real path: the ChatGPT connection's watched fetch, the connection's health, GET /api/usage/glance, the
   window. Headless only. Set PLAN_METER_SHOTS=<folder> to keep light and dark pictures of the line. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, syncChatGPTPresets } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { readRateLimit } from "../dist/rate-limit-headers.js";
import { accountsServiceFor } from "../dist/accounts/service.js";

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } })}.sig`;

test("the plan window ChatGPT reports is read from its headers: share used, and the reset as Unix seconds", () => {
  const now = Date.parse("2026-09-26T12:00:00Z"), reset = Date.parse("2026-09-26T18:00:00Z") / 1000;
  const reading = readRateLimit(new Headers({ "x-codex-primary-used-percent": "88", "x-codex-primary-reset-at": String(reset) }), now);
  assert.deepEqual(reading.windows, [{ id: "plan", title: "Plan window", counts: "plan", limit: 100, remaining: 12,
    resetAt: "2026-09-26T18:00:00.000Z", resetSeconds: 6 * 3600, source: "x-codex-primary-* headers", measuredAt: new Date(now).toISOString() }]);
  assert.equal(readRateLimit(new Headers({ "x-codex-primary-used-percent": "40" }), now).windows[0].resetAt, null, "no reset said, none shown");
  assert.equal(readRateLimit(new Headers(), now), null);
});

test("the status bar shows the ring and '<plan> · N% left · resets at <time>' from the engine, and follows new numbers", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-plan-meter-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const reported = { used: "88", reset: String(Math.ceil(Date.now() / 3_600_000 + 3) * 3600) }; // a whole hour, hours ahead
  const answer = () => new Response(["response.output_text.delta", "response.completed"].map((type) =>
    `data: ${JSON.stringify(type === "response.completed" ? { type, response: { usage: { input_tokens: 3, output_tokens: 1 } } } : { type, delta: "ok" })}\n\n`).join("") + "data: [DONE]\n\n",
  { status: 200, headers: { "content-type": "text/event-stream", "x-codex-primary-used-percent": reported.used, "x-codex-primary-reset-at": reported.reset } });
  const real = globalThis.fetch;
  globalThis.fetch = async () => answer(); // only while the ChatGPT connections are built: their fetch is this stand-in
  let ids;
  try { ids = syncChatGPTPresets(app.runtime.models, { accessToken: async () => token }, true, "BranchTest"); }
  finally { globalThis.fetch = real; }
  const service = accountsServiceFor(app.runtime.models);
  service.deps.chatgpt = { accessToken: async () => token, status: async () => ({ signedIn: true }) };
  await service.readIdentities();
  app.runtime.models.configure(app.runtime.owner, { activePreset: ids[0] });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const browser = await chromium.launch({ headless: true });
  t.after(async () => { await browser.close(); await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, body) => fetch(new URL(path, server.url), { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.json());
  await call("/api/onboarding", { done: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, serviceWorkers: "block", timezoneId: "America/New_York" });
  /* The long list of plans below is the window's answer from the moment it is set (crowded), whenever the read was asked:
     a read already on its way when the list is set answers with the list too, so a slow real answer never lands on it. */
  let crowded = null, checks = 0, holdLook = null;
  await page.route("**/api/usage/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (!["/api/usage/glance", "/api/usage/limits/look", "/api/usage/limits/refresh"].includes(path)) return route.continue();
    if (crowded && path.endsWith("/refresh")) checks++;
    if (crowded && path.endsWith("/look")) await holdLook?.promise;
    try {
      const real = crowded ? null : await route.fetch();
      await route.fulfill(crowded ? { json: crowded } : { response: real });
    } catch { await route.abort().catch(() => undefined); } // the page or the engine closed while it was asked
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByLabel("Session token", { exact: true }).fill(server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });

  const meter = page.locator('#statusbar [data-act="usagepop"]');
  await meter.waitFor();
  /* The owner's picture, before the first measurement: the plan's name and an empty ring, never the model's name. */
  await page.waitForFunction(() => document.querySelector('#statusbar [data-act="usagepop"] .hide-sm')?.textContent === "ChatGPT plan · measuring after your next message", null, { timeout: 30000 });
  assert.equal(await meter.locator("svg .ring-arc").count(), 0, "nothing measured: an empty ring, no share drawn");

  assert.equal((await app.runtime.run({ prompt: "hello" })).status, "completed");
  const row = (await call("/api/usage/glance")).rows.find((r) => r.presets.includes(ids[0]));
  assert.deepEqual(row.windows.map((w) => [w.id, w.limit, w.remaining, w.resetAt, w.state]),
    [["primary", 100, 12, new Date(Number(reported.reset) * 1000).toISOString(), "measured"]], "the engine holds the reported window");
  assert.equal(row.connectionName, "ChatGPT plan", "the service's plan, not the model");
  const date = new Date(Number(reported.reset) * 1000);
  const clock = { hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: "America/New_York" };
  const at = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", ...clock }).format(date);
  const fullReset = `resets ${new Intl.DateTimeFormat("en", { weekday: "long", year: "numeric", month: "numeric", day: "numeric", ...clock }).format(date)}`;
  const words = (pct) => `ChatGPT plan · ${pct}% left · resets ${at}`;
  await page.waitForFunction((want) => document.querySelector('#statusbar [data-act="usagepop"] .hide-sm')?.textContent === want, words(12), { timeout: 30000 });
  assert.equal(await meter.locator(".hide-sm").getAttribute("title"), fullReset, "the footer exposes the complete reset date and zone");
  await meter.click();
  await page.locator(".lims .lim-w small").waitFor();
  assert.equal(await page.locator(".lims .lim-w small").innerText(), fullReset, "the popover puts the full reset underneath the share");
  // Opening the popover reads every plan again and draws it anew as each answer lands (redrawPop): measure once those
  // reads are back, and inside one in-page call, so the row measured is the one on screen, never a node just replaced.
  await page.waitForFunction(() => !document.querySelector(".lim-list")?.textContent.includes("Checking…"));
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    const layout = await page.evaluate(() => {
      const el = document.querySelector(".lims .lim-w");
      const share = el.querySelector(".lim-share").getBoundingClientRect(), reset = el.querySelector(".lim-reset").getBoundingClientRect();
      const row = el.getBoundingClientRect(), bar = el.querySelector(".lim-bar").getBoundingClientRect();
      return { below: reset.top >= share.bottom, fits: reset.right <= row.right + 1, bar: bar.width, overflow: el.scrollWidth > el.clientWidth + 1 };
    });
    assert.equal(layout.below, true, `reset has its own second line at ${width}px`);
    assert.equal(layout.fits && !layout.overflow, true, `the full date stays inside the row at ${width}px`);
    assert.ok(layout.bar > 20, `the date never squeezes the quota bar at ${width}px`);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.keyboard.press("Escape");
  const settings = await page.evaluate(async (row) => {
    const { limitRow } = await import("/app/settings/pages/usage.js");
    const box = document.createElement("div"); box.innerHTML = limitRow(row);
    return box.querySelector(".lim-w small")?.textContent;
  }, row);
  assert.equal(settings, fullReset, "Settings Usage and the popover agree on the service's exact reset instant");
  const arc = () => meter.locator("svg .ring-arc").evaluate((el) => ({ stroke: el.getAttribute("stroke"), offset: Number(el.getAttribute("stroke-dashoffset")) }));
  const full = 2 * Math.PI * 9;
  let ring = await arc();
  assert.equal(ring.stroke, "var(--warn)", "under 15% left the ring turns to the warning colour");
  assert.ok(Math.abs(ring.offset - full * 0.88) < 1e-6, `the ring is 12% full (offset ${ring.offset})`);

  const shots = process.env.PLAN_METER_SHOTS;
  if (shots) {
    const bar = page.locator("#statusbar");
    const mode = () => page.evaluate(() => document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
    for (let i = 0; i < 2; i++) { // both looks, through the window's own light/dark button
      const now = await mode();
      await bar.screenshot({ path: join(shots, `plan-meter-${now}.png`) });
      await meter.click();
      await page.locator(".lims").waitFor();
      await page.locator(".lims").screenshot({ path: join(shots, `plan-meter-pop-${now}.png`) });
      await page.keyboard.press("Escape");
      await page.locator('[data-act="theme-flip"]').click();
      await page.waitForFunction((was) => (document.documentElement.dataset.theme || "") !== was, now);
      await page.waitForTimeout(300);
    }
  }

  reported.used = "40";
  assert.equal((await app.runtime.run({ prompt: "again" })).status, "completed");
  await page.waitForFunction((want) => document.querySelector('#statusbar [data-act="usagepop"] .hide-sm')?.textContent === want, words(60), { timeout: 30000 });
  ring = await arc();
  assert.equal(ring.stroke, "var(--accent)");
  assert.ok(Math.abs(ring.offset - full * 0.4) < 1e-6, "the ring follows the new numbers without a reload");

  reported.reset = "unavailable";
  assert.equal((await app.runtime.run({ prompt: "no reset reported" })).status, "completed");
  await page.waitForFunction(() => document.querySelector('#statusbar [data-act="usagepop"] .hide-sm')?.textContent.includes("Reset time unavailable"), null, { timeout: 30000 });
  assert.equal(await meter.locator(".hide-sm").getAttribute("title"), "Reset time unavailable");
  await meter.click();
  await page.locator(".lims .lim-w small").waitFor();
  assert.equal(await page.locator(".lims .lim-w small").innerText(), "Reset time unavailable", "the missing reset is not fabricated from the current time");
  await page.keyboard.press("Escape");

  const listed = await call("/api/usage/glance");
  listed.rows = Array.from({ length: 12 }, (_, i) => ({ ...listed.rows[0], account: `test-${i}`, accountLabel: `owner-${i}@example.test`, readable: true }));
  crowded = listed;
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 400 });
    holdLook = Promise.withResolvers(); // the popover's own look answers only while Check now is being pressed, below
    const looked = page.waitForResponse((response) => response.url().endsWith("/api/usage/limits/look"));
    await meter.click();
    await page.locator(".lim-list .lim").nth(11).waitFor();
    await page.waitForFunction(() => !document.querySelector(".lim-list")?.textContent.includes("Checking…"));
    const geometry = () => page.locator(".pop .lims").evaluate((el) => {
      const rect = (selector) => { const r = el.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
      const list = el.querySelector(".lim-list"), pop = el.closest(".pop");
      return { heading: rect(".ph"), footer: rect(".lim-foot"), list: rect(".lim-list"), scroll: list.scrollTop,
        scrollable: list.scrollHeight > list.clientHeight, popScroll: pop.scrollTop, fits: pop.getBoundingClientRect().bottom <= innerHeight,
        wide: pop.scrollWidth > pop.clientWidth + 1 };
    });
    const before = await geometry();
    assert.ok(before.scrollable && before.fits && !before.wide, `long plans fit and scroll at ${width}px`);
    await page.locator(".lim-list").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const after = await geometry();
    assert.deepEqual(after.heading, before.heading, "heading remains fixed while plans scroll");
    assert.deepEqual(after.footer, before.footer, "separator and actions remain fixed while plans scroll");
    assert.equal(after.popScroll, 0, "the popup itself does not scroll");
    assert.ok(after.scroll > 0 && after.list.bottom <= after.footer.top, "only the plan list scrolls above the footer");
    const previous = checks;
    /* The look's answer draws the popover anew while Check now is held down: the press must still become its click. */
    const box = await page.getByRole("button", { name: "Check now", exact: true }).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    holdLook.resolve();
    await looked;
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done())));
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector(".lim-list")?.textContent.includes("Checking…"));
    assert.equal(checks, previous + 12, "the fixed Check now button refreshes every account");
    assert.equal((await geometry()).scroll, after.scroll, "refresh preserves the scrolled position");
    await page.getByRole("button", { name: "Open Usage", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".pop .lims"));
  }
  crowded = null;
  await page.setViewportSize({ width: 1280, height: 800 });

  await call("/api/usage/glance/settings", { ring: "hidden" });
  assert.equal((await app.runtime.run({ prompt: "once more" })).status, "completed");
  await meter.locator("svg").waitFor({ state: "detached", timeout: 30000 });
  const m = (await call("/api/state")).activeModel;
  assert.equal(await meter.innerText(), [m.presetName, m.reasoning].filter(Boolean).join(" · "), "the ring switched off: the model's name alone");
  assert.deepEqual(errors, []);
});
