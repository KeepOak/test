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
