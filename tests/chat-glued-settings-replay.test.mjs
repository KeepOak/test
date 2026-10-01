/**
 * The owner's glued-message report (2026-09-30): "why tf did you still ask me for permission in full access?", then,
 * as its own message, "so what can you do cause you havent installed a fix or fixed yourself". The model ran both
 * together into one settings.find request; the matcher found no setting and handed back a canned
 * "I could not find a setting that matches …. Which setting do you mean?", which the model relayed word for word.
 *
 * A stand-in model replays what the real one did, round for round: it passes the joined words to settings.find and
 * relays any question it gets back through user.ask. Words that name no setting now come back as "no-match", with no
 * question to relay, so the turn ends in the model's own answer. A plain settings request still resolves, and a
 * message typed while a task works reaches the model as its own message: a note, or its own next turn.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, savePolicy } from "../dist/index.js";
import { discardTemp } from "./temp-dir.mjs";
import { startServer } from "../dist/server.js";
import { executeCommand } from "../dist/commands/execute.js";
import { commandHost } from "../dist/commands/host.js";

const first = "why tf did you still ask me for permission in full access?";
const second = "so what can you do cause you havent installed a fix or fixed yourself";

async function fixture(t, complete) {
  const root = await mkdtemp(join(tmpdir(), "branch-glued-replay-"));
  const requests = [];
  const provider = { name: "scripted", async complete(request) { requests.push(request); return complete(request, requests.length); } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, requests, root };
}

const users = (request) => request.messages.filter((m) => m.role === "user").map((m) => String(m.content));
const lastTool = (request) => {
  const last = request.messages.at(-1);
  return last?.role === "tool" ? JSON.parse(String(last.content)) : null;
};
const until = async (check, what) => {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), `timed out: ${what}`);
};

test("the two messages replayed end in the model's own answer, each message intact, with no settings-matcher reply", async (t) => {
  let findResult = null;
  const { app, requests } = await fixture(t, (request) => {
    const said = users(request).at(-1) ?? "";
    if (said.includes(first)) return { content: "Commands no rule mentions are still set to ask.", toolCalls: [] };
    const result = lastTool(request);
    // Round 1 of the second turn: what the real model did, both messages run together as one settings request.
    if (!result) return { content: "", toolCalls: [{ id: "find-1", name: "settings.find",
      arguments: JSON.stringify({ request: `${first} ${second}`, value: "allow" }) }] };
    if (!findResult) findResult = result;
    // Round 2: a question handed back is relayed to the owner as it stands, as the real model relayed it.
    const question = result.result?.question;
    if (question) return { content: "", toolCalls: [{ id: "ask-1", name: "user.ask", arguments: JSON.stringify({ question }) }] };
    return { content: "I can switch commands no rule mentions to allow, so Full access stops asking. Shall I?", toolCalls: [] };
  });
  const one = await app.runtime.run({ prompt: first, source: "owner" });
  assert.equal(one.status, "completed", one.output);
  const two = await app.runtime.run({ prompt: second, sessionId: one.sessionId, source: "owner" });

  assert.equal(two.status, "completed", `the turn ended in the model's answer, not a question: ${two.output}`);
  assert.doesNotMatch(two.output, /could not find a setting|Which setting do you mean/);
  assert.match(two.output, /Full access stops asking/);
  assert.equal(findResult.result.status, "no-match");
  assert.equal(findResult.result.question, undefined, "no canned question to relay");
  assert.match(findResult.result.note, /answer their message yourself/);

  // The model saw both messages, each as its own message, word for word.
  const secondTurn = requests.find((request) => users(request).at(-1)?.includes(second));
  const said = users(secondTurn);
  assert.ok(said.some((text) => text.includes(first) && !text.includes(second)), "the first message is its own");
  assert.ok(said.some((text) => text.includes(second) && !text.includes(first)), "the second message is its own");
  const stored = app.store.messages(one.sessionId).map((m) => String(m.content ?? ""));
  assert.ok(!stored.some((text) => /could not find a setting/.test(text)), "no settings-matcher reply in the conversation");
});

test("an explicit settings request still resolves to the one setting, in a conversation", async (t) => {
  let found = null;
  const { app } = await fixture(t, (request) => {
    const result = lastTool(request);
    if (!result) return { content: "", toolCalls: [{ id: "find-1", name: "settings.find", arguments: JSON.stringify({ request: "turn on learning from experience" }) }] };
    found = result.result;
    return { content: "That would turn on what Branch learns from experience.", toolCalls: [] };
  });
  const done = await app.runtime.run({ prompt: "turn on learning from experience", source: "owner" });
  assert.equal(done.status, "completed", done.output);
  assert.equal(found.status, "ready");
  assert.equal(found.setting, "fly-core.mode");
});

test("a message sent while a task works reaches the model as its own message, never joined to another", async (t) => {
  let release = null;
  const { app, requests } = await fixture(t, async (request, n) => {
    if (n === 1) await new Promise((resolve) => { release = resolve; });
    return { content: `Answer ${n}.`, toolCalls: [] };
  });
  app.flowsBoards.setMode("waiting-line", { mode: "on" });
  for (const mode of ["queue", "steer"]) {
    requests.length = 0;
    const session = app.store.createSession(app.runtime.owner);
    const working = app.runtime.run({ prompt: first, sessionId: session, source: "owner" });
    await until(() => release !== null, "the task is working");
    // Steered while the model writes its last answer, the note is too late to read: it must become its own turn.
    const sent = app.flowsBoards.waiting.send(session, second, mode);
    assert.equal(sent.working, true, mode);
    release(); release = null;
    assert.equal((await working).status, "completed", mode);
    await until(() => requests.length >= 2 && app.store.runs(app.runtime.owner).filter((r) => r.sessionId === session && r.status === "completed").length === 2,
      `${mode}: the second message ran as its own turn`);
    const said = users(requests.at(-1));
    assert.ok(said.some((text) => text.includes(first) && !text.includes(second)), `${mode}: the first message is its own`);
    assert.ok(said.some((text) => text.includes(second) && !text.includes(first)), `${mode}: the second message is its own`);
  }
});

test("a late note from the Steer chip or /steer runs as its own next turn, and one from a chat's /steer does not", async (t) => {
  let release = null;
  const { app, requests, root } = await fixture(t, async (request, n) => {
    if (n === 1) await new Promise((resolve) => { release = resolve; });
    return { content: `Answer ${n}.`, toolCalls: [] };
  });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  const chip = (runId, text) => fetch(new URL(`/api/runs/${runId}/steer`, server.url), { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify({ text }) });
  const command = (surface) => (runId, text, sessionId) => executeCommand(commandHost(app.runtime),
    { surface, line: `/steer ${text}`, sessionId, access: "full", ownWindow: surface === "window" });
  const ways = [["the Steer chip", chip, true], ["/steer in the window", command("window"), true], ["/steer in a chat", command("chat"), false]];
  for (const [way, steer, ownTurn] of ways) {
    requests.length = 0;
    const session = app.store.createSession(app.runtime.owner);
    const working = app.runtime.run({ prompt: first, sessionId: session, source: "owner" });
    await until(() => release !== null, `${way}: the task is working`);
    const runId = app.store.runs(app.runtime.owner).find((r) => r.sessionId === session).id;
    // Steered while the model writes its last answer, the note is too late to read.
    await steer(runId, second, session);
    release(); release = null;
    assert.equal((await working).status, "completed", way);
    const done = () => app.store.runs(app.runtime.owner).filter((r) => r.sessionId === session && r.status === "completed").length;
    if (!ownTurn) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(done(), 1, `${way}: the chat's router owns its late notes, so no turn starts here`);
      continue;
    }
    await until(() => done() === 2, `${way}: the late note ran as its own turn`);
    const said = users(requests.at(-1));
    assert.ok(said.some((text) => text.includes(first) && !text.includes(second)), `${way}: the first message is its own`);
    assert.ok(said.some((text) => text.includes(second) && !text.includes(first)), `${way}: the note is its own message`);
  }
});
