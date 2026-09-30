/**
 * selfdev: how many tokens one task may use is the owner's own knob (limits.maxTaskTokens), not a fixed 200,000. Auto is
 * 200,000 while a key billed per token answers (this scripted connection), and no limit on a sign-in
 * (tests/task-no-limit.test.mjs).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createBranch } from "../dist/index.js";
import { readKnobs, saveKnobs } from "../dist/knobs/settings.js";
import { taskBudget } from "../dist/knobs/apply.js";
import { applyChanges, changesFor } from "../dist/settings-kit/changes.js";
import { settingsKitWriters } from "../dist/settings-kit/writers.js";
import { discardTemp } from "./temp-dir.mjs";

test("a task's token allowance follows the owner's knob, and the built-in figure stays when it is empty", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-task-tokens-"));
  const call = { id: "probe", name: "probe.budget", arguments: "{}" };
  let turn = 0;
  const provider = { name: "scripted", async complete() { return ++turn % 2 ? { content: "", toolCalls: [call] } : { content: "Done.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const seen = [];
  app.registry.register({ name: "probe.budget", permission: "files.read", description: "test probe", parameters: z.object({}).strict(),
    execute: async (_input, context) => { seen.push(context.budget.limits.maxTokens); return "seen"; } });
  const owner = app.runtime.owner;
  assert.equal(readKnobs(app.store, owner, "limits").maxTaskTokens, null);
  assert.equal(taskBudget(app.store, owner).billed.maxTokens, 200000);
  await app.runtime.run({ prompt: "look" });
  saveKnobs(app.store, owner, "limits", { maxTaskTokens: 1_500_000, maxModelRounds: 200 });
  assert.equal(taskBudget(app.store, owner).maxTokens, 1_500_000);
  await app.runtime.run({ prompt: "look again" });
  assert.deepEqual(seen, [200000, 1_500_000]);
  assert.throws(() => saveKnobs(app.store, owner, "limits", { maxTaskTokens: 100 }));
  assert.throws(() => saveKnobs(app.store, owner, "limits", { maxModelRounds: 501 }));
  // Branch can change it for the owner through the settings kit: its field is not named like a secret.
  const { changes, refused } = changesFor(app.store, owner, [{ key: "task-tokens", field: "taskAllowance", value: 3_000_000 }]);
  assert.deepEqual(refused ?? [], []);
  applyChanges(app.store, owner, changes, { accept: changes.map((change) => change.id), confirmLoosening: true, why: "test", writers: settingsKitWriters(app) });
  assert.equal(taskBudget(app.store, owner).maxTokens, 3_000_000);
});
