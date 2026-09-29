/**
 * The window's key goes only to a program that proved it is the engine (src/engine-proof.ts): a program that took the
 * engine's port while it restarted gets no key and cannot pass the proof, even by relaying the question to the real
 * engine elsewhere; the window's requests are held until the engine is back (src/desktop/engine-gate.ts,
 * src/desktop/request-hold.ts); and joining a background engine asks for the proof before the key goes out.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { answerHeader, answerMark, answerProof, answerShort, askHeader, engineProof, isSessionKey, markFor, newBoot, newChallenge, ProofDoor, proofHolds, proofPath, proveOnce, sessionKey, watchEngine } from "../dist/engine-proof.js";
import { AnswerCheck } from "../dist/desktop/answer-check.js";
import { EngineGate } from "../dist/desktop/engine-gate.js";
import { RequestHold } from "../dist/desktop/request-hold.js";
import { attachToRunning, writeRunning } from "../dist/install/running.js";

const KEY = "c".repeat(64);
const BOOT = "a".repeat(32);
const OTHER = "d".repeat(64);

/** A program on this computer at a port: `answer(request)` decides what it says; it records every request it gets. */
async function program(t, answer) {
  const heard = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    heard.push({ url: request.url, authorization: request.headers.authorization ?? null });
    answer(request, response);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stop = () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); });
  t.after(stop);
  return { origin: `http://127.0.0.1:${server.address().port}`, port: server.address().port, heard, stop };
}

/**
 * The engine's own answer, as src/server.ts gives it: one short proof to anybody, and the connection held open only
 * for the window's session key, on the connection it has just proved.
 */
const engineAnswer = (key, boot = BOOT, door = new ProofDoor()) => (request, response) => {
  const url = new URL(request.url, "http://x");
  if (url.pathname !== proofPath) { response.writeHead(404).end(); return; }
  if (url.searchParams.get("hold") === "1") {
    const supplied = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
    if (!isSessionKey(supplied, key, boot)) { response.writeHead(404).end(); return; }
    if (!door.hold(response)) answerShort(response, 429, {});
    return;
  }
  if (!door.mayAnswer()) { answerShort(response, 429, {}); return; }
  const answer = answerProof(url.searchParams, key, { port: request.socket.localPort, address: request.socket.localAddress }, boot);
  if (!answer) { response.writeHead(404).end(); return; }
  answerShort(response, 200, answer);
};

test("the proof holds only for the same key, challenge, port and engine process", () => {
  const challenge = newChallenge();
  const proof = engineProof(KEY, challenge, 4000, BOOT);
  assert.equal(proofHolds(proof, KEY, challenge, 4000, BOOT), true);
  assert.equal(proofHolds(proof, OTHER, challenge, 4000, BOOT), false, "another key");
  assert.equal(proofHolds(proof, KEY, newChallenge(), 4000, BOOT), false, "another challenge");
  assert.equal(proofHolds(proof, KEY, challenge, 4001, BOOT), false, "another port");
  assert.equal(proofHolds(proof, KEY, challenge, 4000, newBoot()), false, "another process");
  assert.equal(proofHolds(proof, KEY, challenge, 4000, undefined), false);
  assert.equal(proofHolds(proof.toUpperCase(), KEY, challenge, 4000, BOOT), false);
  assert.equal(proofHolds(undefined, KEY, challenge, 4000, BOOT), false);
  const asked = new URLSearchParams(`challenge=${challenge}`);
  assert.equal(answerProof(new URLSearchParams("challenge=abc"), KEY, { port: 4000, address: "127.0.0.1" }, BOOT), null, "a challenge of the wrong shape");
  assert.equal(answerProof(asked, KEY, { address: "127.0.0.1" }, BOOT), null);
  assert.deepEqual(answerProof(asked, KEY, { port: 4000, address: "127.0.0.1" }, BOOT), { proof, boot: BOOT });
  assert.deepEqual(answerProof(asked, KEY, { port: 4000, address: "::ffff:127.0.0.1" }, BOOT), { proof, boot: BOOT });
  // Asked at another of the engine's addresses, at the same port: no answer a program holding 127.0.0.1 could pass on.
  for (const address of ["::1", "192.168.1.20", "100.64.0.7", "127.0.0.2", undefined])
    assert.equal(answerProof(asked, KEY, { port: 4000, address }, BOOT), null, `asked at ${address}`);
});

