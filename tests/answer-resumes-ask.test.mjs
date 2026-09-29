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
 * - src/runtime.ts replyToAsk: drop `startedWithShortLivedKey()`, `!ownersOwnTask(...)`, `!waitsForReply(...)` or the
 *   open-question check: the matching "only the owner's own message answers" test fails (the waiting task is taken over).
 * - src/runtime.ts continuedReach: hand back what is asked now, unnarrowed: "keeps the reach it started with" fails.
 * - src/store.ts reopenAsked: drop `AND status='needs_input'`: "a task no longer waiting is never reopened" fails.
 * The household test pins the outer refusals (a person's own key never reaches POST /api/run; a household profile does
 * not find the owner's conversation); replyToAsk's `currentPerson()` and `isOwner()` checks stand behind them.
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

const allowedNote = /Do not make that call again/; // QA R1: the engine ran the approved call itself
const repliedNote = /their answer is their newest message/;
const system = (request) => String(request.messages[0]?.content ?? "");

/** Writes the file a message names; never makes a call again after a yes (told to, it then asks for a different one); asks where a trip goes. */
function model(options = {}) {
  let file = "";
  return { name: "scripted", async complete(request) {
    const last = request.messages.at(-1);
    const text = String(last?.content ?? "");
    const named = /^write (\S+)/.exec(text);
    if (last?.role === "user" && named) file = named[1];
    const write = (path) => ({ content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path, content: "hello" }) }] });
    if (last?.role === "user" && named) return write(file);
    if (last?.role === "tool" && /Permission denied/.test(text)) return { content: "Done.", toolCalls: [] };
    if (last?.role === "tool" && /"ok":true/.test(text) && options.swap && !options.swapped && allowedNote.test(system(request))) {
      options.swapped = true;
      return write(options.swap);
    }
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
  const call = async (path, body, token = server.token) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
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
  assert.ok(existsSync(join(f.root, "workspace", "b.txt")), "the approved request did, run by the engine");
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

/* Only the owner's own message at the window answers the owner's own task's question; anything else starts beside it. */
async function waitingTrip(f, token) {
  const asked = await f.call("run", { prompt: "plan my trip" }, token);
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(f.app.store.run(asked.body.id).status, "needs_input", "control: it asked where to");
  return f.app.store.run(asked.body.id);
}
const untouched = (f, run, reply) => {
  assert.notEqual(reply.body.id, run.id, "the reply did not take over the waiting task");
  assert.equal(f.app.store.run(run.id).status, "needs_input", "the waiting task still waits");
  assert.equal(f.app.store.events(run.id).some((event) => event.kind === "run.continued"), false);
};

test("only the owner's own message answers: a short-lived key's message starts beside the owner's waiting task", async (t) => {
  const f = await fixture(t);
  const first = await waitingTrip(f);
  const key = f.app.sessionTokens.create(f.app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const reply = await f.call("run", { prompt: "Paris", sessionId: first.sessionId }, key);
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  untouched(f, first, reply);
});

test("only the owner's own message answers: the owner's message does not take over a task a short-lived key started", async (t) => {
  const f = await fixture(t);
  const key = f.app.sessionTokens.create(f.app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const first = await waitingTrip(f, key);
  const reply = await f.call("run", { prompt: "Paris", sessionId: first.sessionId });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  untouched(f, first, reply);
});

test("only the owner's own message answers: with a request still waiting for a yes in the conversation, a message starts anew", async (t) => {
  const f = await fixture(t);
  const writing = await f.app.runtime.run({ prompt: "write d.txt" });
  assert.equal(writing.status, "needs_input", "control: a request waits for a yes");
  const first = await f.app.runtime.run({ prompt: "plan my trip", sessionId: writing.sessionId });
  assert.equal(first.status, "needs_input", "control: the newest task asked where to");
  const reply = await f.call("run", { prompt: "Paris", sessionId: first.sessionId });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  untouched(f, first, reply);
});

test("only the owner's own message answers: a household person at the window, or with their own key, never takes over the owner's task", async (t) => {
  const f = await fixture(t);
  const first = await waitingTrip(f);
  assert.equal((await f.call("people/settings", { mode: "on" })).status, 200);
  const sam = f.app.store.profiles.create({ name: "Sam", pin: "2468" });
  const samsKey = f.app.people.keys.issue(sam.id, 60, "pin", "test").key;
  const byKey = await f.call("run", { prompt: "Paris", sessionId: first.sessionId }, samsKey);
  untouched(f, first, byKey);
  f.app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  t.after(() => f.app.store.profiles.switch({ profileId: null }));
  const atWindow = await f.call("run", { prompt: "Paris", sessionId: first.sessionId });
  untouched(f, first, atWindow);
});

test("only the owner's own message answers: a task waiting on something other than its own question is not taken over", async (t) => {
  let held;
  const f = await fixture(t, {}, async (app) => {
    // Waiting, but not on a question of its own (no user.ask): a message there starts beside it.
    held = app.store.createRun(app.runtime.owner, "tidy the folder");
    app.store.event(held.id, "run.started", { source: "owner", permissions: [] });
    app.store.finish(held.id, "needs_input", "Waiting for the folder to be trusted.");
  });
  const reply = await f.call("run", { prompt: "go on", sessionId: held.sessionId });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  untouched(f, held, reply);
});

test("a task taken up again by a reply keeps the reach it started with, never the wider reach of the new message", async (t) => {
  const f = await fixture(t);
  const first = await f.app.runtime.run({ prompt: "plan my trip", permissions: ["user.ask", "files.read"] });
  assert.equal(first.status, "needs_input", "control: it asked where to");
  const started = f.app.store.events(first.id).find((event) => event.kind === "run.started").data.permissions;
  assert.deepEqual(started, ["files.read", "user.ask"], "control: it started without file writing");
  // The reply asks for a file to be written, which the window's own message could do and the task that asked never could.
  const reply = await f.call("run", { prompt: "write e.txt", sessionId: first.sessionId });
  assert.equal(reply.body.id, first.id, "the reply went to the task that asked");
  // Q050 follow-up: outside the reach it started with, so refused before any question: no yes could widen it.
  assert.ok(await settled(() => f.app.store.run(first.id).status === "completed"));
  assert.equal(f.app.store.events(first.id).some((event) => event.kind === "policy.ask" && event.data.name === "files.write"), false,
    "the owner was never asked about a tool the task was not given");
  assert.equal(existsSync(join(f.root, "workspace", "e.txt")), false, "the task's reach was not widened");
  assert.ok(f.app.store.events(first.id).some((event) => event.kind === "tool.failed" && /Permission denied: files.write/.test(String(event.data.error))));
});

test("a task no longer waiting is never reopened, however an answer reaches it", async (t) => {
  const f = await fixture(t);
  const run = f.app.store.createRun(f.app.runtime.owner, "plan a party");
  f.app.store.finish(run.id, "needs_input", "How many guests?");
  f.app.store.finish(run.id, "completed", "Done.");
  assert.equal(f.app.store.reopenAsked(run.id), undefined);
  assert.equal(f.app.store.run(run.id).status, "completed");
});
