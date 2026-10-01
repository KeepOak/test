/**
 * Owner's PC 2026-09-29: the daemon's gateway held every request for hours ("Branch is starting its engine again") while
 * its engine was alive and idle. One connection reset on a healthy engine latched its port as dead, and only a new
 * engine's ready message ever cleared that; an engine that stays up never sends one. These check that a reset no longer
 * latches, and that the gateway's watchdog restarts an engine that stops answering (and leaves one that answers alone).
 * Every server and fake engine here is one this file starts, on 127.0.0.1 with port 0.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, request } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { Gateway } from "../dist/never-break/gateway.js";
import { EngineWatchdog } from "../dist/never-break/engine-watchdog.js";
import { gatewayContract } from "../dist/never-break/contract.js";

/** An engine's HTTP side: `mode` says how it answers the next request. */
async function engineServer(t) {
  const state = { mode: "ok", seen: [] };
  const server = createServer((req, res) => {
    state.seen.push(req.url);
    if (state.mode === "hang") return; // never answers, like an engine whose requests all wait on something
    if (state.mode === "reset-once") { state.mode = "ok"; req.socket.destroy(); return; }
    if (req.url === "/api/alive" && state.mode === "key") { res.writeHead(401); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }));
  return { state, port: server.address().port };
}

/** A worker as the gateway sees it: says it is ready at `port`, and ends when killed. */
class FakeWorker extends EventEmitter {
  constructor(port, pid) {
    super();
    Object.assign(this, { pid, exitCode: null, signalCode: null, connected: true, kills: [] });
    setImmediate(() => this.emit("message", { type: "ready", contract: gatewayContract.speaks, accepts: gatewayContract.accepts, port, version: "t", pid }));
  }
  send(message, done) { if (message.type === "stop") setImmediate(() => this.end(0, null)); done?.(null); return true; }
  kill(signal = "SIGTERM") { this.kills.push(signal); setImmediate(() => this.end(null, signal)); return true; }
  end(code, signal) {
    if (!this.connected) return;
    Object.assign(this, { connected: false, exitCode: code, signalCode: signal });
    this.emit("exit", code, signal);
  }
}

async function gatewayWith(t, port, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-gw-watchdog-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, "gateway.json"), JSON.stringify({ mode: "on", holdSeconds: 2 }));
  const workers = [], events = [];
  const gw = new Gateway({ dataDir, script: "unused", port: 0, version: "test", settleMs: 60_000,
    spawn: () => { const worker = new FakeWorker(port, 5000 + workers.length); workers.push(worker); return worker; },
    onWorker: (event) => events.push(event), ...options });
  t.after(async () => { await gw.stop(); await discardTemp(root); });
  await gw.start();
  await until(() => gw.health().worker.state === "ready", "the worker to be ready");
  return { gw, workers, events };
}

async function until(check, what, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await delay(20); }
  assert.fail(`timed out waiting for ${what}`);
}

const get = (url, path) => new Promise((done, fail) => {
  const target = new URL(path, url);
  const req = request({ host: target.hostname, port: target.port, path: target.pathname, agent: false }, (res) => {
    let body = ""; res.on("data", (chunk) => { body += chunk; }); res.on("end", () => done({ status: res.statusCode, body }));
  });
  req.on("error", fail);
  req.end();
});

test("one connection reset from an engine that is still up does not hold every later request", async (t) => {
  const engine = await engineServer(t);
  const { gw, workers } = await gatewayWith(t, engine.port, { watchdog: false });
  engine.state.mode = "reset-once";
  const first = await get(gw.url, "/api/first");
  assert.equal(first.status, 200, `the reset request is tried again on a fresh connection (${first.body})`);
  const later = await get(gw.url, "/api/later");
  assert.equal(later.status, 200, `a later request reaches the same engine (${later.body})`);
  assert.equal(workers.length, 1, "the engine was never replaced");
});

test("the watchdog restarts an engine that stops answering, and says why", async (t) => {
  const engine = await engineServer(t);
  const { gw, workers, events } = await gatewayWith(t, engine.port, { watchdog: { everyMs: 40, timeoutMs: 80, unresponsiveMs: 300 } });
  engine.state.mode = "hang";
  await until(() => workers.length === 2, "a second engine to be started", 8000);
  assert.deepEqual(workers[0].kills, ["SIGKILL"], "the silent engine was ended");
  const crash = events.find((event) => event.kind === "crash");
  assert.match(crash?.why ?? "", /did not answer for \d+ seconds/, "the crash record names the watchdog");
  assert.ok(gw.notes.some((note) => /did not answer for \d+ seconds, so it was stopped and started again/.test(note.text)), "the gateway's notes say so");
  assert.ok(engine.state.seen.includes("/api/alive"), "the engine's own address was asked directly");
});

test("the watchdog leaves an engine that answers alone, even when the answer is a refusal", async (t) => {
  const engine = await engineServer(t);
  engine.state.mode = "key"; // /api/alive without a key: 401 is still an answer
  const { workers } = await gatewayWith(t, engine.port, { watchdog: { everyMs: 30, timeoutMs: 80, unresponsiveMs: 200 } });
  await delay(700);
  assert.ok(engine.state.seen.filter((url) => url === "/api/alive").length >= 3, "it kept asking");
  assert.deepEqual(workers[0].kills, [], "an answering engine is never ended");
  assert.equal(workers.length, 1);
});

