import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EngineHost } from "../dist/desktop/engine-host.js";
import { captureService } from "../dist/desktop/capture-service.js";
const key = "a".repeat(64), commit = "b".repeat(40);
class Child extends EventEmitter {
  constructor(name, starting) { super(); this.name = name; this.starting = starting; this.pid = 77; }
  postMessage(message) {
    if (message.kind === "start") { this.starting(this.name); queueMicrotask(() => this.emit("message", { kind: "ready", url: "http://127.0.0.1:45001", token: key })); }
    if (message.kind !== "call") return;
    if (message.method === "stop") { this.kill(); return; }
    const value = message.method === "hand-over" ? { drained: true, handedOver: [], stillWorking: [], ms: 0 } : [];
    queueMicrotask(() => this.emit("message", { kind: "reply", id: message.id, ok: true, value }));
  }
  kill() { queueMicrotask(() => this.emit("exit", 0)); return true; }
}
async function setup(t) {
  const order = [], lines = []; let protectedNow = false, oldNumber = 0;
  const window = { isDestroyed: () => false, isContentProtected: () => protectedNow, setContentProtection: (value) => { protectedNow = value; },
    getNativeWindowHandle: () => { const b = Buffer.alloc(8); b.writeBigUInt64LE(101n); return b; } };
  const capture = captureService({ platform: "win32", release: "10.0.19045", processId: 77, windows: () => [window], onCreated: () => () => {} });
  const starting = (name) => { order.push(`${name}-start`); assert.equal(protectedNow, false, "departure teardown precedes every new authenticated chain");
    if (name === "old2") capture.acquire({ leaseId: "c".repeat(32) }); };
  const host = new EngineHost({ fork: () => new Child(`old${++oldNumber}`, starting), handlers: {}, log: (line) => lines.push(line),
    config: { dataDir: "C:/stand-in/data", workspace: "C:/stand-in/work", providerEnv: null, version: "0.0.0", executable: null,
      installRoot: null, packaged: false, loginItem: null, appPid: 77, testHooks: false } });
  t.after(async () => { await host.end(100); capture.close(); });
  await host.start(); capture.acquire({ leaseId: "a".repeat(32) });
  return { host, capture, order, lines, protected: () => protectedNow, fork: () => {
    const candidate = new Child("candidate", starting); queueMicrotask(() => candidate.emit("message", { kind: "loaded", contract: 1, commit })); return candidate;
  } };
}
test("a rejected candidate loses its capture leases before the restored engine acquires its own", async (t) => {
  const f = await setup(t);
  const result = await f.host.handOver({ fork: f.fork, commit, onSwitch: () => { f.order.push("teardown"); f.capture.close(); }, check: async () => {
    f.capture.acquire({ leaseId: "b".repeat(32) }); throw new Error("candidate check rejected"); } });
  assert.equal(result.ok, false); assert.equal(result.why, "candidate check rejected");
  assert.deepEqual(f.order, ["old1-start", "teardown", "candidate-start", "teardown", "old2-start"]);
  assert.equal(f.protected(), true); assert.equal(f.capture.release({ leaseId: "b".repeat(32) }), false);
  assert.equal(f.protected(), true, "a departed candidate cannot release the restored chain");
});
test("cleanup errors during rollback cannot replace the candidate failure or tear down a successor afterward", async (t) => {
  const f = await setup(t); let resets = 0;
  const result = await f.host.handOver({ fork: f.fork, commit, onSwitch: () => { f.capture.close(); if (++resets === 2) throw new Error("cleanup failure"); },
    check: async () => { throw new Error("original candidate failure"); } });
  assert.equal(result.why, "original candidate failure"); assert.equal(resets, 2); assert.equal(f.protected(), true);
  assert.ok(f.lines.some((line) => line.includes("departure cleanup failed (cleanup failure)")));
});
