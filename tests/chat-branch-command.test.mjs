import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture, last } from "./chat-fixture.mjs";

/* CHAT-194: /branch (or /fork) from the owner's own direct chat copies the conversation, and the chat follows the copy;
   the original is kept. From a friend's chat it does nothing. */
const chatSession = (app, chatId) => app.channels.chats(app.runtime.owner).find((chat) => chat.chatId === chatId)?.sessionId;

test("/branch copies this chat's conversation, names it and follows the copy", async (t) => {
  const { app, sent, say } = await chatFixture(t);
  await say("owner-1", "plan a trip to Lisbon");
  const original = chatSession(app, "dm-owner-1");
  app.store.save("settings", app.runtime.owner, `conversation-mode:${original}`, { mode: "ask" });
  await say("owner-1", "/branch --here Porto instead");
  assert.match(last(sent), /^Branched here as "Porto instead"/);
  const copy = chatSession(app, "dm-owner-1");
  assert.ok(copy && copy !== original, "the chat now follows a new conversation");
  const copied = app.store.sessionView(app.runtime.owner, copy).messages.map((m) => m.content);
  assert.ok(copied.includes("plan a trip to Lisbon"), "the copy holds the conversation so far");
  assert.equal(app.store.get("settings", app.runtime.owner, `conversation-mode:${copy}`)?.data.mode, "ask", "its mode is carried");
  assert.equal(app.store.paths.list(app.runtime.owner, copy).paths.find((path) => path.sessionId === copy)?.name, "Porto instead");
  await say("owner-1", "what about trains");
  const next = app.store.runs(app.runtime.owner).find((run) => run.prompt === "what about trains");
  assert.equal(next.sessionId, copy);
  assert.equal(app.store.sessionView(app.runtime.owner, original).messages.some((m) => m.content === "what about trains"), false,
    "the original is left as it was");
});

test("a friend's /branch changes nothing", async (t) => {
  const { app, say } = await chatFixture(t);
  await say("friend-2", "hello");
  const before = chatSession(app, "dm-friend-2");
  await say("friend-2", "/fork mine");
  assert.equal(chatSession(app, "dm-friend-2"), before);
});
