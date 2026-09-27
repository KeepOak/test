/**
 * The desktop engine runs in a process of its own so nothing it does can freeze the window. These check the boundary
 * between the two without Electron: what main accepts from the engine (only the expected shapes, only a loopback
 * address, only a key of the right form, only the requests it offers), how it restarts an engine that stopped by
 * itself and never one it stopped, and the real engine process run under Node (its test hook exists only when main
 * says so, and a busy engine is really busy).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { fork } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discardTemp } from "./temp-dir.mjs";
import { EngineHost } from "../dist/desktop/engine-host.js";
import { EngineConfigSchema, FromEngineSchema, ToEngineSchema } from "../dist/desktop/engine-link.js";

const KEY = "a".repeat(64);
const OTHER_KEY = "b".repeat(64);
const config = (overrides = {}) => ({
  dataDir: "C:/data", workspace: "C:/work", providerEnv: null, version: "0.0.0", executable: null, installRoot: null,
  packaged: false, loginItem: null, appPid: 1234, testHooks: false, ...overrides,
});

/** A stand-in for Electron's UtilityProcess. */
class Child extends EventEmitter {
  constructor(pid) { super(); this.pid = pid; this.posted = []; this.killed = false; }
  postMessage(message) { this.posted.push(message); this.emit("posted", message); }
  kill() { this.killed = true; queueMicrotask(() => this.emit("exit", 1)); return true; }
  say(message) { this.emit("message", message); }
}

function hostWith(options = {}) {
  const children = [];
  const forked = new EventEmitter();
  const lines = [];
  const host = new EngineHost({
    fork: () => { const child = new Child(100 + children.length); children.push(child); forked.emit("child", child); return child; },
    config: config(), handlers: {}, log: (line) => lines.push(line), ...options,
  });
  return { host, children, forked, lines };
}
const nextPost = (child) => once(child, "posted").then(([message]) => message);
/** Says `message` as the engine and resolves with main's next message back (some answers go out at once). */
const answerTo = (child, message) => { const next = nextPost(child); child.say(message); return next; };

test("main hands the engine its settings only in the start message, and the shapes are strict", () => {
  const { host, children } = hostWith();
  void host.start().catch(() => undefined);
  assert.deepEqual(children[0].posted, [{ kind: "start", config: config() }]);
  assert.equal(EngineConfigSchema.safeParse({ ...config(), extra: 1 }).success, false, "no field main did not name");
  assert.equal(ToEngineSchema.safeParse({ kind: "start", config: config(), extra: 1 }).success, false);
  assert.equal(FromEngineSchema.safeParse({ kind: "ready", url: "http://127.0.0.1:4000", token: KEY, extra: 1 }).success, false);
  void host.end(0);
});

test("main takes the engine's address only on this computer and its key only in the right form", async () => {
  const { host, children, lines } = hostWith();
  const started = host.start();
  const child = children[0];
  for (const url of ["http://10.0.0.5:4000", "https://127.0.0.1:4000", "http://127.0.0.1:4000/x", "http://127.0.0.1.example.com:80", "http://localhost:4000"])
    child.say({ kind: "ready", url, token: KEY });
  for (const token of [KEY.toUpperCase(), KEY.slice(1), `${KEY}0`, 42])
    child.say({ kind: "ready", url: "http://127.0.0.1:4000", token });
  child.say({ kind: "reply", id: 1, ok: true, stolen: true });
  assert.equal(host.running, false, "nothing of the wrong shape counts as ready");
  assert.equal(lines.filter((line) => /unexpected shape/.test(line)).length, 10);
  child.say({ kind: "ready", url: "http://127.0.0.1:4000", token: KEY });
  assert.equal(await started, "http://127.0.0.1:4000");
  assert.equal(host.token, KEY);
  child.say({ kind: "key", token: "not-a-key" });
  assert.equal(host.token, KEY, "a key of the wrong form is ignored");
  child.say({ kind: "key", token: OTHER_KEY });
  assert.equal(host.token, OTHER_KEY, "a new window key is used for the next signed request");
  child.say({ kind: "event", name: "running", args: 3 });
  child.say({ kind: "event", name: "running", args: "3; rm" });
  assert.equal(host.lastRunning, 3);
  await host.end(1000);
});

test("an engine that never says it is ready is ended and the start refused", async () => {
  const { host, children } = hostWith({ startMs: 50 });
  await assert.rejects(host.start(), /did not start in time/);
  assert.equal(children[0].killed, true);
});

