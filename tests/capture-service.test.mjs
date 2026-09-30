import test from "node:test";
import assert from "node:assert/strict";
import { captureService } from "../dist/desktop/capture-service.js";
import { trustedCaptureLease } from "../dist/desktop/capture-link.js";
import { engineBroker } from "../dist/desktop/engine-broker.js";
const first = "a".repeat(32), second = "b".repeat(32), proof = { processId: 77, handles: ["101"] };

test("a departed engine releases protection; a successor gets a fresh owned lease", () => {
  let protectedNow = false, removed = 0; const listeners = [];
  const window = { isDestroyed: () => false, isContentProtected: () => protectedNow, setContentProtection: (value) => { protectedNow = value; },
    getNativeWindowHandle: () => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(101n); return bytes; } };
  const service = captureService({ platform: "win32", release: "10.0.19045", processId: 77, windows: () => [window],
    onCreated: (listener) => { listeners.push(listener); return () => { removed++; }; } });
  assert.deepEqual(service.acquire({ leaseId: first }), proof); assert.equal(protectedNow, true);
  service.close(); assert.equal(protectedNow, false); assert.equal(removed, 1);
  assert.deepEqual(service.acquire({ leaseId: second }), proof);
  assert.equal(service.release({ leaseId: first }), false, "a departed chain cannot release the new lease");
  assert.equal(protectedNow, true);
  assert.equal(service.release({ leaseId: second }), true); assert.equal(protectedNow, false);
});
test("trusted capture IPC parses strict arguments and proof, rejecting unavailable gateway ownership", async () => {
  const calls = [], client = trustedCaptureLease({ call: async (method, args) => { calls.push({ method, args }); return method === "capture-acquire" ? proof : true; } }, true);
  assert.deepEqual(await client.acquire(first), proof); await client.release(first);
  assert.deepEqual(calls, [{ method: "capture-acquire", args: { leaseId: first } }, { method: "capture-release", args: { leaseId: first } }]);
  await assert.rejects(client.acquire("bad")); assert.equal(calls.length, 2);
  const absent = trustedCaptureLease({ call: async () => { throw new Error("must not call"); } }, false);
  await assert.rejects(absent.acquire(first), /no proved host/); await assert.rejects(absent.release(first), /no proved host/);
  await assert.rejects(trustedCaptureLease({ call: async () => ({ ...proof, bypass: true }) }, true).acquire(first));
  await assert.rejects(trustedCaptureLease({ call: async () => false }, true).release(first), /no longer owned/);
});
test("the broker accepts capture leases only through its strict owned host service", () => {
  const calls = [];
  const options = { vault: { read: async () => null, write: async () => {}, clear: async () => {} }, banner: async () => ({ close: () => {} }),
    loginItem: null, tell: () => {}, quit: () => {}, capture: { acquire: (args) => { calls.push(args); return proof; }, release: () => true, close: () => calls.push("close") } };
  const broker = engineBroker(options);
  assert.throws(() => broker.handlers["capture-acquire"]({ leaseId: first, excludeAnyWindow: true })); assert.equal(calls.length, 0);
  assert.deepEqual(broker.handlers["capture-acquire"]({ leaseId: first }), proof);
  assert.equal(broker.handlers["capture-release"]({ leaseId: first }), true);
  broker.close(); assert.deepEqual(calls, [{ leaseId: first }, "close"]);
  delete options.capture;
  assert.throws(() => engineBroker(options).handlers["capture-acquire"]({ leaseId: first }), /no proved desktop capture host/);
});
