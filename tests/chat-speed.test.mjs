/**
 * chat-speed (P0, 2026-09-29): a Telegram message is answered as fast as the model allows. On the owner's computer a
 * "Hi" waited a second for more messages, then 8 and 23 seconds for a workspace snapshot, before the model was asked,
 * and the bot asked Telegram for updates several times a second while each turn worked. Every chat service and git
 * here is a stand-in on this computer.
 *
 * Mutation notes (each turns this file red):
 * - rewind.ts turnStarted: await the snapshot again                         -> "the second message's model call" fails.
 * - router.ts gatherMs: wait the split wait after every message              -> "was asked ... after Telegram handed it over" fails.
 * - telegram.ts poll: drop the busy pause                                    -> "asked Telegram ... times while one turn worked" fails.
 * - runtime.ts addDocuments: no deadline for a chat's lookup                  -> "the model was asked ... after the message" fails.
 * - reliability.ts shrinkEarlierTurns: keep every result                      -> "Earlier result of 5000 characters removed" fails.
 * - reply-stream.ts text: wait an interval for the first words                -> chat-reply-stream "without waiting ten seconds" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, TelegramAdapter, saveGoalUndoSettings } from "../dist/index.js";

async function until(check, label, tries = 1500) {
  for (let i = 0; i < tries; i++) { const value = check(); if (value) return value; await delay(10); }
  assert.fail(`Timed out: ${label}`);
}
const lastUser = (request) => String(request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "");

/** git for the hidden snapshot store, as slow as the owner's computer was at its best: every `add` takes 2 seconds. */
function slowGit() {
  return async (args) => {
    if (args[0] === "init") await mkdir(args.at(-1), { recursive: true }).then(() => writeFile(join(args.at(-1), "HEAD"), "ref: x\n"));
    if (args.includes("add")) await delay(2000);
    return { ok: true, stdout: args.includes("write-tree") ? "a".repeat(40) + "\n" : "", stderr: "" };
  };
}

/** A Telegram Bot API stand-in that holds getUpdates open like the real one: `push` hands an update out. */
async function telegram(t) {
  const state = { queue: [], polls: [], sent: [], waiting: new Set() };
  state.push = (update) => { state.queue.push(update); for (const wake of state.waiting) wake(); };
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const method = req.url.split("/").pop(), body = raw ? JSON.parse(raw) : {};
    const reply = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result })); };
    if (method === "getMe") return reply({ id: 999, is_bot: true, first_name: "Branch", username: "BranchTestBot" });
    if (method === "getUpdates") {
      state.polls.push(Date.now());
      const pending = () => state.queue.filter((u) => u.update_id >= (body.offset ?? 0));
      if (!pending().length) {
        await new Promise((resolve) => { const done = () => { state.waiting.delete(done); clearTimeout(timer); resolve(); };
          const timer = setTimeout(done, (body.timeout ?? 0) * 1000); state.waiting.add(done); });
      }
      return reply(pending());
    }
    if (method === "sendMessage") { state.sent.push({ at: Date.now(), text: body.text }); return reply({ message_id: 5000 + state.sent.length }); }
    return reply(true);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  // Last of all (after hooks run in the order they were added): the bot is stopped first, then its open polls are let go.
  t.after(() => new Promise((resolve) => { for (const wake of state.waiting) wake(); server.closeAllConnections(); server.close(resolve); }));
  const adapter = new TelegramAdapter({ id: "tg", token: "1:x", apiBase: `http://127.0.0.1:${server.address().port}`, pollTimeoutSeconds: 2 });
  return { state, adapter };
}
const from = { id: 42, first_name: "Ann" }, chat = { id: 501, type: "private" };

async function fixture(t, answerMs) {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-speed-"));
  const model = { name: "scripted", requests: [] };
  model.complete = async (request) => {
    model.requests.push({ at: Date.now(), said: lastUser(request) });
    await delay(answerMs);
    return { content: `Echo: ${lastUser(request)}`, toolCalls: [] };
  };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model, snapshotGit: slowGit() });
  saveGoalUndoSettings(app.store, "local", { snapshots: "on" }); // the owner's own choice (2026-09-28)
  const events = [];
  app.store.onEvent((runId, kind) => events.push({ runId, kind, at: Date.now() }));
  t.after(async () => { await app.channels.detachAll(); await app.close(); await discardTemp(root); });
  const { state, adapter } = await telegram(t);
  await app.channels.attach(adapter, { activation: "always", pairing: false, allowlist: ["42"] });
  await until(() => state.polls.length, "polling");
  return { app, model, events, state };
}

