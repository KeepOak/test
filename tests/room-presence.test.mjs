/**
 * chatlook: who is typing in a room, and who has it open. Kept in memory only, shown only to those the room admits,
 * never to the one typing, never across rooms, and ending by itself.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fixture, on } from "./trunks-helpers.mjs";
import { typingMs, hereMs } from "../dist/trunks/rooms.js";

async function served(t) {
  let closeServer = async () => undefined;
  const made = await fixture({ after: (hook) => t.after(async () => { await closeServer(); await hook(); }) });
  const { startServer } = await import("../dist/server.js");
  const server = await startServer(made.app, { dataDir: join(made.root, "data"), port: 0, host: "127.0.0.1" });
  closeServer = () => server.close();
  const call = async (path, body) => {
    const response = await fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  return { ...made, call };
}

async function twoRooms(t) {
  const made = await served(t);
  const { app, call } = made;
  on(app, "rooms");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  const sam = app.store.profiles.create({ name: "Sam", pin: "1234" });
  const lee = app.store.profiles.create({ name: "Lee", pin: "5678" });
  const a = (await call("/api/trunks/rooms", { name: "Bench", members: [ann.id, ben.id], people: [sam.id] })).body.room;
  const b = (await call("/api/trunks/rooms", { name: "Porch", members: [ann.id, ben.id], people: [sam.id, lee.id] })).body.room;
  const as = (who) => (who ? app.store.profiles.switch({ profileId: who.id, pin: who === sam ? "1234" : "5678" }) : app.store.profiles.switch({ profileId: null }));
  return { ...made, sam, lee, a, b, as };
}

test("a person typing in a room is shown to the others in that room only, and never to themselves", async (t) => {
  const { call, sam, a, b, as } = await twoRooms(t);
  as(sam);
  const typed = await call(`/api/trunks/rooms/${a.id}/typing`, {});
  assert.equal(typed.status, 200);
  assert.equal(typed.body.typing, true);
  const own = await call(`/api/trunks/rooms/${a.id}`);
  assert.deepEqual(own.body.typing, [], "you never see yourself typing");
  assert.ok(own.body.here.some((p) => p.id === sam.id && p.name === "Sam"));

  as(null);
  const seen = await call(`/api/trunks/rooms/${a.id}`);
  assert.deepEqual(seen.body.typing, [{ id: sam.id, name: "Sam" }], "the owner sees Sam typing in the room Sam typed in");
  const other = await call(`/api/trunks/rooms/${b.id}`);
  assert.deepEqual(other.body.typing, [], "another room never shows it");
  assert.ok(!other.body.here.some((p) => p.id === sam.id), "nor that Sam is there");
});

test("the owner typing is shown to a person in the room, and sending ends it", async (t) => {
  const { call, sam, a, as } = await twoRooms(t);
  as(null);
  assert.equal((await call(`/api/trunks/rooms/${a.id}/typing`, {})).status, 200);
  as(sam);
  assert.deepEqual((await call(`/api/trunks/rooms/${a.id}`)).body.typing, [{ id: "owner", name: null }]);
  as(null);
  assert.equal((await call(`/api/trunks/rooms/${a.id}/send`, { text: "(pass)" })).status, 200);
  as(sam);
  assert.deepEqual((await call(`/api/trunks/rooms/${a.id}`)).body.typing, [], "sending ends is typing");
});

test("someone the room does not admit can neither say they are typing nor see who is", async (t) => {
  const { app, call, sam, lee, a, as } = await twoRooms(t);
  as(sam);
  await call(`/api/trunks/rooms/${a.id}/typing`, {});
  as(lee);
  const refused = await call(`/api/trunks/rooms/${a.id}/typing`, {});
  assert.equal(refused.status, 403);
  assert.throws(() => app.trunks.rooms.typing(a.id, lee.id), /only for its members/, "the rooms themselves refuse it too");
  const read = await call(`/api/trunks/rooms/${a.id}`);
  assert.equal(read.status, 403);
  assert.doesNotMatch(JSON.stringify(read.body), /Sam/);
});

test("the body names nobody: any field is refused, so nobody can type as someone else", async (t) => {
  const { call, lee, a, as } = await twoRooms(t);
  as(null);
  const forged = await call(`/api/trunks/rooms/${a.id}/typing`, { profileId: lee.id, name: "Lee" });
  assert.equal(forged.status, 400);
  assert.deepEqual((await call(`/api/trunks/rooms/${a.id}`)).body.typing, []);
});

test("typing and being here end by themselves, and a person taken out of the room stops showing", async (t) => {
  const { app, sam, a } = await twoRooms(t);
  const rooms = app.trunks.rooms, room = () => rooms.get(a.id), now = Date.now();
  rooms.typing(a.id, sam.id, now);
  assert.equal(rooms.presenceFor(room(), null, now + typingMs - 1).typing.length, 1);
  assert.equal(rooms.presenceFor(room(), null, now + typingMs).typing.length, 0, "typing ends after typingMs");
  assert.equal(rooms.presenceFor(room(), null, now + hereMs - 1).here.length, 1);
  assert.equal(rooms.presenceFor(room(), null, now + hereMs).here.length, 0, "being here ends after hereMs");
  rooms.typing(a.id, sam.id, Date.now());
  rooms.edit(a.id, { people: [] });
  const after = rooms.presenceFor(room(), null);
  assert.deepEqual([after.typing, after.here], [[], []], "a person no longer admitted is dropped");
});
