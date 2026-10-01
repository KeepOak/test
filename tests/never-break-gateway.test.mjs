import { processRunning } from "./process-running.mjs";
/**
 * Never breaks, threats 2 and 3: the gateway keeps Branch's address open, replaces a worker that
 * dies, puts back the last good settings when new ones will not start, and takes nothing with it
 * when it is killed itself. Every process here is one this file starts, in a temporary folder.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { Gateway } from "../dist/never-break/gateway.js";
import {
  loadGatewayConfig, promoteGood, proposeConfig, acceptProposal, readProposal, saveGatewayConfig, writeAtomic,
  defaultGatewayConfig, GatewayConfigSchema,
} from "../dist/never-break/gateway-config.js";
import { crashVerdict, markRunning, markExited } from "../dist/never-break/gateway-state.js";
import { contractsMeet, gatewayContract } from "../dist/never-break/contract.js";
import { neverBreakApi } from "../dist/never-break/api.js";
import { answerHeader, answerMark, askHeader, newBoot, proveOnce, sessionKey, watchEngine } from "../dist/engine-proof.js";

const worker = resolve("tests/fixtures/never-break-worker.mjs");
const alive = (pid) => processRunning(pid, () => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } });
async function until(check, what, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = await check(); if (value) return value; await delay(50); }
  assert.fail(`timed out waiting for ${what}`);
}
async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-never-gw-"));
  const dataDir = join(root, "data");
  await mkdir(dataDir, { recursive: true });
  return { root, dataDir };
}
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("BRANCH_") && name !== "NODE_OPTIONS"));
async function gateway(t, options = {}) {
  const { root, dataDir } = await temp(t);
  const events = [];
  const gw = new Gateway({ dataDir, script: worker, args: [], port: 0, version: "test", settleMs: 200,
    env: { ...cleanEnv(), ...(options.env ?? {}) }, onWorker: (event) => events.push(event), ...options.gateway });
  t.after(async () => { await gw.stop(); await discardTemp(root); });
  if (options.before) await options.before(dataDir);
  await gw.start();
  return { gw, dataDir, events, root };
}
const get = (url, path, options = {}) => new Promise((done, fail) => {
  const { method = "GET", body, ...headers } = options;
  const target = new URL(path, url);
  const req = request({ host: target.hostname, port: target.port, path: target.pathname, method, headers }, (response) => {
    let body = ""; response.on("data", (c) => { body += c; }); response.on("end", () => done({ status: response.statusCode, body }));
  });
  req.on("error", fail);
  req.end(body);
});

/* ---------- settings ---------- */

test("settings: missing means defaults, broken means the last good copy, and writes are whole", async (t) => {
  const { root, dataDir } = await temp(t);
  t.after(() => discardTemp(root));
  assert.deepEqual((await loadGatewayConfig(dataDir)).config, defaultGatewayConfig());
  await writeFile(join(dataDir, "gateway.json"), "{ not json");
  const noGood = await loadGatewayConfig(dataDir);
  assert.equal(noGood.restored, false);
  assert.match(noGood.problem, /not readable JSON.*defaults are in use/);
  const good = GatewayConfigSchema.parse({ mode: "on", holdSeconds: 7 });
  await promoteGood(dataDir, good);
  await writeFile(join(dataDir, "gateway.json"), JSON.stringify({ mode: "on", holdSeconds: "seven" }));
  const back = await loadGatewayConfig(dataDir);
  assert.equal(back.restored, true);
  assert.equal(back.config.holdSeconds, 7);
  assert.match(back.problem, /holdSeconds.*last settings that worked were put back/);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, "gateway.json"), "utf8")), good, "the good copy is on disk again");
  await writeAtomic(join(dataDir, "x.json"), "1");
  assert.deepEqual((await readdir(dataDir)).filter((name) => name.endsWith(".tmp")), [], "no half-written file is left");
  for (const name of ["BRANCH_DATA_DIR", "BRANCH_BASH", "BRANCH_GIT", "BRANCH_SELF_TEST", "BRANCH_RESUME", "BRANCH_EXECUTABLE", "PATH"])
    await assert.rejects(saveGatewayConfig(dataDir, { ...good, workerEnv: { [name]: "/elsewhere" } }), /Only these settings/, name);
});

