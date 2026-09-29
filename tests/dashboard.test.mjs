import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import {
  dashboardApi, dashboardSettings, pauseAutomations, resumeAutomations, saveDashboardSettings,
} from "../dist/dashboard-api.js";
import { forecast, restartPlan, scheduleStanding } from "../dist/dashboard-summary.js";
import { launchdLabel } from "../dist/install/launchd.js";
import { waitInPage } from "./wait-in-page.mjs";

/* Wave mac3: the owner's control dashboard (src/dashboard-api.ts, public/dashboard/). */
const PUBLIC = join(import.meta.dirname, "..", "public");
const DASHBOARD = join(PUBLIC, "dashboard");

async function fixture(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-dashboard-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: provider ?? { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } },
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (path, key = server.token, body) => fetch(server.url + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { app, server, call, owner: app.runtime.owner, root };
}
const schedule = (app, id, data) => app.store.save("schedules", app.runtime.owner, id, {
  prompt: "Check the post", kind: "task", dueAt: new Date(Date.now() + 3600e3).toISOString(), ...data,
});

test("the dashboard ships off: its page is not served and its summary refuses until the owner switches it on", async (t) => {
  const f = await fixture(t);
  assert.equal(dashboardSettings(f.app.store, f.owner).mode, "off");
  for (const path of ["/dashboard", "/dashboard/dashboard.js", "/dashboard/dashboard.css"])
    assert.equal((await fetch(f.server.url + path)).status, 404, `${path} is served while the switch is off`);
  assert.equal((await f.call("/api/dashboard")).status, 404);
  // Redesign: the old window's switch card (/dashboard-card.js) left with that window; the new window follows the
  // dashboard's links itself (public/app/main.js followLink), so nothing of the dashboard is served while it is off.
  assert.notEqual((await fetch(f.server.url + "/dashboard-card.js")).status, 200);
  assert.deepEqual(await (await f.call("/api/dashboard/settings")).json(), { mode: "off", access: "full" });

  const saved = await f.call("/api/dashboard/settings", f.server.token, { mode: "when-needed" });
  assert.equal(saved.status, 200);
  assert.equal(dashboardSettings(f.app.store, f.owner).mode, "when-needed");
  assert.equal((await f.call("/api/dashboard/settings", f.server.token, { mode: "always" })).status, 400);
  const html = await fetch(f.server.url + "/dashboard");
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  /* Nothing is reachable without a key, switched on or not. */
  assert.equal((await fetch(f.server.url + "/api/dashboard")).status, 401);
});

