/**
 * The engine's own ask that has a new Trunk introduce itself is marked on the saved message
 * (Message.system = "trunk-intro"), so the window hides it by the marker and never by its words.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fixture, on } from "./trunks-helpers.mjs";

test("a new Trunk's introduce-yourself ask is saved with the trunk-intro marker; the owner's words are not", async (t) => {
  const { app } = await fixture(t);
  on(app);
  const trunk = app.trunks.create({ name: "Ada" });
  await app.trunks.introduced();
  const owner = app.runtime.owner;
  const first = app.store.sessionView(owner, trunk.chatSessionId).messages.find((m) => m.role === "user");
  assert.equal(first.system, "trunk-intro", "the engine's ask carries the marker the window hides by");
  const reply = app.store.messages(trunk.chatSessionId).find((m) => m.role === "assistant");
  assert.equal(reply.system, undefined, "the Trunk's hello is its own words and stays unmarked");

  await app.runtime.run({ prompt: "What can you do?", sessionId: trunk.chatSessionId });
  const users = app.store.messages(trunk.chatSessionId).filter((m) => m.role === "user");
  assert.equal(users.length, 2);
  assert.equal(users[1].system, undefined, "a message the owner sends is never marked");
});

test("a marked Trunk conversation still exports and imports, keeping the marker", async (t) => {
  const { app } = await fixture(t);
  on(app);
  const trunk = app.trunks.create({ name: "Bo" });
  await app.trunks.introduced();
  const owner = app.runtime.owner;
  const archive = app.store.exportSession(owner, trunk.chatSessionId);
  const imported = app.store.importSession(owner, archive);
  const sessionId = imported.sessionId ?? imported.id;
  const first = app.store.messages(sessionId).find((m) => m.role === "user");
  assert.equal(first.system, "trunk-intro");
});
