import test from "node:test";
import assert from "node:assert/strict";
import { EnginePowerRecovery } from "../dist/desktop/engine-power.js";

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
