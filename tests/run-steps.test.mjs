/**
 * Pass 17 (Timeline and Helpers): GET /api/runs/:id/steps answers one task's steps in order — model calls with their
 * price, tool steps, the questions it stopped on and how they were answered, the helpers it started, the notes the owner
 * steered it with — and each chained step's hash from the activity chain. A helper's question is answered under the same
 * exact-request rules as the main card, and a yes to it never carries the helper on as a task of the owner's own.
 * A scripted model; no provider.
 *
 * Mutation notes (each turns this file red):
 * - src/server.ts settleAsked: drop `&& !origin.parentRunId` and "a yes to a helper's question settles it" fails (the
 *   helper's conversation gains a carry-on task started as the owner's own).
 * - src/run-steps.ts runSteps: drop `...steerSteps(events)` and the "You" step is missing; drop the `.sort(...)` and the
 *   steps come out of order; make chainQueue return null and the tool step's hash is gone.
 * - src/run-steps.ts helpersOf: drop the parentRunId filter and an unrelated task is listed as a helper.
 * - src/run-steps.ts: drop the `.sort(...)` and the tool test's order (model, tool, model) fails.
 * - The "no" test pins the engine's existing settle for a refusal: in settleAsked, finish the task as "completed" for
 *   a no too and it fails (the helper must read cancelled).
 * - src/runtime.ts: drop the `agent` mark on a helper's run.started and the helper has no name.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** Writes the file its message names ("write <file>"), then says it is done. */
const writer = { name: "scripted", async complete(request) {
  const last = request.messages.at(-1);
  const named = /^write (\S+)/.exec(String(last?.content ?? ""));
  if (last?.role === "user" && named) return { content: "", toolCalls: [{ id: `w${Math.random()}`, name: "files.write", arguments: JSON.stringify({ path: named[1], content: "hello" }) }] };
  return { content: "Done.", toolCalls: [] };
} };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-run-steps-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: writer });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { app, call };
}

test("a task's steps come back in order: model calls, tools with their chain hash, questions, and the owner's notes", async (t) => {
  const { app, call } = await fixture(t);
  await call("safety-extras/switch", { part: "activity-chain", mode: "on" });
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const run = await app.runtime.run({ prompt: "write a.txt" });
  assert.equal(run.status, "needs_input", "control: it stopped to ask");
  app.store.event(run.id, "run.steered", { note: "only the August one", waiting: 1 });
  const { status, body } = await call(`runs/${run.id}/steps`);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.title, "write a.txt");
  const kinds = body.steps.map((step) => step.kind);
  assert.deepEqual(kinds, ["model", "ask", "you"], JSON.stringify(body.steps));
  const [model, ask, you] = body.steps;
  assert.equal(model.detail, "scripted", "the model call names its provider");
  assert.equal(ask.state, "waiting", "the question is still waiting");
  assert.match(ask.hash, /^[a-f0-9]{64}$/, "the question carries its link in the chain");
  assert.equal(you.title, "only the August one");
  assert.equal(body.chain.mode, "on");
  assert.equal(body.chain.tip, ask.hash, "the task's latest link is its newest chained step");
  const sorted = [...body.steps].sort((a, b) => a.at.localeCompare(b.at));
  assert.deepEqual(body.steps, sorted, "in the order they happened");
  const verified = await call("safety-extras/activity/verify", { tip: body.chain.tip });
  assert.equal(verified.body.check.ok, true, "the task's link is in an unbroken chain");
  // Answered: the question says how, from the record.
  const asked = app.runtime.approvals.questionFor(run.sessionId);
  await call("policy/approve", { sessionId: run.sessionId, decision: "deny", remember: "never", fingerprint: asked.fingerprint, carryOn: true });
  const after = (await call(`runs/${run.id}/steps`)).body;
  assert.equal(after.steps.find((step) => step.kind === "ask").state, "refused");
});

test("tool steps carry their label, input and output, and a tool call's id to find its message", async (t) => {
  const { app, call } = await fixture(t);
  await call("safety-extras/switch", { part: "activity-chain", mode: "on" });
  savePolicy(app.store, app.runtime.owner, { preset: "workspace" });
  const run = await app.runtime.run({ prompt: "write b.txt" });
  assert.equal(run.status, "completed", "control: nothing asked");
  const steps = (await call(`runs/${run.id}/steps`)).body.steps;
  const tool = steps.find((step) => step.kind === "tool");
  assert.ok(tool, JSON.stringify(steps));
  assert.equal(tool.detail, "files.write");
  assert.match(tool.had, /b\.txt/);
  assert.match(tool.callId, /^w/);
  assert.match(tool.hash, /^[a-f0-9]{64}$/, "a finished tool step carries its link when the chain is on");
  assert.deepEqual(steps.map((step) => step.kind), ["model", "tool", "model"], "one model call before the tool, one after, in that order");
});

