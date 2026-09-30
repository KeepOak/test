import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { canopyView } from "../dist/canopy.js";
import { taskInTree } from "../dist/orchard/ancestry.js";
import { discardTemp } from "./temp-dir.mjs";

test("Canopy includes old active work, helper ancestry, pause and resume, and all computers and boards", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-canopy-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: { name: "scripted", async complete() { return { content: "Done", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const { store, runtime } = app, owner = runtime.owner;
  const trunk = app.trunks.create({ name: "Oak" });
  const parent = store.createRun(owner, "Older live task");
  store.event(parent.id, "trunk.turn", { trunkId: trunk.id });
  const helper = store.createRun(owner, "Its helper");
  store.event(helper.id, "run.started", { parentRunId: parent.id });
  const paused = store.createRun(owner, "Paused old task");
  store.event(paused.id, "run.paused", {}); store.finish(paused.id, "interrupted", "");
  for (let i = 0; i < 105; i++) store.finish(store.createRun(owner, "Finished history").id, "completed", "");
  const waiting = store.createRun(owner, "Waiting task"); store.finish(waiting.id, "needs_input", "");
  const grandchild = store.createRun(owner, "Nested helper");
  store.event(grandchild.id, "run.started", { parentRunId: helper.id });
  store.finish(grandchild.id, "needs_input", "");
  const view = () => canopyView({ store, owner, orchard: app.flowsBoards.orchard,
    trunks: () => [{ id: trunk.id, name: trunk.name, paused: false }],
    computers: () => [{ id: "remote", name: "Remote", connected: true }], here: () => "Local",
    liveOf: () => ({ status: "running", steps: [{ icon: "x", label: "Reading", state: "running" }] }),
    waiting: () => [{ runId: waiting.id }, { runId: grandchild.id }], pickedComputer: (id) => id === helper.sessionId ? "remote" : null });
  for (const run of [parent, helper, paused, waiting]) assert.ok(view().tasks.some((task) => task.id === run.id), run.prompt);
  assert.ok(!view().tasks.some((task) => task.title === "Finished history"));
  assert.equal(view().tasks.find((task) => task.id === helper.id).trunkId, trunk.id);
  assert.ok(view().computers.find((computer) => computer.id === "remote").tasks.includes(helper.id));
  assert.equal(view().tasks.find((task) => task.id === waiting.id).asks, 1);
  assert.equal(view().tasks.find((task) => task.id === parent.id).asks, 1, "a nested helper's question is counted with its root");
  assert.ok(taskInTree(store, parent.id, grandchild.id));
  assert.equal(taskInTree(store, parent.id, waiting.id), false);
  const resumed = store.createRun(owner, "Resumed"); store.event(resumed.id, "run.started", { resumedFrom: paused.id });
  assert.ok(!view().tasks.some((task) => task.id === paused.id));
  // Malformed imported ancestry must not recurse forever.
  const cycle = store.createRun(owner, "Imported cycle");
  store.event(cycle.id, "run.started", { parentRunId: cycle.id });
  assert.equal(view().tasks.find((task) => task.id === cycle.id).trunkId, null);
  assert.equal(taskInTree(store, parent.id, cycle.id), false);
});
