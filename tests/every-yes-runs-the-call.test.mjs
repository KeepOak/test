/**
 * QA R1 follow-up: #730 made the window's yes carry the task that asked on, with the engine running the approved call.
 * Every other place a yes is given did not: a chat app said "Send your next message and I will carry on", the terminal
 * ran the prompt again, ACP and the app-server protocol sent "Go ahead with the step you were waiting on", and a room
 * started the member's turn again. Each left the model to make the call a second time, which a small local model mostly
 * does not. Now each carries the waiting task on as itself (src/carry-on.ts), and the engine runs the approved call.
 * The scripted model here NEVER repeats a call: it asks for the stand-in tool once, then only reports what it got.
 * Mutations, each turns the matching test red (each was built and run):
 * - src/channels/router.ts answer: drop the `carryTurn` branch: every chat test (typed y, /approve, a pressed button).
 * - src/terminal-conversation.ts answerApproval: drop the `carry` branch: "the terminal".
 * - src/acp.ts prompt: always send the old prompt instead of `carried`: "an editor over ACP".
 * - src/asks/app-server.ts runTurn: the same: "a program over the app-server protocol".
 * - src/trunks/rooms.ts turn: drop the `carried` start: "a room".
 * - src/carry-on.ts carryable: drop the source check: "a chat's yes never carries on the owner's own task".
 * - src/carry-on.ts carryable: drop the lastMessageId check: "words written since the task stopped…".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { Conversation } from "../dist/terminal-conversation.js";
import { AcpConnection } from "../dist/acp.js";
import { AppServerConnection } from "../dist/asks/app-server.js";
import { call as callOf, fixture as trunkFixture, on } from "./trunks-helpers.mjs";

const tool = "demo.once";
/** Asks for the stand-in tool once for each message, and never again: after a tool result it only reports it. */
function neverRepeats() {
  let serial = 0;
  return { name: "scripted", async complete(request) {
    const last = request.messages.at(-1);
    if (last?.role === "tool") return { content: `Done: ${String(last.content).slice(0, 80)}`, toolCalls: [] };
    if (last?.role === "user") return { content: "", toolCalls: [{ id: `c${++serial}`, name: tool, arguments: JSON.stringify({ note: "once" }) }] };
    return { content: "ok", toolCalls: [] };
  } };
}
/** The stand-in tool, which only counts; the rules ask before it runs. */
function standIn(app, permission = "invented.power") {
  const ran = [];
  app.registry.register({ name: tool, permission, description: "stand-in", group: "core",
    parameters: z.object({ note: z.string() }).strict(), execute: async (input) => { ran.push(input); return { ran: true }; } });
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [{ tool, match: "*", applies: "any", decision: "ask", remember: "session" }] });
  return ran;
}
async function branch(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-every-yes-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: neverRepeats() });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}
/** What every path must show: one call from the model, run once by the engine under that call's id, in the task that asked. */
function ranOnceByTheEngine(app, runId, ran) {
  assert.equal(ran.length, 1, "the approved call ran once");
  const run = app.store.run(runId);
  assert.equal(run.status, "completed", `the task that asked finished: ${run.output}`);
  const calls = app.store.messages(run.sessionId).flatMap((m) => (m.role === "assistant" ? m.toolCalls ?? [] : [])).filter((c) => c.name === tool);
  assert.equal(calls.length, 1, "the model asked for it once");
  const events = app.store.events(runId);
  assert.deepEqual(events.filter((e) => e.kind === "run.approved_call").map((e) => e.data.id), [calls[0].id], "the engine ran it");
  assert.equal(events.filter((e) => e.kind === "tool.completed" && e.data.id === calls[0].id).length, 1);
  assert.match(run.output, /Done: .*"ok":true/, "and the model carried on from the real result");
}
const settle = async (check) => { for (let i = 0; i < 1500; i++) { if (await check()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

/* ------------------------------------------------------------------------------------------------ chat apps */

let next = 1;
const inbound = (text) => ({ channel: "fake", chatId: "c1", chatKind: "direct", senderId: "owner", senderName: "Sam", text, addressed: true, messageId: `m${next++}` });
async function chat(t) {
  const app = await branch(t);
  const ran = standIn(app);
  const sent = [], buttons = [];
  const adapter = { id: "fake", kind: "fake", botName: () => "bot", async start() {}, async stop() {},
    async send(_chat, text) { sent.push(text); return String(sent.length); },
    async sendButtons(_chat, text, offered) { sent.push(text); buttons.push(offered); return String(sent.length); } };
  app.channels.mergeWindowMs = 0;
  app.channels.setPermissionSettings({ extras: true, rules: [{ channel: "fake", sender: "owner", allow: ["invented.power"], approvals: true, note: "my phone" }] });
  await app.channels.attach(adapter, { activation: "always", pairing: true, allowlist: ["owner"] });
  assert.equal(await app.channels.handle(inbound("use the new thing")), "replied");
  const asked = app.store.runs(app.runtime.owner).at(-1);
  assert.equal(asked.status, "needs_input", "control: the chat's task stopped to ask");
  return { app, ran, sent, buttons, asked };
}
for (const [name, answer] of [["a typed y", () => "y"], ["/approve", () => "/approve"], ["a pressed Yes button", (buttons) => buttons.at(-1)[0].value]]) {
  test(`a chat app: ${name} carries the task on, and the engine runs the approved call`, async (t) => {
    const { app, ran, sent, buttons, asked } = await chat(t);
    const runs = app.store.runs(app.runtime.owner).length;
    assert.equal(await app.channels.handle(inbound(answer(buttons))), "replied");
    ranOnceByTheEngine(app, asked.id, ran);
    assert.equal(app.store.runs(app.runtime.owner).length, runs, "no second task");
    // A slow task's reply may be headed with its steps line (the router's own), so only the reply itself is matched.
    assert.match(sent.at(-1), /(^|\n)Done: /, "the chat got the task's own reply");
    assert.doesNotMatch(sent.at(-1), /Send your next message/, "not \"send your next message\"");
    assert.equal(app.store.events(asked.id).find((e) => e.kind === "run.continued") !== undefined, true);
    assert.equal(app.store.messages(asked.sessionId).filter((m) => m.role === "user").length, 1, "nothing was said in the chat's name");
  });
}

test("a chat's yes never carries on the owner's own task in that conversation: it is left for the owner", async (t) => {
  const { app, ran, sent, asked } = await chat(t);
  // The waiting task is marked as the owner's own (as if started at the window in this conversation).
  app.store.sqlite.prepare("DELETE FROM events WHERE run_id=? AND kind='channel.inbound'").run(asked.id);
  const started = app.store.events(asked.id).find((e) => e.kind === "run.started");
  app.store.sqlite.prepare("UPDATE events SET data=? WHERE id=?").run(JSON.stringify({ ...started.data, source: "owner" }), started.id);
  assert.equal(await app.channels.handle(inbound("y")), "replied");
  assert.equal(ran.length, 0, "nothing ran");
  assert.equal(app.store.run(asked.id).status, "needs_input");
  assert.match(sent.at(-1), /Send your next message/);
});

test("words written in the conversation since the task stopped: a chat's yes answers, but does not carry the task on", async (t) => {
  const { app, ran, sent, asked } = await chat(t);
  // A routine's note, written after the task stopped to ask (src/server.ts carryOnAllowed, NAS 3fd7700).
  app.store.message(asked.sessionId, { role: "assistant", content: "Your weekly note: nothing new." });
  assert.equal(await app.channels.handle(inbound("y")), "replied");
  assert.equal(ran.length, 0, "nothing ran: the carried task would have read the note as the answer");
  assert.equal(app.store.run(asked.id).status, "needs_input");
  assert.match(sent.at(-1), /Send your next message/);
});

/* ------------------------------------------------------------------------------------------------ the terminal */

test("the terminal: y carries the task on, and the engine runs the approved call", async (t) => {
  const app = await branch(t);
  const ran = standIn(app);
  const conversation = new Conversation(app.runtime, () => undefined, 5);
  await conversation.send("use the new thing");
  assert.ok(conversation.awaiting, "control: the terminal is asked");
  const asked = app.store.run(conversation.awaiting.runId);
  await conversation.send("y");
  ranOnceByTheEngine(app, asked.id, ran);
  assert.equal(app.store.runs(app.runtime.owner).filter((run) => run.sessionId === asked.sessionId).length, 1, "the prompt was not run again");
  assert.ok(conversation.transcript.some((line) => /^Done: /.test(line.text)), "the answer is shown");
});

test("the terminal: n carries the task on told of the No, and nothing runs", async (t) => {
  const app = await branch(t);
  const ran = standIn(app);
  const conversation = new Conversation(app.runtime, () => undefined, 5);
  await conversation.send("use the new thing");
  const asked = app.store.run(conversation.awaiting.runId);
  await conversation.send("n");
  assert.equal(ran.length, 0);
  assert.equal(app.store.run(asked.id).status, "completed", "the task that asked replied");
  assert.ok(app.store.events(asked.id).some((e) => e.kind === "run.after_refusal"), "told of the No");
});

/* ------------------------------------------------------------------------------------------------ editors */

function lines(output, send) {
  const messages = [];
  let buffer = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });
  const until = async (match) => {
    for (let i = 0; i < 500; i++) { const found = messages.find(match); if (found) return found; await new Promise((r) => setTimeout(r, 10)); }
    throw new Error(`Timed out; saw ${JSON.stringify(messages).slice(0, 800)}`);
  };
  return { messages, send, until };
}

test("an editor over ACP: allow carries the task on, and the engine runs the approved call", async (t) => {
  const app = await branch(t);
  const ran = standIn(app);
  const input = new PassThrough(), output = new PassThrough();
  const serving = new AcpConnection(app.runtime, app.store, { input, output, log: () => {} }).serve();
  t.after(async () => { input.end(); await serving; });
  const acp = lines(output, (message) => input.write(`${JSON.stringify(message)}\n`));
  acp.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
  await acp.until((m) => m.id === 1);
  acp.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
  const sessionId = (await acp.until((m) => m.id === 2)).result.sessionId;
  acp.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "use the new thing" }] } });
  const question = await acp.until((m) => m.method === "session/request_permission");
  const asked = app.store.runs(app.runtime.owner).find((run) => run.sessionId === sessionId && run.status === "needs_input");
  acp.send({ jsonrpc: "2.0", id: question.id, result: { outcome: { outcome: "selected", optionId: "allow" } } });
  assert.equal((await acp.until((m) => m.id === 3)).result.stopReason, "end_turn");
  ranOnceByTheEngine(app, asked.id, ran);
  assert.equal(app.store.messages(sessionId).filter((m) => m.role === "user").length, 1, "no \"Go ahead\" message was sent for the owner");
});

