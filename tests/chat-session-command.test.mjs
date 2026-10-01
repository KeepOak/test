import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture, last } from "./chat-fixture.mjs";
import { chatThreadLifecycle } from "../dist/channels/thread-lifecycle.js";

/* CHAT-082 (owner-approved 2026-09-30): /session sets this chat's idle and age limits, from the owner's own direct chat
   only; the next ordinary message after a limit starts a fresh conversation and keeps the old one in history. */
const chatSession = (app, chatId) => app.channels.chats(app.runtime.owner).find((chat) => chat.chatId === chatId)?.sessionId;

test("the owner sets an idle limit; once passed, the next message starts afresh and says so", async (t) => {
  const { app, sent, say } = await chatFixture(t);
  await say("owner-1", "first thing");
  const before = chatSession(app, "dm-owner-1");
  await say("owner-1", "/session idle 30m");
  assert.match(last(sent), /This chat: idle 30 minutes; maximum age off\./);
  assert.equal(chatThreadLifecycle(app.store, app.runtime.owner, "tg", "dm-owner-1").idleTimeoutMs, 30 * 60_000);
  await say("owner-1", "still here");
  assert.equal(chatSession(app, "dm-owner-1"), before, "within the limit the conversation carries on");
  // Age the chat's thread past the limit, as if half an hour went by.
  const key = app.store.list("settings", app.runtime.owner).find((row) => row.id.startsWith("channel-session:tg:dm-owner-1")).id;
  const thread = app.store.get("settings", app.runtime.owner, key).data;
  app.store.save("settings", app.runtime.owner, key, { ...thread, updatedAt: new Date(Date.now() - 31 * 60_000).toISOString() });
  app.store.sqlite.prepare("UPDATE sessions SET created_at=? WHERE id=?").run(new Date(Date.now() - 40 * 60_000).toISOString(), before);
  await say("owner-1", "back again");
  assert.notEqual(chatSession(app, "dm-owner-1"), before, "a fresh conversation");
  assert.match(last(sent), /^Started a fresh conversation because this chat reached its idle limit\./);
  assert.ok(app.store.sessionView(app.runtime.owner, before).messages.some((m) => m.content === "first thing"), "the old one is kept");
});

test("a friend or a group cannot set limits, and nothing is saved", async (t) => {
  const { app, say } = await chatFixture(t);
  await say("friend-2", "/session idle 1m");
  assert.equal(chatThreadLifecycle(app.store, app.runtime.owner, "tg", "dm-friend-2").idleTimeoutMs, 0);
  await say("owner-1", "/session idle 1m", { chatId: "group-1", chatKind: "group" });
  assert.equal(chatThreadLifecycle(app.store, app.runtime.owner, "tg", "group-1").idleTimeoutMs, 0);
  assert.equal(app.store.list("settings", app.runtime.owner).some((row) => row.id.startsWith("chat-session-lifecycle:")), false);
});
