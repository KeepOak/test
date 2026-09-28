/**
 * Approvals by reaction on apps without buttons (src/channels/reaction-answers.ts), as OpenClaw does: 👍 / ✅ on the
 * question says yes, 👎 / ❌ says no, only on that exact question message, only from the person it asked, only once.
 * WhatsApp (signed webhook), Matrix (m.annotation) and Signal (signal-cli's reaction and its send timestamp), then the
 * router end to end: the question says so, and a reaction answers exactly that question. Stand-ins only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy, WhatsAppAdapter, MatrixAdapter, SignalAdapter } from "../dist/index.js";
import { metaSignature } from "../dist/channels/meta-graph.js";
import { ReactionAnswers, reactionAnswer } from "../dist/channels/reaction-answers.js";

const fp = "c".repeat(32);

test("which reactions answer: thumbs and checks, with any skin tone; nothing else", () => {
  for (const emoji of ["👍", "👍🏽", "✅", "✔️"]) assert.equal(reactionAnswer(emoji), "y", emoji);
  for (const emoji of ["👎", "👎🏿", "❌"]) assert.equal(reactionAnswer(emoji), "n", emoji);
  for (const emoji of ["😂", "❤️", "", "👀"]) assert.equal(reactionAnswer(emoji), null, emoji);
});

test("only the watched question, in its chat, from the person it asked, once, and not after it expires", () => {
  let now = 0;
  const answers = new ReactionAnswers(() => now, 1000);
  answers.watch("q1", "chat", "owner", fp);
  assert.equal(answers.read("q2", "chat", "owner", "👍"), null, "another message");
  assert.equal(answers.read("q1", "other-chat", "owner", "👍"), null, "another chat");
  assert.equal(answers.read("q1", "chat", "stranger", "👍"), null, "someone else");
  assert.equal(answers.read("q1", "chat", "owner", "😂"), null, "not an answer");
  assert.equal(answers.read("q1", "chat", "owner", "👍"), `y:${fp}`);
  assert.equal(answers.read("q1", "chat", "owner", "👎"), null, "answered once");
  answers.watch("q3", "chat", "owner", fp);
  now = 2000;
  assert.equal(answers.read("q3", "chat", "owner", "👎"), null, "expired");
});

test("WhatsApp: a signed reaction on the question from its person is the answer", async () => {
  const inbound = [];
  const wa = new WhatsAppAdapter({ id: "whatsapp", phoneNumberId: "1", token: "t", verifyToken: "v", appSecret: "stand-in-secret",
    apiBase: "https://graph.test", fetch: async () => new Response(JSON.stringify({ messages: [{ id: "wamid.Q" }] })) });
  await wa.start(async (message) => { inbound.push(message); });
  assert.equal(await wa.send("15550100", "May it read notes.md?"), "wamid.Q");
  wa.watchAnswers("15550100", "wamid.Q", "15550100", fp);
  const post = async (from, target, emoji) => {
    const raw = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: `wamid.R${Math.random()}`, from, type: "reaction",
      reaction: { message_id: target, emoji } }] } }] }] }));
    await wa.receive(raw, metaSignature(raw, "stand-in-secret"));
  };
  await post("15550199", "wamid.Q", "👍");
  await post("15550100", "wamid.other", "👍");
  assert.equal(inbound.length, 0, "a stranger's, or on another message, answers nothing");
  await post("15550100", "wamid.Q", "👍");
  assert.deepEqual(inbound.map((one) => [one.senderId, one.chatKind, one.text]), [["15550100", "direct", `y:${fp}`]]);
});

test("Matrix: an annotation on Branch's own question event, by the person asked, is the answer", async () => {
  const matrix = new MatrixAdapter({ id: "matrix", homeserver: "https://matrix.test", accessToken: "t", userId: "@branch:matrix.test",
    fetch: async () => new Response(JSON.stringify({ event_id: "$question:matrix.test" })) });
  const id = await matrix.send("!room:matrix.test", "May it read notes.md?");
  matrix.watchAnswers("!room:matrix.test", id, "@owner:matrix.test", fp);
  const react = (sender, target, key) => matrix.answer("!room:matrix.test", { type: "m.reaction", event_id: `$r${Math.random()}`, sender,
    content: { "m.relates_to": { rel_type: "m.annotation", event_id: target, key } } });
  assert.equal(react("@stranger:matrix.test", "$question:matrix.test", "👍"), null);
  assert.equal(react("@owner:matrix.test", "$elsewhere:matrix.test", "👍"), null);
  assert.equal(react("@owner:matrix.test", "$question:matrix.test", "👎").text, `n:${fp}`);
});

test("Signal: a reaction on the message this account sent at that timestamp, by the person asked, is the answer", () => {
  const signal = new SignalAdapter({ id: "signal", path: "signal-cli", account: "+15550100" });
  signal.inbound(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { timestamp: 1790000000123 } }));
  signal.watchAnswers("+15550199", "7", "+15550199", fp);
  const react = (source, author, at, emoji, extra = {}) => signal.inbound(JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { envelope: {
    source, timestamp: 1790000000999, dataMessage: { reaction: { emoji, targetAuthorNumber: author, targetSentTimestamp: at, ...extra } } } } }));
  assert.equal(react("+15550188", "+15550100", 1790000000123, "👍"), null, "someone else");
  assert.equal(react("+15550199", "+15550177", 1790000000123, "👍"), null, "a message somebody else sent");
  assert.equal(react("+15550199", "+15550100", 1790000000124, "👍"), null, "another message");
  assert.equal(react("+15550199", "+15550100", 1790000000123, "👍", { isRemove: true }), null, "taking a reaction away");
  assert.equal(react("+15550199", "+15550100", 1790000000123, "✅").text, `y:${fp}`);
});

test("through the router: the question says a reaction works, and a reaction answers exactly that question", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chat-reaction-approvals-"));
  let turn = 0;
  const provider = { name: "scripted", complete: async (request) => {
    turn++;
    if (request.messages.at(-1)?.role === "tool") return { content: "Done.", toolCalls: [] };
    return { content: "", toolCalls: [{ id: `a${turn}`, name: "files.read", arguments: JSON.stringify({ path: "README.md" }) }] };
  } };
  const app = await createBranch({ workspace: join(root, "w"), dataDir: join(root, "d"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const sent = [], watched = [];
  app.channels.mergeWindowMs = 0;
  await app.channels.attach({ id: "chat", kind: "fake", botName: () => "Branch", async start() {}, async stop() {},
    async send(_chatId, text) { sent.push(text); return `m${sent.length}`; },
    watchAnswers(...args) { watched.push(args); } }, { activation: "always", pairing: true, allowlist: ["owner"] });
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [{ tool: "files.read", match: "*", applies: "any", decision: "ask", remember: "session" }] });
  let serial = 0;
  const say = (text) => app.channels.handle({ channel: "chat", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam", text, addressed: true, messageId: `u${++serial}` });
  await say("read the readme");
  const sessionId = app.store.runs(app.runtime.owner)[0].sessionId;
  const [question] = app.runtime.waitingApprovals(sessionId);
  assert.match(sent.at(-1), /react 👍 or 👎/);
  assert.deepEqual(watched, [["c1", `m${sent.length}`, "owner", question.fingerprint]], "the question message, its chat, the person asked and its fingerprint");
  await say(`y:${question.fingerprint}`);
  assert.equal(app.runtime.waitingApprovals(sessionId).length, 0);
});
