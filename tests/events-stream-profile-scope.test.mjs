/**
 * Q253 (security review): GET /api/events/stream follows who is at the window, as the activity list does since #324.
 * A stream opened as the owner stops once the window switches to a household person: an owner event written after the
 * switch never goes out on it, and it ends (reason "profile") so the window's reconnect opens it again under the new
 * scope. The fresh stream then carries the person's own events and none of the owner's. Nothing reaches a provider.
 *
 * Mutation that turns this red: remove `scopeNow: () => app.store.profiles.scope(),` from the /api/events/stream call
 * in src/server.ts (or make `scopeMoved` in src/streams.ts return false). The owner-opened stream then stays open and
 * delivers "owner.after" to the household person's window, failing "no owner event reaches the window after it
 * switched profile".
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

/** Opens the stream and collects its events; `ended` settles when the engine closes it. */
async function openStream(server, t) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(server.url + "/api/events/stream?maxMs=60000", {
    headers: { authorization: "Bearer " + server.token }, signal: controller.signal });
  assert.equal(response.status, 200);
  const events = [];
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
    } catch { /* aborted, or cut when the server closes at the end: either way it has ended */ }
  })();
  return { events, ended, kinds: () => events.map((e) => e.kind) };
}

async function until(check, what, ms = 5000) {
  const stop = Date.now() + ms;
  while (Date.now() < stop) { if (check()) return; await delay(50); }
  assert.fail("timed out waiting for " + what);
}

test("an open event stream stops carrying the owner's events once the window switches to a household person", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-stream-profile-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, path, body) => fetch(server.url + path, { method,
    headers: { authorization: "Bearer " + server.token, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));

  const ownerScope = app.store.profiles.scope();
  const ownerRun = app.store.createRun(ownerScope, "OWNER PRIVATE: draft my resignation letter");
  const owners = await openStream(server, t);
  await until(() => owners.kinds().includes("ready"), "the owner's stream to open");
  app.store.event(ownerRun.id, "owner.before", { note: "OWNER PRIVATE before" });
  await until(() => owners.kinds().includes("owner.before"), "the owner's own event on the owner's stream");

  const person = (await call("POST", "/api/profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call("POST", "/api/profiles/switch", { profileId: person.id, pin: "2468" })).status, 200);
  const personScope = app.store.profiles.scope();
  assert.notEqual(personScope, ownerScope, "the window now files records under the person");
  app.store.event(ownerRun.id, "owner.after", { note: "OWNER PRIVATE after the switch" });

  // Three of the stream's 500 ms polls: long enough that an owner-scoped stream would have sent "owner.after".
  await delay(1500);
  assert.ok(!owners.kinds().includes("owner.after"), "no owner event reaches the window after it switched profile");
  // The old stream has ended by itself (well inside its 60 s), because the window switched profile.
  await Promise.race([owners.ended, delay(5000).then(() => assert.fail("the owner's stream stayed open after the switch"))]);
  assert.ok(!owners.kinds().includes("owner.after"));
  assert.equal(owners.events.at(-1)?.kind, "end");
  assert.equal(owners.events.at(-1)?.data?.reason, "profile", "it ended because the window switched profile");

  // The window reconnects: the fresh stream is the person's, carries their events, and none of the owner's.
  const theirs = await openStream(server, t);
  await until(() => theirs.kinds().includes("ready"), "the person's stream to open");
  const personRun = app.store.createRun(personScope, "Sam's own task");
  app.store.event(ownerRun.id, "owner.later", { note: "OWNER PRIVATE later" });
  app.store.event(personRun.id, "person.own", { note: "Sam's own event" });
  await until(() => theirs.kinds().includes("person.own"), "the person's own event on the fresh stream");
  assert.ok(!theirs.kinds().some((kind) => kind.startsWith("owner.")), "the fresh stream never carries the owner's events");
  assert.doesNotMatch(JSON.stringify(theirs.events), /OWNER PRIVATE/);
});
