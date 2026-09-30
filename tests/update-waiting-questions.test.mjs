/**
 * Dogfood F4: "update by itself" held for five conversations waiting hours for an answer, and the card called them
 * working. A task stopped on a question holds an update only while the question is under an hour old.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { busyTaskCount, busyTasks, maxBusyHoldMs, noteStalledLooks, noteUpdateLook, updateProblem, questionHoldsUpdateMs, staleTaskMs, updateHold, updatePlan } from "../dist/comfort/auto-update.js";
import { saveComfort } from "../dist/comfort/settings.js";

test("F4 working tasks and fresh questions hold an update; a question older than an hour does not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-f4-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const asked = (ms) => {
    const run = app.store.createRun(owner, "a question");
    app.store.finish(run.id, "needs_input", "May I?");
    app.store.sqlite.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(new Date(Date.now() - ms).toISOString(), run.id);
  };
  asked(3 * 60 * 60 * 1000);
  asked(questionHoldsUpdateMs + 60_000);
  assert.deepEqual(busyTasks(app.store), { working: 0, asking: 0, stale: [] }, "questions left past ten minutes hold nothing");
  saveComfort(app.store, owner, "notify", { autoUpdate: "install" });
  assert.equal(updatePlan(app.store, owner, { busyTasks: busyTaskCount(app.store), updaterPhase: "available" }).step, "install",
    "update by itself goes ahead past old questions");
  asked(2 * 60_000);
  app.store.createRun(owner, "working");
  assert.deepEqual(busyTasks(app.store), { working: 1, asking: 1, stale: [] });
  assert.equal(busyTaskCount(app.store), 2);
  assert.equal(updatePlan(app.store, owner, { busyTasks: busyTaskCount(app.store), updaterPhase: "available" }).step, "nothing");
});

test("a task marked working that has recorded nothing past the stale window holds nothing, and is reported", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-stale-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  const old = new Date(Date.now() - staleTaskMs - 60_000).toISOString();
  const stuck = app.store.createRun(owner, "stuck since this morning");
  app.store.sqlite.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(old, stuck.id);
  app.store.sqlite.prepare("UPDATE events SET created_at=? WHERE run_id=?").run(old, stuck.id);
  const quiet = app.store.createRun(owner, "long tool, still recording");
  app.store.sqlite.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(old, quiet.id);
  app.store.event(quiet.id, "tool.started", { name: "files.list" });
  assert.deepEqual(busyTasks(app.store), { working: 1, asking: 0, stale: [stuck.id] }, "a task that still records is working; a silent one is stale");
  const held = updateHold(app.store, owner, busyTasks(app.store));
  assert.equal(held.working, 1);
  assert.deepEqual(held.stale, [stuck.id]);
});

test("an update waits for busy tasks at most three hours, then goes ahead and says why", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-hold-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner;
  saveComfort(app.store, owner, "notify", { autoUpdate: "install" });
  app.store.createRun(owner, "a task that never ends");
  const start = Date.now();
  const first = updateHold(app.store, owner, busyTasks(app.store, start), start);
  assert.deepEqual([first.working, first.overdue], [1, 0]);
  assert.equal(updatePlan(app.store, owner, { busyTasks: 1, workingTasks: 1, updaterPhase: "available" }).step, "nothing");
  const later = start + maxBusyHoldMs + 1000;
  const overdue = updateHold(app.store, owner, busyTasks(app.store, later, later - start + staleTaskMs), later);
  assert.deepEqual([overdue.working, overdue.asking, overdue.overdue], [0, 0, 1], "past the limit, busy tasks no longer hold it");
  const plan = updatePlan(app.store, owner, { busyTasks: 0, workingTasks: 0, overdueTasks: overdue.overdue, updaterPhase: "available" });
  assert.equal(plan.step, "install");
  assert.match(plan.reason, /waited three hours for 1 task\(s\).*carries on after it/);
  // Once nothing holds it, the clock starts again for the next time.
  app.store.sqlite.prepare("UPDATE tasks SET status='completed'").run();
  assert.equal(updateHold(app.store, owner, busyTasks(app.store, later), later).heldSince, null);
});

test("an update loop that stops looking is said as a problem, and a look clears it: never silent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-stalled-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const owner = app.runtime.owner, start = Date.now();
  saveComfort(app.store, owner, "notify", { autoUpdate: "install", releaseChannel: "beta" });
  noteUpdateLook(app.store, owner, new Date(start));
  assert.equal(noteStalledLooks(app.store, owner, start - 60_000, start + 10 * 60_000), null, "ten minutes: still looking");
  const said = noteStalledLooks(app.store, owner, start - 60_000, start + 16 * 60_000);
  assert.match(said ?? "", /has not looked for an update since .* updating by itself has stopped/);
  assert.equal(updateProblem(app.store, owner)?.message, said, "Settings › Updates says it");
  saveComfort(app.store, owner, "notify", { autoUpdate: "off" });
  assert.equal(noteStalledLooks(app.store, owner, start, start + 60 * 60_000), null, "off: nothing is expected to look");
});