test("a suggested change is tried first and applied only when the owner accepts it", async (t) => {
  const { root, dataDir } = await temp(t);
  t.after(() => discardTemp(root));
  const tried = [];
  const passes = async (config) => { tried.push(config); return { ok: true, detail: "started" }; };
  const proposal = await proposeConfig(dataDir, { holdSeconds: 5 }, "shorter waits", passes);
  assert.equal(proposal.check.ok, true);
  assert.equal(tried[0].holdSeconds, 5);
  assert.equal((await loadGatewayConfig(dataDir)).config.holdSeconds, 20, "nothing changed yet");
  await acceptProposal(dataDir);
  assert.equal((await loadGatewayConfig(dataDir)).config.holdSeconds, 5);
  assert.equal(await readProposal(dataDir), null);

  const refused = await proposeConfig(dataDir, { startSeconds: 1 }, "too short", passes);
  assert.equal(refused.check.ok, false, "the schema refuses it before anything is tried");
  await assert.rejects(acceptProposal(dataDir), /cannot be used/);
  await proposeConfig(dataDir, { holdSeconds: 9 }, "try", async () => ({ ok: false, detail: "engine died" }));
  await assert.rejects(acceptProposal(dataDir), /engine died/);

  const call = (method, path, body) => neverBreakApi(dataDir, { method }, path, async () => body);
  assert.equal((await call("GET", "/api/never-break")).proposal.why, "try");
  await call("POST", "/api/never-break/proposal/discard");
  assert.equal((await call("POST", "/api/never-break", { mode: "when-needed" })).mode, "when-needed");
  await assert.rejects(call("POST", "/api/never-break", { mode: "always" }), /off, when needed or on/);
});

test("crashes are chained by the gap between them, and a long chain slows the gateway down", () => {
  const limits = { maxQuickCrashes: 3, gapSeconds: 60 };
  assert.deepEqual(crashVerdict([], limits), { chained: 0, tripped: false, delayMs: 0 });
  assert.equal(crashVerdict([1000], limits).delayMs, 500);
  assert.equal(crashVerdict([1000, 2000], limits).delayMs, 1000);
  assert.equal(crashVerdict([1000, 2000, 3000], limits).tripped, true);
  assert.equal(crashVerdict([1000, 2000, 3000], limits).delayMs, 300000);
  assert.equal(crashVerdict([0, 100000, 200000], limits).chained, 1, "a quiet gap breaks the chain");
  assert.equal(crashVerdict([0, 50000, 100000, 150000], limits).tripped, true, "a slow loop is still a loop");
});

test("the gateway knows when the last exit was not clean", async (t) => {
  const { root, dataDir } = await temp(t);
  t.after(() => discardTemp(root));
  assert.equal((await markRunning(dataDir)).uncleanBefore, false);
  assert.equal((await markRunning(dataDir)).uncleanBefore, true, "running, then running again: the first never said goodbye");
  await markExited(dataDir);
  assert.equal((await markRunning(dataDir)).uncleanBefore, false);
});

test("old and new gateways and workers read each other for one release", () => {
  assert.equal(contractsMeet(gatewayContract, { speaks: 1, accepts: [1, 1] }), true);
  assert.equal(contractsMeet({ speaks: 1, accepts: [1, 1] }, { speaks: 2, accepts: [1, 2] }), true, "new worker, old gateway");
  assert.equal(contractsMeet({ speaks: 2, accepts: [1, 2] }, { speaks: 1, accepts: [1, 1] }), true, "old worker, new gateway");
  assert.equal(contractsMeet({ speaks: 1, accepts: [1, 1] }, { speaks: 3, accepts: [3, 3] }), false);
});

/* ---------- the running gateway ---------- */

test("requests go through to the worker, and a killed worker is replaced while the address stays open", async (t) => {
  const { gw, events } = await gateway(t);
  await until(() => events.some((e) => e.kind === "ready"), "the first worker");
  const first = JSON.parse((await get(gw.url, "/api/state")).body);
  assert.equal(first.version, "9.9.9", "the worker answered through the gateway, with the host rewritten");
  const echoed = JSON.parse((await get(gw.url, "/api/echo", { method: "POST", origin: gw.url, "content-type": "text/plain", body: "hello" })).body);
  assert.equal(echoed.body, "hello");
  assert.match(echoed.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await get(gw.url, "/api/state", { host: "evil.example" })).status, 403, "another address is refused at the gateway");
  assert.equal((await get(gw.url, "/api/state", { origin: "http://evil.example" })).status, 403);

  process.kill(first.pid, "SIGKILL");
  const during = await get(gw.url, "/gateway/health");
  assert.equal(during.status, 200, "the gateway answers while its worker is dead");
  const second = JSON.parse((await get(gw.url, "/api/state")).body);
  assert.notEqual(second.pid, first.pid, "a request made during the restart waited and reached the new worker");
  assert.equal(gw.restarts, 1);
  // Windows has no signals: a process ended from outside reports an exit code and no signal.
  assert.equal(events.filter((e) => e.kind === "crash")[0].signal, process.platform === "win32" ? null : "SIGKILL");
  assert.equal(alive(first.pid), false);
});

