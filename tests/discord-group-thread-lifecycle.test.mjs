// CHAT-124: a thread response belongs to the Discord connection that requested it, even after a restart.
import test from "node:test";
import assert from "node:assert/strict";
import { DiscordAdapter } from "../dist/channels/discord.js";

const parent = "111111111111111111", thread = "222222222222222222";
const message = () => ({ channel: "discord", chatId: parent, chatKind: "group", senderId: "owner",
  senderName: "Owner", text: "hello", addressed: true, messageId: "333333333333333333" });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

function fixture() {
  const reading = deferred(), reply = deferred(), connected = deferred(), closed = deferred(), calls = [];
  const adapter = new DiscordAdapter({ id: "discord", token: "test-bot-token", gatewayUrl: "wss://fixture.invalid",
    async fetch(url, init) {
      calls.push({ url, init });
      // The HTTP response already arrived; hold only parsing its already buffered body across stop/restart.
      return { ok: true, status: 200, headers: new Headers(), async json() { reading.resolve(); return reply.promise; } };
    },
    async connect() { connected.resolve(); return { closed: closed.promise, close() { closed.resolve(); } }; },
  });
  adapter.ready({ user: { id: "bot", username: "Branch" }, session_id: "fixture", resume_gateway_url: "wss://fixture.invalid" });
  const release = (value = { id: thread, parent_id: parent }) => reply.resolve(value);
  const followup = () => adapter.inbound({ id: "444444444444444444", channel_id: thread, guild_id: "guild",
    content: "next", author: { id: "owner", username: "Owner" }, mentions: [], attachments: [] });
  return { adapter, reading, connected, calls, release, followup };
}

test("an uninterrupted thread response binds only its exact source and admits known-thread followups", async (t) => {
  const fx = fixture();
  t.after(() => fx.adapter.stop());
  const pending = fx.adapter.prepareGroup(message());
  await fx.reading.promise;
  fx.release();
  const bound = await pending;
  assert.equal(bound.chatId, thread);
  assert.equal(bound.messageId, message().messageId);
  assert.equal(bound.addressed, true);
  assert.equal(fx.followup().addressed, true);
  assert.equal(fx.calls.length, 1);
  assert.match(fx.calls[0].url, new RegExp(`/channels/${parent}/messages/${message().messageId}/threads$`));
  await assert.rejects(fx.adapter.prepareGroup(message()), /already/);
});

test("a thread returned for a different parent is refused without admitting its followups", async (t) => {
  const fx = fixture();
  t.after(() => fx.adapter.stop());
  const pending = fx.adapter.prepareGroup(message());
  const refused = assert.rejects(pending, /source changed/);
  await fx.reading.promise;
  fx.release({ id: thread, parent_id: "555555555555555555" });
  await refused;
  assert.equal(fx.followup().addressed, false);
});

for (const restart of [false, true]) test(`a late thread response after ${restart ? "restart" : "stop"} is refused without becoming a known thread`, async (t) => {
  const fx = fixture();
  t.after(() => fx.adapter.stop());
  const pending = fx.adapter.prepareGroup(message());
  const refused = assert.rejects(pending, /stopped|changed/);
  await fx.reading.promise;
  const oldSignal = fx.calls[0].init.signal;
  if (restart) { await fx.adapter.restart(async () => {}); await fx.connected.promise; }
  else await fx.adapter.stop();
  assert.equal(oldSignal.aborted, true, "the original request was cancelled");
  fx.release();
  await refused;
  assert.equal(fx.followup().addressed, false, "stale parsing cannot register an old thread in the current adapter");
  assert.equal(fx.calls.length, 1, "the stale result starts no second network request");
});
