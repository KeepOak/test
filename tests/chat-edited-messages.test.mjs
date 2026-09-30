/**
 * Settings › Chat apps › Edited messages beyond Telegram (CHAT-107): a person's edit on Discord (MESSAGE_UPDATE with an
 * edit time), Slack (`message_changed`) and Matrix (`m.replace`) comes back as that message again, marked edited, for
 * the router to answer or leave as the owner chose. A change that left the words as they were (a link unfolding), a
 * bot's own edit, and on Matrix someone else's "edit" of another person's message are not edits. Stand-ins only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DiscordAdapter, SlackAdapter, MatrixAdapter } from "../dist/index.js";

const discordMessage = (extra = {}) => ({ id: "m1", channel_id: "dm1", content: "what is two plus two", author: { id: "u1", username: "sam" },
  mentions: [], attachments: [], ...extra });
test("Discord: an edit with an edit time and new words is the message again, marked edited", async () => {
  const seen = [];
  const discord = new DiscordAdapter({ id: "discord", token: "stand-in", fetch: async () => new Response("{}") });
  const receive = (t, d) => discord.receive(JSON.stringify({ op: 0, t, d, s: 1 }), async (message) => { seen.push(message); });
  await receive("MESSAGE_CREATE", discordMessage());
  await receive("MESSAGE_UPDATE", discordMessage({ edited_timestamp: null }));
  await receive("MESSAGE_UPDATE", discordMessage({ edited_timestamp: "2026-09-28T01:00:00Z" }));
  await receive("MESSAGE_UPDATE", discordMessage({ id: "m1", content: "what is two plus three", edited_timestamp: "2026-09-28T01:00:01Z" }));
  await receive("MESSAGE_UPDATE", discordMessage({ content: "embed only", edited_timestamp: "2026-09-28T01:00:02Z", author: { id: "b", bot: true } }));
  assert.deepEqual(seen.map((one) => [one.text, one.edited === true, one.messageId]),
    [["what is two plus two", false, "m1"], ["what is two plus three", true, "m1"]]);
});

test("Slack: message_changed with new words from a person is the message again, marked edited", () => {
  const seen = [];
  const slack = new SlackAdapter({ id: "slack", token: "stand-in", appToken: "stand-in", apiBase: "http://slack.test/api", fetch: async () => new Response('{"ok":true}') });
  const send = (id, event) => slack.receive(JSON.stringify({ type: "events_api", envelope_id: id, payload: { event_id: id, event } }), async (message) => { seen.push(message); });
  send("e1", { type: "message", channel: "D1", channel_type: "im", user: "U1", text: "draft plan", ts: "1.1" });
  send("e2", { type: "message", subtype: "message_changed", channel: "D1", channel_type: "im",
    message: { type: "message", user: "U1", text: "draft plan", ts: "1.1" } });
  send("e3", { type: "message", subtype: "message_changed", channel: "D1", channel_type: "im",
    message: { type: "message", user: "U1", text: "draft the plan for Friday", ts: "1.1" } });
  send("e4", { type: "message", subtype: "message_changed", channel: "D1", channel_type: "im",
    message: { type: "message", bot_id: "B1", text: "the bot's own edit", ts: "2.2" } });
  assert.deepEqual(seen.map((one) => [one.text, one.edited === true, one.messageId, one.chatKind]),
    [["draft plan", false, "1.1", "direct"], ["draft the plan for Friday", true, "1.1", "direct"]]);
});

test("Matrix: an m.replace by the message's own sender is that message again with the new words", () => {
  const matrix = new MatrixAdapter({ id: "matrix", homeserver: "https://matrix.test", accessToken: "t", userId: "@branch:matrix.test",
    fetch: async () => new Response("{}") });
  const original = matrix.inbound("!room:matrix.test", { type: "m.room.message", event_id: "$orig", sender: "@sam:matrix.test",
    content: { msgtype: "m.text", body: "remind me at 5" } });
  const edit = (sender, target) => matrix.inbound("!room:matrix.test", { type: "m.room.message", event_id: `$e${Math.random()}`, sender,
    content: { msgtype: "m.text", body: "* remind me at 6", "m.new_content": { msgtype: "m.text", body: "remind me at 6" },
      "m.relates_to": { rel_type: "m.replace", event_id: target } } });
  const own = edit("@sam:matrix.test", "$orig");
  assert.deepEqual([own.text, own.edited, own.messageId], ["remind me at 6", true, original.messageId]);
  assert.equal(edit("@mallory:matrix.test", "$orig"), null, "someone else cannot edit Sam's message into a new question");
  assert.equal(edit("@sam:matrix.test", "$never-read"), null, "an edit of a message this adapter never read");
});
