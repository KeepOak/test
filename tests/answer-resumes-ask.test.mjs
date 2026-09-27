/**
 * Q050: pressing Allow on a waiting request sent "Yes, go ahead." as a new message, which started a second task, and the
 * task that asked stayed waiting for good: Overview, Health and Inbox › Needs you kept asking for an answer already
 * given. Now an answer reaches the exact task that asked: a yes through the approvals route (by conversation and
 * fingerprint) carries that same task on, a reply to its own question (user.ask) resumes it, no second task starts, and
 * every "needs you" count reads the engine's one number. Node only, through the window's own routes.
 * Mutations, each turns a test here red:
 * - src/server.ts settleAsked: start a new task for the yes (runForCurrentPerson with a prompt) in place of
 *   app.runtime.continueAsked: "a yes carries on the task that asked" fails (a second task, words in the owner's name).
 * - src/runtime.ts execute: drop `if (!parent) options = this.replyToAsk(options);`: "a reply resumes" fails.
 * - src/needs-you.ts needsYou: add the open questions without folding them into their task (counted.size +
 *   approvals.waiting().length): "one ask counts once" fails (2). src/health.ts: count every needs_input task: the
 *   cleanup test's Health check fails (a helper's question and the person's are counted together).
 * - src/server.ts startServer: drop settleSupersededAsks(app): "a task already overtaken stops waiting" fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer, supersededAskNote } from "../dist/server.js";

const allowedNote = /The call you asked about did not run/;
const repliedNote = /their answer is their newest message/;
const system = (request) => String(request.messages[0]?.content ?? "");

/** Writes the file a message names; after a yes, writes it again (or, told to, a different one); asks where a trip goes. */
function model(options = {}) {
  let file = "";
  return { name: "scripted", async complete(request) {
    const last = request.messages.at(-1);
    const text = String(last?.content ?? "");
    const named = /^write (\S+)/.exec(text);
    if (last?.role === "user" && named) file = named[1];
    const write = (path) => ({ content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path, content: "hello" }) }] });
    if (last?.role === "user" && named) return write(file);
    if (last?.role === "tool" && !/"ok":true/.test(text) && allowedNote.test(system(request))) return write(options.swap ?? file);
    if (last?.role === "user" && text === "plan my trip")
      return { content: "", toolCalls: [{ id: `a${Math.random()}`, name: "user.ask", arguments: JSON.stringify({ question: "Where would you like to go?" }) }] };
    if (last?.role === "user" && repliedNote.test(system(request))) return { content: `Booked: ${text}.`, toolCalls: [] };
    return { content: "Done.", toolCalls: [] };
  } };
}

