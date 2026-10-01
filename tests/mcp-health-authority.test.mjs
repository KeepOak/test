import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, McpConnections } from "../dist/index.js";
import { connectorsApi } from "../dist/connectors-api.js";
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-mcp-authority-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  // An existing session stand-in: no opener, tool registration or real account is invoked.
  app.store.save("settings", app.runtime.owner, "mcp-own-servers", { servers: [{ id: "one", name: "One", on: true,
    server: { transport: "stdio", command: "stand-in", args: [], envKeys: [] }, approved: null,
    tools: [], version: null, hidden: [], addedAt: new Date().toISOString() }] });
  const pinged = [], entered = Promise.withResolvers(), released = Promise.withResolvers();
  app.ownMcp.live.set("one", { names: [], close: async () => {}, check: async signal => {
    pinged.push(signal); entered.resolve(signal); await released.promise; signal?.throwIfAborted();
  } });
  return { app, pinged, entered, released };
}

function slowBody() {
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  const request = new EventEmitter(); request.method = "POST"; request.headers = { "content-type": "application/json" };
  request[Symbol.asyncIterator] = async function* () { entered.resolve(); await released.promise; yield Buffer.from("{}"); };
  return { request, entered, released };
}

function revoke(app, what, request) {
  if (what === "lock") app.sessionLock.lock();
  if (what === "profile" || what === "roundtrip") {
    const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
    app.store.profiles.switch({ profileId: person.id, pin: "1234" });
    if (what === "roundtrip") app.store.profiles.switch({ profileId: null });
  }
  if (what === "disconnect") request.emit("aborted");
}

for (const what of ["lock", "profile", "roundtrip", "disconnect"]) test(`a slow health body cannot ping after ${what}`, async t => {
  const f = await fixture(t), body = slowBody();
  const checking = connectorsApi(f.app, body.request, "/api/mcp/servers/one/test");
  const refused = assert.rejects(checking, /authorized|owner|Unlock/);
  await body.entered.promise; revoke(f.app, what, body.request); body.released.resolve();
  await refused;
  assert.equal(f.pinged.length, 0, "no authenticated ping was admitted after authority changed");
  assert.equal(body.request.listenerCount("aborted"), 0, "the request subscription is released");
});

for (const what of ["lock", "profile", "disconnect"]) test(`an existing health ping is cancelled after ${what}`, async t => {
  const f = await fixture(t), body = slowBody(); body.released.resolve();
  const checking = connectorsApi(f.app, body.request, "/api/mcp/servers/one/test");
  const refused = assert.rejects(checking, /authorized|owner|Unlock/);
  const signal = await f.entered.promise; revoke(f.app, what, body.request);
  assert.ok(signal.aborted, "the existing transport receives the revoked request's signal");
  f.released.resolve(); await refused;
  assert.equal(f.pinged.length, 1, "the revoked session is never reacquired or pinged twice");
});

test("an unchanged owner checks only the existing session and gets a liveness receipt", async t => {
  const f = await fixture(t), body = slowBody(); body.released.resolve(); f.released.resolve();
  const result = await connectorsApi(f.app, body.request, "/api/mcp/servers/one/test");
  assert.equal(result.health.ok, true); assert.equal(f.pinged.length, 1);
  assert.ok(!f.pinged[0].aborted);
  assert.equal(body.request.listenerCount("aborted"), 0);
});

test("on-demand health checks forward cancellation without invoking an opener again", async t => {
  const f = await fixture(t), manager = new McpConnections(f.app.store, () => f.app.store.profiles.scope());
  const entered = Promise.withResolvers(), released = Promise.withResolvers(), controller = new AbortController();
  let opens = 0;
  manager.register("one", async () => { opens++; return { close: async () => {}, check: async signal => {
    entered.resolve(signal); await released.promise; signal?.throwIfAborted();
  } }; });
  t.after(() => manager.closeAll());
  await manager.acquire("fixture", "one");
  const checking = manager.check("one", controller.signal), refused = assert.rejects(checking, /Stopped/);
  assert.equal(await entered.promise, controller.signal);
  controller.abort(new Error("Stopped")); released.resolve(); await refused;
  assert.equal(opens, 1);
});
