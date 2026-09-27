// The first task within two minutes: the sign-ins have to work every time. ChatGPT's device sign-in rides out a
// network blip, a 5xx and a 429, stops cleanly when the window is closed, and says each failure in plain words with
// one next step; an account already signed in is used as it is. Claude Code's own sign-in starts with one click, is
// reused when the program is already signed in, and stops when the window goes back.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, ChatGPTAuth, FileTokenVault } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { checkProgram, startProgramSignIn, stopProgramSignIn, programLoginArgs } from "../dist/accounts/sign-ins.js";
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

test("the Ollama address is 127.0.0.1:11434 unless BRANCH_OLLAMA_URL moves it, and only on this computer", () => {
  assert.equal(ollamaAddress(""), "http://127.0.0.1:11434");
  assert.equal(ollamaAddress("http://127.0.0.1:3814"), "http://127.0.0.1:3814");
  assert.throws(() => ollamaAddress("http://example.com:11434"), /not on this computer/);
  assert.throws(() => ollamaAddress("http://user:pw@127.0.0.1:3814"), /plain/);
});
