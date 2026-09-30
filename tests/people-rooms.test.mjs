import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { brain, on } from "./trunks-helpers.mjs";
import { setLockdown } from "../dist/lockdown.js";

/* TRUNK-079: a household person seated in a room reads and writes it from their own device, and only that room. */
test("a seated person lists, reads and writes only their own rooms, until their key is revoked", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-people-rooms-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: brain() });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (method, path, key, body) => {
    const response = await fetch(server.url + path, { method,
      headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  assert.equal((await call("POST", "/api/people/settings", server.token, { mode: "on" })).status, 200);
  on(app, "rooms");
  const sam = app.store.profiles.create({ name: "Sam", pin: "1234" });
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  const seated = app.trunks.rooms.create({ name: "Kitchen", members: [ann.id, ben.id], people: [sam.id] });
  const other = app.trunks.rooms.create({ name: "Owner only", members: [ann.id, ben.id] });
  const { key } = app.people.keys.issue(sam.id, 60, "pin", "test");

  const listed = await call("GET", "/api/people/rooms", key);
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.rooms.map((room) => room.name), ["Kitchen"]);
  assert.equal(listed.body.capped, false);
  assert.notEqual((await call("GET", `/api/people/rooms/${other.id}`, key)).status, 200, "a room without a seat is refused");
  assert.notEqual((await call("POST", `/api/people/rooms/${other.id}/message`, key, { text: "hello" })).status, 200);

  const sent = await call("POST", `/api/people/rooms/${seated.id}/message`, key, { text: "@ann what is for dinner?" });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  await app.trunks.rooms.settled(seated.id);
  const view = await call("GET", `/api/people/rooms/${seated.id}`, key);
  assert.equal(view.status, 200);
  const said = view.body.messages.find((message) => message.role === "user");
  assert.deepEqual([said.who, said.content], ["Sam", "@ann what is for dinner?"]);
  assert.ok(view.body.messages.some((message) => message.role === "assistant" && message.who === "Ann"), "Ann's answer is shown");

  setLockdown(app.store, app.runtime.owner, { on: true });
  assert.notEqual((await call("GET", "/api/people/rooms", key)).status, 200, "Lockdown closes rooms to other devices");
  assert.notEqual((await call("POST", `/api/people/rooms/${seated.id}/message`, key, { text: "still here?" })).status, 200);
  setLockdown(app.store, app.runtime.owner, { on: false });
  assert.equal((await call("GET", "/api/people/rooms", key)).status, 200);

  app.people.keys.revokeAll(sam.id);
  assert.equal((await call("GET", "/api/people/rooms", key)).status, 401, "a revoked key reaches no room");
});
