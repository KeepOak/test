/**
 * RES-188: a routine's month of use, counted from its own turns and their helpers only. Each call is priced by its own
 * model and billing kind; a plan sign-in or a missing price is unknown, never free. An enabled budget stops the next
 * model round once the month's estimate reaches it, and holds when the record is incomplete.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { routineUsage, routineBudgetRefusal, saveRoutineBudget } from "../dist/routine-usage.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-routine-usage-"));
  const provider = { name: "scripted", async complete() { return { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close().catch(() => undefined); await discardTemp(root); });
  const { store } = app, owner = app.runtime.owner;
  const schedule = (id, kind = "task") => { store.save("schedules", owner, id, { kind, prompt: `routine ${id}` }); return id; };
  const turn = (scheduleId) => {
    const run = store.createRun(owner, `turn of ${scheduleId}`);
    store.event(run.id, "run.started", {});
    store.event(run.id, "schedule.turn", { scheduleId });
    return run.id;
  };
  const helper = (parentRunId) => {
    const run = store.createRun(owner, "helper");
    store.event(run.id, "run.started", { parentRunId });
    return run.id;
  };
  const call = (runId, usageKind, estimatedInput, model = "gpt-4o") =>
    store.event(runId, "model.completed", { toolCalls: 0, usageKind, model, estimatedInput, estimatedOutput: 0 });
  return { store, owner, schedule, turn, helper, call };
}

test("a routine counts its own turns and helpers, prices each call by its own model, and keeps other routines out", async (t) => {
  const { store, owner, schedule, turn, helper, call } = await fixture(t);
  const daily = schedule("daily"), other = schedule("other");
  const root = turn(daily), child = helper(root), elsewhere = turn(other);
  call(root, "api-key", 1_000_000); // gpt-4o input is $2.50 per million
  call(child, "local", 500);
  store.event(root, "spend.recorded", { dollars: 1.25 });
  call(elsewhere, "api-key", 4_000_000);
  const usage = routineUsage(store, owner, daily);
  assert.equal(usage.turns, 1, "one turn of this routine");
  assert.equal(usage.tasks, 2, "the turn and its helper");
  assert.equal(usage.modelCalls, 2);
  assert.equal(usage.tokens, 1_000_500);
  assert.equal(usage.estimatedModelDollars, 2.5, "the other routine's call is not counted here");
  assert.equal(usage.recordedSpendDollars, 1.25);
  assert.equal(usage.unpricedCalls, 0, "a local model has no provider charge");
  call(child, "chatgpt", 100);
  assert.equal(routineUsage(store, owner, daily).unpricedCalls, 1, "a plan sign-in is unknown, not free");
});

test("an enabled budget stops the next round at its limit, holds on unknown costs, and cannot be set on evaluations", async (t) => {
  const { store, owner, schedule, turn, helper, call } = await fixture(t);
  const daily = schedule("daily"), priced = { model: "gpt-4o" };
  const root = turn(daily), child = helper(root);
  call(root, "api-key", 1_000_000);
  assert.equal(routineBudgetRefusal(store, owner, child, priced, "api-key"), null, "no budget, no stop");
  saveRoutineBudget(store, owner, daily, { monthlyEstimatedDollars: 10 });
  assert.equal(routineBudgetRefusal(store, owner, child, priced, "api-key"), null, "under the budget");
  assert.match(routineBudgetRefusal(store, owner, child, priced, "chatgpt"), /cannot price/, "a sign-in round cannot be priced");
  saveRoutineBudget(store, owner, daily, { monthlyEstimatedDollars: 2 });
  assert.match(routineBudgetRefusal(store, owner, child, priced, "api-key"), /reached its monthly estimate budget/,
    "a helper of the routine is stopped too");
  saveRoutineBudget(store, owner, daily, { monthlyEstimatedDollars: 10 });
  call(child, "chatgpt", 100);
  assert.match(routineBudgetRefusal(store, owner, root, priced, "api-key"), /incomplete/, "unknown use holds the budget");
  const unrelated = store.createRun(owner, "not a routine");
  assert.equal(routineBudgetRefusal(store, owner, unrelated.id, priced, "api-key"), null, "a task outside routines is untouched");
});

test("an evaluation routine's judges and a resumed turn count toward its budget", async (t) => {
  const { store, owner, schedule, turn, call } = await fixture(t);
  const grader = schedule("grader", "evaluation"), priced = { model: "gpt-4o" };
  const root = turn(grader);
  const judge = store.createRun(owner, "judge");
  store.event(judge.id, "run.started", {});
  store.event(judge.id, "routine.parent", { runId: root });
  const resumed = store.createRun(owner, "resumed turn");
  store.event(resumed.id, "run.started", { resumedFrom: root });
  call(judge.id, "api-key", 1_000_000);
  call(resumed.id, "api-key", 400_000);
  const usage = routineUsage(store, owner, grader);
  assert.equal(usage.tasks, 3, "the turn, its judge and its resumed task");
  assert.equal(usage.estimatedModelDollars, 3.5);
  saveRoutineBudget(store, owner, grader, { monthlyEstimatedDollars: 3 });
  assert.match(routineBudgetRefusal(store, owner, judge.id, priced, "api-key"), /reached its monthly estimate budget/,
    "a judge is stopped by its evaluation routine's budget");
});