test("selfdev: an engine restarting itself on request (exit code 75) is started again at once and is not a crash", async (t) => {
  const { gw, events } = await gateway(t);
  await until(() => events.some((e) => e.kind === "ready"), "the first worker");
  const first = JSON.parse((await get(gw.url, "/api/state")).body);
  await get(gw.url, "/api/dashboard/restart", { method: "POST", origin: gw.url, "content-type": "application/json", body: "{}" });
  await until(() => events.filter((e) => e.kind === "ready").length >= 2, "the worker started again");
  const second = JSON.parse((await get(gw.url, "/api/state")).body);
  assert.notEqual(second.pid, first.pid);
  assert.equal(events.filter((e) => e.kind === "crash").length, 0, "a restart asked for is not recorded as a crash");
  assert.equal(gw.restarts, 0);
});

test("a request waits only so long for a worker that will not come", async (t) => {
  const { gw } = await gateway(t, { env: { FAKE_MODE: "never-ready" },
    before: (dataDir) => saveGatewayConfig(dataDir, GatewayConfigSchema.parse({ holdSeconds: 0, startSeconds: 60 })) });
  const answer = await get(gw.url, "/api/state");
  assert.equal(answer.status, 503);
  assert.match(JSON.parse(answer.body).error, /starting its engine again/);
});

test("settings that stop the worker starting are replaced by the last good ones", async (t) => {
  const { gw, events, dataDir } = await gateway(t, { before: async (dataDir) => {
    await promoteGood(dataDir, GatewayConfigSchema.parse({ mode: "on" }));
    await saveGatewayConfig(dataDir, GatewayConfigSchema.parse({ mode: "on", workerEnv: { BRANCH_PROVIDER: "never-break-crash" } }));
  } });
  await until(() => events.some((e) => e.kind === "ready"), "a worker on the good settings");
  assert.equal(events.filter((e) => e.kind === "crash").length, 2, "two failed starts, then the good settings");
  assert.deepEqual((await loadGatewayConfig(dataDir)).config.workerEnv, {});
  assert.match(gw.health().notes.map((n) => n.text).join("\n"), /last settings that worked were put back/);
});

test("a worker speaking a gateway language this gateway cannot read is stopped", async (t) => {
  const { gw } = await gateway(t, { env: { FAKE_MODE: "future-contract" } });
  await until(() => gw.health().notes.some((n) => /cannot read/.test(n.text)), "the refusal");
  assert.equal(gw.health().worker.state === "ready", false);
});

test("a connection upgrade is carried through to the worker", async (t) => {
  const { gw, events } = await gateway(t);
  await until(() => events.some((e) => e.kind === "ready"), "the worker");
  const port = Number(new URL(gw.url).port);
  const reply = await new Promise((done, fail) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(`GET /socket HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: echo\r\n\r\n`);
    });
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\r\n\r\n") && !text.includes("echo:")) socket.write("ping");
      if (text.includes("echo:ping")) { socket.destroy(); done(text); }
    });
    socket.on("error", fail);
  });
  assert.match(reply, /101 Switching Protocols[\s\S]*echo:ping/);
});

