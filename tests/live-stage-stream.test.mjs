/* SCREEN-015: the task's live browser view is pushed as it paints (NDJSON), rather than polled twice a second. A paint
   only wakes the stream; the picture sent is always the separately masked frame from watch(). One stream per
   conversation, and it ends when the conversation stops being readable. A stand-in browser; no page is opened. */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { streamLiveStage } from "../dist/live-stage-stream.js";

async function world(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-live-stream-"));
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d") });
  const run = app.store.createRun(app.store.profiles.scope(), "open a page");
  let shown = 1, paint = null, readable = true;
  const browser = {
    async watch() { return { url: "https://example.org/a", title: "A", tabs: [], frame: Buffer.from([0xff, 0xd8, shown]), borrowed: false }; },
    async paintWake(_owner, _runId, _signal, painted) { paint = painted; return { close: async () => { paint = null; }, current: () => true }; },
  };
  const deps = { store: app.store, owner: "local", profiles: app.store.profiles, browser };
  const server = createServer((request, response) => {
    streamLiveStage(deps, run.sessionId, response, () => readable).catch((error) => { response.writeHead(409); response.end(error.message); });
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); server.close(); await app.close(); await discardTemp(root); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  return { url, repaint: (n) => { shown = n; paint?.(); }, painting: () => !!paint, close: () => { readable = false; } };
}
async function lines(response) {
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffered = "";
  return async function next(timeout = 3000) {
    const deadline = Date.now() + timeout;
    while (!buffered.includes("\n")) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error("no line in time");
      const part = await Promise.race([reader.read(), new Promise((done) => setTimeout(() => done({ timeout: true }), left))]);
      if (part.timeout) throw new Error("no line in time");
      if (part.done) return null;
      buffered += decoder.decode(part.value, { stream: true });
    }
    const at = buffered.indexOf("\n"), line = buffered.slice(0, at);
    buffered = buffered.slice(at + 1);
    return JSON.parse(line);
  };
}

test("SCREEN-015: a paint pushes the new masked frame at once, and one conversation has one stream", async (t) => {
  const w = await world(t);
  const response = await fetch(w.url);
  assert.equal(response.headers.get("content-type"), "application/x-ndjson");
  const next = await lines(response);
  const first = await next();
  assert.equal(first.browser.frame, `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 1]).toString("base64")}`);
  assert.equal(w.painting(), true, "the page's paints wake the stream");
  const second = await fetch(w.url);
  assert.equal(second.status, 409, "a second stream for the same conversation is refused");
  const asked = Date.now();
  w.repaint(2);
  const pushed = await next();
  assert.equal(pushed.browser.frame, `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 2]).toString("base64")}`);
  assert.ok(Date.now() - asked < 900, "pushed on the paint, not on a half-second poll or the one-second heartbeat");
  w.close();
  assert.equal(await next(), null, "the stream ends once the conversation is no longer readable");
});
