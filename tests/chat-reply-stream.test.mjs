import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ReplyStream } from "../dist/channels/reply-stream.js";
import { createBranch } from "../dist/index.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";

function fixture(options = {}) {
  const calls = [];
  const adapter = { id: "stand-in", kind: "telegram", maxTextLength: options.limit ?? 3500,
    async send(chat, text, replyTo) { calls.push({ op: "send", chat, text, replyTo }); return options.noId ? undefined : "r1"; },
    async edit(chat, id, text) { calls.push({ op: "edit", chat, id, text }); if (options.fail) throw new Error("offline"); },
  };
  const target = { adapter, chatId: "dm", messageId: "in1", allowed: options.allowed ?? (() => true) };
  const stream = new ReplyStream(target, options.guard ?? (async text => ({ text, blocked: false })), 5);
  return { stream, calls };
}
test("reply streams in its own message then finalizes without another send", async () => {
  const { stream, calls } = fixture();
  stream.text("First words "); await delay(20);
  stream.text("and more "); await delay(20);
  const placed = await stream.finish("First words and more.");
  assert.equal(calls.filter(c => c.op === "send").length, 1);
  assert.equal(calls.at(-1).text, "First words and more.");
  assert.deepEqual(placed, { messageId: "r1", text: "First words and more." });
});
test("unfinished credential stays buffered until the complete word passes the scrub", async () => {
  const { stream, calls } = fixture({ guard: async text => ({ text: text.replace(/sk-secret\w+/g, "[hidden]"), blocked: false }) });
  stream.text("Safe sk-sec"); await delay(20);
  assert.deepEqual(calls.map(c => c.text), ["Safe"]);
  stream.text("ret123456 end "); await delay(20);
  assert.ok(calls.every(c => !c.text.includes("sk-")));
  await stream.finish("Safe sk-secret123456 end");
  assert.equal(calls.at(-1).text, "Safe [hidden] end");
});
test("guard held content never reaches send or edit", async () => {
  const { stream, calls } = fixture({ guard: async text => ({ text, blocked: true }) });
  stream.text("Blocked answer "); await delay(20);
  assert.equal(await stream.finish("Blocked answer"), null);
  assert.deepEqual(calls, []);
});
test("revocation mid-stream prevents edits and timer sends", async () => {
  let allowed = true;
  const { stream, calls } = fixture({ allowed: () => allowed });
  stream.text("Some words "); await delay(20);
  allowed = false;
  stream.text("more words "); await delay(20);
  assert.equal(await stream.finish("Full answer"), null);
  assert.equal(calls.length, 1);
});
test("long final answer places first chunk and returns every remaining chunk", async () => {
  const { stream, calls } = fixture({ limit: 80 });
  stream.text("Short preview "); await delay(20);
  const full = Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ");
  const placed = await stream.finish(full);
  const all = [placed.text, ...placed.rest];
  assert.ok(all.every(part => part.length <= 80));
  assert.equal(all.join(" "), full);
  assert.equal(calls.filter(c => c.op === "send").length, 1);
});
test("new model round replaces pre-tool words and final is authoritative", async () => {
  const { stream, calls } = fixture();
  stream.text("I will look "); await delay(20);
  stream.round(); stream.text("The result is ready "); await delay(20);
  await stream.finish("The result is ready.");
  assert.equal(calls.at(-1).text, "The result is ready.");
});
test("rate limits hold further edits without counting as permanent failure", async () => {
  const calls = []; let refused = false;
  const adapter = { async send(chat, text) { calls.push(text); return "r1"; },
    async edit(chat, id, text) { if (!refused) { refused = true; throw Object.assign(new Error("wait"), { retryAfter: .04 }); } calls.push(text); } };
  const stream = new ReplyStream({ adapter, chatId: "dm", messageId: "in" }, async text => ({ text, blocked: false }), 5);
  stream.text("First words "); await delay(20);
  stream.text("More words "); await delay(20);
  stream.text("Last words "); await delay(70);
  const placed = await stream.finish("Final answer.");
  assert.equal(placed.text, "Final answer.");
  assert.equal(calls.at(-1), "Final answer.");
});
test("quick answers, no ids, permanent edit failure and cancel fall back", async () => {
  const quick = fixture(); quick.stream.text("Quick");
  assert.equal(await quick.stream.finish("Quick"), null);
  await delay(20); assert.deepEqual(quick.calls, []);
  const missing = fixture({ noId: true }); missing.stream.text("Preview words "); await delay(20);
  assert.equal(await missing.stream.finish("Answer"), null);
  const failed = fixture({ fail: true }); failed.stream.text("Preview words "); await delay(20);
  assert.equal(await failed.stream.finish("Answer"), null);
  const cancelled = fixture(); cancelled.stream.text("Some words "); cancelled.stream.cancel();
  await delay(20); assert.deepEqual(cancelled.calls, []);
});

async function routed(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-reply-stream-"));
  const calls = []; let next = 1;
  const output = options.output ?? "The answer is ready.";
  const provider = { name: "stand-in", async complete(request) {
    await delay(30); request.onTextDelta?.("The answer ");
    await delay(30); request.onTextDelta?.("is ready. ");
    await delay(30); return { content: output, toolCalls: [] };
  } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.channels.mergeWindowMs = 0;
  app.channels.liveTiming = { progressAfterMs: 5, editEveryMs: 5, typingEveryMs: 1000, reactEveryMs: 5 };
  app.channels.setSwitches({ liveStatus: "on", steps: "on" });
  const adapter = { id: "stand-in", kind: "telegram", maxTextLength: options.limit ?? 3500,
    botName: () => "Branch", async start() {}, async stop() {},
    async send(chat, text, replyTo, format) { const id = String(next++); calls.push({ op: "send", id, text, format }); return id; },
    async edit(chat, id, text) { calls.push({ op: "edit", id, text }); },
  };
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: ["owner"] });
  const result = await app.channels.handle({ channel: adapter.id, chatId: "dm", chatKind: options.group ? "group" : "direct",
    senderId: "owner", senderName: "Owner", text: "answer", addressed: true, messageId: "in1" });
  return { app, calls, result, output };
}
test("router sends no steps message for a turn without steps and records a streamed reply only once", async t => {
  const { app, calls, result } = await routed(t);
  assert.equal(result, "replied");
  const sent = calls.filter(c => c.op === "send");
  assert.equal(sent.length, 1, "a turn that took no step posts only its reply");
  assert.equal(sent[0].text, "The");
  assert.ok(calls.some(c => c.op === "edit" && c.id === sent[0].id && c.text === "The answer is ready."));
  const rows = app.channels.deliveries.list().filter(r => r.key.startsWith("reply:"));
  assert.equal(rows.length, 1); assert.equal(rows[0].text, "The answer is ready.");
});
test("router delivers every remaining long chunk without duplicating its streamed first chunk", async t => {
  const output = Array.from({ length: 70 }, (_, i) => `word${i}`).join(" ");
  const { app, calls } = await routed(t, { limit: 80, output });
  const rows = app.channels.deliveries.list().filter(r => r.key.startsWith("reply:")).sort((a,b) => a.order-b.order);
  assert.equal(rows.map(r => r.text).join(" "), output);
  assert.ok(rows.length > 1);
  assert.ok(calls.filter(c => c.op === "send").every(c => c.text.length <= 80));
});
test("groups keep private progress summaries and receive no draft reply", async t => {
  const { calls } = await routed(t, { group: true });
  assert.ok(!calls.some(c => c.text === "The" || c.text === "The answer is"));
  assert.equal(calls.filter(c => c.op === "send" && c.text === "The answer is ready.").length, 1);
});
