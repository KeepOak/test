/**
 * CHAT-020: Telegram webhook reception. Only the right secret header is accepted, the address must be
 * public HTTPS, and a delivered update is kept until handled, taken once, and replayed after a restart.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TelegramWebhookInbox, validateTelegramWebhook, verifyTelegramWebhook } from "../dist/channels/telegram-webhook.js";

function memoryStore() {
  const rows = new Map();
  return { get: (_t, owner, id) => rows.has(`${owner}/${id}`) ? { data: rows.get(`${owner}/${id}`) } : undefined,
    save: (_t, owner, id, data) => rows.set(`${owner}/${id}`, JSON.parse(JSON.stringify(data))) };
}

test("CHAT-020: the secret header and address are checked", () => {
  assert.doesNotThrow(() => verifyTelegramWebhook("s3cret_token", "s3cret_token"));
  for (const wrong of ["s3cret_toke", "S3cret_token", undefined, ["s3cret_token"]]) assert.throws(() => verifyTelegramWebhook("s3cret_token", wrong));
  assert.throws(() => validateTelegramWebhook({ url: "http://bot.example.com/hook", secretToken: "abc" }), /HTTPS/);
  assert.throws(() => validateTelegramWebhook({ url: "https://bot.example.com:9000/hook", secretToken: "abc" }), /HTTPS/);
  assert.doesNotThrow(() => validateTelegramWebhook({ url: "https://bot.example.com/hook", secretToken: "abc" }));
});

test("CHAT-020: an update is kept until handled, taken once, and still there after a restart", () => {
  const store = memoryStore();
  const inbox = new TelegramWebhookInbox(store, "local", "telegram", "42");
  assert.equal(inbox.enqueue(7, '{"update_id":7}'), true);
  assert.equal(inbox.enqueue(7, '{"update_id":7}'), false, "Telegram's retry of the same update is dropped");
  const again = new TelegramWebhookInbox(store, "local", "telegram", "42");
  assert.deepEqual(again.pending().map((one) => one.id), [7], "replayed after a restart");
  again.complete(7);
  assert.deepEqual(again.pending(), []);
  assert.equal(again.enqueue(7, '{"update_id":7}'), false, "a handled update is not taken again");
});
