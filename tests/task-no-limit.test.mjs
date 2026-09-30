/**
 * "No limit" for a task's tokens, steps and rounds (the owner, 2026-09-29: "Token budget exhausted" kept stopping work on a
 * ChatGPT plan). The ship-on rule: limits only where money is spent. So auto is no limit while a sign-in (no per-token
 * charge) answers, and the old finite figures while an API key billed per token does; "No limit" can be chosen for each,
 * and the loop guard still stops a runaway. Local only: a ChatGPT sign-in whose fetch is a fake, and scripted keys.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Budget, BudgetError, ChatGPTProvider, createBranch } from "../dist/index.js";
import { readKnobs, saveKnobs } from "../dist/knobs/settings.js";
import { taskBudget } from "../dist/knobs/apply.js";
import { applyChanges, changesFor } from "../dist/settings-kit/changes.js";
import { clarifyRequest } from "../dist/settings-kit/clarify.js";
import { settingsKitWriters } from "../dist/settings-kit/writers.js";
import { discardTemp } from "./temp-dir.mjs";

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = `${b64({ alg: "none" })}.${b64({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_1" } })}.sig`;
const auth = { accessToken: async () => token };

/** A Responses stream that answers with `events`. */
function stream(events) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const usage = { type: "response.completed", response: { usage: { input_tokens: 10, output_tokens: 2 } } };

/** The model's side, the same for a sign-in and a key: `next(n, request)` gives round n's tool call, or null to finish. */
function sayings(next) {
  const seen = { rounds: 0 };
  const turn = (probe) => {
    const call = next(++seen.rounds);
    return call ? { call: { ...call, name: probe } } : { text: "Done." };
  };
  return { seen, turn };
}
/** A ChatGPT sign-in (no per-token charge) whose requests go to a fake. */
function signIn(next) {
  const { seen, turn } = sayings(next);
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const probe = body.tools.find((tool) => tool.description === "test probe")?.name ?? "not-offered";
    const said = turn(probe);
    return stream(said.call
      ? [{ type: "response.output_item.done", item: { type: "function_call", call_id: `c${seen.rounds}`, name: said.call.name, arguments: said.call.arguments } }, usage]
      : [{ type: "response.output_text.delta", delta: said.text }, usage]);
  };
  return { seen, provider: new ChatGPTProvider(auth, { model: "gpt-6-sol", fetch }) };
}
/** A connection billed per token (a scripted key). */
function billedKey(next) {
  const { seen, turn } = sayings(next);
  return { seen, provider: { name: "scripted", async complete() {
    const said = turn("probe.step");
    return said.call ? { content: "", toolCalls: [{ id: `c${seen.rounds}`, ...said.call }] } : { content: said.text, toolCalls: [] };
  } } };
}

async function branch(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-no-limit-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const limits = [];
  app.registry.register({ name: "probe.step", permission: "files.read", description: "test probe", parameters: z.object({ n: z.number() }).strict(),
    execute: async (input, context) => { limits.push({ ...context.budget.limits }); return `step ${input.n}`; } });
  return { app, owner: app.runtime.owner, limits };
}
const distinct = (upTo) => (n) => (n <= upTo ? { arguments: JSON.stringify({ n }) } : null);

test("auto is no limit on a sign-in and the old figures on a key; a figure or No limit holds on both", async (t) => {
  const { app, owner } = await branch(t, { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } });
  assert.deepEqual(readKnobs(app.store, owner, "limits").maxSteps, null, "the step limit ships as auto");
  assert.deepEqual(taskBudget(app.store, owner), { maxSteps: Infinity, maxTokens: Infinity, billed: { maxSteps: 60, maxTokens: 200000 } });
  saveKnobs(app.store, owner, "limits", { maxSteps: "none", maxTaskTokens: "none" });
  assert.deepEqual(taskBudget(app.store, owner), { maxSteps: Infinity, maxTokens: Infinity, billed: { maxSteps: Infinity, maxTokens: Infinity } });
  saveKnobs(app.store, owner, "limits", { maxSteps: 90, maxTaskTokens: 300000 });
  assert.deepEqual(taskBudget(app.store, owner), { maxSteps: 90, maxTokens: 300000, billed: { maxSteps: 90, maxTokens: 300000 } });
  assert.throws(() => saveKnobs(app.store, owner, "limits", { maxTaskTokens: "lots" }));
});

test("a record saved with the old shipped 60 steps reads as auto; a 60 the owner chose stays", async (t) => {
  const { app, owner } = await branch(t, { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } });
  app.store.save("settings", owner, "knobs-limits", { maxSteps: 60, maxTaskTokens: 400000 }); // written whole when another limit was saved
  assert.equal(readKnobs(app.store, owner, "limits").maxSteps, null);
  saveKnobs(app.store, owner, "limits", { maxSteps: 60 });
  assert.equal(readKnobs(app.store, owner, "limits").maxSteps, 60);
});

