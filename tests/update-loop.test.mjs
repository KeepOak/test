/* Update by itself runs in the app, not in the window's page (src/desktop/update-loop.ts): it goes on with the window
   closed, still loading or not there at all. Stand-ins for the engine's plan and the updater: nothing is built,
   downloaded or installed here. */
import test from "node:test";
import assert from "node:assert/strict";
import { UpdateLoop, factsOf } from "../dist/desktop/update-loop.js";
import { UpdateInstallClaim } from "../dist/desktop/update-install-claim.js";

function world({ autoUpdate = "install", channel = "beta", plans = [] } = {}) {
  const calls = [], said = [], timers = [];
  const updater = {
    status: { phase: "idle", release: null, outcome: null, message: "" }, inProgress: false, selectedChannel: "stable",
    setChannel(next) { calls.push(`channel ${next}`); this.selectedChannel = next; },
    async check() { calls.push("check"); this.status = { phase: "available", release: { tag: "dev-aaaaaaa" }, outcome: null, message: "A newer Beta build" }; return this.status; },
  };
  const loop = new UpdateLoop({
    readiness: async () => ({ channel, autoUpdate }),
    plan: async (facts) => { calls.push(`plan ${JSON.stringify(facts)}`); return plans.shift() ?? { mode: autoUpdate, step: "nothing", reason: "" }; },
    updater, install: async () => { calls.push("install"); },
    tell: (words) => said.push(words),
    setTimer: (run, ms) => { const timer = { run, ms, cancelled: false, cancel() { this.cancelled = true; } }; timers.push(timer); return timer; },
  });
  return { loop, updater, calls, said, timers };
}

test("with no window at all the loop looks, finds a newer Beta build and installs it, each on the engine's plan", async () => {
  const { loop, calls } = world({ plans: [{ mode: "install", step: "check", reason: "" }, { mode: "install", step: "install", reason: "" }] });
  const next = await loop.look();
  assert.deepEqual(calls, ["channel beta", 'plan {"updaterPhase":"idle"}', "check", 'plan {"updaterPhase":"available","updaterTag":"dev-aaaaaaa","checked":true}', "install"]);
  assert.equal(next, 30_000, "Beta updating by itself is looked at again in thirty seconds");
});

test("it backs off to five minutes while nothing can change, and never runs two looks at once or beside an install", async () => {
  const off = world({ autoUpdate: "off" });
  assert.equal(await off.loop.look(), 300_000);
  assert.deepEqual(off.calls, [], "updating turned off: the engine is not even asked for a plan");
  const stable = world({ channel: "stable", autoUpdate: "install" });
  assert.equal(await stable.loop.look(), 300_000, "Stable with nothing found");
  const busy = world();
  busy.updater.inProgress = true;
  assert.equal(await busy.loop.look(), 30_000);
  assert.deepEqual(busy.calls, [], "an install under way is never looked over");
});

test("a failed look is said once, in the updater's own words, and the engine keeps it (never silently)", async () => {
  const { loop, updater, said, calls } = world({ plans: [{ mode: "install", step: "check", reason: "" }, { mode: "install", step: "nothing", reason: "", tellProblem: true }] });
  updater.check = async () => { updater.status = { phase: "error", release: null, outcome: null, message: "git was not found." }; return updater.status; };
  await loop.look();
  assert.deepEqual(said, ["git was not found."]);
  assert.ok(calls.some((call) => call.includes('"problem":"git was not found."')), "the engine is told, so Settings shows it");
});

test("a release whose install failed is named to the engine, so it is not tried again by itself", () => {
  assert.deepEqual(factsOf({ phase: "error", release: { tag: "dev-bbbbbbb" }, outcome: { kept: "1.0.0" } }), { updaterPhase: "error", updaterTag: "dev-bbbbbbb", failedTag: "dev-bbbbbbb" });
  assert.deepEqual(factsOf({ phase: "error", release: { tag: "dev-bbbbbbb" }, outcome: null }), { updaterPhase: "error", updaterTag: "dev-bbbbbbb" });
});

test("after a live update the install is free again, so the next change lands too (it used to stay claimed for good)", async () => {
  const claim = new UpdateInstallClaim();
  let installs = 0;
  const once = () => claim.run(() => "status", () => false, async () => { installs++; claim.release(); return "done"; });
  assert.equal(await once(), "done");
  assert.equal(await once(), "done");
  assert.equal(installs, 2);
});

/* The owner's copy stopped updating by itself (13:04 UTC): the loop lived in the window's page, and that page stopped
   looking. In the app a look that never ends is left behind: the loop goes on looking, with no window open at all. */
