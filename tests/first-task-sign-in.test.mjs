// The first task within two minutes: the sign-ins have to work every time. ChatGPT's device sign-in rides out a
// network blip, a 5xx and a 429, stops cleanly when the window is closed, and says each failure in plain words with
// one next step; an account already signed in is used as it is. Claude Code's own sign-in starts with one click, is
// reused when the program is already signed in, and stops when the window goes back.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, ChatGPTAuth, FileTokenVault } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { checkProgram, startProgramSignIn, stopProgramSignIn, programLoginArgs, startLogin } from "../dist/accounts/sign-ins.js";
import { setLockdown } from "../dist/lockdown.js";
import { hereOnly } from "../dist/remote/window-key.js";
import { deviceExpired, deviceUnreachable, deviceStartRefusal, devicePollRefusal } from "../dist/chatgpt-auth.js";
import { ollamaAddress } from "../dist/local-models.js";

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "none" })}.${b64(claims)}.sig`;
const json = (status, body = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const code = () => json(200, { user_code: "ABCD-EFGH", device_auth_id: "dev_1", interval: 5, expires_in: 900 });
const tokens = () => json(200, { access_token: jwt({ n: 1 }), refresh_token: "r1", id_token: jwt({ email: "p@example.com" }), expires_in: 3600 });

/** A scripted OpenAI: `polls` is what each poll answers in turn ("throw" is a network failure); then approval. */
async function scripted(t, { start = code, polls = [], clock, hold = false, cleanup = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "first-task-signin-"));
  if (cleanup) t.after(() => discardTemp(root));
  const seen = { polls: 0, waits: [], approve: !hold };
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/accounts/deviceauth/usercode") return start();
    if (path === "/api/accounts/deviceauth/token") {
      const next = polls[seen.polls++];
      if (next === "throw") throw new TypeError("fetch failed");
      if (typeof next === "number") return json(next);
      if (!seen.approve) return json(404);
      return json(200, { authorization_code: "c1", code_verifier: "v1" });
    }
    if (path === "/oauth/token") return tokens();
    return json(404);
  };
  let now = Date.now();
  const sleep = async (ms, signal) => {
    seen.waits.push(ms);
    if (clock) now += ms;
    await new Promise((resolve) => setImmediate(resolve));
    signal?.throwIfAborted();
  };
  const auth = new ChatGPTAuth(new FileTokenVault(join(root, "auth.json")), { issuer: "https://auth.example", fetch, sleep, now: () => now });
  return { auth, seen, root };
}

test("a network blip, a 5xx and a 429 while waiting do not end the sign-in; a 429 asks less often", async (t) => {
  const { auth, seen } = await scripted(t, { polls: [404, "throw", 503, 429, 403] });
  await auth.startDeviceLogin();
  const status = await auth.waitForDeviceLogin();
  assert.equal(status.signedIn, true);
  assert.equal(status.lastError, null);
  assert.equal(seen.polls, 6);
  assert.deepEqual(seen.waits, [5000, 5000, 5000, 5000, 10000, 10000], "after the 429 it waits five seconds longer");
});

test("each way the device sign-in fails is said in plain words, with one next step", async (t) => {
  for (const [status, words] of [[404, /Device code authorization.*Settings > Security.*then try again/], [429, /Wait a minute and try again/],
    [502, /not answering right now \(HTTP 502\)\. Wait a minute/], [400, /could not start \(HTTP 400\)\. Try again/]]) {
    const { auth } = await scripted(t, { start: () => json(status) });
    await assert.rejects(auth.startDeviceLogin(), (error) => words.test(error.message));
    assert.equal(deviceStartRefusal(status), (await auth.startDeviceLogin().catch((e) => e)).message);
  }
  const offline = await scripted(t, { start: () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(offline.auth.startDeviceLogin(), { message: deviceUnreachable });
  // Four network failures in a row while waiting.
  const lost = await scripted(t, { polls: ["throw", "throw", "throw", "throw"] });
  await lost.auth.startDeviceLogin();
  await assert.rejects(lost.auth.waitForDeviceLogin(), { message: deviceUnreachable });
  assert.equal((await lost.auth.status()).lastError, deviceUnreachable, "the window reads it from the status");
  assert.equal((await lost.auth.status()).pending, null);
  // Declined, or a 5xx that does not clear.
  const declined = await scripted(t, { polls: [404, 410] });
  await declined.auth.startDeviceLogin();
  await assert.rejects(declined.auth.waitForDeviceLogin(), { message: devicePollRefusal(410) });
  assert.match(devicePollRefusal(410), /Try again for a new code/);
  const down = await scripted(t, { polls: [500, 500, 500, 500] });
  await down.auth.startDeviceLogin();
  await assert.rejects(down.auth.waitForDeviceLogin(), { message: devicePollRefusal(500) });
  // The code runs out.
  const slow = await scripted(t, { polls: Array(400).fill(404), clock: true });
  await slow.auth.startDeviceLogin();
  await assert.rejects(slow.auth.waitForDeviceLogin(), { message: deviceExpired });
  assert.match(deviceExpired, /Try again for a new code/);
});

test("cancel stops the wait, drops the code and leaves no error; a new start gets its own wait", async (t) => {
  const { auth, seen } = await scripted(t, { hold: true });
  await auth.startDeviceLogin();
  const waiting = auth.waitForDeviceLogin();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const after = await auth.cancelDeviceLogin();
  await assert.rejects(waiting, /stopped/);
  assert.equal(after.pending, null);
  assert.equal(after.lastError, null, "a cancel is not an error");
  const polled = seen.polls;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen.polls, polled, "nothing is asked of OpenAI after the cancel");
  // Started again: a fresh code and a fresh wait, which the old cancel does not touch.
  seen.approve = true;
  await auth.startDeviceLogin();
  assert.equal((await auth.waitForDeviceLogin()).signedIn, true);
});

test("over HTTP: signed in already means no new code; cancel is the owner's and answers with the status", async (t) => {
  const { auth, root } = await scripted(t, { hold: true, cleanup: false });
  const app = await createBranch({ workspace: join(root, "ws"), dataDir: join(root, "data"), chatgpt: auth });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const closing = [];
  t.after(async () => { for (const close of closing.reverse()) await close(); await discardTemp(root); });
  closing.push(() => app.close(), () => server.close());
  const call = async (path, body) => {
    const response = await fetch(server.url + "/api/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + server.token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const started = await call("chatgpt/login", {});
  assert.equal(started.data.userCode, "ABCD-EFGH");
  assert.equal((await call("chatgpt/status")).data.pending.userCode, "ABCD-EFGH");
  const cancelled = await call("chatgpt/cancel", {});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.pending, null);
  assert.equal(cancelled.data.lastError, null);
  assert.equal((await call("chatgpt/cancel", { extra: 1 })).status, 400, "the body is strict");
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  assert.ok((await call("chatgpt/cancel", {})).status >= 400, "a household person cannot stop the owner's sign-in");
  assert.ok((await call("chatgpt/login", {})).status >= 400, "nor start one");
  app.store.profiles.switch({ profileId: null });
  // Signed in (here, by writing the vault as a finished sign-in would).
  await new FileTokenVault(join(root, "auth.json")).write({ accessToken: jwt({ n: 1 }), refreshToken: "r1", expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  const fresh = new ChatGPTAuth(new FileTokenVault(join(root, "auth.json")), { issuer: "https://auth.example" });
  const again = await createBranch({ workspace: join(root, "ws2"), dataDir: join(root, "data2"), chatgpt: fresh });
  const server2 = await startServer(again, { dataDir: join(root, "data2"), port: 0 });
  closing.push(() => again.close(), () => server2.close());
  const response = await fetch(server2.url + "/api/chatgpt/login", { method: "POST", headers: { authorization: "Bearer " + server2.token, "content-type": "application/json" }, body: "{}" });
  assert.deepEqual(await response.json(), { signedIn: true });
});

test("Claude Code: one click starts its own sign-in, is reused when signed in, and stops on Back", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "first-task-cli-"));
  const app = await createBranch({ workspace: join(root, "ws"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const service = accountsServiceFor(app.runtime.models);
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; });
  for (const name of ["claude", "claude.cmd"]) await writeFile(join(root, name), "", { mode: 0o755 });
  process.env.PATH = root;
  assert.deepEqual(programLoginArgs["claude-code"], ["auth", "login"]);
  let signedIn = false;
  const status = async () => ({ code: signedIn ? 0 : 1, missing: false });
  const started = [];
  let finish = null, killed = 0;
  const launch = (row, args, env, done) => { started.push([row.command, ...args]); finish = done; return () => { killed++; done(null, false); }; };
  // Signed in already: nothing is started.
  signedIn = true;
  assert.equal((await startProgramSignIn({ service }, { id: "claude-code" }, status, launch)).signedIn, true);
  assert.equal(started.length, 0);
  // Not signed in: the program's own sign-in starts, once.
  signedIn = false;
  const first = await startProgramSignIn({ service }, { id: "claude-code" }, status, launch);
  assert.deepEqual(started, [["claude", "auth", "login"]]);
  assert.equal(first.signingIn, true);
  assert.match(first.message, /opened its sign-in page in your browser.*claude auth login/);
  await startProgramSignIn({ service }, { id: "claude-code" }, status, launch);
  assert.equal(started.length, 1, "a second click while it runs starts nothing more");
  // It finishes by itself: the status says signed in.
  signedIn = true;
  finish(0, false);
  assert.equal((await checkProgram({ service }, { id: "claude-code" }, status)).signedIn, true);
  // It ends without signing in: said plainly, with one next step.
  signedIn = false;
  await startProgramSignIn({ service }, { id: "claude-code" }, status, launch);
  finish(1, false);
  const failed = await checkProgram({ service }, { id: "claude-code" }, status);
  assert.equal(failed.signingIn, undefined);
  assert.match(failed.message, /sign-in ended without signing in \(exit 1\)\. Press Sign in to try again/);
  // Back stops the one that is running.
  await startProgramSignIn({ service }, { id: "claude-code" }, status, launch);
  await stopProgramSignIn({ service }, { id: "claude-code" });
  assert.equal(killed, 1);
  assert.equal((await checkProgram({ service }, { id: "claude-code" }, status)).signingIn, undefined);
  await assert.rejects(startProgramSignIn({ service }, { id: "gemini-cli" }, status, launch), /Sign in to it yourself in a terminal/);
});

/** An engine with nothing on its PATH, so no coding assistant is ever really started whatever a route decides. */
async function emptyPathEngine(t) {
  const root = await mkdtemp(join(tmpdir(), "first-task-guard-"));
  const saved = process.env.PATH;
  process.env.PATH = join(root, "bin-empty");
  const app = await createBranch({ workspace: join(root, "ws"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { process.env.PATH = saved; await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body, key = server.token, headers = {}) => {
    const response = await fetch(server.url + "/api/" + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  return { app, server, call };
}

test("under Lockdown a coding assistant's sign-in is not started; checking and stopping stay open", async (t) => {
  const { call } = await emptyPathEngine(t);
  const open = await call("accounts/sign-ins/start", { id: "claude-code" });
  assert.equal(open.status, 200, "with Lockdown off the route answers");
  assert.equal(open.data.installed, false, "nothing is on PATH, so nothing was started");
  assert.equal((await call("lockdown", { on: true })).status, 200);
  const refused = await call("accounts/sign-ins/start", { id: "claude-code" });
  assert.equal(refused.status, 409, JSON.stringify(refused.data));
  assert.equal(refused.data.error, `Lockdown is on, so Branch does not start Claude Code's sign-in. Turn Lockdown off in Settings to allow this again, or run "claude auth login" in a terminal.`);
  assert.equal((await call("accounts/sign-ins/start", { id: "codex" })).status, 409);
  const checked = await call("accounts/sign-ins/check", { id: "claude-code" });
  assert.equal(checked.status, 200);
  assert.equal(checked.data.installed, false);
  assert.equal((await call("accounts/sign-ins/stop", { id: "claude-code" })).status, 200);
  assert.equal((await call("lockdown", { on: false })).status, 200);
  const again = await call("accounts/sign-ins/start", { id: "claude-code" });
  assert.equal(again.status, 200, "Lockdown off again, it answers again");
  assert.equal(again.data.installed, false);
});

