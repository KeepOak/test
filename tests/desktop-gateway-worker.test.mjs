import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { DesktopGatewayWorker } from "../dist/desktop/gateway-worker.js";
import { WorkerReadySchema } from "../dist/never-break/contract.js";

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function fixture({ held = false } = {}) {
  const calls = [], gate = deferred();
  let gone;
  const host = { pid: 42, running: true, start: async () => { calls.push("start"); return "http://127.0.0.1:49123"; },
    stop: async () => { calls.push("stop"); }, end: async () => { calls.push("end"); host.running = false; } };
  const worker = new DesktopGatewayWorker({ version: "1.2.3", closeBroker: () => calls.push("broker-close"),
    create: async (callback) => { gone = callback; if (held) await gate.promise; return host; } });
  worker.on("error", (error) => calls.push(error.message));
  return { worker, host, calls, release: gate.resolve, crash: () => gone(7) };
}

test("the desktop engine becomes a gateway worker with the checked readiness contract", async () => {
  const f = fixture();
  const [ready] = await once(f.worker, "message");
  assert.equal(WorkerReadySchema.safeParse(ready).success, true);
  assert.equal(ready.port, 49123);
  assert.equal(f.worker.pid, 42);
  const exited = once(f.worker, "exit");
  f.worker.send({ type: "stop" });
  assert.deepEqual(await exited, [0, null]);
  assert.deepEqual(f.calls, ["start", "stop", "end", "broker-close"]);
});

test("an unexpected desktop-engine exit ends its host and closes broker before gateway replacement", async () => {
  const f = fixture();
  await once(f.worker, "message");
  const exited = once(f.worker, "exit");
  f.crash();
  assert.deepEqual(await exited, [7, null]);
  assert.equal(f.host.running, false);
  assert.deepEqual(f.calls, ["start", "end", "broker-close"]);
  assert.equal(f.worker.kill(), false);
});

test("a gateway stopped while encrypted settings load never starts an engine afterward", async () => {
  const f = fixture({ held: true });
  const messages = [];
  f.worker.on("message", (message) => messages.push(message));
  const exited = once(f.worker, "exit");
  f.worker.kill("SIGKILL");
  assert.deepEqual(await exited, [null, "SIGKILL"]);
  f.release();
  await new Promise((done) => setImmediate(done));
  assert.equal(f.host.running, false);
  assert.equal(f.calls.includes("start"), false);
  assert.deepEqual(messages, []);
});

test("the desktop worker refuses arbitrary commands instead of forwarding engine or vault calls", async () => {
  const f = fixture();
  await once(f.worker, "message");
  let refused;
  assert.equal(f.worker.send({ type: "call", method: "vault-read" }, (error) => { refused = error; }), false);
  assert.match(refused.message, /refused/);
  assert.equal(f.worker.connected, true);
  assert.equal(f.worker.send({ type: "hello", contract: 1, accepts: [1, 1] }), true);
  assert.deepEqual(f.calls, ["start"], "a contract greeting never stops the engine");
  const exited = once(f.worker, "exit");
  f.worker.kill();
  await exited;
});

test("a proved hot adoption refreshes readiness with the successor PID on the same internal port", async () => {
  const f = fixture(); await once(f.worker, "message"); f.host.pid = 84;
  const refreshed = once(f.worker, "message"); f.worker.updated("1.2.4");
  const [ready] = await refreshed; assert.equal(ready.pid, 84); assert.equal(ready.version, "1.2.4"); assert.equal(ready.port, 49123);
  const ended = once(f.worker, "exit"); f.worker.kill(); await ended;
  let late = false; f.worker.on("message", () => { late = true; }); f.worker.updated("1.2.5"); assert.equal(late, false);
});