test("helpers: the tasks a task started, named, with the question each waits on; a yes to it settles it", async (t) => {
  const { app, call } = await fixture(t);
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const owner = app.runtime.owner;
  const parent = app.store.createRun(owner, "compare the invoice");
  const unrelated = app.store.createRun(owner, "something else");
  app.store.event(unrelated.id, "run.started", { parentRunId: null });
  const context = app.runtime.context({ runId: parent.id });
  const child = await app.runtime.delegate("write helper.txt", context, [...context.permissions], "", { agent: "mode:code" });
  assert.equal(child.status, "needs_input", "control: the helper stopped to ask");
  const { body } = await call(`runs/${parent.id}/steps`);
  assert.equal(body.helpers.length, 1, "only the task this one started");
  const [helper] = body.helpers;
  assert.equal(helper.runId, child.id);
  assert.equal(helper.name, "Code", "named after the mode it works as");
  assert.equal(helper.provider, "scripted");
  assert.equal(helper.job, "write helper.txt");
  assert.equal(helper.waiting.length, 1);
  const question = helper.waiting[0];
  assert.equal(question.sessionId, child.sessionId);
  assert.equal(question.tool, "files.write");
  assert.match(question.fingerprint, /^[a-f0-9]{32}$/);
  assert.ok(body.steps.some((step) => step.kind === "helper" && step.helperRunId === child.id));
  // The same body the main card sends: that exact request, once, and the window's carry-on.
  const answered = await call("policy/approve", { sessionId: question.sessionId, decision: "allow", remember: "never", fingerprint: question.fingerprint, carryOn: true });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(answered.body.task, "settled", "a helper's yes settles it rather than carrying it on");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const inHelper = app.store.runs(owner).filter((run) => run.sessionId === child.sessionId);
  assert.equal(inHelper.length, 1, "nothing was started in the helper's conversation as the owner's own task");
  assert.equal(app.store.run(child.id).status, "completed");
  const later = (await call(`runs/${parent.id}/steps`)).body.helpers[0];
  assert.deepEqual(later.waiting, [], "nothing waits any more");
});

test("a helper's question names the task that started it, in /api/policy and /api/state; the owner's own does not", async (t) => {
  const { app, call } = await fixture(t);
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const own = await app.runtime.run({ prompt: "write mine.txt" });
  assert.equal(own.status, "needs_input", "control: the owner's own task stopped to ask");
  const parent = app.store.createRun(app.runtime.owner, "compare the invoice");
  const context = app.runtime.context({ runId: parent.id });
  const child = await app.runtime.delegate("write helper.txt", context, [...context.permissions], "", { agent: "mode:code" });
  assert.equal(child.status, "needs_input", "control: the helper stopped to ask");
  // The learning passes mark their rows "learning", which names no task: never read as a helper's parent.
  const learning = app.store.createRun(app.runtime.owner, "Learning: a pass");
  app.store.event(learning.id, "run.started", { parentRunId: "learning", source: "learning" });
  app.store.finish(learning.id, "needs_input", "Keep this?");
  const waiting = (await call("policy")).body.waiting;
  assert.deepEqual(waiting.map((q) => [q.runId, q.parentRunId ?? null]).sort(), [[child.id, parent.id], [own.id, null]].sort());
  const attention = (await call("state")).body.attention;
  assert.equal(attention.find((a) => a.runId === child.id)?.parentRunId, parent.id, "the helper's waiting task is marked");
  assert.ok(attention.some((a) => a.runId === own.id) && attention.find((a) => a.runId === own.id).parentRunId === undefined, "the owner's own is not");
  assert.ok(attention.some((a) => a.runId === learning.id) && attention.find((a) => a.runId === learning.id).parentRunId === undefined, "nor a learning row");
});

test("a no to a helper's question stops the helper, and nothing is started in its conversation", async (t) => {
  const { app, call } = await fixture(t);
  savePolicy(app.store, app.runtime.owner, { preset: "ask-before-changes" });
  const owner = app.runtime.owner, parent = app.store.createRun(owner, "compare the invoice");
  const context = app.runtime.context({ runId: parent.id });
  const child = await app.runtime.delegate("write helper.txt", context, [...context.permissions], "", { agent: "mode:code" });
  const [question] = (await call(`runs/${parent.id}/steps`)).body.helpers[0].waiting;
  const answered = await call("policy/approve", { sessionId: question.sessionId, decision: "deny", remember: "never", fingerprint: question.fingerprint, carryOn: true });
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(app.store.run(child.id).status, "cancelled");
  assert.equal(app.store.runs(owner).filter((run) => run.sessionId === child.sessionId).length, 1);
  const helper = (await call(`runs/${parent.id}/steps`)).body.helpers[0];
  assert.equal(helper.status, "cancelled");
  assert.deepEqual(helper.waiting, []);
});

test("somebody else's task, or none, is not found", async (t) => {
  const { call } = await fixture(t);
  const missing = await call("runs/00000000-0000-4000-8000-000000000000/steps");
  assert.equal(missing.status, 404);
});
