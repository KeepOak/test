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
import { answerProof, engineProof, newChallenge, proofHolds, proofPath, proveOnce, watchEngine } from "../dist/engine-proof.js";
import { EngineGate } from "../dist/desktop/engine-gate.js";
import { RequestHold } from "../dist/desktop/request-hold.js";
import { attachToRunning, writeRunning } from "../dist/install/running.js";

const KEY = "c".repeat(64);
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

/** The engine's own answer, as src/server.ts gives it: it holds the connection when asked to. */
const engineAnswer = (key) => (request, response) => {
  const url = new URL(request.url, "http://x");
  const answer = url.pathname === proofPath ? answerProof(url.searchParams, key, { port: request.socket.localPort, address: request.socket.localAddress }) : null;
  if (!answer) { response.writeHead(404).end(); return; }
  response.writeHead(200, { "content-type": "application/json" });
  response.write(`${JSON.stringify(answer)}\n`);
  if (url.searchParams.get("hold") !== "1") response.end();
};

test("the proof holds only for the same key, challenge and port", () => {
  const challenge = newChallenge();
  const proof = engineProof(KEY, challenge, 4000);
  assert.equal(proofHolds(proof, KEY, challenge, 4000), true);
  assert.equal(proofHolds(proof, OTHER, challenge, 4000), false, "another key");
  assert.equal(proofHolds(proof, KEY, newChallenge(), 4000), false, "another challenge");
  assert.equal(proofHolds(proof, KEY, challenge, 4001), false, "another port");
  assert.equal(proofHolds(proof.toUpperCase(), KEY, challenge, 4000), false);
  assert.equal(proofHolds(undefined, KEY, challenge, 4000), false);
  const asked = new URLSearchParams(`challenge=${challenge}`);
  assert.equal(answerProof(new URLSearchParams("challenge=abc"), KEY, { port: 4000, address: "127.0.0.1" }), null, "a challenge of the wrong shape");
  assert.equal(answerProof(asked, KEY, { address: "127.0.0.1" }), null);
  assert.deepEqual(answerProof(asked, KEY, { port: 4000, address: "127.0.0.1" }), { proof });
  assert.deepEqual(answerProof(asked, KEY, { port: 4000, address: "::ffff:127.0.0.1" }), { proof });
  // Asked at another of the engine's addresses, at the same port: no answer a program holding 127.0.0.1 could pass on.
  for (const address of ["::1", "192.168.1.20", "100.64.0.7", "127.0.0.2", undefined])
    assert.equal(answerProof(asked, KEY, { port: 4000, address }), null, `asked at ${address}`);
});

test("the real engine proves itself, and the connection ends the moment it stops", async (t) => {
  const engine = await program(t, engineAnswer(KEY));
  const watch = watchEngine(engine.origin, KEY);
  assert.equal(await watch.proved, true);
  assert.deepEqual(engine.heard.map((each) => each.authorization), [null], "the question carries no key");
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
  assert.equal(await proveOnce(squatter.origin, KEY), false);
  const silent = await program(t, () => undefined);
  assert.equal(await proveOnce(silent.origin, KEY, 200), false, "one that never answers");
  assert.ok([...squatter.heard, ...silent.heard].every((each) => each.authorization === null));
  assert.equal(await proveOnce("http://10.0.0.5:4000", KEY), false, "never anywhere but this computer");
  assert.equal(await proveOnce("https://127.0.0.1:4000", KEY), false);
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
  assert.equal(await proveOnce(real.origin, KEY), true, "the real engine, asked at its own port");
  assert.equal(await proveOnce(relay.origin, KEY), false, "the same answer, relayed from another port");
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
  gate.start();
  assert.equal(await gate.whenReady(5000), true);
  assert.deepEqual(answers, [true], "let go once it is proved");
  // The engine stops: requests are held again, and a program on the free port gets nothing it can use.
  await engine.stop();
  while (gate.ready()) await new Promise((resolve) => setImmediate(resolve));
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

test("an engine whose connection ends as soon as it has proved itself is asked again after a growing wait", async (t) => {
  // It proves itself, then drops the connection at once, again and again (an engine failing as it starts).
  const flaky = await program(t, (request, response) => {
    engineAnswer(KEY)(request, response);
    setImmediate(() => request.socket.destroy());
  });
  const waits = [];
  const gate = new EngineGate({ origin: flaky.origin, key: () => KEY, retryMs: (attempt) => { waits.push(attempt); return 5; } });
  t.after(() => gate.stop());
  gate.start();
  const until = Date.now() + 5000;
  while (waits.length < 4 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
  gate.stop();
  assert.deepEqual(waits.slice(0, 4), [0, 1, 2, 3], "each quick end waits longer than the last, never a tight loop");
  assert.ok(flaky.heard.length <= waits.length + 1, `asked ${flaky.heard.length} times for ${waits.length} waits`);
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
  assert.equal(await attachToRunning(root, { fetch, prove: async (url, key) => { asked.push([url, key === KEY]); return false; } }), null);
  assert.deepEqual(asked, [["http://127.0.0.1:45678", true]]);
  assert.deepEqual(fetched, [], "no request carried the key");
  const joined = await attachToRunning(root, { fetch, prove: async () => true });
  assert.equal(joined?.url, "http://127.0.0.1:45678");
  assert.equal(fetched.length, 1);
});