test("a program over the app-server protocol: accept carries the task on, and the engine runs the approved call", async (t) => {
  const app = await branch(t);
  const ran = standIn(app);
  const input = new PassThrough(), output = new PassThrough();
  const serving = new AppServerConnection(app.runtime, { input, output, log: () => {} }, "0.0.0").serve();
  t.after(async () => { input.end(); await serving; });
  const client = lines(output, (message) => input.write(`${JSON.stringify(message)}\n`));
  client.send({ id: 1, method: "initialize", params: {} });
  await client.until((m) => m.id === 1);
  client.send({ id: 2, method: "thread/start", params: {} });
  const threadId = (await client.until((m) => m.id === 2)).result.thread.id;
  client.send({ id: 3, method: "turn/start", params: { threadId, input: [{ type: "text", text: "use the new thing" }] } });
  const question = await client.until((m) => m.method === "item/commandExecution/requestApproval");
  const asked = app.store.runs(app.runtime.owner).find((run) => run.sessionId === threadId && run.status === "needs_input");
  client.send({ id: question.id, result: { decision: "accept" } });
  const completed = await client.until((m) => m.method === "turn/completed");
  assert.equal(completed.params.turn.status, "completed");
  ranOnceByTheEngine(app, asked.id, ran);
  assert.match(client.messages.find((m) => m.method === "item/completed").params.item.text, /Done: /);
});