test("the window's session key and the engine's marks hold only for one engine process, key, port and request", () => {
  const session = sessionKey(KEY, BOOT);
  assert.match(session, /^[a-f0-9]{64}$/, "the window key's own shape");
  assert.notEqual(session, KEY);
  assert.equal(isSessionKey(session, KEY, BOOT), true);
  assert.equal(isSessionKey(session, KEY, newBoot()), false, "a fresh engine process takes no key made for the one before");
  assert.equal(isSessionKey(session, OTHER, BOOT), false);
  assert.equal(isSessionKey(KEY, KEY, BOOT), false, "the window key is not a session key");
  assert.equal(isSessionKey("", KEY, BOOT), false);
  const ask = newBoot();
  const at = { port: 4000, address: "127.0.0.1" };
  assert.equal(markFor(ask, session, at, BOOT), answerMark(session, ask, 4000, BOOT));
  for (const bad of [undefined, "", "abc", ask.toUpperCase(), `${ask}\r\nx: y`, [ask]]) assert.equal(markFor(bad, session, at, BOOT), null);
  for (const address of ["::1", "192.168.1.20", undefined]) assert.equal(markFor(ask, session, { port: 4000, address }, BOOT), null, `asked at ${address}`);

  const check = new AnswerCheck(4000);
  const mark = (id, key = session, boot = BOOT, port = 4000) => { const asked = check.ask(id, session, BOOT); return answerMark(key, asked, port, boot); };
  const first = mark(1);
  assert.equal(check.holds(1, { [answerHeader]: [first] }), true, "the engine's own answer");
  assert.equal(check.holds(1, { [answerHeader]: [first] }), false, "a request's mark is used once");
  assert.equal(check.holds(2, { "X-Branch-Answer": mark(2) }), true, "in any letter case");
  assert.equal(check.holds(3, {}), false, "no mark");
  assert.equal(check.holds(4, { [answerHeader]: [mark(4, OTHER)] }), false, "another key");
  assert.equal(check.holds(5, { [answerHeader]: [mark(5, session, newBoot())] }), false, "another engine process");
  assert.equal(check.holds(6, { [answerHeader]: [mark(6, session, BOOT, 4001)] }), false, "another port");
  const again = mark(7);
  assert.equal(check.holds(7, { [answerHeader]: [again, again] }), false, "two marks");
  const twice = mark(10);
  assert.equal(check.holds(10, { [answerHeader]: [twice], "X-Branch-Answer": [twice] }), false, "two marks under two spellings");
  check.ask(8, session, BOOT);
  assert.equal(check.holds(8, { [answerHeader]: [mark(9)] }), false, "another request's mark");
  assert.equal(check.holds(99, { [answerHeader]: ["0".repeat(64)] }), false, "a request never asked");
  const small = new AnswerCheck(4000, 3);
  for (let id = 0; id < 10; id += 1) small.ask(id, session, BOOT);
  assert.equal(small.open, 3, "requests whose answers never came are let go of");
});

test("the real engine proves itself, and the connection ends the moment it stops", async (t) => {
  const engine = await program(t, engineAnswer(KEY));
  const watch = watchEngine(engine.origin, KEY);
  assert.equal(await watch.proved, BOOT, "it names its process");
  assert.deepEqual(engine.heard.map((each) => each.authorization), [null, `Bearer ${sessionKey(KEY, BOOT)}`],
    "the question carries no key; the hold, on the same proved connection, only the session key");
  let ended = false;
  void watch.ended.then(() => { ended = true; });
  await engine.stop();
  await watch.ended;
  assert.equal(ended, true);
});

test("a program that took the engine's port cannot prove itself and never sees the key", async (t) => {
  const squatter = await program(t, (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`${JSON.stringify({ proof: "e".repeat(64) })}\n`);
  });
  assert.equal(await proveOnce(squatter.origin, KEY), null);
  const silent = await program(t, () => undefined);
  assert.equal(await proveOnce(silent.origin, KEY, 200), null, "one that never answers");
  assert.ok([...squatter.heard, ...silent.heard].every((each) => each.authorization === null));
  assert.equal(await proveOnce("http://10.0.0.5:4000", KEY), null, "never anywhere but this computer");
  assert.equal(await proveOnce("https://127.0.0.1:4000", KEY), null);
});

test("passing the question on to the real engine at another port does not pass the proof", async (t) => {
  const real = await program(t, engineAnswer(KEY));
  const relay = await program(t, (request, response) => {
    const onward = httpRequest(`${real.origin}${request.url.replace("hold=1", "hold=0")}`, (answer) => {
      response.writeHead(answer.statusCode, answer.headers);
      answer.pipe(response);
    });
    onward.end();
  });
  assert.equal(await proveOnce(real.origin, KEY), BOOT, "the real engine, asked at its own port");
  assert.equal(await proveOnce(relay.origin, KEY), null, "the same answer, relayed from another port");
});