test("a coding assistant's sign-in starts only from this computer's window; short-lived keys and household people are refused", async (t) => {
  const { app, server, call } = await emptyPathEngine(t);
  const beyond = { "x-branch-tunnel": "1" };
  assert.equal((await call("accounts/sign-ins", undefined, server.token, beyond)).status, 200, "the key is let in from beyond this computer");
  const door = await call("accounts/sign-ins/start", { id: "claude-code" }, server.token, beyond);
  assert.equal(door.status, 403, JSON.stringify(door.data));
  assert.equal(door.data.error, hereOnly);
  const checked = await call("accounts/sign-ins/check", { id: "claude-code" }, server.token, beyond);
  assert.equal(checked.status, 200, "checking stays open");
  assert.equal(checked.data.installed, false);
  assert.equal((await call("accounts/sign-ins/stop", { id: "claude-code" }, server.token, beyond)).status, 200, "stopping stays open");
  const short = (await call("tokens", { scope: "run", minutes: 5 })).data.token;
  assert.ok(short, "a short-lived key was made");
  for (const path of ["accounts/sign-ins/start", "accounts/sign-ins/stop"])
    assert.ok((await call(path, { id: "claude-code" }, short)).status >= 400, `a short-lived key is refused ${path}`);
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  for (const path of ["accounts/sign-ins/start", "accounts/sign-ins/stop"])
    assert.ok((await call(path, { id: "claude-code" })).status >= 400, `a household person is refused ${path}`);
  app.store.profiles.switch({ profileId: null });
  const here = await call("accounts/sign-ins/start", { id: "claude-code" });
  assert.equal(here.status, 200, "the owner's window on this computer is not refused");
  assert.equal(here.data.installed, false);
});

