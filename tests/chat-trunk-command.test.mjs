import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture, last } from "./chat-fixture.mjs";

/* CHAT-075: from the owner's own direct chat, /trunk <name> <message> asks one named Trunk once; ordinary messages in
   that chat keep going where they went before. From anybody else it starts nothing. */
const turnOf = (app, runId) => app.store.events(runId).find((event) => event.kind === "trunk.turn")?.data.trunkId;

test("/trunk asks the named Trunk once, lists them bare, and leaves the chat's routing alone", async (t) => {
  const { app, sent, say } = await chatFixture(t);
  app.trunks.setMode("trunks", { mode: "on" });
  const ada = app.trunks.create({ name: "Ada" });
  await app.trunks.introduced();
  await say("owner-1", "/trunk ada plan dinner");
  assert.match(last(sent), /Ada does not answer on tg/, "the Trunk's own chat-app reach still decides");
  app.trunks.edit(ada.id, { reach: { channels: ["tg"], commands: false } });
  await say("owner-1", "hello");
  const before = app.channels.chats(app.runtime.owner).find((chat) => chat.chatId === "dm-owner-1")?.sessionId;
  await say("owner-1", "/trunk");
  assert.match(last(sent), /@ada — Ada/);
  assert.match(last(sent), /\n.+ answers here \(default\)\.$/,"the same reply names which Trunk answers this chat");
  await say("owner-1", "/trunk ada plan dinner");
  assert.equal(last(sent), "@ada: Done.");
  const asked = app.store.runs(app.runtime.owner).find((run) => run.prompt === "plan dinner");
  assert.ok(asked, "the named Trunk ran the request");
  assert.equal(turnOf(app, asked.id), ada.id);
  assert.equal(app.channels.chats(app.runtime.owner).find((chat) => chat.chatId === "dm-owner-1")?.sessionId, before,
    "the chat still carries on its own conversation");
  await say("owner-1", "and again");
  const ordinary = app.store.runs(app.runtime.owner).find((run) => run.prompt === "and again");
  assert.notEqual(turnOf(app, ordinary.id), ada.id, "an ordinary message is not sent to Ada");
});

test("a paired friend's /trunk starts nothing", async (t) => {
  const { app, say } = await chatFixture(t);
  app.trunks.setMode("trunks", { mode: "on" });
  app.trunks.create({ name: "Ada" });
  await app.trunks.introduced();
  await say("friend-2", "/trunk ada read me the owner's notes");
  assert.equal(app.store.runs(app.runtime.owner).some((run) => run.prompt === "read me the owner's notes"), false);
});