test("the watchdog waits while an engine is being checked or handed over", async (t) => {
  const engine = await engineServer(t);
  const { gw, workers } = await gatewayWith(t, engine.port, { watchdog: { everyMs: 30, timeoutMs: 60, unresponsiveMs: 150 } });
  workers[0].emit("message", { type: "checking" });
  engine.state.mode = "hang";
  await delay(600);
  assert.equal(gw.health().worker.state, "checking");
  assert.deepEqual(workers[0].kills, [], "a hand-over in progress is not the watchdog's to end");
});

test("an answer clears a port marked dead, so a refused connection does not hold requests for good", async (t) => {
  let answers = true, clock = 0;
  const cleared = [], silent = [];
  const dog = new EngineWatchdog({ probe: async () => answers, onAnswer: () => cleared.push(clock), onUnresponsive: (ms) => silent.push(ms),
    everyMs: 1000, unresponsiveMs: 3000, now: () => clock, schedule: () => undefined });
  dog.arm();
  await dog.tick();
  assert.deepEqual(cleared, [0], "an answer is passed on at once");
  answers = false;
  for (clock = 1000; clock <= 3000; clock += 1000) await dog.tick();
  assert.deepEqual(silent, [], "two seconds of silence is not yet three");
  clock = 4000; await dog.tick();
  assert.deepEqual(silent, [3000], "three seconds of silence is reported once");
  clock = 5000; await dog.tick();
  assert.equal(silent.length, 1, "and not again until it is armed again");
});

test("a watchdog that wakes long after its time (the computer slept) starts counting again", async () => {
  let clock = 0;
  const silent = [];
  const dog = new EngineWatchdog({ probe: async () => false, onUnresponsive: (ms) => silent.push(ms),
    everyMs: 1000, unresponsiveMs: 3000, now: () => clock, schedule: () => undefined });
  dog.arm();
  await dog.tick();
  clock = 60 * 60 * 1000; await dog.tick(); // an hour later: the silence was the computer's sleep, not the engine's
  assert.deepEqual(silent, []);
  for (let step = 1; step <= 3; step++) { clock += 1000; await dog.tick(); }
  assert.deepEqual(silent, [3000], "three seconds of silence after waking is reported");
});

test("a failed live engine update wakes the gateway again even when the window cannot be restored", async (t) => {
  const { liveHooks } = await import("../dist/desktop/hot-apply.js");
  const { stageLive } = await import("../dist/hot-update/live-folder.js");
  const root = await mkdtemp(join(tmpdir(), "branch-gw-hot-")); t.after(() => discardTemp(root));
  const source = join(root, "source"), appRoot = join(root, "app"), readies = [];
  await mkdir(join(source, "public"), { recursive: true }); await writeFile(join(source, "public", "app.js"), "export {};\n");
  const built = await stageLive({ source, appRoot, commit: "c".repeat(40), version: "1.0.2", withEngine: false });
  const host = { running: true, call: async () => ({ changed: [], ms: 0 }) };
  const hooks = liveHooks({ appRoot, dataDir: join(root, "data"), repo: "branch-test/live", buildDir: join(root, "build"), packaged: "a".repeat(40),
    host: () => host, tellWindow: async () => {}, runtime: process.execPath, forkLive: () => { throw new Error("unused"); },
    snapshot: async () => { throw new Error("the copy could not be made"); }, backup: async () => {},
    recoverWindow: async () => { throw new Error("The previous window did not restore and draw."); },
    gateway: { ready: (version, provisional) => readies.push([version, provisional === true]), checking: () => {}, packagedVersion: "1.0.0" } });
  const outcome = { tier: "engine", ...built, version: "1.0.2", changed: [{ path: "public/app.js", part: "window" }] };
  await assert.rejects(hooks.apply(outcome, { onStage: () => {} }), /did not restore/);
  assert.deepEqual(readies, [["1.0.0", true], ["1.0.0", false]], "the gateway is told the previous engine is ready, not left holding");
});

test("the watchdog's keyless probe gets an answer from the real engine and never counts as a wrong key", async (t) => {
  const { createBranch } = await import("../dist/index.js");
  const { startServer } = await import("../dist/server.js");
  const { engineAnswers } = await import("../dist/never-break/engine-watchdog.js");
  const root = await mkdtemp(join(tmpdir(), "branch-gw-probe-real-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  // A tight limit: were keyless probes counted as guesses, the third would already be made to wait.
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, authLimits: { attempts: 2, lockoutMs: 60_000, windowMs: 60_000 } });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const port = Number(new URL(server.url).port);
  for (let probe = 0; probe < 8; probe++) assert.equal(await engineAnswers(port, 5000), true, `probe ${probe} was answered`);
  const keyless = await get(server.url, "/api/alive");
  assert.equal(keyless.status, 401, "keyless is refused, not made to wait");
  const owner = await fetch(`${server.url}/api/alive`, { headers: { authorization: `Bearer ${server.token}` } });
  assert.equal(owner.status, 200, "the owner's own requests from this address are never shut out by the probes");
});
