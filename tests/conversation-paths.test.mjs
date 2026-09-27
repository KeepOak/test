/**
 * Pass 17 (design/redesign/pass17/FEATURES17C.md §2, §3, §7): named paths of a conversation ("Branch from here"),
 * leaving a message out of what the model sees, and read marks. Node only, through the window's own routes; a
 * scripted model records every request it is sent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** Answers "Answer N" to each message; "write <file>" asks to write it (a change that needs the owner's yes). */
function scripted(seen) {
  let n = 0;
  return { name: "scripted", async complete(request) {
    seen.push(request.messages.map((m) => `${m.role}:${typeof m.content === "string" ? m.content : ""}`));
    const last = request.messages.at(-1);
    const named = last?.role === "user" ? /^write (\S+)/.exec(String(last.content)) : null;
    if (named) return { content: "", toolCalls: [{ id: `w${++n}`, name: "files.write", arguments: JSON.stringify({ path: named[1], content: "hi" }) }] };
    return { content: `Answer ${++n}`, toolCalls: [] };
  } };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-paths-"));
  const seen = [];
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted(seen) });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close().catch(() => undefined); await app.close().catch(() => undefined); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const messages = async (id) => (await call(`sessions/${id}`)).body.messages;
  return { app, call, messages, seen };
}

async function twoTurns(f) {
  const first = await f.app.runtime.run({ prompt: "first question" });
  await f.app.runtime.run({ prompt: "second question", sessionId: first.sessionId });
  return first.sessionId;
}

test("a path from a reply copies up to it, keeps its name and model, and the tree lists every path", async (t) => {
  const f = await fixture(t);
  const sid = await twoTurns(f);
  f.app.runtime.models.configureSession(f.app.runtime.owner, sid, { reasoning: "high" });
  const reply = (await f.messages(sid)).find((m) => m.role === "assistant");
  const preset = [...f.app.runtime.models.presets.keys()][0];
  const made = await f.call(`sessions/${sid}/branch`, { messageId: reply.messageId, name: "Try 2", preset });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  assert.equal(made.body.split, "after");
  assert.equal(made.body.again, null, "a reply is not answered again");
  const copy = await f.messages(made.body.sessionId);
  assert.deepEqual(copy.map((m) => m.content), ["first question", reply.content], "everything up to the reply, nothing after");
  assert.equal(f.app.runtime.models.session(f.app.runtime.owner, made.body.sessionId).preset, preset, "the chosen model");
  assert.equal(f.app.runtime.models.session(f.app.runtime.owner, made.body.sessionId).reasoning, "high", "the conversation's own choices come along");
  const tree = (await f.call(`sessions/${made.body.sessionId}/paths`)).body;
  assert.equal(tree.current, made.body.sessionId);
  assert.deepEqual(tree.paths.map((p) => [p.sessionId, p.parentSessionId, p.name]), [[sid, null, null], [made.body.sessionId, sid, "Try 2"]]);
  assert.equal(tree.paths[1].branchPointMessageId, reply.messageId);
  assert.equal(tree.paths[1].copied, 2);
  assert.equal(tree.paths[0].lastAnswer, "Answer 2", "each path's last answer, for Compare");
  assert.equal((await f.call(`sessions/${sid}/branch`, { messageId: reply.messageId, name: "x", preset: "no-such-model" })).status, 400);
  assert.equal((await f.call(`sessions/${sid}/branch`, { messageId: reply.messageId })).status, 400, "a path needs a name");
});

test("a path from your own message stops just before it and hands the words back to answer again", async (t) => {
  const f = await fixture(t);
  const sid = await twoTurns(f);
  const asked = (await f.messages(sid)).filter((m) => m.role === "user");
  const again = (await f.call(`sessions/${sid}/branch`, { messageId: asked[1].messageId, name: "Again", preset: null })).body;
  assert.equal(again.split, "before");
  assert.equal(again.again, "second question");
  assert.deepEqual((await f.messages(again.sessionId)).map((m) => m.content), ["first question", "Answer 1"], "the words are not copied twice");
  const fromStart = (await f.call(`sessions/${sid}/branch`, { messageId: asked[0].messageId, name: "Fresh", preset: null })).body;
  assert.deepEqual(await f.messages(fromStart.sessionId), [], "from the very first message the path starts empty");
  const tree = (await f.call(`sessions/${sid}/paths`)).body.paths;
  assert.deepEqual(tree.map((p) => p.name), [null, "Again", "Fresh"], "and it is still recorded as a path");
  assert.equal(tree[2].branchPointMessageId, asked[0].messageId);
});