test("with no window open, a look that never ends is left behind and the loop keeps looking", async () => {
  let clock = 0, hung = null, reads = 0;
  const calls = [], said = [], timers = [];
  const updater = {
    status: { phase: "idle", release: null, outcome: null, message: "" }, inProgress: false, selectedChannel: "beta",
    setChannel() {}, async check() { calls.push("check"); return this.status; },
  };
  const loop = new UpdateLoop({
    // The first read never answers (an engine call that hangs); later ones do.
    readiness: () => { reads++; return reads === 1 ? new Promise((resolve) => { hung = resolve; }) : Promise.resolve({ channel: "beta", autoUpdate: "install" }); },
    plan: async (facts) => { calls.push(`plan ${facts.updaterPhase}`); return { mode: "install", step: "nothing", reason: "" }; },
    updater, install: async () => { calls.push("install"); }, tell: (words) => said.push(words), now: () => clock,
    setTimer: (run, ms) => { const timer = { run, ms, cancelled: false, cancel() { this.cancelled = true; } }; timers.push(timer); return timer; },
  });
  const live = () => timers.filter((timer) => !timer.cancelled);
  loop.start(60_000);
  clock = 60_000;
  const first = loop.look();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [], "the first look is stuck reading the owner's choice");
  assert.deepEqual(live().map((timer) => timer.ms), [600_000], "but it left a timer that fires even if it never ends");
  clock += 600_000;
  live()[0].run(); // the safety net fires, as setTimeout would
  for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["plan idle"], "a new look asks the engine's plan");
  assert.match(said[0], /had not finished after 10 minutes, so Branch started looking again/);
  assert.deepEqual(live().map((timer) => timer.ms), [30_000], "and the next look is on the schedule");
  hung({ channel: "beta", autoUpdate: "install" });
  await first;
  assert.deepEqual(calls, ["plan idle"], "the look left behind does nothing more when it finally answers");
  assert.deepEqual(live().map((timer) => timer.ms), [30_000], "nor does it set a second schedule");
});

test("an engine that could not be closed for an update (UpdateStuckError) is said and kept, never a quiet wait, and the release is not marked failed", async () => {
  const { loop, calls, said } = world({ plans: [{ mode: "install", step: "install", reason: "" }, { mode: "install", step: "nothing", reason: "", tellProblem: true }] });
  const stuck = new Error("Branch could not close its background engine: taskkill refused.");
  stuck.name = "UpdateStuckError";
  loop.options.install = async () => { calls.push("install"); throw stuck; };
  assert.equal(await loop.look(), 30_000);
  assert.deepEqual(said, [stuck.message]);
  assert.equal(loop.last.wait, null);
  const told = calls.find((call) => call.includes('"problem"'));
  assert.ok(told && !told.includes("failedTag"), "kept as a problem; the release is tried again, not skipped");
});

/* The owner's case: dev-a460a1b failed to install once (GitHub had the repo locked while it moved), and newer green
   builds exist. Driven through the engine's real plan (src/comfort/auto-update.ts), as /api/comfort/update-plan runs it. */
test("a release that failed once is not retried, and the newer one after it installs by itself", async () => {
  const { updatePlan, noteUpdateCheck, noteFailedInstall } = await import("../dist/comfort/auto-update.js");
  const records = { "comfort-notify": { autoUpdate: "install", releaseChannel: "beta" }, "ship-on-chosen": { "comfort-notify": ["autoUpdate", "releaseChannel"] } };
  const store = { get: (_kind, _owner, key) => ({ data: records[key] }), save: (_kind, _owner, key, data) => { records[key] = data; } };
  let clock = Date.parse("2026-09-29T13:30:00Z");
  noteFailedInstall(store, "local", "dev-a460a1b", new Date(clock - 3_600_000));
  const plan = async (facts) => {
    if (facts.checked) noteUpdateCheck(store, "local", new Date(clock));
    if (facts.failedTag) noteFailedInstall(store, "local", facts.failedTag, new Date(clock));
    return updatePlan(store, "local", { busyTasks: 0, ...facts, now: new Date(clock) });
  };
  const newest = ["dev-a460a1b", "dev-c0ffee1"];
  const installs = [];
  const updater = {
    status: { phase: "idle", release: null, outcome: null, message: "" }, inProgress: false, selectedChannel: "beta", setChannel() {},
    async check() { this.status = { phase: "available", release: { tag: newest.shift() }, outcome: null, message: "" }; return this.status; },
  };
  const loop = new UpdateLoop({ readiness: async () => ({ channel: "beta", autoUpdate: "install" }), plan, updater,
    install: async () => { installs.push(updater.status.release.tag); }, setTimer: () => ({ cancel() {} }) });
  await loop.look();
  assert.deepEqual(installs, [], "the release that failed here is not tried again by itself");
  clock += 60_000;
  await loop.look();
  assert.deepEqual(installs, ["dev-c0ffee1"], "a minute on, the newer build is found and installed");
});
