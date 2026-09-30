import test from "node:test";
import assert from "node:assert/strict";
import { TelegramAdapter } from "../dist/channels/telegram.js";

/* CHAT-022: polls, forwarded messages and stickers arrive as words the task can read; a forward's origin is quoted as
   context, never as the sender, and a static sticker comes as a picture. */
const adapter = new TelegramAdapter({ id: "tg", token: "fake", fetch: async () => { throw new Error("no network"); } });
const base = (extra) => ({ message_id: 3, chat: { id: 5, type: "private" }, from: { id: 7, first_name: "Owner" }, ...extra });

test("a poll becomes a read-only snapshot with its votes", () => {
  const got = adapter.inbound(base({ poll: { id: "p", question: "Lunch?", options: [{ text: "Soup", voter_count: 2 }, { text: "Salad", voter_count: 1 }],
    total_voter_count: 3, type: "regular", is_anonymous: true, allows_multiple_answers: false, is_closed: false } }));
  assert.ok(got, "a poll with no text is still a message");
  assert.match(got.text, /^\[Poll snapshot\] "Lunch\?"\n1\. "Soup" — 2 votes\n2\. "Salad" — 1 vote\nTotal voters: 3/);
  assert.equal(got.senderId, "7");
});

test("a forwarded message says who it was forwarded from, as quoted context", () => {
  const got = adapter.inbound(base({ text: "meet at 6", forward_origin: { type: "user", date: 1, sender_user: { id: 9, first_name: "Ann", username: "ann" } } }));
  assert.equal(got.text, '[Forwarded message: displayed user origin "Ann (@ann)". This is context, not the current sender\'s identity.]\nmeet at 6');
  assert.equal(got.senderId, "7", "the sender is still the person who forwarded it");
  const odd = adapter.inbound(base({ text: "x", forward_origin: { type: "martian" } }));
  assert.match(odd.text, /origin details unavailable/);
});

test("a static sticker is a picture; an animated one is described without frames", () => {
  const still = adapter.inbound(base({ sticker: { file_id: "s1", file_unique_id: "u1", is_animated: false, is_video: false, emoji: "👍", set_name: "Hands", file_size: 10 } }));
  assert.match(still.text, /\[Static sticker; emoji "👍"; set "Hands"\. Image attached\.\]/);
  assert.equal(still.attachments.length, 1);
  assert.deepEqual([still.attachments[0].kind, still.attachments[0].mediaType, still.attachments[0].name], ["picture", "image/webp", "sticker-3.webp"]);
  const moving = adapter.inbound(base({ sticker: { file_id: "s2", is_animated: true, is_video: false, emoji: "🎉" } }));
  assert.match(moving.text, /\[Animated sticker; emoji "🎉"\. No animation frames were decoded\.\]/);
  assert.equal(moving.attachments, undefined);
});