test("the gateway proves itself for the desktop window, hands the worker the window key its session key stands for, and marks its answers", async (t) => {
  const key = "e".repeat(64);
  const { gw, events } = await gateway(t, { before: (dataDir) => writeFile(join(dataDir, "session-token"), key) });
  await until(() => events.some((e) => e.kind === "ready"), "the worker");
  const port = Number(new URL(gw.url).port);
  const boot = await proveOnce(gw.url, key);
  assert.match(boot ?? "", /^[a-f0-9]{32}$/, "the gateway, which holds the window's address, proves itself there");
  assert.equal(await proveOnce(gw.url, "0".repeat(64)), null, "only under the window's own key");
  const status = (path) => fetch(`${gw.url}${path}`).then(async (answer) => { await answer.body?.cancel(); return answer.status; });
  assert.equal(await status(`/api/engine-proof?challenge=${"1".repeat(64)}`), 200, "one short proof to anybody");
  assert.equal(await status(`/api/engine-proof?challenge=${"1".repeat(64)}&hold=1`), 404, "no held connection without the session key");
  const watch = watchEngine(gw.url, key);
  assert.equal(await watch.proved, boot, "the window's watch is held there, with its session key");
  watch.close();
  const many = await Promise.all(Array.from({ length: 80 }, () => status(`/api/engine-proof?challenge=${"1".repeat(64)}`)));
  assert.ok(many.includes(200) && many.includes(429), "a burst of keyless questions is told to wait");
  const session = sessionKey(key, boot);
  const ask = newBoot();
  const answer = await new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/headers", headers: { authorization: `Bearer ${session}`, [askHeader]: ask } }, (response) => {
      let body = ""; response.on("data", (c) => { body += c; }); response.on("end", () => done({ mark: response.headers[answerHeader], body: JSON.parse(body) }));
    });
    req.on("error", fail);
    req.end();
  });
  assert.deepEqual(answer.body, { authorization: `Bearer ${key}`, ask: null }, "the worker gets the window key, and no question it would mark at its own port");
  assert.equal(answer.mark, answerMark(session, ask, port, boot), "the answer carries the mark for the gateway's port");
  const other = sessionKey(key, newBoot());
  assert.equal(JSON.parse((await get(gw.url, "/api/headers", { authorization: `Bearer ${other}` })).body).authorization, `Bearer ${other}`,
    "a key made for another process is passed on as it came, and the engine refuses it");
  const opened = await new Promise((done, fail) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write([`GET /socket HTTP/1.1`, `Host: 127.0.0.1:${port}`, "Connection: Upgrade", "Upgrade: echo", `${askHeader}: ${ask}`,
        `Authorization: Bearer ${session}`, "", ""].join("\r\n"));
    });
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
      if (text.includes("\r\n\r\n") && !text.includes("echo:")) socket.write("ping");
      if (text.includes("echo:ping")) { socket.destroy(); done(text); }
    });
    socket.on("error", fail);
  });
  assert.match(opened, /101 Switching Protocols/);
  assert.ok(opened.includes(`${answerHeader}: ${answerMark(session, ask, port, boot)}\r\n`), "a socket's opening is marked too");
  assert.match(opened, /echo:ping/, "and carried through as before");
});

test("asking the engine to close closes the gateway too, instead of starting it again", async (t) => {
  const { gw, events } = await gateway(t);
  await until(() => events.some((e) => e.kind === "ready"), "the worker");
  const pid = JSON.parse((await get(gw.url, "/api/state")).body).pid;
  assert.equal((await get(gw.url, "/api/deployment/close", { method: "POST" })).status, 200);
  await until(() => !alive(pid), "the worker to close");
  await delay(300);
  assert.equal(gw.restarts, 0, "a close the owner asked for is not a crash");
});

test("a gateway that is killed takes its worker with it, so the database is never left held", async (t) => {
  const { root, dataDir } = await temp(t);
  const child = spawn(process.execPath, [resolve("tests/fixtures/never-break-gateway.mjs"), dataDir],
    { env: cleanEnv(), stdio: ["ignore", "pipe", "inherit"] });
  t.after(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await discardTemp(root); });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  const line = await until(() => out.split("\n").find((l) => l.startsWith("{")), "the gateway's worker");
  const { worker: workerPid } = JSON.parse(line);
  assert.equal(alive(workerPid), true);
  child.kill("SIGKILL");
  await until(() => !alive(workerPid), "the orphaned worker to close itself", 25000);
});

test("the real engine runs behind the gateway and comes back, database and all, after being killed", async (t) => {
  const { root, dataDir } = await temp(t);
  await saveGatewayConfig(dataDir, GatewayConfigSchema.parse({ mode: "on", holdSeconds: 120, startSeconds: 180 }));
  const child = spawn(process.execPath, [resolve("dist/cli.js"), "start"], { stdio: ["ignore", "pipe", "pipe"],
    env: { ...cleanEnv(), BRANCH_DATA_DIR: dataDir, BRANCH_WORKSPACE: join(root, "workspace"), BRANCH_PORT: "0" } });
  t.after(async () => { if (child.exitCode === null) child.kill("SIGKILL"); await delay(500); await discardTemp(root); });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  child.stderr.on("data", (chunk) => { out += chunk; });
  const url = await until(() => /Branch gateway listening at (\S+)/.exec(out)?.[1], "the gateway", 60000);
  const health = async () => JSON.parse((await get(url, "/gateway/health")).body);
  const first = await until(async () => { const h = await health(); return h.worker.state === "ready" && h; }, "the engine", 180000);
  const token = (await readFile(join(dataDir, "session-token"), "utf8")).trim();
  const state = async () => get(url, "/api/state", { authorization: `Bearer ${token}` });
  assert.equal((await state()).status, 200);
  const running = JSON.parse(await readFile(join(dataDir, "running.json"), "utf8"));
  assert.equal(running.pid, child.pid, "the app window joins the gateway, not the engine behind it");

  process.kill(first.worker.pid, "SIGKILL");
  const again = await state();
  assert.equal(again.status, 200, `the engine came back and opened the database again: ${again.body.slice(0, 200)}`);
  const second = await health();
  assert.notEqual(second.worker.pid, first.worker.pid);
  assert.equal(second.restarts, 1);

  child.kill("SIGTERM");
  // On Windows SIGTERM ends the process outright: it has a signal, no exit code, and no chance to tidy up.
  await until(() => child.exitCode !== null || child.signalCode !== null, "the gateway to close", 60000);
  await until(() => !alive(second.worker.pid), "the engine to close with it", 30000);
  if (process.platform !== "win32") await assert.rejects(readFile(join(dataDir, "running.json")), "the running note is cleared");
});

