import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture, last } from "./chat-fixture.mjs";
import { TelegramAdapter } from "../dist/channels/telegram.js";

/* CHAT-081: /topic <name> in the owner's own Telegram direct chat makes a private forum topic, which the adapter's topic
   address already keeps as its own conversation. The request is written down first, so an uncertain one is never sent
   twice; a friend's /topic makes nothing. */
test("/topic creates one topic per request, from the owner's own direct chat only", async (t) => {
  const made = [];
  const { sent, say } = await chatFixture(t, { adapter: { async createDirectTopic(chatId, name) { made.push([chatId, name]); return `${chatId}:41`; } } });
  await say("owner-1", "/topic");
  assert.match(last(sent), /^Send \/topic <name> to create a separate Telegram conversation/);
  await say("owner-1", "/topic Holiday plans", { messageId: "m-topic" });
  assert.deepEqual(made, [["dm-owner-1", "Holiday plans"]]);
  assert.match(last(sent), /^Topic created\./);
  // The same Telegram message delivered again (a redelivery after a restart) makes no second topic.
  await say("owner-1", "/topic Holiday plans", { messageId: "m-topic" });
  assert.equal(made.length, 1, "the same request is not sent to Telegram again");
  await say("friend-2", "/topic Mine");
  assert.equal(made.length, 1, "a friend's /topic makes nothing");
});

test("the Telegram adapter checks private chat and topic mode, then names the topic within 120 characters", async () => {
  const calls = [];
  const answers = { getChat: { type: "private" }, getMe: { has_topics_enabled: true }, createForumTopic: { message_thread_id: 41 } };
  const fetch = async (url, init) => {
    const method = url.split("/").at(-1);
    calls.push([method, JSON.parse(init.body)]);
    return new Response(JSON.stringify({ ok: true, result: answers[method] }), { headers: { "content-type": "application/json" } });
  };
  const adapter = new TelegramAdapter({ id: "tg", token: "123:abc", fetch });
  const address = await adapter.createDirectTopic("555", `  ${"x".repeat(130)}  `);
  assert.equal(address.split(":")[0], "555");
  const created = calls.find(([method]) => method === "createForumTopic")[1];
  assert.equal(created.chat_id, 555);
  assert.equal(Array.from(created.name).length, 120);
  answers.getMe = { has_topics_enabled: false };
  await assert.rejects(() => adapter.createDirectTopic("555", "Plans"), /Enable forum topic mode/);
  await assert.rejects(() => adapter.createDirectTopic("-1001", "Plans"), /direct chat/);
});
