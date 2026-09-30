// CHAT-157: /pair from the owner's own approved direct chat only asks; the local window shows the request for two minutes
// and makes the invitation there. A sender who is not allowed, a bad argument, a repeat or a burst asks nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { DevicePairProposals } from "../dist/channels/device-pair-proposals.js";
import { lookup } from "../dist/commands/catalog.js";

const from = { channel: "telegram", chatId: "c1", senderId: "owner-1", senderName: "Owner", messageId: "m1" };

test("an allowed owner DM leaves a two-minute request in the window, and nothing else", () => {
  let now = Date.parse("2026-09-30T10:00:00Z");
  const allowed = new Set(["owner-1"]);
  const proposals = new DevicePairProposals((p) => allowed.has(p.senderId), () => now);
  assert.match(proposals.request(from, "phone Pixel 9"), /^Pairing requested/);
  const [waiting] = proposals.list();
  assert.deepEqual([waiting.kind, waiting.label, waiting.senderId], ["phone", "Pixel 9", "owner-1"]);
  assert.doesNotMatch(JSON.stringify(waiting), /code|token|key/i, "no code or key is made from chat");
  assert.match(proposals.request(from, "phone"), /already waiting/, "the same message asks once");
  assert.match(proposals.request({ ...from, messageId: "m2" }, "computer"), /Wait a minute/, "one request a minute per sender");
  assert.throws(() => proposals.consume(waiting.id, "computer"), /expired|no longer/, "the window's kind must match");
  now += 121_000;
  assert.deepEqual(proposals.list(), [], "it expires after two minutes");
});

test("a sender who is not allowed, or a bad argument, asks nothing; a sender who loses approval loses the request", () => {
  const allowed = new Set(["owner-1"]);
  const proposals = new DevicePairProposals((p) => allowed.has(p.senderId));
  assert.match(proposals.request({ ...from, senderId: "stranger" }, "phone"), /need your own approved direct chat/);
  assert.match(proposals.request(from, "toaster"), /^Use \/pair phone/);
  assert.equal(proposals.list().length, 0);
  proposals.request(from, "computer");
  allowed.clear();
  assert.deepEqual(proposals.list(), [], "rechecked every time it is read");
});

test("/pair is a chat command", () => {
  assert.equal(lookup("pair")?.name, "pair");
});
