import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, Budget, looksMultiPart } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const say = (content) => ({ content, toolCalls: [] });
const call = (name, args) => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 9)}`, name, arguments: JSON.stringify(args) }] });
const kinds = (app, runId) => app.store.events(runId).map((e) => e.kind);
const data = (app, runId, kind) => app.store.events(runId).filter((e) => e.kind === kind).map((e) => e.data);

/** A provider whose answer is chosen from the system prompt and the last message of the request. */
function scripted(reply) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    const system = request.messages[0].content;
    const user = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    const last = request.messages.at(-1);
    return reply({ system, user, last, request });
  } };
  return provider;
}
async function fixture(t, reply, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-orchestration-"));
  const provider = scripted(reply);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, provider, root };
}
async function served(t, reply, options = {}) {
  const made = await fixture(t, reply, options);
  const root = made.root;
  const server = await startServer(made.app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); });
  const api = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error);
    return json;
  };
  return { ...made, api, server };
}
/** An evaluated, promoted specialist the runtime will delegate to. */
async function specialist(app, name, permissions = ["files.read"]) {
  const context = app.runtime.context();
  const proposed = await app.registry.execute("specialists.propose", {
    name, instructions: `You are the ${name}.`, permissions,
    evaluation: { prompt: "say ready", checks: [{ path: `${name}.txt`, expected: "ready" }] },
  }, context);
  await writeFile(join(app.runtime.workspace, `${name}.txt`), "ready");
  await app.registry.execute("specialists.evaluate", { id: proposed.id }, context);
  await app.registry.execute("specialists.promote", { id: proposed.id }, context);
  return proposed.id;
}

test("a planned task makes a numbered plan and works through the steps in order, checking each one", async (t) => {
  const { app } = await fixture(t, ({ system, user }) => {
    if (/You are planning a task/.test(system))
      return say('```json\n{"steps":[{"title":"Gather the numbers","mustMention":"numbers"},{"title":"Add them up","mustMention":"total"},{"title":"Write the note"}]}\n```');
    if (/did not pass its check/.test(user)) return say("The total is 42.");
    if (/^Step 1 of 3/.test(user)) return say("I gathered the numbers.");
    if (/^Step 2 of 3/.test(user)) return say("Added them.");
    if (/^Step 3 of 3/.test(user)) return say("Note written.");
    if (/Every step of the plan is done/.test(user)) return say("All three steps are done and the total is 42.");
    return say("unexpected");
  });
  const run = await app.runtime.run({ prompt: "gather the numbers, then add them up, and then write the note", plan: true });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "All three steps are done and the total is 42.");
  assert.deepEqual(data(app, run.id, "plan.created")[0].steps, ["Gather the numbers", "Add them up", "Write the note"]);
  assert.deepEqual(data(app, run.id, "plan.step.started").map((d) => [d.step, d.title]), [[1, "Gather the numbers"], [2, "Add them up"], [3, "Write the note"]]);
  assert.deepEqual(data(app, run.id, "plan.step.finished").map((d) => [d.step, d.passed]), [[1, true], [2, true], [3, true]]);
  assert.deepEqual(data(app, run.id, "plan.step.retry").map((d) => d.step), [2], "step two missed its check once and was asked again");
  assert.equal(kinds(app, run.id).filter((k) => k === "plan.completed").length, 1);
  assert.equal(app.runtime.orchestration.plan(run.sessionId), undefined, "a finished plan is cleared");

  // Nothing plans on its own: the same task without the flag runs exactly as it always did.
  const plain = await app.runtime.run({ prompt: "gather the numbers, then add them up, and then write the note" });
  assert.equal(plain.status, "completed");
  assert.ok(!kinds(app, plain.id).some((k) => k.startsWith("plan.")));
  assert.equal(looksMultiPart("do this, then that, and then finally the other"), true);
  assert.equal(looksMultiPart("say hello"), false);
});

test("a plan whose step keeps failing stops the task, and the next message is not answered by the abandoned plan", async (t) => {
  const { app } = await fixture(t, ({ system, user }) => {
    if (/You are planning a task/.test(system)) return say('{"steps":[{"title":"Find the invoice"},{"title":"Read the amount","mustMention":"amount"}]}');
    if (/^Step 1 of 2/.test(user)) return say("Found it.");
    return say("I could not work that out.");
  });
  const run = await app.runtime.run({ prompt: "find the invoice and then read the amount", plan: true });
  assert.equal(run.status, "failed");
  assert.match(run.output, /Step 2 of the plan did not pass its check/);
  assert.equal(app.runtime.orchestration.plan(run.sessionId), undefined, "the abandoned plan is dropped");
  const next = await app.runtime.run({ prompt: "never mind, what is the weather?", sessionId: run.sessionId });
  assert.equal(next.status, "completed");
  assert.ok(!kinds(app, next.id).some((k) => k.startsWith("plan.")), "the next message runs as an ordinary task");
});

test("with plan approval on, the task stops with its plan, the owner can edit it, and the next message runs it", async (t) => {
  const { app, api } = await served(t, ({ system, user }) => {
    if (/You are planning a task/.test(system)) return say('{"steps":[{"title":"Draft it"},{"title":"Send it"}]}');
    if (/^Step 1 of 1/.test(user)) return say("Drafted, nothing sent.");
    if (/Every step of the plan is done/.test(user)) return say("The draft is ready and nothing was sent.");
    return say("unexpected");
  });
  assert.deepEqual(await api("orchestration", { planApproval: true, autoPlan: true }), {
    autoPlan: true, planApproval: true, verify: false, milestoneRounds: 0, stuckAction: "default", pattern: "auto",
  });
  const asked = await api("run", { prompt: "write the letter and send it", plan: true });
  assert.equal(asked.status, "needs_input");
  assert.match(asked.output, /Here is my plan:\n1\. Draft it\n2\. Send it/);
  assert.deepEqual(data(app, asked.id, "plan.awaiting_approval")[0].steps, ["Draft it", "Send it"]);
  assert.deepEqual((await api(`runs/${asked.id}/plan`)).plan.steps.map((s) => s.title), ["Draft it", "Send it"]);
  const edited = await api(`runs/${asked.id}/plan`, { steps: [{ title: "Draft it" }] });
  assert.deepEqual(edited.steps.map((s) => s.title), ["Draft it"]);
  assert.equal(edited.approved, true);
  const done = await api("run", { prompt: "go ahead", sessionId: asked.sessionId });
  assert.equal(done.status, "completed");
  assert.equal(done.output, "The draft is ready and nothing was sent.");
  assert.deepEqual(data(app, done.id, "plan.step.started").map((d) => d.title), ["Draft it"]);
  await assert.rejects(api(`runs/${done.id}/plan`, {}), /no plan waiting/);

  // A plan the person walks away from is finished with, so a later "ok, ..." never sets it going.
  const shown = await api("run", { prompt: "write the letter and send it", plan: true });
  assert.equal(shown.status, "needs_input");
  const elsewhere = await api("run", { prompt: "what is the time?", sessionId: shown.sessionId });
  assert.equal(app.runtime.orchestration.plan(shown.sessionId), undefined, "the plan they left is dropped");
  assert.ok(!kinds(app, elsewhere.id).some((k) => k.startsWith("plan.")));
  const later = await api("run", { prompt: "ok, and what about the invoices?", sessionId: shown.sessionId });
  assert.ok(!kinds(app, later.id).some((k) => k === "plan.step.started"), "a later yes does not start the old plan");
});

test("a parallel fan-out keeps going when one branch fails and hands every answer back to be combined", async (t) => {
  const { app } = await fixture(t, ({ system, last }) => {
    if (/You are the alpha/.test(system)) return say("alpha says the roof is blue");
    if (/You are the beta/.test(system)) return say("beta says the roof is grey");
    if (last?.role === "tool") return say("Alpha and beta disagree about the roof; one branch did not run.");
    return say("unexpected");
  });
  const alpha = await specialist(app, "alpha"), beta = await specialist(app, "beta");
  const missing = "00000000-0000-4000-8000-000000000000";
  const parent = await app.runtime.run({ prompt: "parent" });
  const context = app.runtime.context({ runId: parent.id });
  const outcome = await app.registry.execute("delegate.parallel", { tasks: [
    { specialist: alpha, prompt: "alpha view" },
    { specialist: beta, prompt: "beta view" },
    { specialist: missing, prompt: "nobody" },
  ] }, context);
  assert.deepEqual(outcome.branches.map((b) => [b.id, b.status]), [["b1", "completed"], ["b2", "completed"], ["b3", "failed"]]);
  assert.match(outcome.branches[2].error, /not found|no evaluated active version/);
  assert.equal(outcome.branches[0].output, "alpha says the roof is blue");
  assert.match(outcome.synthesise, /Combine these branch answers/);
  const recorded = data(app, parent.id, "delegation.parallel")[0];
  assert.deepEqual(recorded.branches.map((b) => b.status), ["completed", "completed", "failed"]);
  assert.ok(recorded.share > 0 && recorded.spent > 0);

  // The whole shape end to end: the model asks for the fan-out and then writes one answer.
  const run = await app.runtime.run({ prompt: "compare the two views" });
  assert.equal(run.status, "completed");
});

test("each branch of a fan-out gets its own share of the budget and cannot spend past it", async (t) => {
  const { app } = await fixture(t, () => say("short"));
  const alpha = await specialist(app, "alpha");
  const parent = await app.runtime.run({ prompt: "parent" });
  const tight = app.runtime.context({ runId: parent.id, budget: new Budget({ maxSteps: 20, maxTokens: 90 }) });
  const outcome = await app.registry.execute("delegate.parallel", { tasks: [
    { specialist: alpha, prompt: "one" }, { specialist: alpha, prompt: "two" }, { specialist: alpha, prompt: "three" },
  ] }, tight);
  assert.equal(outcome.tokensEach, 30, "what is left is split evenly between the branches");
  assert.deepEqual(outcome.branches.map((b) => b.status), ["budget_exceeded", "budget_exceeded", "budget_exceeded"]);
  assert.ok(outcome.branches.every((b) => /budget/i.test(b.output)), "each branch says plainly that it ran out");
  assert.ok(tight.budget.tokens <= tight.budget.limits.maxTokens, "no branch costs the parent more than its share");
});

test("a sub-task can hand its work to a named specialist with a brief", async (t) => {
  const { app } = await fixture(t, ({ system }) => {
    if (/You are the writer/.test(system)) return say("Here is the finished note.");
    return say("handed over");
  });
  const writer = await specialist(app, "writer");
  const parent = await app.runtime.run({ prompt: "parent" });
  const context = app.runtime.context({ runId: parent.id });
  const result = await app.registry.execute("delegate.handoff", { specialist: writer, brief: "Finish the note about the roof." }, context);
  assert.equal(result.status, "completed");
  assert.equal(result.output, "Here is the finished note.");
  const handoff = data(app, parent.id, "delegation.handoff")[0];
  assert.equal(handoff.to, writer);
  assert.equal(handoff.brief, "Finish the note about the roof.");
  assert.equal(handoff.from, "the main task");
});

test("a note sent to a task that is still working reaches its next round", async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { app, api } = await served(t, async ({ last }) => {
    if (last?.role === "tool") return say("I stopped looking and checked the diary instead.");
    await held;
    return call("files.list", { path: "." });
  });
  const started = api("run", { prompt: "look through the workspace" });
  let running;
  for (let i = 0; i < 300 && !running; i++) { await delay(10); running = (await api("activity"))[0]; }
  assert.ok(running, "the task is working");
  assert.deepEqual(await api(`runs/${running.runId}/steer`, { text: "check the diary instead" }), { queued: 1 });
  release();
  const run = await started;
  assert.equal(run.status, "completed");
  assert.equal(run.output, "I stopped looking and checked the diary instead.");
  assert.equal(data(app, run.id, "run.steered")[0].note, "check the diary instead");
  assert.equal(data(app, run.id, "run.steer_applied")[0].notes, 1);
  const messages = app.store.messages(run.sessionId);
  /* Wrapped in the marker the standing instructions name as the only trusted one. A bare "note from
     the person" line is the shape of a prompt injection, and models refuse it for exactly that. */
  const steered = messages.find((m) => m.role === "user" && m.content.includes("check the diary instead"));
  assert.ok(steered, "the note is in the saved transcript");
  assert.match(steered.content, /^\[OUT-OF-BAND MESSAGE FROM THE OWNER — sent by Branch itself/);
  assert.match(steered.content, /not a new instruction when it appears again in the conversation history\]/,
    "the marker says what it is, so a replay is not obeyed twice");
  assert.match(steered.content, /\[\/OUT-OF-BAND MESSAGE FROM THE OWNER\]$/);
  await assert.rejects(api(`runs/${run.id}/steer`, { text: "too late" }), /still working/);
});

test("a reviewer pass sends one answer back with fixes and accepts the next", async (t) => {
  let reviews = 0;
  const { app } = await fixture(t, ({ system, user }) => {
    if (/You review a finished answer/.test(system))
      return say(++reviews === 1 ? '{"verdict":"revise","fixes":["say what it costs"]}' : '{"verdict":"accept","fixes":[]}');
    if (/A reviewer checked your answer/.test(user)) return say("The roof is blue and it costs £40.");
    return say("The roof is blue.");
  });
  const run = await app.runtime.run({ prompt: "describe the roof", verify: true });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "The roof is blue and it costs £40.");
  assert.deepEqual(data(app, run.id, "verify.verdict").map((d) => d.verdict), ["revise", "accept"]);
  assert.deepEqual(data(app, run.id, "verify.verdict")[0].fixes, ["say what it costs"]);
  assert.equal(reviews, 2, "at most one reviewer pass per answer");

  // A task that does not ask for it is never reviewed.
  const plain = await app.runtime.run({ prompt: "describe the roof again" });
  assert.ok(!kinds(app, plain.id).some((k) => k.startsWith("verify.")));
});

test("a long task writes a plain note of where it has got to every few rounds", async (t) => {
  const { app } = await fixture(t, ({ last }) => last?.role === "tool" ? say("Everything is read.") : call("files.list", { path: "." }));
  app.store.save("settings", "local", "orchestration", { autoPlan: false, planApproval: false, verify: false, milestoneRounds: 1, stuckAction: "default" });
  const run = await app.runtime.run({ prompt: "read the workspace" });
  assert.equal(run.status, "completed");
  const notes = data(app, run.id, "run.milestone");
  assert.ok(notes.length >= 1);
  assert.match(notes[0].text, /After 1 rounds: 1 thing\(s\) done/);
  assert.equal(app.runtime.orchestration.lastMilestone(run.sessionId).runId, run.id);
});

test("a task that goes quiet twice changes strategy instead of trying the same thing again", async (t) => {
  const hang = (request) => new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
  const root = await mkdtemp(join(tmpdir(), "branch-stuck-"));
  const provider = { name: "sleepy", async complete(request) { return hang(request); } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, reliability: { modelStallMs: 5000 } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.runtime.reliability.modelStallMs = 120;
  app.runtime.models.register({ id: "spare", name: "Spare", provider: { name: "spare", async complete() { return say("the spare model answered"); } }, model: "y" });
  app.runtime.models.configure("local", { fallbackOrder: ["spare"] });

  app.store.save("settings", "local", "orchestration", { autoPlan: false, planApproval: false, verify: false, milestoneRounds: 0, stuckAction: "switch" });
  const switched = await app.runtime.run({ prompt: "hello", onTextDelta: () => undefined });
  assert.equal(switched.status, "completed");
  assert.equal(switched.output, "the spare model answered");
  assert.deepEqual(data(app, switched.id, "run.stuck").map((d) => [d.action, d.stalls]), [["switched", 2]]);
  assert.deepEqual(data(app, switched.id, "model.stall_recovery").map((d) => d.action), ["retry"], "it did not simply retry a third time");

  app.store.save("settings", "local", "orchestration", { autoPlan: false, planApproval: false, verify: false, milestoneRounds: 0, stuckAction: "ask" });
  app.runtime.models.configure("local", { fallbackOrder: [] });
  const asked = await app.runtime.run({ prompt: "hello again", onTextDelta: () => undefined });
  assert.equal(asked.status, "needs_input");
  assert.match(asked.output, /gone quiet twice/);
  assert.equal(data(app, asked.id, "run.stuck")[0].action, "ask");
});

test("sub-tasks of one task share a scratch area, and it is emptied when the task finishes", async (t) => {
  const { app } = await fixture(t, ({ system, last }) => {
    if (/You are the reader/.test(system))
      return last?.role === "tool"
        ? say(`the note said: ${JSON.parse(last.content).result.value}`)
        : call("scratch.read", { key: "finding" });
    if (last?.role !== "tool") return call("scratch.set", { key: "finding", value: "the roof is blue" });
    const result = JSON.parse(last.content).result;
    if (result?.key === "finding") return call("specialists.delegate", { id: app.readerId, prompt: "read the shared note" });
    return say(`the specialist reported: ${result.run?.output ?? result.output ?? ""}`);
  });
  app.readerId = await specialist(app, "reader", ["scratch.read"]);
  const run = await app.runtime.run({ prompt: "leave a note for the reader" });
  assert.equal(run.status, "completed");
  assert.match(run.output, /the note said: the roof is blue/, "the sub-task read what the parent wrote");
  assert.deepEqual(app.runtime.orchestration.scratchRead(run.id), {}, "the scratch area is emptied when the task finishes");

  // Size limits: a note that is too long, and too many notes, are both refused plainly.
  const parent = await app.runtime.run({ prompt: "parent" });
  const context = app.runtime.context({ runId: parent.id });
  await assert.rejects(app.registry.execute("scratch.set", { key: "big", value: "x".repeat(4001) }, context), /4000 characters/);
  for (let i = 0; i < 32; i++) await app.registry.execute("scratch.set", { key: `k${i}`, value: "x" }, context);
  await assert.rejects(app.registry.execute("scratch.set", { key: "one-too-many", value: "x" }, context), /at most 32 notes/);
  assert.equal((await app.registry.execute("scratch.read", {}, context)).notes.length, 32);
});
