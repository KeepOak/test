/* UI-059: a task the owner started that fails because no model, account or service can answer is marked for setup, so
   the window opens Add an account or Models once (src/model-recovery.ts, runtime "model.setup_needed"). */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { modelRecoveryFor } from "../dist/model-recovery.js";
import { NoConfiguredModelError } from "../dist/no-model.js";

test("which failures send the owner to set a model up, and which do not", () => {
  assert.equal(modelRecoveryFor(new NoConfiguredModelError()), "setup");
  assert.equal(modelRecoveryFor(new Error("The policy refused this")), null, "a plain refusal is not a model problem");
});

test("an owner task with no model set up is marked for setup; a failure after words were written is not", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-model-recovery-"));
  const failing = { name: "stand-in", async complete() { throw new NoConfiguredModelError(); } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: failing });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "Say hi" });
  assert.equal(run.status, "failed");
  const marks = app.store.events(run.id).filter((event) => event.kind === "model.setup_needed");
  assert.deepEqual(marks.map((event) => event.data.recovery), ["setup"]);
});
