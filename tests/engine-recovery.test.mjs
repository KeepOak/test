import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { engineHealthy } from "../dist/desktop/engine-health.js";
import { EnginePage } from "../dist/desktop/engine-page.js";
import { answerProof, answerShort, newBoot } from "../dist/engine-proof.js";

const key = "a".repeat(64);

test("engine health requires a signed proof and a working database, including after key rotation", async (t) => {
  let token = key, valid = true, heard = 0;
  const boot = newBoot();
  const server = createServer((request, response) => {
    heard++;
    const answer = answerProof(new URL(request.url, "http://localhost").searchParams, token,
      { port: request.socket.localPort, address: request.socket.localAddress }, boot);
    answerShort(response, 200, valid ? answer : { proof: "0".repeat(64), boot });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(done); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await engineHealthy(() => {}, origin, key), true);
  valid = false;
  assert.equal(await engineHealthy(() => {}, origin, key), false, "an unrelated 200 cannot keep a broken engine alive");
  valid = true;
  token = "b".repeat(64);
  assert.equal(await engineHealthy(() => {}, origin, key), false);
  assert.equal(await engineHealthy(() => {}, origin, token), true);
  const before = heard;
  assert.equal(await engineHealthy(() => { throw new Error("database closed"); }, origin, token), false);
  assert.equal(heard, before, "a failed database never asks the listener");
});

function page() {
  let ready = false, missing = true, loads = 0;
  const events = {};
  const access = { ready: () => ready, onReady: (fn) => { events.ready = fn; }, onLost: (fn) => { events.lost = fn; } };
  const recovery = new EnginePage(access, () => missing, () => loads++);
  return { recovery, events, get loads() { return loads; }, ready(value = true) { ready = value; }, missing(value) { missing = value; } };
}

test("a failed initial page is retried after the first proof even if no onLost fired", () => {
  const p = page();
  p.recovery.failed();
  assert.equal(p.loads, 0);
  p.ready(); p.events.ready();
  assert.equal(p.loads, 1);
  p.events.ready();
  assert.equal(p.loads, 1, "no duplicate retry");
});

test("a proof arriving before the cancellation is also recovered, without reloading a healthy page", () => {
  const p = page();
  p.ready(); p.events.ready();
  assert.equal(p.loads, 0, "the normal first navigation stays in progress");
  p.recovery.failed();
  assert.equal(p.loads, 1);
  p.missing(false); p.events.lost(); p.events.ready();
  assert.equal(p.loads, 1, "a loaded page keeps its draft and scroll");
});