test("on a ChatGPT sign-in with auto limits a long task runs past 60 steps and 40 rounds and finishes", async (t) => {
  const model = signIn(distinct(70));
  const { app, limits } = await branch(t, model.provider);
  const run = await app.runtime.run({ prompt: "work through seventy steps" });
  assert.equal(run.status, "completed", run.output);
  assert.equal(model.seen.rounds, 71);
  assert.equal(limits.length, 70);
  assert.deepEqual(limits[0], { maxSteps: Infinity, maxTokens: Infinity });
});

test("on a key billed per token auto keeps the finite limits and the same task stops", async (t) => {
  const model = billedKey(distinct(70));
  const { app, limits } = await branch(t, model.provider);
  const run = await app.runtime.run({ prompt: "work through seventy steps" });
  assert.notEqual(run.status, "completed");
  // The launch figure of 12 rounds, and one more for the last word it gives when it stops.
  assert.ok(model.seen.rounds <= 13, `a key stops at the launch round figure, not ${model.seen.rounds}`);
  assert.deepEqual(limits[0], { maxSteps: 60, maxTokens: 200000 });
});

test("a figure the owner set still stops a sign-in's task", async (t) => {
  const model = signIn(distinct(70));
  const { app, owner } = await branch(t, model.provider);
  saveKnobs(app.store, owner, "limits", { maxSteps: 5 });
  const run = await app.runtime.run({ prompt: "work through seventy steps" });
  assert.notEqual(run.status, "completed");
  assert.match(run.output, /as many steps as one task may \(5\)/);
});

test("with No limit everywhere the loop guard still stops a runaway that repeats one call", async (t) => {
  const model = signIn(() => ({ arguments: JSON.stringify({ n: 1 }) }));
  const { app, owner } = await branch(t, model.provider);
  saveKnobs(app.store, owner, "limits", { maxSteps: "none", maxModelRounds: "none", maxTaskTokens: "none" });
  const run = await app.runtime.run({ prompt: "go round and round" });
  assert.notEqual(run.status, "completed");
  assert.ok(model.seen.rounds < 30, `stopped after ${model.seen.rounds} rounds`);
  assert.ok(app.store.events(run.id).some((event) => event.kind === "loop.stopped"), "the loop guard stopped it");
});

test("the billed limits count only what was spent while a key answered, and shares keep No limit", () => {
  const budget = new Budget({ maxSteps: Infinity, maxTokens: Infinity, billed: { maxSteps: 3, maxTokens: 200000 } });
  budget.answeredBy(false);
  budget.charge(300000);
  for (let i = 0; i < 5; i++) budget.step(AbortSignal.timeout(1000));
  budget.answeredBy(true);
  assert.equal(budget.remaining(), 200000, "a key may still spend its own 200,000");
  budget.charge(150000);
  assert.throws(() => budget.charge(60000), BudgetError);
  for (let i = 0; i < 3; i++) budget.step(AbortSignal.timeout(1000));
  assert.throws(() => budget.step(AbortSignal.timeout(1000)), BudgetError, "the key's three steps are used; the five before it were free");
  const free = new Budget({ maxSteps: Infinity, maxTokens: Infinity });
  assert.deepEqual(free.share(3), { maxSteps: Infinity, maxTokens: Infinity });
  assert.doesNotThrow(() => new Budget(free.share(3)));
  assert.throws(() => new Budget({ maxSteps: 1.5, maxTokens: 10 }), /Invalid budget/);
});

test("Branch's settings tools offer No limit for tokens, steps and rounds, and set it", async (t) => {
  const { app, owner } = await branch(t, { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } });
  const asked = clarifyRequest(app.store, owner, { request: "tokens per task" });
  assert.equal(asked.status, "ask");
  assert.match(asked.question, /or auto, or no limit\./, "the tool says No limit is a choice");
  assert.equal(clarifyRequest(app.store, owner, { request: "tokens per task", value: "no limit" }).status, "ready");
  const proposals = [
    { key: "task-tokens", field: "taskAllowance", value: "no limit" },
    { key: "step-limit", field: "maxSteps", value: "unlimited" },
    { key: "round-limit", field: "maxModelRounds", value: "none" },
  ];
  const { changes, refused } = changesFor(app.store, owner, proposals);
  assert.deepEqual(refused ?? [], []);
  assert.equal(changes.length, 3);
  applyChanges(app.store, owner, changes, { accept: changes.map((change) => change.id), confirmLoosening: true, why: "test", writers: settingsKitWriters(app) });
  const limits = readKnobs(app.store, owner, "limits");
  assert.deepEqual([limits.maxTaskTokens, limits.maxSteps, limits.maxModelRounds], ["none", "none", "none"]);
  assert.deepEqual(taskBudget(app.store, owner).billed, { maxSteps: Infinity, maxTokens: Infinity });
  const back = changesFor(app.store, owner, [{ key: "task-tokens", field: "taskAllowance", value: "auto" }]);
  applyChanges(app.store, owner, back.changes, { accept: back.changes.map((change) => change.id), confirmLoosening: true, why: "test", writers: settingsKitWriters(app) });
  assert.equal(readKnobs(app.store, owner, "limits").maxTaskTokens, null);
});