test("the sign-in, and only the sign-in, can reach the desktop and the chosen browser; keys never pass", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "first-task-env-"));
  const app = await createBranch({ workspace: join(root, "ws"), dataDir: join(root, "data") });
  const service = accountsServiceFor(app.runtime.models);
  const names = ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "BROWSER", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "PATH"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(async () => {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await app.close(); await discardTemp(root);
  });
  for (const name of ["claude", "claude.cmd"]) await writeFile(join(root, name), "", { mode: 0o755 });
  Object.assign(process.env, { PATH: root, DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    XDG_RUNTIME_DIR: "/run/user/1000", BROWSER: "firefox", ANTHROPIC_API_KEY: "sk-ant-secret", OPENAI_API_KEY: "sk-secret" });
  const statusEnvs = [];
  const status = async (_row, _args, env) => { statusEnvs.push(env); return { code: 1, missing: false }; };
  let loginEnv = null;
  const launch = (_row, _args, env) => { loginEnv = env; return () => undefined; };
  await startProgramSignIn({ service }, { id: "claude-code", account: "0a1b2c3d" }, status, launch);
  t.after(() => stopProgramSignIn({ service }, { id: "claude-code", account: "0a1b2c3d" }));
  assert.ok(loginEnv, "the sign-in was started");
  assert.deepEqual([loginEnv.DISPLAY, loginEnv.WAYLAND_DISPLAY, loginEnv.DBUS_SESSION_BUS_ADDRESS, loginEnv.XDG_RUNTIME_DIR, loginEnv.BROWSER],
    [":0", "wayland-0", "unix:path=/run/user/1000/bus", "/run/user/1000", "firefox"]);
  assert.equal(loginEnv.ANTHROPIC_API_KEY, undefined);
  assert.equal(loginEnv.OPENAI_API_KEY, undefined);
  assert.equal(loginEnv.CLAUDE_CONFIG_DIR, service.homeOf("cli-claude-code", "0a1b2c3d"), "the extra account keeps its own folder");
  assert.ok(statusEnvs.length > 0);
  for (const env of statusEnvs) {
    assert.equal(env.DISPLAY, undefined, "the status command gets no desktop");
    assert.equal(env.BROWSER, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  }
});