test("the engine may ask main only for what main offers, and a bad request is refused, not obeyed", async () => {
  const asked = [];
  const { host, children } = hostWith({ handlers: {
    "vault-read": (args) => { asked.push(args); return { found: true }; },
    "vault-write": () => { throw new Error("Refused: not a sign-in"); },
  } });
  const started = host.start();
  const child = children[0];
  child.say({ kind: "ready", url: "http://127.0.0.1:4000", token: KEY });
  await started;
  assert.deepEqual(await answerTo(child, { kind: "call", id: 7, method: "vault-read", args: { x: 1 } }), { kind: "reply", id: 7, ok: true, value: { found: true } });
  assert.deepEqual(await answerTo(child, { kind: "call", id: 8, method: "safe-storage-decrypt", args: "secret" }), { kind: "reply", id: 8, ok: false, error: 'Unknown request "safe-storage-decrypt"' });
  assert.deepEqual(await answerTo(child, { kind: "call", id: 9, method: "vault-write", args: { accessToken: 1 } }), { kind: "reply", id: 9, ok: false, error: "Refused: not a sign-in" });
  child.say({ kind: "call", id: 10, method: "vault-read", extra: true });
  child.say({ kind: "call", id: -1, method: "vault-read" });
  child.say({ kind: "call", id: 11, method: "x".repeat(41) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.posted.length, 4, "a request of the wrong shape gets no answer at all");
  assert.deepEqual(asked, [{ x: 1 }]);
  await host.end(1000);
});

test("a question the engine never answers is refused in time, and one open when it stops is refused at once", async () => {
  const { host, children } = hostWith();
  const started = host.start();
  children[0].say({ kind: "ready", url: "http://127.0.0.1:4000", token: KEY });
  await started;
  await assert.rejects(host.call("running-count", undefined, 30), /No answer to "running-count" within 30 ms/);
  const open = host.call("running-count", undefined, 60000);
  children[0].emit("exit", 9);
  await assert.rejects(open, /The engine stopped/);
  await host.end(0);
});

test("an engine that stops by itself is started again; one main stopped is not", async () => {
  const back = [];
  const gone = [];
  const { host, children, forked } = hostWith({ onBack: (url) => back.push(url), onGone: (code) => gone.push(code) });
  const started = host.start();
  children[0].say({ kind: "ready", url: "http://127.0.0.1:4000", token: KEY });
  await started;
  const again = once(forked, "child");
  children[0].emit("exit", 3);
  assert.deepEqual(gone, [3]);
  assert.equal(host.running, false);
  assert.equal(host.servingAt, null, "while it is down, the window's address is not the engine's (nothing is sent there)");
  const [second] = await again;
  assert.deepEqual(second.posted, [{ kind: "start", config: config() }], "the same settings again");
  second.say({ kind: "ready", url: "http://127.0.0.1:4000", token: OTHER_KEY });
  while (!back.length) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(back, ["http://127.0.0.1:4000"]);
  assert.equal(host.servingAt, "http://127.0.0.1:4000");
  assert.equal(host.token, OTHER_KEY);
  // Stopped by main: asked to stop, it closes, and nothing starts again.
  const asked = nextPost(second);
  const stopping = host.stop(5000);
  const ask = await asked;
  assert.equal(ask.method, "stop");
  second.say({ kind: "reply", id: ask.id, ok: true, value: true });
  second.emit("exit", 0);
  await stopping;
  assert.deepEqual(gone, [3], "an engine main stopped is not started again (a restart says so at once)");
  assert.equal(children.length, 2);
});

test("ending the engine waits until it has gone, but never longer than asked", async () => {
  const { host, children } = hostWith();
  void host.start().catch(() => undefined);
  await host.end(5000);
  assert.equal(children[0].killed, true);
  const stuck = hostWith();
  void stuck.host.start().catch(() => undefined);
  stuck.children[0].kill = () => true; // it never exits
  const began = Date.now();
  await stuck.host.end(80);
  assert.ok(Date.now() - began < 2000);
});

/* ---------- the real engine process, under Node ---------- */

const engineEntry = fileURLToPath(new URL("./fixtures/engine-in-node.mjs", import.meta.url));

async function realEngine(t, overrides = {}, answers = {}) {
  const home = await mkdtemp(join(tmpdir(), "branch-engine-host-"));
  const child = fork(engineEntry, [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "local"), BRANCH_PROVIDER: "demo" },
  });
  const messages = new EventEmitter();
  child.on("message", (message) => messages.emit(message.kind, message));
  // What main answers: no ChatGPT sign-in is saved; nothing else is asked of it here.
  const offered = { "vault-read": () => null, ...answers };
  messages.on("call", (call) => child.send(call.method in offered ? { kind: "reply", id: call.id, ok: true, value: offered[call.method](call.args) }
    : { kind: "reply", id: call.id, ok: false, error: `Unknown request "${call.method}"` }));
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, "exit"); }
    await discardTemp(home);
  });
  let id = 0;
  const ask = async (method, args) => {
    const mine = ++id;
    child.send({ kind: "call", id: mine, method, ...(args === undefined ? {} : { args }) });
    for (;;) { const [reply] = await once(messages, "reply"); if (reply.id === mine) return reply; }
  };
  const ready = once(messages, "ready");
  child.send({ kind: "start", config: config({ dataDir: join(home, "state"), workspace: join(home, "work"), appPid: process.pid, ...overrides }) });
  const [hello] = await ready;
  assert.equal(FromEngineSchema.safeParse(hello).success, true);
  return { child, hello, ask, messages };
}

