import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { GatewayPowerPolicy } from "../dist/desktop/gateway-power.js";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
  const events = new EventEmitter(), active = new Set(), started = [], stopped = [];
  let next = 0, saved = { keepAwake: false, gatewayDesired: true }, suspended = 0, resumed = 0;
  const policy = new GatewayPowerPolicy({ everyMs: 0, events, read: async () => saved,
    blocker: { start: (type) => { started.push(type); active.add(next); return next++; }, stop: (id) => { stopped.push(id); return active.delete(id); }, isStarted: (id) => active.has(id) },
    suspended: () => { suspended++; }, resumed: () => { resumed++; } });
  return { policy, events, started, stopped, active, save: (value) => { saved = value; }, get suspended() { return suspended; }, get resumed() { return resumed; } };
}

test("default OFF respects OS policy, owner ON requests application wake only, and shell/engine refreshes do not duplicate it", async () => {
  const f = fixture(); await f.policy.start(); assert.equal(f.policy.status().active, false); assert.deepEqual(f.started, []);
  f.save({ keepAwake: true, gatewayDesired: true }); await f.policy.refresh();
  assert.deepEqual(f.started, ["prevent-app-suspension"]); assert.equal(f.policy.status().active, true);
  await f.policy.refresh(); await f.policy.refresh(); assert.equal(f.started.length, 1);
  await f.policy.start(); assert.equal(f.events.listenerCount("resume"), 1);
  f.save({ keepAwake: false, gatewayDesired: true }); await f.policy.refresh(); assert.deepEqual(f.stopped, [0]);
  f.policy.close(); assert.equal(f.events.listenerCount("resume"), 0);
});

test("gateway OFF releases its own blocker and a terminal owner quit cannot be revived by resume", async () => {
  const f = fixture(); f.save({ keepAwake: true, gatewayDesired: true }); await f.policy.start();
  f.save({ keepAwake: true, gatewayDesired: false }); await f.policy.refresh(); assert.deepEqual(f.stopped, [0]);
  f.save({ keepAwake: true, gatewayDesired: true }); await f.policy.refresh(); f.policy.close(); f.policy.close();
  assert.deepEqual(f.stopped, [0, 1]); f.events.emit("resume"); await tick(); await f.policy.refresh();
  assert.equal(f.started.length, 2); assert.equal(f.resumed, 0); assert.equal(f.policy.status().active, false);
});

test("manual suspend releases wake request and one resume restores preference and invokes recovery once", async () => {
  const f = fixture(); f.save({ keepAwake: true, gatewayDesired: true }); await f.policy.start();
  f.events.emit("suspend"); await tick(); assert.equal(f.suspended, 1); assert.equal(f.policy.status().suspended, true); assert.equal(f.policy.status().active, false);
  f.events.emit("resume"); f.events.emit("resume"); await tick();
  assert.equal(f.resumed, 1); assert.equal(f.started.length, 2); assert.equal(f.policy.status().suspended, false); assert.equal(f.policy.status().active, true);
  f.policy.close();
});

test("a restarted gateway acquires its own request after the departed owner releases its ID", async () => {
  const old = fixture(); old.save({ keepAwake: true, gatewayDesired: true }); await old.policy.start(); old.policy.close();
  const next = fixture(); next.save({ keepAwake: true, gatewayDesired: true }); await next.policy.start();
  assert.deepEqual(old.stopped, [0]); assert.equal(next.policy.status().active, true); next.policy.close();
});

test("a slow saved-preference read completing after shutdown cannot start a blocker", async () => {
  const events = new EventEmitter(); let release, called = false;
  const policy = new GatewayPowerPolicy({ events, everyMs: 0, read: () => new Promise((resolve) => { release = resolve; }),
    blocker: { start: () => { called = true; return 0; }, stop: () => true, isStarted: () => true } });
  const starting = policy.start(); policy.close(); release({ keepAwake: true, gatewayDesired: true }); await starting;
  assert.equal(called, false); assert.equal(events.listenerCount("resume"), 0);
});

test("closing during resume cancels recovery and a queued suspend callback", async () => {
  const events = new EventEmitter(); let resolveRead, reads = 0, recovered = 0, checkpointed = 0;
  const policy = new GatewayPowerPolicy({ events, everyMs: 0,
    read: () => ++reads === 1 ? Promise.resolve({ keepAwake: false, gatewayDesired: true }) : new Promise((resolve) => { resolveRead = resolve; }),
    blocker: { start: () => 0, stop: () => true, isStarted: () => false }, resumed: () => { recovered++; }, suspended: () => { checkpointed++; } });
  await policy.start(); events.emit("resume"); events.emit("suspend"); policy.close();
  resolveRead({ keepAwake: true, gatewayDesired: true }); await tick();
  assert.equal(recovered, 0); assert.equal(checkpointed, 0);
});

test("failed OS release stays visible and shutdown retries only the owned request", async () => {
  const events = new EventEmitter(); let active = true, refusing = true; const stopped = [];
  const policy = new GatewayPowerPolicy({ events, everyMs: 0, read: async () => ({ keepAwake: true, gatewayDesired: true }),
    blocker: { start: () => 17, isStarted: () => active, stop: (id) => { stopped.push(id); if (refusing) throw new Error("release refused"); active = false; return true; } } });
  await policy.start(); policy.close(); assert.equal(policy.status().active, true); assert.equal(policy.status().error, "release refused");
  refusing = false; policy.close(); assert.equal(policy.status().active, false); assert.deepEqual(stopped, [17, 17]);
});
