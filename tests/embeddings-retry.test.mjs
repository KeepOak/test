/**
 * Q208: documents.test.mjs failed on a slow Windows runner with no embedding request reaching the stand-in service.
 * The service closes a kept-open connection after 5 s idle, and fetch does not send a POST again when the connection
 * it reused was just closed, so the whole batch was lost. A request that fails on the way out is now sent once more;
 * a refusal is not. The service here is a stand-in on this computer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EmbeddingClient } from "../dist/document-embeddings.js";

async function service(t, answer) {
  const seen = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (part) => { body += part; });
    request.on("end", () => { seen.push(JSON.parse(body).input.length); answer(request, response, seen.length); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, endpoint: `http://127.0.0.1:${server.address().port}` };
}
const vectors = (count) => JSON.stringify({ data: Array.from({ length: count }, (_, index) => ({ index, embedding: [1, 0] })) });

test("a request dropped before any answer is sent once more, and the vectors come back", async (t) => {
  const stand = await service(t, (request, response, nth) => {
    if (nth === 1) { request.socket.destroy(); return; } // the connection goes away with no answer
    response.writeHead(200, { "content-type": "application/json" }).end(vectors(2));
  });
  const client = new EmbeddingClient(stand.endpoint, "test-key");
  const got = await client.embed(["one", "two"], AbortSignal.timeout(10000));
  assert.equal(got.length, 2);
  assert.deepEqual(stand.seen, [2, 2], "the same batch was sent a second time");
});

test("a refusal is not sent again", async (t) => {
  const stand = await service(t, (_request, response) => { response.writeHead(500).end('{"error":"no"}'); });
  const client = new EmbeddingClient(stand.endpoint, "test-key");
  await assert.rejects(client.embed(["one"], AbortSignal.timeout(10000)), /refused to read these passages \(500\)/);
  assert.deepEqual(stand.seen, [1], "asked once");
});

test("a request dropped twice fails, so a service that is down is said as down", async (t) => {
  const stand = await service(t, (request) => { request.socket.destroy(); });
  const client = new EmbeddingClient(stand.endpoint, "test-key");
  await assert.rejects(client.embed(["one"], AbortSignal.timeout(10000)), TypeError);
  assert.deepEqual(stand.seen, [1, 1], "asked twice, no more");
});