/* Clearing old conversations (src/retention.ts) is how a conversation is removed for good. */
test("a path and the conversation it came off can each be cleared away; what is left keeps its own paths", async (t) => {
  const f = await fixture(t);
  const sid = await twoTurns(f);
  const reply = (await f.messages(sid)).find((m) => m.role === "assistant");
  const a = (await f.call(`sessions/${sid}/branch`, { messageId: reply.messageId, name: "A", preset: null })).body;
  const b = (await f.call(`sessions/${a.sessionId}/branch`, { messageId: (await f.messages(a.sessionId)).at(-1).messageId, name: "B", preset: null })).body;
  const owner = f.app.runtime.owner;
  assert.equal(f.app.store.forgetSession(owner, a.sessionId).discarded, true, "a path in the middle can go");
  assert.deepEqual((await f.call(`sessions/${b.sessionId}/paths`)).body.paths.map((p) => p.name), ["B"], "its own path now stands alone");
  assert.equal(f.app.store.forgetSession(owner, sid).discarded, true, "and so can the original");
  assert.equal((await f.call(`sessions/${sid}/paths`)).status, 404);
});

test("an approval is one decision on every path: a branch never gets its own copy to answer", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "hello" });
  const asking = await f.app.runtime.run({ prompt: "write a.txt", sessionId: first.sessionId });
  assert.equal(asking.status, "needs_input", "control: it stopped to ask");
  const question = f.app.runtime.approvals.questionFor(first.sessionId);
  const reply = (await f.messages(first.sessionId)).find((m) => m.role === "assistant" && !m.toolCalls?.length);
  const path = (await f.call(`sessions/${first.sessionId}/branch`, { messageId: reply.messageId, name: "Other", preset: null })).body;
  const waiting = () => f.call("state").then((r) => r.body.attention.filter((a) => [first.sessionId, path.sessionId].includes(a.sessionId)));
  assert.equal((await waiting()).length, 1, "Inbox counts it once");
  assert.equal(f.app.runtime.approvals.questionFor(path.sessionId), undefined, "the branch has no question of its own");
  const onBranch = { sessionId: path.sessionId, decision: "allow", remember: "session", fingerprint: question.fingerprint };
  assert.equal((await f.call("policy/approve", onBranch)).status, 400, "answering it on the branch is refused");
  assert.equal((await f.call("policy/approve", { ...onBranch, sessionId: first.sessionId })).status, 200, "answered where it was asked");
  assert.equal((await f.call("policy/approve", onBranch)).status, 400, "and it cannot be answered again on the branch");
  assert.equal(f.app.runtime.approvals.questionFor(first.sessionId), undefined, "nothing waits in the original any more");
  const later = await f.app.runtime.run({ prompt: "write a.txt", sessionId: path.sessionId });
  assert.equal(later.status, "needs_input", "a yes for the original conversation does not allow the same request on the branch");
});

test("a message left out stays in the conversation but is never sent to the model, until it is put back", async (t) => {
  const f = await fixture(t);
  const sid = await twoTurns(f);
  const list = await f.messages(sid);
  const secret = list.find((m) => m.content === "first question");
  assert.equal((await f.call(`sessions/${sid}/pins`, { messageId: secret.messageId, pinned: true })).status, 200);
  const out = await f.call(`sessions/${sid}/left-out`, { messageId: secret.messageId, out: true });
  assert.deepEqual(out.body, { messageId: secret.messageId, out: true, unpinned: true }, "a pinned message is unpinned too");
  const shown = await f.messages(sid);
  assert.equal(shown.find((m) => m.messageId === secret.messageId).leftOut, true, "kept and shown, marked left out");
  assert.equal((await f.call(`sessions/${sid}/pins`)).body.pins.length, 0);
  await f.app.runtime.run({ prompt: "third question", sessionId: sid });
  const sent = f.seen.at(-1);
  assert.ok(sent.includes("user:third question"), "control: the request is the one for this turn");
  assert.ok(!sent.some((line) => line.includes("first question")), "the provider request leaves it out");
  assert.ok(sent.includes("user:second question"), "and keeps everything else");
  await f.call(`sessions/${sid}/left-out`, { messageId: secret.messageId, out: false });
  await f.app.runtime.run({ prompt: "fourth question", sessionId: sid });
  assert.ok(f.seen.at(-1).includes("user:first question"), "put back, the model sees it again");
});