test("the Ollama address is 127.0.0.1:11434 unless BRANCH_OLLAMA_URL moves it, and only on this computer", () => {
  assert.equal(ollamaAddress(""), "http://127.0.0.1:11434");
  assert.equal(ollamaAddress("http://127.0.0.1:3814"), "http://127.0.0.1:3814");
  assert.throws(() => ollamaAddress("http://example.com:11434"), /not on this computer/);
  assert.throws(() => ollamaAddress("http://user:pw@127.0.0.1:3814"), /plain/);
});

/** An engine with "claude" on its PATH (an empty file: the status and sign-in are stand-ins) and its accounts service. */
async function withClaude(t) {
  const root = await mkdtemp(join(tmpdir(), "first-task-minor-"));
  const app = await createBranch({ workspace: join(root, "ws"), dataDir: join(root, "data") });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await app.close(); } };
  const saved = process.env.PATH;
  t.after(async () => { process.env.PATH = saved; await close(); await discardTemp(root); });
  for (const name of ["claude", "claude.cmd"]) await writeFile(join(root, name), "", { mode: 0o755 });
  process.env.PATH = root;
  const status = async () => ({ code: 1, missing: false });
  const launched = { count: 0, killed: 0 };
  const launch = (_row, _args, _env, done) => { launched.count++; return () => { launched.killed++; done(null, false); }; };
  return { app, root, close, service: accountsServiceFor(app.runtime.models), status, launch, launched };
}

