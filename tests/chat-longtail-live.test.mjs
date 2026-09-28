/**
 * Typing, status reactions and quote-replies beyond the four big apps (CHAT-109, 112, 116): WhatsApp's typing indicator
 * and reaction on the person's message, Signal's typing, reaction and quote through signal-cli, and Matrix's reply
 * quoting the person's own message. Each goes only to a message Branch received. Stand-ins only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WhatsAppAdapter, SignalAdapter, MatrixAdapter } from "../dist/index.js";
import { metaSignature } from "../dist/channels/meta-graph.js";

test("WhatsApp: typing against the person's newest message, and a status reaction on it", async () => {
  const calls = [];
  const wa = new WhatsAppAdapter({ id: "whatsapp", phoneNumberId: "99", token: "t", verifyToken: "v", appSecret: "stand-in-secret",
    apiBase: "https://graph.test", fetch: async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return new Response('{"success":true}'); } });
  await wa.start(async () => {});
  await assert.rejects(wa.sendTyping("15550100"), /against a message/);
  const raw = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: "wamid.A", from: "15550100", type: "text", text: { body: "hi" } }] } }] }] }));
  await wa.receive(raw, metaSignature(raw, "stand-in-secret"));
  await wa.sendTyping("15550100");
  await wa.react("15550100", "wamid.A", "👀");
  assert.deepEqual(calls.map((one) => one.body), [
    { messaging_product: "whatsapp", status: "read", message_id: "wamid.A", typing_indicator: { type: "text" } },
    { messaging_product: "whatsapp", recipient_type: "individual", to: "15550100", type: "reaction", reaction: { message_id: "wamid.A", emoji: "👀" } },
  ]);
  assert.ok(calls.every((one) => one.url === "https://graph.test/99/messages"));
});

function signalWorld() {
  const stdin = new PassThrough(), stdout = new PassThrough(), written = [];
  stdin.on("data", (chunk) => { for (const line of String(chunk).split("\n").filter(Boolean)) written.push(JSON.parse(line)); });
  const child = Object.assign(new EventEmitter(), { stdin, stdout, stderr: new PassThrough(), kill() {} });
  const signal = new SignalAdapter({ id: "signal", path: "signal-cli", account: "+15550100", exists: async () => true, spawnProcess: () => child });
  return { signal, stdout, written };
}
test("Signal: typing, a reaction and a quoted reply on a message it received, through signal-cli", async () => {
  const { signal, stdout, written } = signalWorld();
  const inbound = [];
  await signal.start(async (message) => { inbound.push(message); });
  stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { envelope: { source: "+15550199", timestamp: 1790000000555,
    dataMessage: { message: "hello" } } } }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [message] = inbound;
  await signal.sendTyping(message.chatId);
  await signal.react(message.chatId, message.messageId, "👍");
  await signal.send(message.chatId, "Hi there", message.messageId);
  await assert.rejects(signal.react(message.chatId, "123", "👍"), /not one Branch received/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(written.map(({ method, params }) => [method, params]), [
    ["sendTyping", { recipient: ["+15550199"] }],
    ["sendReaction", { recipient: ["+15550199"], emoji: "👍", targetAuthor: "+15550199", targetTimestamp: 1790000000555 }],
    ["send", { recipient: ["+15550199"], message: "Hi there", quoteTimestamp: 1790000000555, quoteAuthor: "+15550199" }],
  ]);
  await signal.stop();
});

test("Matrix: a reply quotes the person's message in the same room, and only there", async () => {
  const bodies = [];
  const matrix = new MatrixAdapter({ id: "matrix", homeserver: "https://matrix.test", accessToken: "t", userId: "@branch:matrix.test",
    fetch: async (url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ event_id: `$sent${bodies.length}` })); } });
  const message = matrix.inbound("!room:matrix.test", { type: "m.room.message", event_id: "$asked", sender: "@sam:matrix.test",
    content: { msgtype: "m.text", body: "what time is it?" } });
  await matrix.send(message.chatId, "Five o'clock.", message.messageId);
  await matrix.send("!other:matrix.test", "Elsewhere.", message.messageId);
  assert.deepEqual(bodies[0]["m.relates_to"], { "m.in_reply_to": { event_id: "$asked" } });
  assert.equal(bodies[1]["m.relates_to"], undefined, "another room never quotes it");
});