test("a reply that used tools cannot be left out, and a message of another conversation is not found", async (t) => {
  const f = await fixture(t);
  const asking = await f.app.runtime.run({ prompt: "write b.txt" });
  const call = (await f.messages(asking.sessionId)).find((m) => m.toolCalls?.length);
  assert.equal((await f.call(`sessions/${asking.sessionId}/left-out`, { messageId: call.messageId, out: true })).status, 400);
  const elsewhere = await f.app.runtime.run({ prompt: "hi" });
  assert.equal((await f.call(`sessions/${elsewhere.sessionId}/left-out`, { messageId: call.messageId, out: true })).status, 400);
});

test("read marks: a new reply is unread until opened, can be marked unread again, and Mark all read clears the lot", async (t) => {
  const f = await fixture(t);
  const unread = async (id) => (await f.call("sessions")).body.sessions.find((s) => s.sessionId === id).unread;
  const sid = (await f.app.runtime.run({ prompt: "one" })).sessionId;
  assert.equal(await unread(sid), true, "a reply nobody has opened");
  assert.equal(await unread(sid), true, "reading the list marks nothing");
  assert.equal((await f.call("read-marks", { conversation: sid, unread: false })).status, 200);
  assert.equal(await unread(sid), false);
  await f.app.runtime.run({ prompt: "two", sessionId: sid });
  assert.equal(await unread(sid), true, "a later reply is unread again");
  await f.call("read-marks", { conversation: sid, unread: false });
  await f.call("read-marks", { conversation: sid, unread: true });
  assert.equal(await unread(sid), true, "marked unread by hand");
  const other = (await f.app.runtime.run({ prompt: "three" })).sessionId;
  await f.call("read-marks", { all: "conversations" });
  assert.equal(await unread(sid), false);
  assert.equal(await unread(other), false);
  assert.equal((await f.call("read-marks", { conversation: "00000000-0000-4000-8000-000000000000", unread: false })).status, 400);
  const before = (await f.call("read-marks")).body.inbox;
  assert.ok(before.since && before.read.length === 0);
  await f.call("read-marks", { inbox: "run:abc-1", unread: false });
  await f.call("read-marks", { inbox: "ask:abc:def", unread: true });
  const marks = (await f.call("read-marks")).body.inbox;
  assert.deepEqual([marks.read, marks.unread], [["run:abc-1"], ["ask:abc:def"]]);
  await f.call("read-marks", { all: "inbox" });
  const after = (await f.call("read-marks")).body.inbox;
  assert.deepEqual([after.read, after.unread], [[], []]);
  assert.ok(after.since >= before.since, "everything up to now is read");
  assert.equal((await f.call("read-marks", { inbox: "not a key", unread: false })).status, 400);
});

test("a backup keeps what was left out of context and the paths' names, so a restore never sends it again", async (t) => {
  const f = await fixture(t);
  const sid = await twoTurns(f);
  const first = (await f.messages(sid)).find((m) => m.content === "first question");
  await f.call(`sessions/${sid}/left-out`, { messageId: first.messageId, out: true });
  const reply = (await f.messages(sid)).find((m) => m.role === "assistant");
  await f.call(`sessions/${sid}/branch`, { messageId: reply.messageId, name: "Kept", preset: null });
  const archive = f.app.store.backup("test");
  const root = await mkdtemp(join(tmpdir(), "branch-paths-restore-"));
  const fresh = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted([]) });
  t.after(async () => { await fresh.close().catch(() => undefined); await discardTemp(root); });
  fresh.store.restore(JSON.parse(JSON.stringify(archive)));
  assert.deepEqual(fresh.store.workingMessages(sid).rows.map((r) => r.message.content).filter((c) => c === "first question"), [], "still left out after a restore");
  assert.deepEqual(fresh.store.paths.list(fresh.runtime.owner, sid).paths.map((p) => p.name), [null, "Kept"]);
});

test("an upgraded install starts with its old conversations read", async (t) => {
  const f = await fixture(t);
  const sid = (await f.app.runtime.run({ prompt: "old" })).sessionId;
  f.app.store.sqlite.exec("DELETE FROM read_baselines; DELETE FROM read_marks;");
  const { ReadMarks } = await import("../dist/read-marks.js");
  new ReadMarks(f.app.store.sqlite);
  assert.equal(f.app.store.readMarks.unread(f.app.runtime.owner, sid), false, "what was there before is read");
});