test("chat-speed: back-to-back messages: each model call starts at once, the second within a second of the first's reply", async (t) => {
  const { model, events, state } = await fixture(t, 600);
  const handed = Date.now();
  state.push({ update_id: 1, message: { message_id: 10, text: "Hi", from, chat } });
  await until(() => model.requests.length === 1, "the first model call");
  t.diagnostic(`first model call ${model.requests[0].at - handed} ms after Telegram handed the message over`);
  assert.ok(model.requests[0].at - handed < 1000, `the first message was asked ${model.requests[0].at - handed} ms after Telegram handed it over`);
  await delay(200);
  state.push({ update_id: 2, message: { message_id: 11, text: "How are you?", from, chat } }); // while the first is answered
  await until(() => events.filter((e) => e.kind === "channel.sent").length === 2, "both replies", 3000);
  const firstSent = events.find((e) => e.kind === "channel.sent").at;
  assert.equal(model.requests.length, 2);
  assert.match(model.requests[1].said, /How are you/);
  t.diagnostic(`second model call ${model.requests[1].at - firstSent} ms after the first reply was sent`);
  assert.ok(model.requests[1].at - firstSent < 1000,
    `the second message's model call started ${model.requests[1].at - firstSent} ms after the first reply was sent`);
  assert.ok(state.sent.some((m) => /^Echo: Hi/.test(m.text ?? "")) && state.sent.some((m) => /How are you/.test(m.text ?? "")), "both answered");
});

test("chat-speed: while a turn works, the bot does not ask Telegram over and over for the update it is answering", async (t) => {
  const { model, events, state } = await fixture(t, 2000);
  state.push({ update_id: 1, message: { message_id: 10, text: "Take your time", from, chat } });
  await until(() => model.requests.length === 1, "the model call");
  const from0 = state.polls.length;
  await until(() => events.some((e) => e.kind === "channel.sent"), "the reply", 1500);
  const asked = state.polls.length - from0;
  t.diagnostic(`${asked} getUpdates calls while one two-second turn worked`);
  assert.ok(asked <= 16, `asked Telegram for updates ${asked} times while one two-second turn worked`);
  const after = Date.now();
  state.push({ update_id: 2, message: { message_id: 11, text: "And now?", from, chat } });
  await until(() => model.requests.length === 2, "the next message");
  assert.ok(model.requests[1].at - after < 1000, "the next message is taken in at once once the turn is over");
});

test("chat-speed: a chat app's document lookup does not wait on a slow embedding service; the words-only matches still come in", async (t) => {
  let slowMs = 0;
  const embedder = createServer((request, response) => {
    let body = ""; request.on("data", (part) => { body += part; });
    request.on("end", async () => {
      await delay(slowMs);
      const data = JSON.parse(body || "{}").input.map((text, index) => ({ index, embedding: [/leave|holiday/i.test(text) ? 1 : 0.01, 0.5] }));
      if (!response.destroyed) response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data }));
    });
  });
  await new Promise((resolve) => embedder.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { embedder.closeAllConnections(); embedder.close(resolve); }));
  const root = await mkdtemp(join(tmpdir(), "branch-chat-speed-docs-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "handbook.md"), "# Handbook\n\n## Holiday\n\nStaff get twenty days of paid leave each year.\n", "utf8");
  // Passages travel with the question, as Branch's own note in the turn (src/runtime.ts intoTurn).
  const provider = { name: "scripted", requests: [], embeddings: () => ({ endpoint: `http://127.0.0.1:${embedder.address().port}`, apiKey: "test-key" }),
    async complete(input) { this.requests.push({ at: Date.now(), system: input.messages.filter((m) => m.role === "system" || m.from === "branch").map((m) => m.content).join("\n") });
      return { content: "Twenty days.", toolCalls: [] }; } };
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const made = app.knowledgeBases.create("local", { name: "Work", sources: [{ kind: "folder", path: "." }] });
  await app.knowledgeBases.reindex("local", made.id);
  app.knowledgeBases.attach("local", made.id, true);
  slowMs = 3000; // the owner's lookup took 0.6 to 1.1 seconds; this one is slower still
  const began = Date.now();
  const run = await app.runtime.run({ prompt: "How much paid leave is there?", permissions: [], source: "channel" });
  assert.equal(run.status, "completed");
  t.diagnostic(`model asked ${provider.requests[0].at - began} ms after the message, with a 3-second embedding service`);
  assert.ok(provider.requests[0].at - began < 1500, `the model was asked ${provider.requests[0].at - began} ms after the message`);
  assert.match(provider.requests[0].system, /twenty days of paid leave/, "the passage found by its words is still in front of the model");
});

