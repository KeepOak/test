/**
 * models-ui (P2, cost per Trunk): the most a Trunk may spend in a month (src/trunks/spend-cap.ts).
 *
 * - Nothing saved: no limit, as before. Only the owner's route changes it; it is checked, logged, and never carried
 *   by the generic Trunk edit.
 * - What it spent is this month's turns and the helpers they started, at the price on file; another Trunk's work,
 *   last month's, and the owner's own are not counted, and a task with no price is named as uncounted.
 * - Once the month reaches the limit, a turn does not start, and a turn already running stops before its next model
 *   call, each in one plain sentence. The owner's own assistant is never held by a Trunk's limit.
 *
 * Mutation notes (each turns this file red):
 * - src/store.ts trunkTaskIdsSince: drop the helper half of the family  -> "helpers count" fails.
 * - src/runtime.ts execute: drop the trunkSpendRefusal check             -> "a turn does not start" fails.
 * - src/runtime.ts checkSpendCap: drop the Trunk check                   -> "stops before its next model call" fails.
 * - src/trunks/spend-cap.ts taskCost: count a task with no price as 0    -> the unpriced count fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { monthStart } from "../dist/trunks/spend-cap.js";
import { brain, on } from "./trunks-helpers.mjs";

async function fixture(t, rules = []) {
  const root = await mkdtemp(join(tmpdir(), "branch-trunk-spend-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: brain(rules) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  on(app, "conversations");
  // Two dollars a million input tokens, so the sums below are exact.
  app.store.save("settings", app.runtime.owner, "pricing", { overrides: { "priced-model": { input: 2, output: 0 } } });
  const scout = app.trunks.create({ name: "Scout", title: "", description: "" });
  const other = app.trunks.create({ name: "Other", title: "", description: "" });
  await app.trunks.introduced();
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  const ask = (path, body) => fetch(new URL(path, server.url), { method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then(async (response) => ({ status: response.status, body: await response.json() }));
  return { app, scout, other, ask };
}

/** A finished task of the Trunk's (or a helper of `parent`), on `model`, with a million input tokens per `millions`. */
function spent(app, { trunkId = null, parent = null, model = "priced-model", millions = 1 }) {
  const run = app.store.createRun(app.runtime.owner, "earlier work");
  if (trunkId) app.store.event(run.id, "trunk.turn", { trunkId });
  app.store.event(run.id, "run.started", { provider: "scripted", parentRunId: parent });
  if (model) app.store.event(run.id, "model.selected", { model });
  app.store.addUsage(run.id, 0, 0, { input: millions * 1_000_000, output: 0 });
  return run.id;
}

test("the route: no limit until set; spending counts this month's turns and their helpers, checked and logged", async (t) => {
  const { app, scout, other, ask } = await fixture(t);
  const fresh = await ask(`/api/trunks/${scout.id}/spend`);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  // Its introduction was its first turn; the scripted model has no price, so it is counted as a task with none.
  assert.deepEqual([fresh.body.monthlyUsd, fresh.body.spentUsd], [null, 0]);
  const before = { tasks: fresh.body.tasks, unpriced: fresh.body.unpricedTasks };
  assert.equal(fresh.body.since, monthStart(Date.now()));

  const turn = spent(app, { trunkId: scout.id });                 // $2
  spent(app, { parent: turn, millions: 0.5 });                     // its helper, $1: helpers count
  spent(app, { trunkId: scout.id, model: "no-price-model" });      // no price on file: named, not counted
  spent(app, { trunkId: other.id, millions: 3 });                  // another Trunk's
  spent(app, { millions: 4 });                                     // the owner's own
  const old = spent(app, { trunkId: scout.id, millions: 5 });      // last month's
  app.store.db.prepare("UPDATE events SET created_at=? WHERE run_id=?").run(new Date(Date.parse(monthStart(Date.now())) - 86_400_000).toISOString(), old);

  const counted = (await ask(`/api/trunks/${scout.id}/spend`)).body;
  assert.deepEqual([counted.spentUsd, counted.tasks - before.tasks, counted.unpricedTasks - before.unpriced], [3, 3, 1], JSON.stringify(counted));

  for (const bad of [{ monthlyUsd: 0 }, { monthlyUsd: -1 }, { monthlyUsd: "5" }, { limit: 5 }])
    assert.equal((await ask(`/api/trunks/${scout.id}/spend`, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await ask(`/api/trunks/${scout.id}`, { monthlyUsd: 5 })).status, 400, "the generic edit never carries it");

  const saved = await ask(`/api/trunks/${scout.id}/spend`, { monthlyUsd: 10 });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.monthlyUsd, 10);
  assert.equal((await ask(`/api/trunks/${other.id}/spend`)).body.monthlyUsd, null, "one Trunk's limit is its own");
  const log = (await ask("/api/audit")).body;
  assert.ok((log.entries ?? log).some((entry) => entry.action === "trunk.spend_cap" && /Scout/.test(entry.subject)), "written in the activity log");
  assert.equal((await ask(`/api/trunks/${scout.id}/spend`, { monthlyUsd: null })).body.monthlyUsd, null, "cleared");
});

test("a turn does not start once the month reaches the limit; the owner's own assistant still answers", async (t) => {
  const { app, scout, ask } = await fixture(t);
  spent(app, { trunkId: scout.id, millions: 2.5 }); // $5
  await ask(`/api/trunks/${scout.id}/spend`, { monthlyUsd: 5 });
  const { sessionId } = app.trunks.startConversation({ trunkId: scout.id });
  await assert.rejects(app.runtime.run({ prompt: "one more thing", sessionId }),
    /^Error: Scout has spent about \$5\.00 this month, which reaches its limit of \$5\.00, so it stopped\. Raise or clear the limit in Edit Trunk › Accounts\.$/);
  assert.equal((await app.runtime.run({ prompt: "hi" })).status, "completed", "the owner's own work has no Trunk limit");
  await ask(`/api/trunks/${scout.id}/spend`, { monthlyUsd: 50 });
  assert.equal((await app.runtime.run({ prompt: "one more thing", sessionId })).status, "completed", "raised, it works again");
});

test("a turn already running stops before its next model call once the month reaches the limit", async (t) => {
  let app, scout, calls = 0;
  const rules = [({ last }) => {
    if (!/keep going/.test(last?.content ?? "") && last?.role !== "tool") return null;
    calls += 1;
    if (calls > 1) return "Still going.";
    // While the turn works, the month reaches the limit: another of its tasks finished meanwhile.
    spent(app, { trunkId: scout.id, millions: 10 });
    app.trunks.spendCap.view(scout.id); // counted afresh, as the window's reading does
    return { content: "", toolCalls: [{ id: "c1", name: "no.such.tool", arguments: "{}" }] };
  }];
  ({ app, scout } = await fixture(t, rules));
  app.trunks.spendCap.set(scout.id, { monthlyUsd: 5 });
  const { sessionId } = app.trunks.startConversation({ trunkId: scout.id });
  const run = await app.runtime.run({ prompt: "keep going", sessionId });
  assert.equal(calls, 1, "no second model call");
  assert.notEqual(run.status, "completed");
  assert.match(run.output, /Scout has spent about \$20\.00 this month, which reaches its limit of \$5\.00, so it stopped\./);
});
