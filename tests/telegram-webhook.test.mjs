/**
 * CHAT-020: Telegram webhook reception. Only the right secret header is accepted, the address must be
 * public HTTPS, and a delivered update is kept until handled, taken once, and replayed after a restart.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TelegramWebhookInbox, validateTelegramWebhook, verifyTelegramWebhook } from "../dist/channels/telegram-webhook.js";
import { createServer, request as postTo } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { TelegramAdapter } from "../dist/channels/telegram.js";
import { rotateWebhookSecret, webhookSecret } from "../dist/channels/webhook-address.js";

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

/* CHAT-020 review: the address a post came in on, and the connection it was admitted for, still hold once its body has
   arrived. A real Telegram adapter in webhook mode behind the real server; Telegram itself is a local stand-in. */
async function webhookServer(t) {
  const telegram = createServer((request, response) => {
    const method = request.url.split("/").pop();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result: method === "getMe" ? { id: 123, is_bot: true, first_name: "Branch", username: "branch_bot" } : true }));
  });
  telegram.listen(0, "127.0.0.1"); await once(telegram, "listening");
  const root = await mkdtemp(join(tmpdir(), "branch-telegram-webhook-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { server.close(); await app.close(); telegram.close(); await discardTemp(root); });
  const owner = app.runtime.owner, word = webhookSecret(app.store, owner, "tg");
  const inbox = new TelegramWebhookInbox(app.store, owner, "tg", "123");
  let armed = null;
  // Posted channels are asked whether they accept once the address has been checked, just before the body is read.
  class Watched extends TelegramAdapter { accepting() { const on = super.accepting(); if (on && armed) { armed(); armed = null; } return on; } }
  const adapter = new Watched({ id: "tg", token: "123:abc", apiBase: `http://127.0.0.1:${telegram.address().port}`,
    webhook: { url: `https://branch.example/webhooks/chat/tg/${word}`, secretToken: "header-secret" }, webhookInbox: inbox });
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: [] });
  /** Posts an update in two halves; `between` runs once the address was checked and before the rest of the body is sent. */
  const post = async (path, update, between = () => {}) => {
    const body = Buffer.from(JSON.stringify(update)), reached = new Promise((done) => { armed = done; });
    const sent = postTo({ host: "127.0.0.1", port: new URL(server.url).port, path, method: "POST", headers: { "content-type": "application/json",
      "content-length": body.length, "x-telegram-bot-api-secret-token": "header-secret" } });
    const answered = new Promise((done, fail) => { sent.on("response", (response) => { response.resume(); done(response.statusCode); }); sent.on("error", fail); });
    sent.write(body.subarray(0, 5));
    await reached;
    await between();
    sent.end(body.subarray(5));
    return answered;
  };
  return { app, owner, word, inbox, post };
}
test("CHAT-020: an address replaced while a post's body arrives does not let that post into the inbox", async (t) => {
  const f = await webhookServer(t);
  assert.equal(await f.post(`/webhooks/chat/tg/${f.word}`, { update_id: 41 }, () => { rotateWebhookSecret(f.app.store, f.owner, "tg"); }), 404);
  assert.equal(f.inbox.has(41), false, "the post on the replaced address was not taken in");
});
test("CHAT-020: a chat app reconnected while a post's body arrives does not let that post into the old connection", async (t) => {
  const f = await webhookServer(t);
  assert.equal(await f.post(`/webhooks/chat/tg/${f.word}`, { update_id: 42 }, async () => { await f.app.channels.detach("tg"); }), 404);
  assert.equal(f.inbox.has(42), false);
});
test("CHAT-020: a post on the current address with a held body is taken in once", async (t) => {
  const f = await webhookServer(t);
  assert.equal(await f.post(`/webhooks/chat/tg/${f.word}`, { update_id: 43 }), 200);
  assert.equal(f.inbox.has(43), true);
});
