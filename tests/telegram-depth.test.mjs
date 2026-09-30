// CHAT-257: Telegram, in depth reads what the loaded Telegram connections can really do, from this computer only: no
// Telegram call, no sender ids, names, texts or secrets.
import test from "node:test";
import assert from "node:assert/strict";
import { telegramDepth } from "../dist/channels/telegram-depth.js";

test("the readout names each Telegram connection's real abilities and nothing private", () => {
  const adapters = { tg: { maxTextLength: 4096, sendTyping() {}, react() {}, edit() {}, sendButtons() {} } };
  const router = {
    summary: () => ({ live: true, channels: [
      { id: "tg", kind: "telegram", health: { state: "ok", error: "token 123:ABC refused" }, activation: "mention", pairing: "on", allowlist: ["111", "222"] },
      { id: "sl", kind: "slack", health: { state: "ok" }, activation: "always", pairing: "off", allowlist: [] }] }),
    adapter: (id) => adapters[id],
  };
  const read = telegramDepth(router);
  assert.equal(read.connections.length, 1, "only Telegram");
  assert.deepEqual({ ...read.connections[0] }, { health: "ok", activation: "mention", pairing: "on", allowlistedSenders: 2, maxTextLength: 4096,
    typing: true, reactions: true, edits: true, buttons: true, voiceReplies: false });
  assert.doesNotMatch(JSON.stringify(read), /111|222|123:ABC/);
});
