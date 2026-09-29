/**
 * The desktop app's requests to its engine (src/desktop/engine-client.ts): a request, and its body, go only on a
 * connection that proved it reaches the engine process the request is signed for; /api/ requests carry the session key,
 * never the window key; an answer without the engine's mark is refused before its body is read. And the engine's door
 * (src/engine-proof.ts ProofDoor): a keyless asker gets one short proof, never a held connection, and is told to wait
 * when it asks too often; held connections are counted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { answerHeader, answerProof, answerShort, askHeader, isSessionKey, markFor, ProofDoor, proofPath, sessionKey, watchEngine } from "../dist/engine-proof.js";
import { EngineClient } from "../dist/desktop/engine-client.js";

const KEY = "c".repeat(64);
const BOOT = "a".repeat(32);

/**
 * A program at a port. With `engine`, it answers as the engine does (proof, hold, and marks on every answer); `mark`
 * decides the mark it puts on answers ("right", "none" or "wrong"). It records every request, with the bytes of its body.
 */
async function program(t, { engine = true, mark = "right", boot = BOOT, door = new ProofDoor() } = {}) {
  const heard = [];
  const sockets = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const seen = { method: request.method, url: request.url, authorization: request.headers.authorization ?? null, bytes: 0 };
    heard.push(seen);
    request.on("data", (chunk) => { seen.bytes += chunk.length; });
    request.on("end", () => {
      const local = { port: request.socket.localPort, address: request.socket.localAddress };
      if (!engine) { answerShort(response, 200, { proof: "f".repeat(64), boot }); return; } // well formed, with its length: only the proof itself fails
      if (url.pathname === proofPath) {
        if (url.searchParams.get("hold") === "1") {
          const supplied = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
          if (!isSessionKey(supplied, KEY, boot)) { response.writeHead(404).end(); return; }
          if (!door.hold(response)) answerShort(response, 429, {});
          return;
        }
        if (!door.mayAnswer()) { answerShort(response, 429, {}); return; }
        const answer = answerProof(url.searchParams, KEY, local, boot);
        if (!answer) { response.writeHead(404).end(); return; }
        answerShort(response, 200, answer);
        return;
      }
      const right = markFor(request.headers[askHeader], sessionKey(KEY, boot), local, boot);
      if (mark === "right" && right) response.setHeader(answerHeader, right);
      if (mark === "wrong") response.setHeader(answerHeader, "0".repeat(64));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ bytes: seen.bytes, authorization: seen.authorization }));
    });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const stop = () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); });
  t.after(stop);
  return { origin: `http://127.0.0.1:${server.address().port}`, heard, stop, connections: () => sockets.size };
}

const client = (t, origin, boot = BOOT) => {
  const made = new EngineClient({ origin, access: { boot: () => boot }, windowKey: () => KEY });
  t.after(() => made.close());
  return made;
};
const body = "B".repeat(70000);

test("a request goes on a connection proved for its engine process, signed with the session key, and its marked answer is taken", async (t) => {
  const engine = await program(t);
  const engineClient = client(t, engine.origin);
  const answer = await engineClient.fetch(`${engine.origin}/api/echo`, { method: "POST", body, headers: { authorization: `Bearer ${KEY}` } });
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { bytes: body.length, authorization: `Bearer ${sessionKey(KEY, BOOT)}` });
  assert.equal(answer.headers.get(answerHeader), null, "the mark stays in main");
  assert.deepEqual(engine.heard.map((each) => `${each.method} ${new URL(each.url, "http://x").pathname} ${each.authorization === null ? "no key" : "key"}`),
    ["GET /api/engine-proof no key", "POST /api/echo key"], "the proof first, with no key, then the request");
  assert.ok(engine.heard.every((each) => each.authorization !== `Bearer ${KEY}`), "the window key never went out");
  const again = await engineClient.fetch(`${engine.origin}/index.html`);
  assert.equal(again.status, 200);
  assert.equal(engine.heard.at(-1).authorization, null, "a file of the window's is asked for with no key");
  assert.equal(engine.heard.filter((each) => each.url.startsWith(proofPath)).length, 1, "a proved connection is used again");
});

test("nothing, above all no body, is sent to a program that cannot prove itself", async (t) => {
  const squatter = await program(t, { engine: false });
  const engineClient = client(t, squatter.origin);
  await assert.rejects(engineClient.fetch(`${squatter.origin}/api/run`, { method: "POST", body }));
  assert.deepEqual(squatter.heard.map((each) => [each.method, new URL(each.url, "http://x").pathname, each.authorization, each.bytes]),
    [["GET", proofPath, null, 0]], "it was only asked for the proof, with no key and no body");
});

test("a connection proved for another engine process never carries the request", async (t) => {
  const engine = await program(t, { boot: "b".repeat(32) });
  const engineClient = client(t, engine.origin, BOOT);
  await assert.rejects(engineClient.fetch(`${engine.origin}/api/run`, { method: "POST", body }));
  assert.ok(engine.heard.every((each) => each.url.startsWith(proofPath) && each.bytes === 0));
});

test("an answer without the engine's mark, or with a wrong one, is refused", async (t) => {
  for (const mark of ["none", "wrong"]) {
    const engine = await program(t, { mark });
    await assert.rejects(client(t, engine.origin).fetch(`${engine.origin}/api/state`), /did not come from Branch's engine/, mark);
  }
});

test("a request with nothing to sign for (the engine is not proved) is refused before anything is sent", async (t) => {
  const engine = await program(t);
  await assert.rejects(client(t, engine.origin, null).fetch(`${engine.origin}/api/state`), /starting its engine again/);
  assert.deepEqual(engine.heard, []);
  await assert.rejects(client(t, engine.origin).fetch("http://127.0.0.1:1/api/state"), /Only the engine's own address/);
});

test("a keyless asker gets one short proof, never a held connection, and is told to wait when it asks too often", async (t) => {
  let now = 1000;
  const door = new ProofDoor(3, 2, () => now);
  const engine = await program(t, { door });
  const ask = (path, headers = {}) => fetch(`${engine.origin}${path}`, { headers }).then(async (answer) => { await answer.body?.cancel(); return answer.status; });
  const challenge = "1".repeat(64);
  assert.equal(await ask(`${proofPath}?hold=1&challenge=${challenge}`), 404, "no key: no held connection");
  assert.deepEqual([await ask(`${proofPath}?challenge=${challenge}`), await ask(`${proofPath}?challenge=${challenge}`), await ask(`${proofPath}?challenge=${challenge}`)], [200, 200, 200]);
  assert.equal(await ask(`${proofPath}?challenge=${challenge}`), 429, "too many in a second");
  now += 1001;
  assert.equal(await ask(`${proofPath}?challenge=${challenge}`), 200, "and answered again a moment later");
  now += 1001;
  const watches = [watchEngine(engine.origin, KEY), watchEngine(engine.origin, KEY), watchEngine(engine.origin, KEY)];
  t.after(() => { for (const watch of watches) watch.close(); });
  assert.deepEqual(await Promise.all(watches.map((watch) => watch.proved)), [BOOT, BOOT, null], "held connections are counted");
  assert.equal(door.holding, 2);
});