test("the engine process starts, answers with its signed key, and has no test hook unless main asks for one", { timeout: 120000 }, async (t) => {
  const { child, hello, ask } = await realEngine(t);
  const state = await fetch(`${hello.url}/api/state`, { headers: { authorization: `Bearer ${hello.token}` } });
  assert.equal(state.status, 200);
  assert.equal((await fetch(`${hello.url}/api/state`)).status, 401, "not without the key");
  assert.deepEqual(await ask("test-block", { ms: 10 }), { kind: "reply", id: 1, ok: false, error: 'Unknown request "test-block"' });
  assert.deepEqual(await ask("running-count"), { kind: "reply", id: 2, ok: true, value: 0 });
  const exited = once(child, "exit");
  assert.equal((await ask("stop")).ok, true);
  assert.deepEqual(await exited, [0, null], "it closes its server and database and ends");
});

test("with the test hook main asked for, a blocked engine really is blocked", { timeout: 120000 }, async (t) => {
  const { hello, ask } = await realEngine(t, { testHooks: true });
  const began = Date.now();
  const blocked = ask("test-block", { ms: 1500 });
  const state = await fetch(`${hello.url}/api/state`, { headers: { authorization: `Bearer ${hello.token}` } });
  const waited = Date.now() - began;
  assert.equal(state.status, 200);
  assert.equal((await blocked).ok, true);
  assert.ok(waited >= 1300, `the engine answered only after the block (${waited} ms)`);
});

test("an engine back at another address is not taken for the window's own", async () => {
  const back = [];
  const { host, children, forked } = hostWith({ onBack: (url) => back.push(url) });
  const started = host.start();
  children[0].say({ kind: "ready", url: "http://127.0.0.1:4000", token: KEY });
  await started;
  const again = once(forked, "child");
  children[0].emit("exit", 1);
  const [second] = await again;
  second.say({ kind: "ready", url: "http://127.0.0.1:4001", token: KEY });
  while (!back.length) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(host.url, "http://127.0.0.1:4000", "the window's address");
  assert.equal(host.servingAt, "http://127.0.0.1:4001", "is not where the engine answers now, so main starts the app again");
  await host.end(1000);
});

test("a Mac login item change reports what main made of it, not a guess", { timeout: 120000 }, async (t) => {
  const asked = [];
  const { hello } = await realEngine(t, { executable: join(tmpdir(), "Branch Agent"), loginItem: { enabled: false, needsApproval: false } },
    { "login-item-set": (args) => { asked.push(args); return { enabled: true, needsApproval: true }; } });
  const response = await fetch(`${hello.url}/api/deployment/autostart`, { method: "POST",
    headers: { authorization: `Bearer ${hello.token}`, "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) });
  const view = await response.json();
  assert.equal(response.status, 200, JSON.stringify(view));
  assert.deepEqual(asked, [{ enabled: true }]);
  assert.equal(view.enabled, true);
  assert.equal(view.needsApproval, true, "the approval the Mac asks for is said at once");
  assert.ok(view.settingsLink, "with the way to System Settings");
});
