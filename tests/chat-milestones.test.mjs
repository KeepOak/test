import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { LiveStatus } from "../dist/channels/live-status.js";

/* CHAT-040: on a direct chat that cannot edit a message (WhatsApp), a long task sends at most three short "Still
   working" lines, each checked by the outgoing rules and again by the chat's own switches; none after it ends. */
function chat() {
  const sent = [];
  const adapter = { id: "wa", kind: "whatsapp", botName: () => "Branch", async start() {}, async stop() {},
    async send(chatId, text) { sent.push(text); return String(sent.length); } };
  return { adapter, sent };
}
const timing = { progressAfterMs: 100000, editEveryMs: 10, typingEveryMs: 100000, reactEveryMs: 5, milestonesAtMs: [20, 40, 60, 80] };
const pass = async (text) => ({ text, blocked: false });

test("at most three Still working lines, with the steps done so far, and none once the task ends", async () => {
  const { adapter, sent } = chat();
  const live = new LiveStatus({ adapter, chatId: "c1", messageId: "q1", milestones: () => true }, pass, timing);
  live.start();
  live.thinking();
  live.event("tool.started", { name: "files.read", id: "a", label: "Reading notes" });
  live.event("tool.completed", { name: "files.read", id: "a" });
  await delay(150);
  const lines = sent.filter((text) => text.startsWith("Still working"));
  assert.equal(lines.length, 3, "a fourth time is never used");
  assert.equal(lines[0], "Still working (1 step completed)…");
  await live.finish("done");
  const after = sent.length;
  await delay(60);
  assert.equal(sent.length, after);
});

test("no lines when the chat's switch says no, or the outgoing rules hold the words back", async () => {
  const off = chat();
  const quiet = new LiveStatus({ adapter: off.adapter, chatId: "c1", messageId: "q1", milestones: () => false }, pass, timing);
  quiet.start(); quiet.thinking();
  const held = chat();
  const blocked = new LiveStatus({ adapter: held.adapter, chatId: "c1", messageId: "q1", milestones: () => true },
    async (text) => ({ text, blocked: true }), timing);
  blocked.start(); blocked.thinking();
  const plain = chat();
  const unasked = new LiveStatus({ adapter: plain.adapter, chatId: "c1", messageId: "q1" }, pass, timing);
  unasked.start(); unasked.thinking();
  await delay(120);
  for (const one of [off, held, plain]) assert.deepEqual(one.sent.filter((text) => text.startsWith("Still working")), []);
  await Promise.all([quiet.finish("done"), blocked.finish("done"), unasked.finish("done")]);
});
