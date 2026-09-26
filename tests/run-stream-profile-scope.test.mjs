/**
 * Q254 (security review): GET /api/runs/:id/stream (SSE) and the run socket /api/runs/:id/ws follow who is at the
 * window, as /api/events/stream does since #339. Each checked the run's owner only when it opened, so a stream or
 * socket opened as the owner on the owner's run kept delivering that run's events after the window switched to a
 * household person. Now, once the window switches, an owner event written after the switch never goes out, and the
 * stream or socket ends by itself with reason "profile". Opening it again as the person is refused (404 / 401); once
 * the window is the owner's again, the owner reopens it and reads their run. Nothing reaches a provider.
 *
 * Mutations that turn this red (each run by hand against a rebuilt dist/, one at a time):
 *  - SSE part: in src/server.ts, drop `{ owner: run.owner, scopeNow: () => app.store.profiles.scope() }` from the
 *    streamRunEvents call on /api/runs/:id/stream (or make `scopeMoved` in streamRunEvents return false). The stream
 *    then delivers "owner.after" to the person's window, failing "no owner event reaches the window on the run stream
 *    after it switched profile".
 *  - WebSocket part: in src/server.ts, drop `owner: run.owner, scopeNow: () => app.store.profiles.scope()` from the
 *    serveRunSocket call in the upgrade handler (or make `inScope` in src/ws.ts return true). The socket then delivers
 *    "owner.after", failing "no owner event reaches the window on the run socket after it switched profile".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-run-stream-profile-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, path, body) => fetch(server.url + path, { method,
    headers: { authorization: "Bearer " + server.token, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));
  const ownerScope = app.store.profiles.scope();
  const ownerRun = app.store.createRun(ownerScope, "OWNER PRIVATE: draft my resignation letter");
  const person = (await call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  const toPerson = async () => {
    assert.equal((await call("POST", "/api/profiles/switch", { profileId: person.id, pin: "2468" })).status, 200);
    assert.notEqual(app.store.profiles.scope(), ownerScope, "the window now files records under the person");
  };
  const toOwner = async () => {
    assert.equal((await call("POST", "/api/profiles/switch", { profileId: null })).status, 200);
    assert.equal(app.store.profiles.scope(), ownerScope);
  };
  return { app, server, ownerRun, toPerson, toOwner };
}

/** Opens the run's SSE stream; `ended` settles when the engine closes it. */
async function openStream(server, runId, t) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${server.url}/api/runs/${runId}/stream`, {
    headers: { authorization: "Bearer " + server.token }, signal: controller.signal });
  const events = [];
  if (response.status !== 200) return { status: response.status, events, ended: Promise.resolve(), kinds: () => [] };
  const ended = (async () => {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        const blocks = (buffer + decoder.decode(value, { stream: true })).split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const kind = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
          if (kind) events.push({ kind, data: data ? JSON.parse(data) : null });
        }
      }
    } catch { /* aborted, or cut when the server closes: either way it has ended */ }
  })();
  return { status: 200, events, ended, kinds: () => events.map((e) => e.kind) };
}

/** Opens the run's socket; `opened` says whether the handshake succeeded, `ended` settles on close. */
async function openSocket(server, runId, t) {
  const socket = new WebSocket(`${server.url.replace(/^http/, "ws")}/api/runs/${runId}/ws`, ["bearer", server.token]);
  t.after(() => socket.close());
  const messages = [];
  let opened = false;
  socket.addEventListener("message", (message) => { messages.push(JSON.parse(String(message.data))); });
  const ended = new Promise((resolve) => socket.addEventListener("close", resolve));
  await Promise.race([new Promise((resolve) => socket.addEventListener("open", () => { opened = true; resolve(); })), ended]);
  return { opened, messages, ended, kinds: () => messages.map((m) => m.kind), close: () => socket.close() };
}

async function until(check, what, ms = 5000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) { if (check()) return; await delay(50); }
  assert.fail("timed out waiting for " + what);
}

test("an open run stream stops carrying the owner's run once the window switches to a household person", async (t) => {
  const { app, server, ownerRun, toPerson, toOwner } = await fixture(t);
  const owners = await openStream(server, ownerRun.id, t);
  assert.equal(owners.status, 200, "the owner opens the stream on their own run");
  app.store.event(ownerRun.id, "owner.before", { note: "OWNER PRIVATE before" });
  await until(() => owners.kinds().includes("owner.before"), "the owner's own event on the owner's stream");

  await toPerson();
  app.store.event(ownerRun.id, "owner.after", { note: "OWNER PRIVATE after the switch" });
  // Four of the stream's 250 ms polls: long enough that an unscoped stream would have sent "owner.after".
  await delay(1000);
  assert.ok(!owners.kinds().includes("owner.after"), "no owner event reaches the window on the run stream after it switched profile");
  await Promise.race([owners.ended, delay(5000).then(() => assert.fail("the owner's run stream stayed open after the switch"))]);
  assert.ok(!owners.kinds().includes("owner.after"));
  assert.deepEqual(owners.events.at(-1), { kind: "end", data: { reason: "profile" } }, "it ended because the window switched profile, and says nothing else about the run");
  assert.doesNotMatch(JSON.stringify(owners.events), /OWNER PRIVATE after/);

  // Reconnecting as the person is refused; back at the owner's profile, the owner reads their run again.
  // Q261: a run's stream is not in householdReads, so it is refused in the one sentence before its route runs.
  assert.equal((await openStream(server, ownerRun.id, t)).status, 400, "the person cannot reopen the owner's run stream");
  await toOwner();
  const again = await openStream(server, ownerRun.id, t);
  assert.equal(again.status, 200);
  await until(() => again.kinds().includes("owner.after"), "the owner's reconnect carrying on with their run");
});

test("an open run socket stops carrying the owner's run and closes once the window switches to a household person", async (t) => {
  const { app, server, ownerRun, toPerson, toOwner } = await fixture(t);
  const owners = await openSocket(server, ownerRun.id, t);
  assert.ok(owners.opened, "the owner opens the socket on their own run");
  app.store.event(ownerRun.id, "owner.before", { note: "OWNER PRIVATE before" });
  await until(() => owners.kinds().includes("owner.before"), "the owner's own event on the owner's socket");

  await toPerson();
  app.store.event(ownerRun.id, "owner.after", { note: "OWNER PRIVATE after the switch" });
  await delay(1000);
  assert.ok(!owners.kinds().includes("owner.after"), "no owner event reaches the window on the run socket after it switched profile");
  await Promise.race([owners.ended, delay(5000).then(() => assert.fail("the owner's run socket stayed open after the switch"))]);
  assert.ok(!owners.kinds().includes("owner.after"));
  assert.deepEqual(owners.messages.at(-1), { kind: "end", reason: "profile" }, "it closed because the window switched profile, and says nothing else about the run");
  assert.doesNotMatch(JSON.stringify(owners.messages), /OWNER PRIVATE after/);

  // Reconnecting as the person is refused at the handshake; back at the owner's profile, the owner reconnects.
  assert.equal((await openSocket(server, ownerRun.id, t)).opened, false, "the person cannot reopen the owner's run socket");
  await toOwner();
  const again = await openSocket(server, ownerRun.id, t);
  assert.ok(again.opened);
  await until(() => again.kinds().includes("owner.after"), "the owner's reconnect carrying on with their run");
  // Closed here, so the server's shutdown does not wait out the socket's own ceiling.
  again.close();
  await again.ended;
});
