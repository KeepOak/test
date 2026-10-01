/**
 * mac7/outside-resume: a task started from outside — a trigger, a schedule, a chat app, MCP, A2A or
 * ACP — keeps that origin however it is carried on, so the 0.18.1 hold (it asks before any change,
 * even under "No approvals") and the chat app's refusals of owner-only actions still apply. Every
 * path in docs/agents/STATUS-outside-resume.md has a test here; the owner's own task is unchanged.
 * A stand-in model and temporary folders only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, readPolicy, savePolicy } from "../dist/index.js";
import { replayRun } from "../dist/replay.js";
import { saveConversationMode } from "../dist/conversation-mode.js";
import { startedFromChat } from "../dist/key-context.js";

const outside = ["trigger", "schedule", "channel", "mcp", "a2a", "acp"];
const write = (path) => `please files.write ${JSON.stringify({ path, content: "x" })}`;

/** A model that calls the tool the newest message names ("please <tool> <json>"), then says it is done. */
function scripted() {
  const model = { name: "scripted", requests: [] };
  model.complete = async (request) => {
    model.requests.push(request);
    const last = request.messages.at(-1);
    const asked = /please ([a-z_.]+) (\{.*\})$/s.exec(last?.role === "user" ? String(last.content) : "");
    if (asked) return { content: "", toolCalls: [{ id: `c${model.requests.length}`, name: asked[1], arguments: asked[2] }] };
    return { content: "Done.", toolCalls: [] };
  };
  return model;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-outside-resume-"));
  const app = await createBranch({ workspace: join(root, "ws"), dataDir: join(root, "data"), provider: scripted(), home: join(root, "home") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  assert.equal(readPolicy(app.store, app.runtime.owner).preset, "off", "the default is No approvals");
  return { app, owner: app.runtime.owner };
}
const started = (app, runId) => app.store.events(runId).find((event) => event.kind === "run.started").data;
/** A task Branch was closed on part way, as the record keeps it: started from `source`, its request not yet done. */
function interrupted(app, source, prompt) {
  const run = app.store.createRun(app.runtime.owner, prompt);
  app.store.event(run.id, "run.started", { provider: "scripted", parentRunId: null, source, permissions: app.registry.permissions().sort() });
  app.store.message(run.sessionId, { role: "user", content: prompt });
  app.store.sqlite.prepare("UPDATE tasks SET status='interrupted' WHERE id=?").run(run.id);
  return run;
}
/** Waits for a queued message to have become a finished task of its own. */
async function drained(app, sessionId, before) {
  for (let i = 0; i < 200; i++) {
    const run = app.store.runs(app.runtime.owner).find((r) => r.sessionId === sessionId && !before.has(r.id) && r.status !== "running");
    if (run) return run;
    await delay(10);
  }
  throw new Error("the queued message never ran");
}

test("Continue on an interrupted outside task (and after a restart): its change still waits, for every source", async (t) => {
  const { app } = await fixture(t);
  for (const source of outside) {
    const resumed = await app.runtime.resume(interrupted(app, source, write(`${source}.txt`)).id);
    assert.equal(resumed.status, "needs_input", `${source}: the resumed task's write waits for the owner`);
    assert.equal(started(app, resumed.id).source, source, `${source}: the resumed task says where it came from`);
    // A task it did not start itself can never be given a standing yes, resumed or not.
    assert.throws(() => app.runtime.approve(resumed.sessionId, "allow", "always"), /did not start yourself/, source);
  }
});

test("branch run --resume (a resume that is not Runtime.resume) keeps the origin too", async (t) => {
  const { app } = await fixture(t);
  const stopped = interrupted(app, "trigger", write("cli.txt"));
  const resumed = await app.runtime.run({ prompt: stopped.prompt, sessionId: stopped.sessionId, resumeFrom: stopped.id });
  assert.equal(resumed.status, "needs_input");
  assert.equal(started(app, resumed.id).source, "trigger");
});

test("a resumed outside task keeps the tools it started with", async (t) => {
  const { app } = await fixture(t);
  const run = app.store.createRun(app.runtime.owner, write("few.txt"));
  app.store.event(run.id, "run.started", { parentRunId: null, source: "trigger", permissions: ["files.read", "files.write"] });
  app.store.message(run.sessionId, { role: "user", content: write("few.txt") });
  app.store.sqlite.prepare("UPDATE tasks SET status='interrupted' WHERE id=?").run(run.id);
  const resumed = await app.runtime.resume(run.id);
  assert.deepEqual(started(app, resumed.id).permissions, ["files.read", "files.write"]);
});

test("a step redone after a restart (a context built by hand) is judged as the outside task's", async (t) => {
  const { app } = await fixture(t);
  for (const source of outside) {
    const run = interrupted(app, source, "hello");
    // src/never-break/resume.ts redoes a step through checkPolicy with a context it builds itself.
    const check = app.runtime.checkPolicy("files.write", { path: "r.txt", content: "x" }, app.runtime.context({ runId: run.id }));
    assert.equal(check.decision, "ask", source);
  }
  const own = interrupted(app, "owner", "hello");
  assert.equal(app.runtime.checkPolicy("files.write", { path: "r.txt", content: "x" }, app.runtime.context({ runId: own.id })).decision, "allow");
});

test("carrying on after answering its question: the owner's next message still asks before the next change", async (t) => {
  const { app } = await fixture(t);
  const first = await app.runtime.run({ prompt: write("one.txt"), source: "trigger" });
  assert.equal(first.status, "needs_input");
  app.runtime.approve(first.sessionId, "allow", "never");
  // "Noted. Send your next message in that conversation to carry on."
  const next = await app.runtime.run({ prompt: write("two.txt"), sessionId: first.sessionId });
  assert.equal(next.status, "needs_input", "the owner's message does not turn the trigger's task into the owner's own");
  assert.equal(started(app, next.id).source, "trigger");
  assert.equal(started(app, next.id).originFrom, first.id);
  assert.throws(() => app.runtime.approve(next.sessionId, "allow", "always"), /did not start yourself/);
  // A queued message (the app's follow-up box) is held the same way.
  const before = new Set(app.store.runs(app.runtime.owner).map((r) => r.id));
  app.runtime.approve(next.sessionId, "deny", "session");
  app.runtime.followUp(first.sessionId, write("three.txt"));
  const queued = await drained(app, first.sessionId, before);
  assert.equal(queued.status, "needs_input");
  assert.equal(started(app, queued.id).source, "trigger");
});

test("the mode chip cannot loosen a carried-on outside task", async (t) => {
  const { app, owner } = await fixture(t);
  savePolicy(app.store, owner, { preset: "ask-before-changes" });
  const first = await app.runtime.run({ prompt: write("m1.txt"), source: "schedule" });
  app.runtime.approve(first.sessionId, "deny", "session");
  saveConversationMode(app.store, owner, first.sessionId, { mode: "full" });
  const next = await app.runtime.run({ prompt: write("m2.txt"), sessionId: first.sessionId });
  assert.equal(next.status, "needs_input", "Full access in the conversation is not the schedule's to use");
  // Pinned (this already held before the fix): a resumed schedule task is not loosened either.
  const stopped = interrupted(app, "schedule", write("m3.txt"));
  saveConversationMode(app.store, owner, stopped.sessionId, { mode: "full" });
  assert.equal((await app.runtime.resume(stopped.id)).status, "needs_input");
  // The owner's own conversation on Full access still goes ahead.
  const mine = await app.runtime.run({ prompt: "hello" });
  saveConversationMode(app.store, owner, mine.sessionId, { mode: "full" });
  assert.equal((await app.runtime.run({ prompt: write("mine.txt"), sessionId: mine.sessionId })).status, "completed");
});

test("Do this again on an outside task is done as that task, not as the owner's own", async (t) => {
  const { app } = await fixture(t);
  const first = await app.runtime.run({ prompt: write("again.txt"), source: "mcp" });
  const done = await replayRun(app.runtime, app.store, first.id);
  assert.equal(done.run.status, "needs_input");
  assert.equal(started(app, done.run.id).source, "mcp");
  const mine = await app.runtime.run({ prompt: write("mine.txt") });
  const again = await replayRun(app.runtime, app.store, mine.id);
  assert.equal(again.run.status, "completed", "the owner's own task done again is unchanged");
  assert.equal(started(app, again.run.id).source, "owner");
  assert.equal(started(app, again.run.id).originFrom, undefined);
});

test("a handed-over step's answer carries the outside task on as that task", async (t) => {
  const { app } = await fixture(t);
  const mine = await app.runtime.run({ prompt: "hello" });
  const trigger = await app.runtime.run({ prompt: "hello", source: "trigger" });
  const mixed = app.runtime.deferrals.open({ id: "mixed", runId: trigger.id, sessionId: mine.sessionId, tool: "files.write", description: "a file" });
  assert.throws(() => app.runtime.settleDeferred(mixed.id, "written"), /saved effective scope or workspace/);
  assert.equal(app.runtime.deferrals.get(mixed.id).settledAt, null, "mixed-session authority remains refused");
  const entry = app.runtime.deferrals.open({ id: "d1", runId: trigger.id, sessionId: trigger.sessionId, tool: "files.write", description: "a file" });
  const before = new Set(app.store.runs(app.runtime.owner).map((r) => r.id));
  app.runtime.settleDeferred(entry.id, "written");
  const carried = await drained(app, trigger.sessionId, before);
  assert.equal(started(app, carried.id).source, "trigger");
  assert.equal(started(app, carried.id).originFrom, trigger.id);
  assert.deepEqual(started(app, carried.id).permissions, started(app, trigger.id).permissions);
  const held = app.runtime.checkPolicy("files.write", { path: "outside-deferred.txt", content: "x" },
    app.runtime.context({ runId: carried.id }));
  assert.equal(held.decision, "ask", "answering a trigger handoff grants no owner's change authority");
  const next = await app.runtime.run({ prompt: write("outside-after-handoff.txt"), sessionId: carried.sessionId });
  assert.equal(started(app, next.id).source, "trigger");
  assert.equal(next.status, "needs_input", "the trigger's next change still waits for approval");
  assert.throws(() => app.runtime.approve(next.sessionId, "allow", "always"), /did not start yourself/);
});

test("a chat's task carried on in the window, done again or resumed still cannot do owner-only things", async (t) => {
  const { app } = await fixture(t);
  const chat = await app.runtime.run({ prompt: "hello", source: "channel" });
  const next = await app.runtime.run({ prompt: "and now?", sessionId: chat.sessionId });
  const again = (await replayRun(app.runtime, app.store, chat.id)).run;
  const stopped = interrupted(app, "channel", "hello");
  const resumed = await app.runtime.resume(stopped.id);
  const workflow = { name: "From a chat", steps: [{ name: "Say", kind: "prompt", prompt: "hi" }] };
  for (const run of [next, again, resumed]) {
    assert.equal(started(app, run.id).source, "channel");
    // A helper's context is built by hand with no source: the record is what the guard reads.
    assert.ok(startedFromChat({ runId: run.id }, app.store));
    await assert.rejects(app.registry.execute("workflows.create", workflow, app.runtime.context({ runId: run.id })),
      /for the owner only/, "saving a workflow is the owner's alone");
  }
  // The owner's own conversation is still the owner's.
  const mine = await app.runtime.run({ prompt: "hello" });
  const own = await app.runtime.run({ prompt: "more", sessionId: mine.sessionId });
  assert.equal(startedFromChat({ runId: own.id }, app.store), false);
  await app.registry.execute("workflows.create", workflow, app.runtime.context({ runId: own.id }));
});

test("an outside task that joined the owner's conversation is held only while it is the one stopped", async (t) => {
  const { app } = await fixture(t);
  const mine = await app.runtime.run({ prompt: "hello" });
  const joined = await app.runtime.run({ prompt: write("j1.txt"), sessionId: mine.sessionId, source: "a2a" });
  assert.equal(joined.status, "needs_input");
  app.runtime.approve(mine.sessionId, "deny", "session");
  const carried = await app.runtime.run({ prompt: write("j2.txt"), sessionId: mine.sessionId });
  assert.equal(carried.status, "needs_input", "carrying on what the other program was stopped on");
  app.runtime.approve(mine.sessionId, "deny", "session");
  // Once nothing from outside is waiting, the owner's own message in their own conversation is theirs.
  const settled = await app.runtime.run({ prompt: "hello again", sessionId: mine.sessionId });
  assert.equal(settled.status, "completed");
  assert.equal((await app.runtime.run({ prompt: write("j3.txt"), sessionId: mine.sessionId })).status, "completed");
});

test("the owner's own interrupted task resumes exactly as before", async (t) => {
  const { app } = await fixture(t);
  const resumed = await app.runtime.resume(interrupted(app, "owner", write("own.txt")).id);
  assert.equal(resumed.status, "completed");
  assert.equal(started(app, resumed.id).source, "owner");
  assert.equal(started(app, resumed.id).originFrom, undefined);
  const follow = await app.runtime.run({ prompt: write("own2.txt"), sessionId: resumed.sessionId });
  assert.equal(follow.status, "completed");
});

const approveThenWrite = { name: "Check then write", steps: [
  { name: "Check", kind: "approval", question: "Go on?" },
  { name: "Write", kind: "tool", tool: "files.write", args: { path: "wf.txt", content: "x" } },
] };

test("a workflow a schedule set going, carried on by the owner's yes, still asks before its change", async (t) => {
  const { app, owner } = await fixture(t);
  const flow = app.workflows.create(owner, approveThenWrite);
  assert.equal((await app.workflows.run(owner, flow.id, "schedule")).status, "waiting_approval");
  const carried = await app.workflows.resume(owner, flow.id);
  assert.equal(carried.status, "waiting_approval", "the write waits for the owner too");
  assert.equal(carried.pendingApproval?.source ?? app.store.get("workflows", owner, flow.id).data.pendingApproval.source, "schedule");
  // The owner's own run of it goes ahead after their yes, as before.
  const own = app.workflows.create(owner, { ...approveThenWrite, name: "Mine" });
  await app.workflows.run(owner, own.id);
  assert.equal((await app.workflows.resume(owner, own.id)).status, "completed");
});

const twoWrites = { name: "Two writes", input: {}, state: { a: "text", b: "text" }, entry: "a",
  nodes: [
    { id: "a", name: "First", kind: "tool", tool: "files.write", args: { path: "g1.txt", content: "x" }, input: {}, output: { a: "text" } },
    { id: "b", name: "Second", kind: "tool", tool: "files.write", args: { path: "g2.txt", content: "x" }, input: {}, output: { b: "text" } },
  ],
  edges: [{ from: "a", to: "b" }] };

test("a graph flow a schedule set going keeps asking after the owner carries it on", async (t) => {
  const { app } = await fixture(t);
  const graph = app.flows.saveGraph(twoWrites);
  const { runId, compiled } = app.flows.graphs.begin({ ...twoWrites, id: graph.id }, {}, { source: "schedule" });
  assert.equal((await app.flows.graphs.work(runId, compiled, { source: "schedule" })).status, "waiting_approval");
  app.flows.resumeGraph(graph.id, { approve: true });
  const after = await app.flows.settled(runId);
  assert.equal(after.status, "waiting_approval", "the second write waits as well");
  assert.match(after.question ?? "", /g2\.txt/);
});

test("a flow an outside task sets going through its tool is held as that task", async (t) => {
  const { app } = await fixture(t);
  const graph = app.flows.saveGraph({ ...twoWrites, name: "Write twice" });
  const trigger = await app.runtime.run({ prompt: "hello", source: "trigger" });
  // The tool as the trigger's task would call it once allowed, with a context built by hand.
  await app.registry.execute("flows.write-twice", {}, app.runtime.context({ runId: trigger.id }));
  const run = app.flows.graphs.resumable(graph.id);
  assert.ok(run, "the flow stopped");
  assert.equal((await app.flows.settled(run.runId)).status, "waiting_approval");
  // Set going by the owner, the same flow goes ahead under No approvals.
  const mine = await app.flows.settled(app.flows.startGraph(graph.id, {}).runId);
  assert.equal(mine.status, "completed");
});

test("a conversation branched off or copied from an outside one is held the same", async (t) => {
  const { app, owner } = await fixture(t);
  const first = await app.runtime.run({ prompt: "hello", source: "trigger" });
  const point = app.store.sessionView(owner, first.sessionId).messages.find((m) => m.role === "user");
  const branched = (await app.store.branchSession(owner, { sessionId: first.sessionId, messageId: point.messageId })).sessionId;
  const copied = (await app.store.duplicateSession(owner, first.sessionId)).sessionId;
  for (const sessionId of [branched, copied]) {
    const run = await app.runtime.run({ prompt: write("copy.txt"), sessionId });
    assert.equal(run.status, "needs_input", "carrying the copy on still asks");
    assert.equal(started(app, run.id).source, "trigger");
  }
});

test("a workflow an outside task sets going through its tool is held as that task", async (t) => {
  const { app, owner } = await fixture(t);
  const flow = app.workflows.create(owner, { name: "Just write", steps: [
    { name: "Write", kind: "tool", tool: "files.write", args: { path: "tool.txt", content: "x" } }] });
  const trigger = await app.runtime.run({ prompt: "hello", source: "trigger" });
  // The tool as the trigger's task would call it once allowed, with a context built by hand.
  const view = await app.registry.execute("workflows.run", { id: flow.id }, app.runtime.context({ runId: trigger.id }));
  assert.equal(view.status, "waiting_approval");
  const mine = await app.runtime.run({ prompt: "hello" });
  const own = app.workflows.create(owner, { name: "Mine too", steps: [
    { name: "Write", kind: "tool", tool: "files.write", args: { path: "tool2.txt", content: "x" } }] });
  assert.equal((await app.registry.execute("workflows.run", { id: own.id }, app.runtime.context({ runId: mine.id }))).status, "completed");
});