test("chat-speed: a chat turn keeps the last turn's tool results and shrinks older ones; what was said stays", async () => {
  const { shrinkEarlierTurns } = await import("../dist/reliability.js");
  const big = "r".repeat(5000);
  const messages = [
    { role: "system", content: "rules" },
    { role: "user", content: "look this up" }, { role: "assistant", content: "", toolCalls: [{ id: "a", name: "web.read", arguments: {} }] },
    { role: "tool", content: big, toolCallId: "a" }, { role: "assistant", content: "Here is what I found." },
    { role: "user", content: "and this" }, { role: "assistant", content: "", toolCalls: [{ id: "b", name: "web.read", arguments: {} }] },
    { role: "tool", content: big, toolCallId: "b" }, { role: "assistant", content: "Also found." },
    { role: "user", content: "Hi" },
  ];
  assert.equal(shrinkEarlierTurns(messages, 2), 1);
  assert.match(messages[3].content, /Earlier result of 5000 characters removed/);
  assert.equal(messages[7].content, big, "the last turn's result is kept");
  assert.deepEqual(messages.filter((m) => m.role !== "tool").map((m) => m.content),
    ["rules", "look this up", "", "Here is what I found.", "and this", "", "Also found.", "Hi"]);
  assert.equal(shrinkEarlierTurns([{ role: "user", content: "Hi" }], 2), 0, "a first message has nothing earlier");
});

test("chat-speed: a chat turn's request leaves out older turns' tool results; the conversation and the window keep them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-chat-speed-shrink-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "big.txt"), "b".repeat(5000), "utf8");
  const requests = [];
  const provider = { name: "scripted", async complete(request) {
    requests.push(request.messages.map((m) => ({ ...m })));
    const said = lastUser(request);
    if (said === "read it" && !request.messages.some((m) => m.role === "tool"))
      return { content: "", toolCalls: [{ id: "call-1", name: "files.read", arguments: JSON.stringify({ path: "big.txt" }) }] };
    return { content: `ok: ${said}`, toolCalls: [] };
  } };
  const app = await createBranch({ workspace, dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const first = await app.runtime.run({ prompt: "read it", permissions: ["files.read"] });
  const toolIn = (messages) => messages.find((m) => m.role === "tool")?.content ?? "";
  await app.runtime.run({ prompt: "second", sessionId: first.sessionId, permissions: [], source: "channel" });
  assert.ok(toolIn(requests.at(-1)).length >= 5000, "the last turn's result is still sent");
  const third = await app.runtime.run({ prompt: "third", sessionId: first.sessionId, permissions: [], source: "channel" });
  assert.match(toolIn(requests.at(-1)), /Earlier result of \d+ characters removed/, "an older turn's result is not sent from a chat app");
  assert.ok(app.store.events(third.id).some((e) => e.kind === "context.earlier_results_shrunk"));
  assert.ok(toolIn(app.store.workingMessages(first.sessionId).rows.map((row) => row.message)).length >= 5000, "the conversation keeps it whole");
  await app.runtime.run({ prompt: "fourth", sessionId: first.sessionId, permissions: [] });
  assert.ok(toolIn(requests.at(-1)).length >= 5000, "the owner's own window still sends it");
});
