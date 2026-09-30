import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture, last } from "./chat-fixture.mjs";
import { chatPersonality } from "../dist/channels/personality-settings.js";

/* CHAT-202 (owner-approved 2026-09-30): /personality chooses this chat's reply tone, from the owner's own direct chat only.
   The tone is a fixed hint added to that chat's next tasks; other chats keep theirs. */
const system = (request) => request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");

test("the owner's tone reaches this chat's next task and no other chat's", async (t) => {
  const { app, provider, sent, say } = await chatFixture(t);
  await say("owner-1", "/personality concise");
  assert.match(last(sent), /^Reply tone for the next task in this chat: concise\./);
  assert.equal(chatPersonality(app.store, app.runtime.owner, "tg", "dm-owner-1"), "concise");
  await say("owner-1", "what is on today");
  assert.match(system(provider.requests.at(-1)), /Reply tone chosen for this chat[\s\S]*Prefer a short answer\./);
  await say("friend-2", "and for me?");
  assert.doesNotMatch(system(provider.requests.at(-1)), /Reply tone chosen for this chat/);
  await say("owner-1", "/personality off");
  assert.equal(chatPersonality(app.store, app.runtime.owner, "tg", "dm-owner-1"), "none");
});

test("a friend or a group cannot choose a tone, and nothing is saved", async (t) => {
  const { app, say } = await chatFixture(t);
  await say("friend-2", "/personality creative");
  await say("owner-1", "/personality creative", { chatId: "group-1", chatKind: "group" });
  assert.equal(chatPersonality(app.store, app.runtime.owner, "tg", "dm-friend-2"), "none");
  assert.equal(chatPersonality(app.store, app.runtime.owner, "tg", "group-1"), "none");
  assert.equal(app.store.list("settings", app.runtime.owner).some((row) => row.id.startsWith("chat-personality:")), false);
});