test("the gate holds the window's requests until the engine proves itself, and again after it stops", async (t) => {
  const engine = await program(t, engineAnswer(KEY));
  const port = engine.port;
  const gate = new EngineGate({ origin: engine.origin, key: () => KEY, retryMs: () => 20 });
  t.after(() => gate.stop());
  const hold = new RequestHold(gate, 10000);
  const answers = [];
  hold.when((go) => answers.push(go));
  assert.deepEqual(answers, [], "held before the proof");
  assert.equal(gate.boot(), null, "no engine process before the proof");
  gate.start();
  assert.equal(await gate.whenReady(5000), true);
  assert.equal(gate.boot(), BOOT, "the proved engine's process");
  assert.deepEqual(answers, [true], "let go once it is proved");
  // The engine stops: requests are held again, and a program on the free port gets nothing it can use.
  await engine.stop();
  while (gate.ready()) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.boot(), null, "nothing to sign for once it has stopped");
  hold.when((go) => answers.push(go));
  assert.equal(hold.held, 1);
  // A program that takes the port the engine left is never let through, and never sees the key.
  const squatter = await programAt(t, port, (request, response) => {
    response.writeHead(200).end(`${JSON.stringify({ proof: "f".repeat(64) })}\n`);
  });
  while (squatter.heard.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(gate.ready(), false);
  assert.equal(hold.held, 1, "still held");
  assert.ok(squatter.heard.every((authorization) => authorization === null));
  await squatter.stop();
  // Back at the same port: proved again, and the held request goes on.
  await programAt(t, port, engineAnswer(KEY));
  assert.equal(await gate.whenReady(5000), true);
  assert.deepEqual(answers, [true, true]);
});

test("the gate gives nothing to sign with while the app's own engine is not serving at the window's address", async (t) => {
  const engine = await program(t, engineAnswer(KEY));
  let serving = true;
  const gate = new EngineGate({ origin: engine.origin, key: () => KEY, also: () => serving, retryMs: () => 20 });
  t.after(() => gate.stop());
  gate.start();
  assert.equal(await gate.whenReady(5000), true);
  assert.equal(gate.boot(), BOOT);
  serving = false; // main saw it go, before its connection said so
  assert.equal(gate.ready(), false);
  assert.equal(gate.boot(), null);
});

test("an engine whose connection ends as soon as it has proved itself is asked again after a growing wait", async (t) => {
  // It proves itself, then drops the connection at once, again and again (an engine failing as it starts).
  const flaky = await program(t, (request, response) => {
    engineAnswer(KEY)(request, response);
    if (request.url.includes("hold=1")) setImmediate(() => request.socket.destroy());
  });
  const waits = [];
  const gate = new EngineGate({ origin: flaky.origin, key: () => KEY, retryMs: (attempt) => { waits.push(attempt); return 5; } });
  t.after(() => gate.stop());
  gate.start();
  const until = Date.now() + 5000;
  while (waits.length < 4 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
  gate.stop();
  assert.deepEqual(waits.slice(0, 4), [0, 1, 2, 3], "each quick end waits longer than the last, never a tight loop");
  assert.ok(flaky.heard.length <= 2 * (waits.length + 1), `asked ${flaky.heard.length} times for ${waits.length} waits (a proof and a hold each)`);
});

/** A program at a given port (the one an engine just left); `heard` holds the authorization of each request. */
async function programAt(t, port, answer) {
  const heard = [];
  const server = createServer((request, response) => { heard.push(request.headers.authorization ?? null); answer(request, response); });
  const sockets = new Set();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const stop = () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); });
  t.after(stop);
  return { heard, stop };
}

test("a held request is refused after waiting too long", async () => {
  const never = { ready: () => false, onReady: () => () => undefined, onLost: () => () => undefined };
  const hold = new RequestHold(never, 30);
  const answer = await new Promise((resolve) => hold.when(resolve));
  assert.equal(answer, false);
  assert.equal(hold.held, 0);
});

test("joining a background engine asks for the proof first, and sends no key when it fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-engine-proof-"));
  t.after(() => discardTemp(root));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "session-token"), KEY);
  await writeRunning(root, { port: 45678, pid: process.pid, url: "http://127.0.0.1:45678", mode: "daemon", version: "1.0.0" });
  const fetched = [];
  const fetch = async (url, init) => { fetched.push([url, init.headers.authorization]); return new Response(JSON.stringify({ version: "1.0.0" })); };
  const asked = [];
  assert.equal(await attachToRunning(root, { fetch, prove: async (url, key) => { asked.push([url, key === KEY]); return null; } }), null);
  assert.deepEqual(asked, [["http://127.0.0.1:45678", true]]);
  assert.deepEqual(fetched, [], "no request carried the key");
  const session = sessionKey(KEY, BOOT);
  const joined = await attachToRunning(root, { fetch, prove: async () => session });
  assert.equal(joined?.url, "http://127.0.0.1:45678");
  assert.deepEqual(fetched, [["http://127.0.0.1:45678/api/state", `Bearer ${session}`]], "only the session key went out, never the window key");
});
