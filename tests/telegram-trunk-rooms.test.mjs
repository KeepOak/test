// CHAT-076: the owner binds one Telegram group to a fresh room of two to six Trunks; the binding is kept, listed, and
// switched off again; another app, a repeated Trunk or a group bound twice is refused.
import test from "node:test";
import assert from "node:assert/strict";
import { ChannelTrunkRooms } from "../dist/channels/trunk-room.js";

const ada = "11111111-1111-4111-8111-111111111111", bo = "22222222-2222-4222-8222-222222222222";
const roomId = "33333333-3333-4333-8333-333333333333";
function world() {
  const rows = new Map(), cancelled = [];
  const store = { get: (_t, _o, id) => rows.get(id), save: (_t, _o, id, data) => rows.set(id, { id, data }) };
  const trunks = { require() {}, records: { get() {} }, rooms: { create: () => ({ id: roomId }), get: () => ({}), roster: () => ["Ada", "Bo"] } };
  const channels = { summary: () => ({ channels: [{ id: "tg", kind: "telegram" }, { id: "sl", kind: "slack" }] }), trunkIdReach: () => null };
  return { rooms: new ChannelTrunkRooms(store, { owner: "local", cancel: (id) => cancelled.push(id) }, trunks, channels), rows };
}

test("a Telegram group is bound to a room of Trunks, listed, and switched off; other apps and repeats are refused", () => {
  const { rooms } = world();
  const made = rooms.create({ connection: "tg", chatId: "-1001", name: "Team", members: [ada, bo] });
  assert.deepEqual(made.bindings.map((b) => [b.chatId, b.roomId, b.enabled, b.unavailable]), [["-1001", roomId, true, false]]);
  assert.throws(() => rooms.create({ connection: "tg", chatId: "-1001", name: "Again", members: [ada, bo] }), /already bound/);
  assert.throws(() => rooms.create({ connection: "sl", chatId: "-1002", name: "Slack", members: [ada, bo] }), /Telegram/);
  assert.throws(() => rooms.create({ connection: "tg", chatId: "-1003", name: "Twice", members: [ada, ada] }), /once/);
  assert.equal(rooms.disable({ roomId }).bindings[0].enabled, false);
});