/* ------------------------------------------------------------------------------------------------ rooms */

test("a room: the owner's yes carries the member's task on, and the engine runs the approved call", async (t) => {
  let asks = 0;
  const { app } = await trunkFixture(t, [({ last }) => {
    const text = String(last?.content ?? "");
    if (last?.role === "tool") return `Done: ${text.slice(0, 80)}`;
    // Asks for the tool on the first room turn only; never again.
    if (text.startsWith("[Room") && /use it/.test(text)) return asks++ === 0 ? callOf(tool, { note: "once" }, "r1") : "(pass)";
    return text.startsWith("[Room") ? "(pass)" : null;
  }]);
  const ran = standIn(app, "files.write");
  on(app, "rooms");
  const ann = app.trunks.create({ name: "Ann" }), ben = app.trunks.create({ name: "Ben" });
  await app.trunks.introduced();
  const room = app.trunks.rooms.create({ name: "Work", members: [ann.id, ben.id] });
  app.trunks.rooms.send(room.id, { text: "@ann use it" });
  await app.trunks.rooms.settled(room.id);
  const [ask] = app.trunks.rooms.view(room.id).waiting;
  assert.ok(ask, "control: the member asked");
  const asked = app.store.runs(app.runtime.owner).find((run) => run.sessionId === room.memberSessions[ann.id] && run.status === "needs_input");
  app.trunks.rooms.answer(room.id, { memberId: ann.id, decision: "allow", ...(ask.fingerprint ? { fingerprint: ask.fingerprint } : {}) });
  await app.trunks.rooms.settled(room.id);
  assert.ok(await settle(() => app.store.run(asked.id).status === "completed"));
  ranOnceByTheEngine(app, asked.id, ran);
  assert.equal(asks, 1, "the member's turn was not started again");
  assert.ok(app.trunks.rooms.view(room.id).events.some((e) => e.kind === "member" && /^Done: /.test(e.text)), "the reply joined the room");
});