/* ---------- integration review (17 September) ---------- */

import { restoreGood } from "../dist/never-break/gateway-config.js";
import { registerNeverBreak } from "../dist/never-break/api.js";
import { ToolRegistry } from "../dist/registry.js";

test("a suggestion can change only timings, and accepting it keeps the owner's switch and engine settings", async (t) => {
  const { root, dataDir } = await temp(t);
  t.after(() => discardTemp(root));
  const passes = async () => ({ ok: true, detail: "started" });
  await saveGatewayConfig(dataDir, GatewayConfigSchema.parse({ mode: "on", workerEnv: { BRANCH_PROVIDER: "local" } }));
  const proposal = await proposeConfig(dataDir, { holdSeconds: 7, mode: "off", workerEnv: { BRANCH_INTEGRATIONS: "/tmp/evil.json" } }, "sneaky", passes);
  assert.equal(proposal.config.mode, "on", "the switch in a suggestion is ignored");
  assert.deepEqual(proposal.config.workerEnv, { BRANCH_PROVIDER: "local" }, "engine settings in a suggestion are ignored");
  // The owner turns the switch down and drops the engine setting while the suggestion waits.
  await saveGatewayConfig(dataDir, GatewayConfigSchema.parse({ mode: "when-needed" }));
  const accepted = await acceptProposal(dataDir);
  assert.deepEqual([accepted.mode, accepted.workerEnv, accepted.holdSeconds], ["when-needed", {}, 7]);

  const registry = new ToolRegistry();
  registerNeverBreak(registry, dataDir, passes);
  const context = { runId: "r", workspace: root, signal: new AbortController().signal, permissions: new Set(["gateway.propose"]), budget: { step: () => undefined } };
  await assert.rejects(registry.execute("gateway.propose", { change: { workerEnv: { BRANCH_BASH: "/tmp/x" } }, why: "faster" }, context),
    /workerEnv|Unrecognized/, "the tool itself does not take engine settings");
  await assert.rejects(registry.execute("gateway.propose", { change: { mode: "off" }, why: "faster" }, context), /mode|Unrecognized/);
  const said = await registry.execute("gateway.propose", { change: { holdSeconds: 6 }, why: "faster" }, context);
  assert.equal(said.waitingForOwner, true);
});

test("putting the last good settings back never undoes what the owner turned off or removed", async (t) => {
  const { root, dataDir } = await temp(t);
  t.after(() => discardTemp(root));
  const good = GatewayConfigSchema.parse({ mode: "on", startSeconds: 60, workerEnv: { BRANCH_INTEGRATIONS: "/old/integrations.json", BRANCH_PROVIDER: "a" } });
  await promoteGood(dataDir, good);
  const current = GatewayConfigSchema.parse({ mode: "off", startSeconds: 3, workerEnv: { BRANCH_PROVIDER: "a", BRANCH_WORKSPACE: "/new" } });
  await saveGatewayConfig(dataDir, current);
  const restored = await restoreGood(dataDir, "would not start", current);
  assert.equal(restored.restored, true);
  assert.equal(restored.config.mode, "off", "the owner's switch stays");
  assert.equal(restored.config.startSeconds, 60, "the timing that worked comes back");
  assert.deepEqual(restored.config.workerEnv, { BRANCH_PROVIDER: "a" }, "nothing the owner removed comes back; only matching settings stay");
  assert.deepEqual((await loadGatewayConfig(dataDir)).config, restored.config);
  const again = await restoreGood(dataDir, "would not start", restored.config);
  assert.equal(again.restored, false, "restoring twice changes nothing more");
});