async function fixture(t, options = {}, before = async () => undefined) {
  const root = await mkdtemp(join(tmpdir(), "branch-q050-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model(options) });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  await before(app);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close().catch(() => undefined); await app.close().catch(() => undefined); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const counts = async () => {
    const state = (await call("state")).body, health = (await call("health")).body;
    const waitingItem = health.items.find((item) => item.name === "Tasks waiting for you");
    return { needsYou: state.needsYou, health: waitingItem.ok ? 0 : Number(/^(\d+)/.exec(waitingItem.summary)?.[1]) };
  };
  const runsIn = (sessionId) => app.store.runs(app.runtime.owner).filter((run) => run.sessionId === sessionId);
  return { app, root, call, counts, runsIn };
}
const settled = async (check) => { for (let i = 0; i < 100; i++) { if (await check()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

test("a yes carries on the task that asked: same task, no words in the owner's name, and every count drops to 0", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "write a.txt" });
  assert.equal(first.status, "needs_input", "control: it stopped to ask");
  assert.deepEqual(await f.counts(), { needsYou: 1, health: 1 }, "one ask counts once: its task and its own question are one thing");
  const asked = f.app.runtime.approvals.questionFor(first.sessionId);
  const said = await f.call("policy/approve", { sessionId: first.sessionId, decision: "allow", remember: "never", fingerprint: asked.fingerprint, carryOn: true });
  assert.equal(said.body.task, "carrying-on");
  assert.ok(await settled(() => f.app.store.run(first.id).status === "completed"), "the task that asked finished");
  assert.ok(existsSync(join(f.root, "workspace", "a.txt")), "and did what the yes was for");
  assert.deepEqual(f.runsIn(first.sessionId).map((run) => run.id), [first.id], "no second task");
  assert.deepEqual(f.app.store.messages(first.sessionId).filter((m) => m.role === "user").map((m) => m.content), ["write a.txt"]);
  assert.ok(f.app.store.events(first.id).some((event) => event.kind === "run.continued"));
  assert.deepEqual(await f.counts(), { needsYou: 0, health: 0 });
  const again = await f.call("policy/approve", { sessionId: first.sessionId, decision: "allow", remember: "never", fingerprint: asked.fingerprint, carryOn: true });
  assert.equal(again.body.task, undefined, "a second yes to the same question answers nothing");
  assert.equal(f.app.store.run(first.id).status, "completed", "and never revives the task");
});

test("the yes holds for the exact request only: a changed request is asked about again, and nothing is written", async (t) => {
  const f = await fixture(t, { swap: "other.txt" });
  const first = await f.app.runtime.run({ prompt: "write b.txt" });
  const asked = f.app.runtime.approvals.questionFor(first.sessionId);
  await f.call("policy/approve", { sessionId: first.sessionId, decision: "allow", remember: "never", fingerprint: asked.fingerprint, carryOn: true });
  assert.ok(await settled(() => f.app.store.run(first.id).status === "needs_input" && f.app.runtime.approvals.waiting(first.sessionId).length === 1),
    "the same task stops again on the changed request");
  assert.notEqual(f.app.runtime.approvals.questionFor(first.sessionId).fingerprint, asked.fingerprint);
  assert.equal(existsSync(join(f.root, "workspace", "other.txt")), false, "the changed request did not run");
  assert.deepEqual(f.runsIn(first.sessionId).map((run) => run.id), [first.id]);
  const wrong = await f.call("policy/approve", { sessionId: first.sessionId, decision: "allow", remember: "never", fingerprint: asked.fingerprint, carryOn: true });
  assert.equal(wrong.body.task, undefined, "the old fingerprint answers nothing");
  assert.equal(existsSync(join(f.root, "workspace", "other.txt")), false);
});

test("a reply to the task's own question resumes that task, not a new one", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "plan my trip" });
  assert.equal(first.status, "needs_input", "control: it asked where to");
  assert.equal((await f.counts()).needsYou, 1);
  const reply = await f.call("run", { prompt: "Paris", sessionId: first.sessionId });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  assert.equal(reply.body.id, first.id, "the reply went to the task that asked");
  assert.equal(f.app.store.run(first.id).status, "completed");
  assert.equal(f.app.store.run(first.id).output, "Booked: Paris.");
  assert.deepEqual(f.runsIn(first.sessionId).map((run) => run.id), [first.id], "no second task");
  assert.deepEqual(await f.counts(), { needsYou: 0, health: 0 });
});

test("a task already overtaken in its conversation stops waiting on start, with the reason, and nothing is allowed", async (t) => {
  let stuck, open;
  const f = await fixture(t, {}, async (app) => {
    // What the old carry-on left behind: the task that asked, still waiting, with the second task after it.
    stuck = app.store.createRun(app.runtime.owner, "write c.txt");
    app.store.finish(stuck.id, "needs_input", "Before I go ahead: Write c.txt. Is that all right?");
    app.store.finish(app.store.createRun(app.runtime.owner, "Yes, go ahead.", stuck.sessionId).id, "completed", "Done.");
    open = app.store.createRun(app.runtime.owner, "plan a party");
    app.store.finish(open.id, "needs_input", "How many guests?");
    // A helper's question is answered inside the task that started it, so it is in no count of the person's.
    const helper = app.store.createRun(app.runtime.owner, "count the chairs");
    app.store.event(helper.id, "run.started", { parentRunId: open.id });
    app.store.finish(helper.id, "needs_input", "Which room?");
  });
  assert.equal(f.app.store.run(stuck.id).status, "cancelled", "the overtaken task no longer waits");
  const resolved = f.app.store.events(stuck.id).find((event) => event.kind === "run.ask_resolved");
  assert.equal(resolved?.data.reason, "superseded");
  assert.equal(f.app.store.run(stuck.id).output, supersededAskNote);
  assert.equal(existsSync(join(f.root, "workspace", "c.txt")), false, "nothing was allowed for it");
  assert.equal(f.app.store.run(open.id).status, "needs_input", "a question still open is left for the person");
  assert.deepEqual(await f.counts(), { needsYou: 1, health: 1 });
});
