import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, compactionSplit, compactionThreshold, saveKnobs } from "../dist/index.js";
import { startServer } from "../dist/server.js";

function scripted(steps) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push({ messages: request.messages.map((m) => ({ ...m })), tools: request.tools.length });
    const system = request.messages[0].content;
    if (/Summarize the conversation below/.test(system)) return { content: "Handoff: the person is renaming photos in /pics; 12 done, 3 left; next rename IMG_0004.", toolCalls: [] };
    return steps.shift() ?? { content: "Continuing from the summary.", toolCalls: [] };
  } };
  return provider;
}
async function fixture(t, steps = []) {
  const root = await mkdtemp(join(tmpdir(), "branch-compact-"));
  const provider = scripted(steps);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, provider };
}
const filler = (n) => `Turn ${n}: ` + "photo renaming details ".repeat(70);

test("an oversized conversation is compacted into a handoff summary; recent turns and the stored history stay", async (t) => {
  const { app, provider } = await fixture(t);
  // dogfood D22: the room is the model's own now (a hosted one has far more); this conversation is held to 20,000 as before.
  saveKnobs(app.store, app.runtime.owner, "compaction", { contextWindowTokens: 20000 });
  const first = await app.runtime.run({ prompt: "start renaming photos in /pics" });
  const sessionId = first.sessionId;
  for (let n = 1; n <= 40; n++) app.store.message(sessionId, { role: n % 2 ? "user" : "assistant", content: filler(n) });
  const stored = app.store.messages(sessionId).length;
  const run = await app.runtime.run({ prompt: "what is left to do?", sessionId });
  assert.equal(run.status, "completed");
  const summariser = provider.requests.find((r) => /Summarize the conversation below/.test(r.messages[0].content));
  assert.ok(summariser, "the model was asked for a handoff summary");
  assert.equal(summariser.tools, 0, "the summariser has no tools");
  assert.match(summariser.messages[1].content, /Turn 1:/);
  const answer = provider.requests.at(-1).messages;
  assert.equal(answer[0].role, "system");
  assert.match(answer[1].content, /^Earlier in this conversation \(compacted summary\):\nHandoff: the person is renaming photos/);
  assert.ok(answer.length <= 2 + 6 + 1, `working context is short (${answer.length} messages)`);
  assert.equal(answer.at(-1).content, "what is left to do?");
  assert.ok(!answer.some((m) => /Turn 1:/.test(m.content)), "old turns left the working context");
  const event = app.store.events(run.id).find((e) => e.kind === "context.compacted");
  assert.ok(event);
  assert.ok(event.data.estimatedBefore > compactionThreshold, `before ${event.data.estimatedBefore}`);
  assert.ok(event.data.estimatedAfter < event.data.estimatedBefore - 5000 && event.data.estimatedAfter < compactionThreshold, `after ${event.data.estimatedAfter}`);
  assert.ok(event.data.droppedMessages >= 30);
  assert.equal(app.store.messages(sessionId).length, stored + 2, "the full transcript is still stored");
  const before = provider.requests.length;
  const next = await app.runtime.run({ prompt: "and after that?", sessionId });
  assert.equal(next.status, "completed");
  assert.equal(provider.requests.length, before + 1, "the saved summary is reused without summarising again");
  assert.match(provider.requests.at(-1).messages[1].content, /compacted summary/);
  assert.ok(!app.store.events(next.id).some((e) => e.kind === "context.compacted"));
});

test("compaction split keeps at least six recent messages, cuts at a user turn and ignores this run's own turns", () => {
  const msgs = [{ role: "system", content: "s" }];
  const ids = [null];
  for (let i = 1; i <= 10; i++) { msgs.push({ role: i % 2 ? "user" : "assistant", content: String(i) }); ids.push(i); }
  msgs.push({ role: "user", content: "new" }); ids.push(null);
  const split = compactionSplit(msgs, ids);
  assert.deepEqual(split, { from: 1, to: 5 });
  assert.equal(msgs[split.to].role, "user");
  assert.equal(compactionSplit([{ role: "system", content: "s" }, { role: "user", content: "a" }], [null, 1]), null);
});

test("a task that needs an answer stops, is listed for attention, reaches channels as a question, and continues with the reply", async (t) => {
  const { app, root } = await fixture(t, [
    { content: "", toolCalls: [{ id: "q1", name: "user.ask", arguments: JSON.stringify({ question: "Which folder should I clean, Downloads or Desktop?" }) }] },
    { content: "Cleaning Downloads now.", toolCalls: [] },
    { content: "", toolCalls: [{ id: "q2", name: "user.ask", arguments: JSON.stringify({ question: "Delete the duplicates too?" }) }] },
  ]);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const state = async () => (await (await fetch(server.url + "/api/state", { headers: { authorization: "Bearer " + server.token, origin: server.url } })).json());
  const run = await app.runtime.run({ prompt: "clean up my files" });
  assert.equal(run.status, "needs_input");
  assert.equal(run.output, "Which folder should I clean, Downloads or Desktop?");
  assert.ok(app.store.events(run.id).some((e) => e.kind === "attention.needed" && e.data.question === run.output));
  const waiting = (await state()).attention;
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].sessionId, run.sessionId);
  assert.equal(waiting[0].runId, run.id);
  const answered = await app.runtime.run({ prompt: "Downloads", sessionId: run.sessionId });
  assert.equal(answered.status, "completed");
  assert.equal((await state()).attention.length, 0, "answering clears the request");
  const channel = { id: "telegram", kind: "telegram", sent: [], botName: () => "Bot", async start() {}, async stop() {},
    async send(chatId, text) { channel.sent.push({ chatId, text }); return "m1"; } };
  await app.channels.attach(channel, { activation: "always", pairing: false, allowlist: ["7"] });
  const outcome = await app.channels.handle({ channel: "telegram", chatId: "7", chatKind: "direct", senderId: "7", senderName: "Sam", text: "tidy up", addressed: true, messageId: "1" });
  assert.equal(outcome, "replied");
  assert.equal(channel.sent[0].text, "Delete the duplicates too?");
});

test("selfdev (SELF-307): after a long conversation is compacted, the task's plan is still in front of the model", async (t) => {
  const { app, provider } = await fixture(t, [
    { content: "", toolCalls: [{ id: "plan", name: "checklist.write", arguments: JSON.stringify({ steps: [
      { text: "Rename IMG_0001 to IMG_0003", done: true }, { text: "Rename IMG_0004 and the rest", done: false }] }) }] },
    { content: "Plan written.", toolCalls: [] },
  ]);
  saveKnobs(app.store, app.runtime.owner, "compaction", { contextWindowTokens: 20000 });
  const first = await app.runtime.run({ prompt: "start renaming photos in /pics; keep a checklist" });
  assert.equal(first.status, "completed", first.output);
  for (let n = 1; n <= 40; n++) app.store.message(first.sessionId, { role: n % 2 ? "user" : "assistant", content: filler(n) });
  const run = await app.runtime.run({ prompt: "what is left to do?", sessionId: first.sessionId });
  assert.ok(app.store.events(run.id).some((e) => e.kind === "context.compacted"), "the conversation was compacted");
  const sent = provider.requests.at(-1).messages.map((m) => m.content).join("\n");
  assert.match(sent, /compacted summary/);
  assert.match(sent, /2\. \[ \] Rename IMG_0004 and the rest/, "the plan survives compaction, sent fresh every round");
});
