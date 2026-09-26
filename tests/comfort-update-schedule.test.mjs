import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { setImmediate as settle } from "node:timers/promises";
import { allComfort, saveComfort, updatePlan, noteUpdateCheck } from "../dist/index.js";

// Run the real renderer scheduler and server planner together. Only the DOM, IPC/network,
// storage and clock are doubles; no downloads, installs, windows or owner data are touched.
// Redesign: the old window's scheduler (public/comfort.js) is the new window's public/app/shell/autoupdate.js, ported as
// it was. Its imports (api, toast, t, E, onRender) are given here instead: api answers the update plan from the real
// planner, as the route does. applyComfort(values) is the old view-and-apply, autoUpdate() the old manual look.
const renderer = (await readFile(new URL("../public/app/shell/autoupdate.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");

function clock() {
  let now = 0, nextId = 0;
  const timers = new Map();
  const add = (fn, ms, repeat = false) => {
    const id = ++nextId;
    timers.set(id, { fn, at: now + ms, ms, repeat });
    return id;
  };
  return {
    get now() { return now; },
    setTimeout: (fn, ms) => add(fn, ms),
    setInterval: (fn, ms) => add(fn, ms, true),
    clear: (id) => timers.delete(id),
    async advance(ms) {
      const end = now + ms;
      await settle();
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        const [id, timer] = next;
        now = timer.at;
        if (timer.repeat) timer.at += timer.ms; else timers.delete(id);
        timer.fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

function fixture(latency, phase = "current", inDesktop = true) {
  const time = clock(), records = new Map(), checks = [], completions = [], installs = [];
  const store = {
    get: (_kind, _owner, key) => records.has(key) ? { data: records.get(key) } : undefined,
    save: (_kind, _owner, key, value) => records.set(key, value),
  };
  let active = 0, maxActive = 0, failNext = false;
  const desktop = {
    updateStatus: async () => ({ phase }),
    installUpdate: async (...args) => { installs.push(args); return { phase: "ready" }; },
    checkForUpdates: async () => {
      checks.push(time.now);
      maxActive = Math.max(maxActive, ++active);
      await new Promise((resolve) => time.setTimeout(resolve, latency));
      active--;
      completions.push(time.now);
      if (failNext) { failNext = false; throw new Error("offline"); }
      return { phase };
    },
  };
  const toasts = [], warned = [], asked = [];
  const context = createContext({
    window: { branchDesktop: inDesktop ? desktop : undefined },
    setTimeout: time.setTimeout, setInterval: time.setInterval,
    clearTimeout: time.clear, clearInterval: time.clear,
    console: { warn: (message) => warned.push(message) },
    // POST /api/comfort/update-plan, answered by the real planner as src/comfort/api.ts does.
    api: async (path, body) => {
      asked.push(path);
      if (path === "comfort" && body === undefined) return { values: allComfort(store, "local") }; // GET /api/comfort
      if (path !== "comfort/update-plan") throw new Error(`not asked in this test: ${path}`);
      const now = new Date(time.now);
      if (body.checked) noteUpdateCheck(store, "local", now);
      return updatePlan(store, "local", { ...body, busyTasks: 0, now });
    },
    toast: (message) => toasts.push(message), t: (key) => key,
    E: { state: null }, onRender: () => undefined,
  });
  runInContext(renderer, context);
  const configure = async (settings) => {
    saveComfort(store, "local", "notify", settings);
    context.testValues = allComfort(store, "local");
    runInContext("applyComfort(testValues);", context);
    await settle();
  };
  /* The window as it runs: the choice is saved to the engine, and the window reads it again after a refresh (a new
     E.state), which is when shell/autoupdate.js's followComfort looks. */
  const save = (settings) => saveComfort(store, "local", "notify", settings);
  const refresh = async () => { context.E.state = {}; runInContext("followComfort()", context); await settle(); await settle(); };
  return { time, checks, completions, installs, configure, save, refresh, toasts, warned, asked, get maxActive() { return maxActive; },
    failOnce() { failNext = true; }, manual: () => runInContext("autoUpdate()", context) };
}

test("the window reads the choice after a refresh, looks again only when it changed, and never outside the desktop app", async () => {
  const f = fixture(45_000);
  f.save({ autoUpdate: "check", releaseChannel: "beta" });
  await f.time.advance(3_600_000);
  assert.deepEqual(f.checks, [], "never looked for before the owner's choice has been read");
  await f.refresh();
  assert.deepEqual(f.asked.slice(0, 1), ["comfort"], "the choice is read from GET /api/comfort");
  assert.deepEqual(f.checks, [3_600_000], "and a look starts once it is read");
  await f.time.advance(45_000);
  await f.refresh();
  assert.equal(f.checks.length, 1, "a refresh with the same choice starts no look of its own");
  await f.time.advance(300_000);
  assert.equal(f.checks.length, 2, "the five-minute schedule carries on");
  f.save({ autoUpdate: "off" });
  await f.refresh();
  await f.time.advance(3_600_000);
  assert.equal(f.checks.length, 2, "turned off, nothing more is looked for");
  assert.equal(f.maxActive, 1);

  const browser = fixture(1, "current", false);
  browser.save({ autoUpdate: "install", releaseChannel: "dev" });
  await browser.refresh();
  await browser.time.advance(3_600_000);
  assert.deepEqual([browser.asked, browser.checks], [[], []], "a browser window asks nothing and looks for nothing");
});

for (const latency of [1, 45_000, 240_000, 360_000]) {
  test(`Beta schedules its next check five minutes after completion (${latency}ms response)`, async () => {
    const f = fixture(latency);
    await f.configure({ autoUpdate: "check", releaseChannel: "beta" });
    for (let index = 0; index < 3; index++) {
      assert.equal(f.checks.length, index + 1);
      await f.time.advance(latency);
      const completed = f.completions.at(-1);
      await f.time.advance(299_999);
      assert.equal(f.checks.length, index + 1, "no early/overlapping check");
      await f.time.advance(1);
      assert.equal(f.checks.at(-1), completed + 300_000, "no skipped five-minute wake");
    }
    assert.equal(f.maxActive, 1);
  });
}

test("refresh during a slow check cannot overlap checks or revive a disabled schedule", async () => {
  const f = fixture(45_000);
  await f.configure({ autoUpdate: "check", releaseChannel: "beta" });
  await f.time.advance(20_000);
  await f.configure({ releaseChannel: "stable" });
  await f.configure({ releaseChannel: "beta" });
  await f.manual();
  assert.equal(f.checks.length, 1);
  await f.configure({ autoUpdate: "off" });
  await f.time.advance(3_600_000);
  assert.equal(f.checks.length, 1);
  await f.configure({ autoUpdate: "check" });
  assert.equal(f.checks.length, 2);
  assert.equal(f.maxActive, 1);
});

test("a failed Beta check is retried after five minutes without overlapping", async () => {
  const f = fixture(45_000);
  f.failOnce();
  await f.configure({ autoUpdate: "check", releaseChannel: "beta" });
  await f.time.advance(345_000);
  assert.deepEqual(f.checks, [0, 345_000]);
  assert.equal(f.maxActive, 1);
});

test("an install that update by itself starts says so, so turning it off while Dev builds stops it (dogfood F1, NAS)", async () => {
  const f = fixture(1, "available");
  await f.configure({ autoUpdate: "install", releaseChannel: "dev" });
  await f.time.advance(10);
  assert.deepEqual(f.installs, [[true]], "the desktop hears that this install was not the Update button");
});
