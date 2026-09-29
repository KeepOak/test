import test from "node:test";
import assert from "node:assert/strict";
import { EnginePowerRecovery, followPower } from "../dist/desktop/engine-power.js";

test("suspend checkpoints saved work; resume wakes due schedules and existing queued deliveries once", async () => {
  const calls = []; let due;
  const power = new EnginePowerRecovery({ checkpoint: () => calls.push("checkpoint"),
    due: () => { calls.push("due"); return new Promise((resolve) => { due = resolve; }); }, flush: async () => { calls.push("flush"); } });
  assert.equal(power.suspend(), true); const first = power.resume(), second = power.resume(); assert.equal(first, second);
  due(); assert.equal(await first, true); assert.deepEqual(calls, ["checkpoint", "checkpoint", "due", "flush"]);
});

test("closing an engine during resume prevents delivery from the departed chain", async () => {
  let due, flushed = false;
  const power = new EnginePowerRecovery({ checkpoint: () => {}, due: () => new Promise((resolve) => { due = resolve; }), flush: async () => { flushed = true; } });
  const waking = power.resume(); power.close(); due(); assert.equal(await waking, false); assert.equal(flushed, false);
  assert.equal(power.suspend(), false); assert.equal(await power.resume(), false);
});

test("resume failure is surfaced and a later OS resume may retry the existing schedule ledger", async () => {
  let attempts = 0, flushed = 0;
  const power = new EnginePowerRecovery({ checkpoint: () => {}, due: async () => { if (++attempts === 1) throw new Error("offline"); }, flush: async () => { flushed++; } });
  await assert.rejects(power.resume(), /offline/); assert.equal(await power.resume(), true); assert.equal(flushed, 1);
});

test("a window's own engine is told of sleep and wake, but not while it is handed over or stopped", async () => {
  const listeners = {}, calls = [], logged = [];
  const engine = { running: true, handingOver: false, call: async (method, args, ms) => { calls.push([method, args, ms]); if (method === "power-resume") throw new Error("busy"); } };
  followPower({ on: (event, listener) => { listeners[event] = listener; } }, engine, (line) => logged.push(line));
  listeners.suspend(); listeners.resume();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [["power-suspend", {}, 5000], ["power-resume", {}, 10000]]);
  assert.match(logged.join("\n"), /power-resume: busy/, "a failed wake is logged, not swallowed");
  engine.handingOver = true; listeners.resume();
  engine.handingOver = false; engine.running = false; listeners.suspend();
  assert.equal(calls.length, 2);
});