test("every file the dashboard loads is served, and nothing it links to is missing", async (t) => {
  const f = await fixture(t);
  saveDashboardSettings(f.app.store, f.owner, { mode: "on" });
  const html = await readFile(join(DASHBOARD, "index.html"), "utf8");
  const referenced = new Set([...html.matchAll(/(?:src|href)="(\/[^"#]*)"/g)].map((m) => m[1]).filter((path) => path !== "/"));
  for (const name of (await readdir(DASHBOARD)).filter((file) => file.endsWith(".js"))) {
    const source = await readFile(join(DASHBOARD, name), "utf8");
    for (const m of source.matchAll(/^import\s+[^"']*["'](\/[a-z0-9/-]+\.js)["']/gm)) referenced.add(m[1]);
  }
  for (const name of await readdir(DASHBOARD))
    referenced.add(name === "index.html" ? "/dashboard" : `/dashboard/${name}`);
  const missing = [];
  for (const path of referenced) {
    const response = await fetch(f.server.url + path);
    if (response.status !== 200) missing.push(`${path} → ${response.status}`);
  }
  assert.deepEqual(missing, []);
  // Redesign: the new window's page loads one module (public/app/main.js), which follows /#open= and /#task= links.
  const index = await readFile(join(PUBLIC, "index.html"), "utf8");
  assert.match(index, /<script type="module" src="\/app\/main\.js"><\/script>/);
  assert.equal(index.includes("/dashboard-card.js"), false, "the old window's card is not loaded");
});

test("the summary answers Now, Health, Spend and Activity from what Branch already keeps", async (t) => {
  const f = await fixture(t);
  saveDashboardSettings(f.app.store, f.owner, { mode: "on" });
  await f.app.runtime.run({ prompt: "Summarise the notes" });
  schedule(f.app, "11111111-1111-4111-8111-111111111111", { status: "pending" });
  const trigger = f.app.triggers.create({ owner: f.owner }, { name: "Door bell", prompt: "Someone rang" });
  const summary = await (await f.call("/api/dashboard")).json();
  assert.equal(summary.mode, "on");
  assert.equal(summary.access, "full");
  assert.equal(summary.now.version, f.app.version);
  assert.equal(summary.now.where, "window");
  assert.equal(summary.now.lockdown, false);
  assert.equal(summary.now.needsYou.total, 0);
  assert.ok(summary.now.model.name);
  assert.equal(summary.health.automations.schedules[0].standing, "never");
  assert.equal(summary.health.engine.restart.possible, false);
  assert.ok(summary.health.resources.computerMemory.total > 0);
  assert.ok(summary.health.resources.databaseBytes > 0);
  assert.ok(Array.isArray(summary.spend.today.byConnection) && Array.isArray(summary.spend.month.byProject));
  assert.ok(summary.spend.month.unpricedRuns + summary.spend.month.pricedRuns >= 1, "the finished task is counted this month");
  assert.ok(summary.activity.events.some((event) => event.kind === "run.started"));
  assert.ok(summary.activity.lastEventId >= summary.activity.events[0].id);
  /* A trigger's secret never leaves the computer through the dashboard. */
  assert.ok(trigger.secret && !JSON.stringify(summary).includes(trigger.secret));
  assert.deepEqual(Object.keys(summary.health.automations.triggers[0]).sort(), ["id", "name", "on"]);
});

test("a short-lived key only looks, or only stops tasks; the master key alone changes anything", async (t) => {
  const f = await fixture(t);
  saveDashboardSettings(f.app.store, f.owner, { mode: "on" });
  const read = f.app.sessionTokens.create(f.owner, { name: "wall screen", scope: "read" }).token;
  const run = f.app.sessionTokens.create(f.owner, { name: "phone script", scope: "run" }).token;
  assert.equal((await (await f.call("/api/dashboard", read)).json()).access, "read");
  assert.equal((await (await f.call("/api/dashboard", run)).json()).access, "run");
  /* Working out what the key may do does not count a second use of it. */
  for (const entry of f.app.sessionTokens.list(f.owner)) assert.equal(entry.uses, 1, `${entry.name} was counted ${entry.uses} times`);
  for (const key of [read, run]) {
    for (const [path, body] of [["/api/dashboard/automations", { paused: true }], ["/api/dashboard/restart", {}], ["/api/dashboard/settings", { mode: "off" }]]) {
      const answer = await f.call(path, key, body);
      assert.ok([401, 403].includes(answer.status), `${path} let a short-lived key through (${answer.status})`);
    }
  }
  /* Lockdown is not a short-lived key's to switch, either way. */
  for (const on of [true, false]) assert.equal((await f.call("/api/lockdown", run, { on })).status, 401);
  assert.equal(dashboardSettings(f.app.store, f.owner).mode, "on");
  assert.equal((await f.call("/api/dashboard", "branch_" + "0".repeat(48))).status, 401);
});

test("pausing every automation touches only what was waiting, and resuming brings back only that", async (t) => {
  const f = await fixture(t);
  schedule(f.app, "11111111-1111-4111-8111-111111111111", { status: "pending" });
  schedule(f.app, "22222222-2222-4222-8222-222222222222", { status: "paused" });
  schedule(f.app, "33333333-3333-4333-8333-333333333333", { status: "completed" });
  const paused = pauseAutomations(f.app);
  assert.deepEqual(paused.schedules, ["11111111-1111-4111-8111-111111111111"]);
  const status = (id) => f.app.store.get("schedules", f.owner, id).data.status;
  assert.equal(status("11111111-1111-4111-8111-111111111111"), "paused");
  assert.deepEqual(resumeAutomations(f.app), { schedules: 1, triggers: 0 });
  assert.equal(status("11111111-1111-4111-8111-111111111111"), "pending");
  assert.equal(status("22222222-2222-4222-8222-222222222222"), "paused", "the one the owner paused by hand stays paused");
  assert.equal(status("33333333-3333-4333-8333-333333333333"), "completed");

  saveDashboardSettings(f.app.store, f.owner, { mode: "on" });
  const answer = await (await f.call("/api/dashboard/automations", f.server.token, { paused: true })).json();
  assert.equal(answer.paused.schedules.length, 1);
  assert.equal((await (await f.call("/api/dashboard")).json()).paused.schedules.length, 1);
  await f.call("/api/dashboard/automations", f.server.token, { paused: false });
  assert.equal((await (await f.call("/api/dashboard")).json()).paused, null);
});

test("pausing switches triggers off and back on, and leaves a trigger the owner turned off alone", async (t) => {
  const f = await fixture(t);
  const on = f.app.triggers.create({ owner: f.owner }, { name: "On", prompt: "Go" });
  const off = f.app.triggers.create({ owner: f.owner }, { name: "Off", prompt: "Go" });
  f.app.triggers.setEnabled(f.owner, off.id, false);
  pauseAutomations(f.app);
  const enabled = (id) => f.app.triggers.list(f.owner).find((entry) => entry.id === id).enabled;
  assert.equal(enabled(on.id), false);
  assert.deepEqual(resumeAutomations(f.app), { schedules: 0, triggers: 1 });
  assert.equal(enabled(on.id), true);
  assert.equal(enabled(off.id), false);
});

test("a restart is offered only where something starts Branch again, on every platform", () => {
  const daemon = { mode: "daemon", pid: 42, port: 1, url: "", version: "1", startedAt: new Date().toISOString() };
  const plan = (platform, env, running = daemon) => restartPlan({ platform, env, pid: 42, running });
  assert.deepEqual(plan("win32", {}), { possible: false, reason: "restart.windows" });
  assert.deepEqual(plan("darwin", { XPC_SERVICE_NAME: launchdLabel }), { possible: true, reason: "restart.ready" });
  assert.deepEqual(plan("darwin", { XPC_SERVICE_NAME: "0" }), { possible: false, reason: "restart.by-hand" });
  assert.deepEqual(plan("linux", { INVOCATION_ID: "abc" }), { possible: true, reason: "restart.ready" });
  assert.deepEqual(plan("linux", {}), { possible: false, reason: "restart.by-hand" });
  assert.deepEqual(plan("darwin", { XPC_SERVICE_NAME: launchdLabel }, { ...daemon, mode: "app" }), { possible: false, reason: "restart.window" });
  assert.deepEqual(plan("linux", { INVOCATION_ID: "abc" }, { ...daemon, pid: 7 }), { possible: false, reason: "restart.window" });
  assert.deepEqual(plan("linux", { INVOCATION_ID: "abc" }, null), { possible: false, reason: "restart.window" });
});

test("restarting stops the engine with exit code 75 so the sign-in file starts it again, and is refused otherwise", async (t) => {
  const f = await fixture(t);
  saveDashboardSettings(f.app.store, f.owner, { mode: "on" });
  const refused = await f.call("/api/dashboard/restart", f.server.token, {});
  assert.equal(refused.status, 409, "a copy running in a test is not the background engine");
  assert.match((await refused.json()).error, /window/i, "its window here, or Windows' own icon by the clock");

  const sent = [];
  const request = { method: "POST", headers: {} };
  const deps = {
    platform: "linux", env: { INVOCATION_ID: "x" }, pid: 4242,
    running: async () => ({ mode: "daemon", pid: 4242, port: 1, url: "", version: "1", startedAt: new Date().toISOString() }),
    signal: (pid, name) => sent.push(["signal", pid, name]),
    setExitCode: (code) => sent.push(["exit", code]),
  };
  const answer = await dashboardApi(f.app, request, "/api/dashboard/restart", { dataDir: join(f.root, "data"), access: "full", readBody: async () => ({}), deps });
  assert.deepEqual(answer, { restarting: true });
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.deepEqual(sent, [["exit", 75], ["signal", 4242, "SIGTERM"]]);
  await assert.rejects(dashboardApi(f.app, request, "/api/dashboard/restart", { dataDir: "", access: "run", readBody: async () => ({}), deps }), /key of the computer/);
});

test("Restart the engine does not wait on the dashboard's switch: the key of this computer, and while it is off the app here only", async (t) => {
  const f = await fixture(t);
  const { markDoorRequest } = await import("../dist/remote/window-key.js");
  assert.equal(dashboardSettings(f.app.store, f.owner).mode, "off", "the dashboard ships off, and stays off");
  const answered = await f.call("/api/dashboard/restart", f.server.token, {});
  assert.equal(answered.status, 409, "it is the restart's own answer (a copy in a test is not the background engine), not the switch's 404");
  assert.doesNotMatch((await answered.json()).error, /switched off/);
  assert.equal((await f.call("/api/dashboard")).status, 404, "the summary still waits for the switch");
  assert.equal((await fetch(f.server.url + "/dashboard")).status, 404, "and the old page is still not served");
  const run = f.app.sessionTokens.create(f.owner, { name: "phone script", scope: "run" }).token;
  assert.ok([401, 403].includes((await f.call("/api/dashboard/restart", run, {})).status), "a short-lived key is refused");

  const sent = [];
  const deps = {
    platform: "linux", env: { INVOCATION_ID: "x" }, pid: 4242,
    running: async () => ({ mode: "daemon", pid: 4242, port: 1, url: "", version: "1", startedAt: new Date().toISOString() }),
    signal: (pid, name) => sent.push(["signal", pid, name]), setExitCode: (code) => sent.push(["exit", code]),
  };
  const context = { dataDir: join(f.root, "data"), access: "full", readBody: async () => ({}), deps };
  const door = { method: "POST", headers: {} };
  markDoorRequest(door);
  await assert.rejects(dashboardApi(f.app, door, "/api/dashboard/restart", context), /app on this computer/, "a door is refused while the dashboard is off");
  await assert.rejects(dashboardApi(f.app, { method: "POST", headers: {} }, "/api/dashboard/restart", { ...context, access: "run" }), /key of the computer/,
    "only the key of this computer, even in the app here");
  assert.deepEqual(await dashboardApi(f.app, { method: "POST", headers: {} }, "/api/dashboard/restart", context), { restarting: true });
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.deepEqual(sent, [["exit", 75], ["signal", 4242, "SIGTERM"]]);
  saveDashboardSettings(f.app.store, f.owner, { mode: "on" });
  assert.deepEqual(await dashboardApi(f.app, door, "/api/dashboard/restart", { ...context, deps: { ...deps, signal: () => {}, setExitCode: () => {} } }), { restarting: true },
    "with the dashboard on, its page may restart from the paired address as before");
});

test("a schedule's standing and the month's forecast are read the way the owner would", () => {
  assert.equal(scheduleStanding({ status: "pending" }), "never");
  assert.equal(scheduleStanding({ status: "paused", lastRunAt: "x" }), "paused");
  assert.equal(scheduleStanding({ status: "running" }), "running");
  assert.equal(scheduleStanding({ status: "pending", history: [{ status: "completed" }] }), "healthy");
  assert.equal(scheduleStanding({ status: "pending", history: [{ status: "failed" }] }), "failing");
  assert.equal(scheduleStanding({ status: "pending", consecutiveFailures: 1, lastRunAt: "x" }), "failing");
  assert.equal(scheduleStanding({ status: "completed", history: [{ status: "completed" }, { status: "running" }] }), "healthy");
  const day = (cost, priced) => ({ date: "", estimatedCost: cost, pricedRuns: priced, unpricedRuns: 0, presets: [] });
  const tenth = new Date(Date.UTC(2026, 8, 10, 12));
  assert.deepEqual(forecast([day(1, 1), day(2, 3)], tenth), { cost: 3, priced: 4, projected: 9 });
  assert.equal(forecast([day(0, 0)], tenth).projected, null, "nothing priced means no guess, never zero");
});

test("the dashboard writes no colour down and says every word in English and real French", async () => {
  const offenders = [];
  for (const name of await readdir(DASHBOARD)) {
    const text = await readFile(join(DASHBOARD, name), "utf8");
    text.split("\n").forEach((line, index) => {
      const rule = line.replace(/\/\*.*?\*\//g, "").split("/*")[0].replace(/\/\/.*$/, "");
      if (/#[0-9a-fA-F]{3,8}\b(?![-\w])|\brgba?\s*\(\s*\d|\bhsla?\s*\(\s*\d/.test(rule) && !/href=|#open=|#task=/.test(rule))
        offenders.push(`${name}:${index + 1} ${rule.trim().slice(0, 70)}`);
    });
  }
  assert.deepEqual(offenders, [], "every colour belongs in public/tokens.css");

  const english = JSON.parse(await readFile(join(PUBLIC, "locales", "en.json"), "utf8"));
  const french = JSON.parse(await readFile(join(PUBLIC, "locales", "fr.json"), "utf8"));
  const keys = new Set();
  for (const name of await readdir(DASHBOARD)) {
    const text = await readFile(join(DASHBOARD, name), "utf8");
    for (const m of text.matchAll(/data-t(?:-label)?="([^"]+)"/g)) keys.add(m[1]);
    for (const m of text.matchAll(/"((?:dashboard|place|lockdown|activity|field|action|nav|settings)\.[A-Za-z0-9.-]+)"/g))
      if (!m[1].endsWith(".")) keys.add(m[1]);
  }
  for (const kind of ["run.started", "run.finished", "model.started", "model.completed", "tool.started", "tool.completed", "tool.failed", "delivery.failed", "policy.ask", "schedule.fired"])
    keys.add(`dashboard.kind.${kind}`);
  for (const filter of ["all", "tasks", "tools", "problems", "questions"]) keys.add(`dashboard.filter.${filter}`);
  for (const reason of ["ready", "windows", "window", "by-hand"]) keys.add(`dashboard.restart.${reason}`);
  for (const page of ["general", "assistant", "appearance", "notifications", "models", "voice", "permissions", "computer", "secrets", "data", "advanced", "about"])
    keys.add(`settings.page.${page}`);
  assert.ok(keys.size > 150, `only ${keys.size} keys found; the scan is looking in the wrong place`);
  assert.deepEqual([...keys].filter((key) => !(key in english)), [], "keys with no English words");
  assert.deepEqual([...keys].filter((key) => !(key in french)), [], "keys with no French words");
  const shared = new Set(["Actions"]);
  assert.deepEqual([...keys].filter((key) => key.startsWith("dashboard.") && french[key] === english[key] && !shared.has(english[key])), [],
    "these dashboard words are still English when French is chosen");
  /* The glossary (docs/design.md): the dashboard's own words never say these. */
  for (const key of [...keys].filter((name) => name.startsWith("dashboard."))) assert.doesNotMatch(english[key] ?? "", /\b(SSE|endpoint|payload|tokens?|provider|daemon|launchd|systemd)\b/i, key);
});

/* ---------- the page itself, in a headless browser ---------- */
async function openDashboard(browser, server, key, width = 1440) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((value) => { if (value) sessionStorage.setItem("branch-token", value); }, key);
  await page.goto(server.url + "/dashboard");
  await page.locator("body.db-ready").waitFor({ state: "attached" });
  return { page, errors };
}

test("the page shows every area, fits 400 px, and a key that may only look gets no controls", async (t) => {
  const f = await fixture(t);
  saveDashboardSettings(f.app.store, f.owner, { mode: "on" });
  await f.app.runtime.run({ prompt: "Summarise the notes" });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const width of [1440, 400]) {
    const { page, errors } = await openDashboard(browser, f.server, f.server.token, width);
    await page.locator("#db-grid").waitFor();
    for (const id of ["db-branch", "db-needs", "db-working", "db-links", "db-automations", "db-engine", "db-computer", "db-errors", "db-today", "db-month", "db-activity", "db-controls", "db-pages"])
      assert.equal(await page.locator(`#${id} > h2`).count(), 1, `${id} has one title`);
    assert.deepEqual(await page.locator(".db-map a").allTextContents(),
      ["Conversation", "Inbox", "Automations", "Library", "Customize", "Settings", "Dashboard"]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `sideways scroll at ${width}`);
    // isVisible() asks whether it is on the page this instant and never waits; waitFor() asks the
    // same question and gives the grid time to finish drawing on a busy machine.
    const pause = await page.getByRole("button", { name: "Pause all automations" })
      .waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
    assert.ok(pause, "the master key is offered Pause all automations");
    assert.equal(await page.locator("#db-controls button:not([hidden])").filter({ hasNotText: /Lockdown|Restart/ }).count(), 1, "one filled button");
    const activity = await page.locator("#db-activity").filter({ hasText: /Started a task/ })
      .waitFor({ timeout: 5000 }).then(() => true, () => false);
    assert.ok(activity, "the activity area names the task that ran");
    assert.deepEqual(errors, []);
    await page.close();
  }
  const read = f.app.sessionTokens.create(f.owner, { scope: "read" }).token;
  const { page } = await openDashboard(browser, f.server, read);
  await page.locator("#db-grid").waitFor();
  assert.equal(await page.getByRole("button", { name: "Pause all automations" }).count(), 0);
  const looksOnly = await page.locator("#db-controls").filter({ hasText: /may only look/ })
    .waitFor({ timeout: 5000 }).then(() => true, () => false);
  assert.ok(looksOnly, "a key that may only look is told so");
  await page.close();
  const none = await openDashboard(browser, f.server, "");
  const signin = await none.page.locator("#db-signin")
    .waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
  assert.ok(signin, "a page with no key asks for one");
  await none.page.getByLabel("Session token").fill(f.server.token);
  await none.page.getByRole("button", { name: "Connect" }).click();
  await none.page.locator("#db-grid").waitFor();
});

/* DG-171 review: the activity filters are the shared segmented control every other choice uses (control-styles.css),
   so the chosen one is raised and the others are plain; they must never all look alike. */
test("the activity filters are the shared segmented control, and the chosen one stands out", async (t) => {
  const f = await fixture(t);
  saveDashboardSettings(f.app.store, f.owner, { mode: "on" });
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const { page, errors } = await openDashboard(browser, f.server, f.server.token, 1200);
  const filters = page.getByRole("group", { name: "Show", exact: true });
  await filters.waitFor();
  const looks = () => filters.evaluate((group) => {
    const style = (node) => getComputedStyle(node);
    const pressed = group.querySelector('[aria-pressed="true"]'), plain = group.querySelector('[aria-pressed="false"]');
    return {
      group: [style(group).padding, style(group).borderRadius, style(group).borderTopWidth],
      pressed: [pressed.textContent, style(pressed).fontWeight, style(pressed).boxShadow !== "none"],
      plain: [style(plain).fontWeight, style(plain).backgroundColor, style(plain).boxShadow, style(plain).padding],
      differ: style(pressed).backgroundColor !== style(plain).backgroundColor,
    };
  });
  assert.deepEqual(await looks(), {
    group: ["2px", "10px", "0px"], pressed: ["Everything", "600", true], plain: ["400", "rgba(0, 0, 0, 0)", "none", "5px 11px"], differ: true,
  });
  await filters.getByRole("button", { name: "Problems", exact: true }).click();
  assert.equal((await looks()).pressed[0], "Problems", "the click moves the chosen filter");
  assert.deepEqual(errors, []);
});

test("Stop ends a working task, Lockdown switches from the page, and when-needed keeps nothing open", async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, {
    name: "scripted",
    async complete(request) {
      await Promise.race([held, new Promise((resolve, reject) => request.signal?.addEventListener("abort", () => reject(new Error("stopped"))))]);
      return { content: "Done.", toolCalls: [] };
    },
  });
  t.after(() => release());
  saveDashboardSettings(f.app.store, f.owner, { mode: "on" });
  const working = f.app.runtime.run({ prompt: "A long report" }).catch(() => undefined);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const { page } = await openDashboard(browser, f.server, f.server.token);
  await page.locator("#db-working .lx-row").waitFor();
  await page.locator("#db-working").getByRole("button", { name: "Stop" }).click();
  await working;
  await page.locator("#db-working .empty-state").waitFor();
  assert.ok(!f.app.store.runs(f.owner).some((run) => run.status === "running"));

  await page.getByRole("button", { name: "Turn Lockdown on" }).click();
  await page.locator("#db-lockbanner:not([hidden])").waitFor();
  assert.equal((await (await f.call("/api/lockdown")).json()).on, true);
  await page.locator("#db-lock-off").click();
  await page.locator("#db-lockbanner[hidden]").waitFor({ state: "attached" });

  saveDashboardSettings(f.app.store, f.owner, { mode: "when-needed" });
  const streams = [];
  const quiet = await browser.newPage();
  quiet.on("request", (request) => { if (request.url().includes("/api/events/stream")) streams.push(request.url()); });
  await quiet.addInitScript((value) => sessionStorage.setItem("branch-token", value), f.server.token);
  await quiet.goto(f.server.url + "/dashboard");
  await quiet.locator("body.db-ready").waitFor({ state: "attached" });
  await quiet.waitForTimeout(500);
  assert.deepEqual(streams, [], "when-needed opened live updates");
  assert.match(await quiet.locator("#db-activity").innerText(), /Press Refresh/);

  saveDashboardSettings(f.app.store, f.owner, { mode: "off" });
  await quiet.getByRole("button", { name: "Refresh" }).click();
  await quiet.locator("#db-off:not([hidden])").waitFor();
});

test("the dashboard's links open the right place in the new window", async (t) => {
  // Redesign: the dashboard page is kept (public/dashboard); its links come back to the window as /#open=<place:tab>
  // (public/dashboard/card.js, sections.js). Settings › Data & usage is the new window's "usage" page.
  const f = await fixture(t);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  await page.goto(f.server.url + "/#open=settings:data");
  await page.getByLabel("Session token", { exact: true }).fill(f.server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  /* The link waited for the sign-in, then opened Settings → Data & usage and tidied the address. */
  await page.locator('[data-act="setpage"][data-v="usage"][aria-current="true"]').waitFor({ timeout: 15000 });
  assert.equal(new URL(page.url()).hash, "");
});

/* Parity B6: the switch lives where the engine's refusal says, Customize › Everywhere › Dashboard in the browser
   (public/app/places/dashsw.js); flipping it is read back through GET /api/dashboard/settings. The window's own Pause
   all and Restart no longer wait on it (batch E). */
test("the switch lives in Customize › Everywhere, where the engine's refusal sends the owner", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/api/dashboard/settings", f.server.token, { mode: "off" })).status, 200);
  const refused = await f.call("/api/dashboard");
  assert.equal(refused.status, 404);
  const words = (await refused.json()).error;
  assert.match(words, /Customize › Everywhere › Dashboard in the browser/);
  assert.equal((await f.call("/api/onboarding", f.server.token, { skipped: true })).status, 200); // setup would sit on top
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  await page.goto(f.server.url + "/#open=customize:everywhere");
  await page.getByLabel("Session token", { exact: true }).fill(f.server.token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("#app #side").waitFor({ state: "visible", timeout: 120000 });
  const tile = page.locator(".tile", { hasText: "Dashboard in the browser" });
  await tile.waitFor({ timeout: 15000 });
  const box = page.locator("#dash-b6");
  assert.equal(await box.isChecked(), false);
  assert.equal(await box.getAttribute("aria-disabled"), null, "the switch is live");
  await box.click();
  await waitInPage(page, async (key) => (await (await fetch("/api/dashboard/settings", { headers: { authorization: `Bearer ${key}` } })).json()).mode === "on", f.server.token, { timeout: 10000 });
  assert.equal(dashboardSettings(f.app.store, f.owner).mode, "on");
  assert.equal((await f.call("/api/dashboard/automations", f.server.token, { paused: false })).status, 200, "Pause all goes through once it is on");
  await tile.getByRole("link", { name: "Open the dashboard" }).waitFor();
  await page.locator("#dash-b6").click();
  await waitInPage(page, async (key) => (await (await fetch("/api/dashboard/settings", { headers: { authorization: `Bearer ${key}` } })).json()).mode === "off", f.server.token, { timeout: 10000 });
  assert.equal(dashboardSettings(f.app.store, f.owner).mode, "off");
});

test("under Lockdown the dashboard may be switched off and never on", async (t) => {
  const f = await fixture(t);
  saveDashboardSettings(f.app.store, f.owner, { mode: "on" });
  assert.equal((await f.call("/api/lockdown", f.server.token, { on: true })).status, 200);
  const off = await f.call("/api/dashboard/settings", f.server.token, { mode: "off" });
  assert.equal(off.status, 200, "switching it off is always allowed");
  assert.equal(dashboardSettings(f.app.store, f.owner).mode, "off");
  for (const mode of ["on", "when-needed"]) {
    const on = await f.call("/api/dashboard/settings", f.server.token, { mode });
    assert.equal(on.status, 409, `${mode} under Lockdown`);
    assert.match((await on.json()).error, /Lockdown is on/);
  }
  assert.equal(dashboardSettings(f.app.store, f.owner).mode, "off");
  assert.equal((await f.call("/api/lockdown", f.server.token, { on: false })).status, 200);
  assert.equal((await f.call("/api/dashboard/settings", f.server.token, { mode: "on" })).status, 200, "on again once Lockdown is off");
});

test("Automations › Pause all works with the dashboard off: the window's own key on this computer, never through a door", async (t) => {
  const f = await fixture(t);
  // Off on purpose (not left to how the dashboard ships), since this is about Pause all while it is off.
  assert.equal((await f.call("/api/dashboard/settings", f.server.token, { mode: "off" })).status, 200);
  schedule(f.app, "44444444-4444-4444-8444-444444444444", { status: "pending" });
  assert.deepEqual(await (await f.call("/api/dashboard/automations")).json(), { paused: null });
  const paused = await f.call("/api/dashboard/automations", f.server.token, { paused: true });
  assert.equal(paused.status, 200);
  assert.deepEqual((await paused.json()).paused.schedules, ["44444444-4444-4444-8444-444444444444"]);
  assert.equal((await (await f.call("/api/dashboard/automations")).json()).paused.schedules.length, 1);
  assert.equal((await f.call("/api/dashboard")).status, 404, "the dashboard's own summary stays off");
  /* A door (a paired phone's address) is refused while the dashboard is off, even with the full key, both ways. */
  const { markDoorRequest } = await import("../dist/remote/window-key.js");
  const context = { dataDir: join(f.root, "data"), access: "full", readBody: async () => ({ paused: false }) };
  for (const method of ["GET", "POST"]) {
    const door = { method, headers: {} };
    markDoorRequest(door);
    await assert.rejects(dashboardApi(f.app, door, "/api/dashboard/automations", context), /app on this computer/, `a door's ${method} is refused while the dashboard is off`);
  }
  await assert.rejects(dashboardApi(f.app, { method: "POST", headers: {} }, "/api/dashboard/automations", { ...context, access: "run" }), /key of the computer/,
    "only the key of this computer, even in the app here");
  assert.equal(f.app.store.get("schedules", f.owner, "44444444-4444-4444-8444-444444444444").data.status, "paused");
  const resumed = await f.call("/api/dashboard/automations", f.server.token, { paused: false });
  assert.deepEqual((await resumed.json()).resumed, { schedules: 1, triggers: 0 });
});

test("Automations › Pause all works the same with the dashboard on", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call("/api/dashboard/settings", f.server.token, { mode: "on" })).status, 200);
  schedule(f.app, "55555555-5555-4555-8555-555555555555", { status: "pending" });
  const paused = await f.call("/api/dashboard/automations", f.server.token, { paused: true });
  assert.equal(paused.status, 200);
  assert.deepEqual((await (await f.call("/api/dashboard/automations")).json()).paused.schedules, ["55555555-5555-4555-8555-555555555555"]);
  assert.equal((await (await f.call("/api/dashboard")).json()).paused.schedules.length, 1, "the dashboard's summary shows the same record");
  assert.equal((await f.call("/api/dashboard/automations", f.server.token, { paused: "yes" })).status, 400);
  const put = await fetch(f.server.url + "/api/dashboard/automations", { method: "PUT", headers: { authorization: `Bearer ${f.server.token}` } });
  assert.equal(put.status, 405);
});