test("switching Lockdown on stops a coding assistant's sign-in that is running, and says why", async (t) => {
  const { app, service, status, launch, launched } = await withClaude(t);
  const other = await withClaude(t);
  const running = await startProgramSignIn({ service }, { id: "claude-code" }, status, launch);
  assert.equal(running.signingIn, true);
  // Lockdown on another engine in the same process leaves this one alone.
  setLockdown(other.app.store, other.app.runtime.owner, { on: true });
  assert.equal(launched.killed, 0);
  setLockdown(app.store, app.runtime.owner, { on: true });
  assert.equal(launched.killed, 1, "the sign-in program was stopped");
  const after = await checkProgram({ service }, { id: "claude-code" }, status);
  assert.equal(after.signingIn, undefined);
  assert.equal(after.message, `Lockdown was switched on, so Branch stopped Claude Code's sign-in. Turn Lockdown off in Settings to sign in again, or run "claude auth login" in a terminal.`);
  await assert.rejects(startProgramSignIn({ service }, { id: "claude-code" }, status, launch), /Lockdown is on/);
  assert.equal(launched.count, 1, "nothing new starts under Lockdown");
  // Once it has ended, switching Lockdown off and on again stops nothing more.
  setLockdown(app.store, app.runtime.owner, { on: false });
  setLockdown(app.store, app.runtime.owner, { on: true });
  assert.equal(launched.killed, 1);
});

test("Lockdown switched on while the status command runs: the sign-in is not started", async (t) => {
  const { app, service, launch, launched } = await withClaude(t);
  const status = async () => { setLockdown(app.store, app.runtime.owner, { on: true }); return { code: 1, missing: false }; };
  await assert.rejects(startProgramSignIn({ service }, { id: "claude-code" }, status, launch), /Lockdown is on/);
  assert.equal(launched.count, 0);
});

test("closing the engine stops every sign-in program it started", async (t) => {
  const { service, status, launch, launched, close } = await withClaude(t);
  await startProgramSignIn({ service }, { id: "claude-code" }, status, launch);
  await startProgramSignIn({ service }, { id: "claude-code", account: "0a1b2c3d" }, status, launch);
  assert.equal(launched.count, 2);
  await close();
  assert.equal(launched.killed, 2);
});

test("the sign-in program is given no input: a program that waits on it ends at once", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "first-task-stdin-"));
  t.after(() => discardTemp(root));
  // Ends with 7 when its input ends, and otherwise waits; a stand-in for a sign-in that asks for Enter.
  const script = "process.stdin.on('end', () => process.exit(7)); process.stdin.resume();\n";
  if (process.platform === "win32") {
    await writeFile(join(root, "fake-cli.js"), script);
    await writeFile(join(root, "claude.cmd"), '@"%dp0%\\fake-cli.js" %*\r\n');
  } else {
    await writeFile(join(root, "claude"), "#!/usr/bin/env node\n" + script);
    await chmod(join(root, "claude"), 0o755);
  }
  const env = { PATH: [root, dirname(process.execPath)].join(delimiter), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  let kill = () => undefined;
  const ended = await new Promise((resolve) => {
    const guard = setTimeout(() => { kill(); resolve("still waiting on its input"); }, 15_000);
    kill = startLogin({ id: "claude-code", name: "Claude Code", command: "claude" }, ["auth", "login"], env, (code, missing) => { clearTimeout(guard); resolve({ code, missing }); });
  });
  assert.deepEqual(ended, { code: 7, missing: false });
});

test("an extra ChatGPT account's sign-in is stopped only for an account in the list", async (t) => {
  const { call } = await emptyPathEngine(t);
  assert.equal((await call("accounts/settings", { mode: "on" })).status, 200);
  const refused = await call("accounts/chatgpt/cancel", { account: "0a1b2c3d" });
  assert.equal(refused.status, 404, JSON.stringify(refused.data));
  assert.equal(refused.data.error, "That ChatGPT account is not in the list.");
  assert.equal((await call("accounts/chatgpt/login", { account: "0a1b2c3d" })).status, 404, "as starting one is");
});
