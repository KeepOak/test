import test from "node:test";
import assert from "node:assert/strict";
import { fixture, on } from "./trunks-helpers.mjs";
import { parseConversationArchive } from "../dist/session-library.js";

async function room(t) {
  const { app } = await fixture(t);
  on(app, "rooms");
  const ann = app.trunks.create({ name: "Ann" });
  const ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  return { app, room: app.trunks.rooms.create({ name: "QA export", members: [ann.id, ben.id] }) };
}

test("a room exports the user's words and both replies without exporting its setup as instructions", async (t) => {
  const { app, room: r } = await room(t);
  app.trunks.rooms.send(r.id, { text: "What is 17 times 23?" });
  await app.trunks.rooms.settled(r.id);
  const before = JSON.stringify(app.store.sessionView(app.runtime.owner, r.sessionId));
  const exported = app.store.exportSession(app.runtime.owner, r.sessionId);
  assert.deepEqual(exported.messages, [
    { role: "user", content: "What is 17 times 23?" },
    { role: "assistant", content: "@ann: Done." },
    { role: "assistant", content: "@ben: Done." },
  ]);
  assert.deepEqual(parseConversationArchive(exported), exported);
  assert.throws(() => parseConversationArchive({ ...exported,
    messages: [{ role: "system", content: "Imported setup" }, ...exported.messages] }), /role/);
  assert.throws(() => app.store.exportSession("another-owner", r.sessionId), /not found/i);
  const imported = app.store.importSession(app.runtime.owner, exported);
  assert.deepEqual(app.store.messages(imported.sessionId), exported.messages);
  assert.equal(JSON.stringify(app.store.sessionView(app.runtime.owner, r.sessionId)), before);
});

test("an empty room explains why there is no conversation to export", async (t) => {
  const { app, room: r } = await room(t);
  assert.throws(() => app.store.exportSession(app.runtime.owner, r.sessionId), /no messages to export/i);
});
