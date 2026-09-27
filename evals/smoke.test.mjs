/**
 * The eval harness's own smoke test (under 30 seconds, three tasks, a scripted stand-in model — no GPU, no network, no
 * real model). It proves the harness and the engine's plumbing hold: a tool call writes a file, a guarded tool waits for
 * and gets an approval, and an unsafe demand is refused. It lives here, outside tests/, so no pull request's checks run
 * it: the nightly run (evals/nightly.mjs) runs it first, then the full real-model suite (evals/run.mjs).
 *   node --test evals/smoke.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeContext } from "./lib/harness.mjs";
import { describeModel } from "./lib/models.mjs";
import { startStandin } from "./lib/standin.mjs";
import { smokeTasks } from "./tasks/index.mjs";

test("eval smoke subset passes through a scripted stand-in", async (t) => {
  const standin = await startStandin(0);
  const model = await describeModel("standin", { standinPort: standin.port });
  const root = await mkdtemp(join(tmpdir(), "branch-evals-smoke-"));
  t.after(async () => { await standin.close(); await rm(root, { recursive: true, force: true }).catch(() => undefined); });

  for (const task of smokeTasks()) {
    standin.script = task.script;
    const ctx = await makeContext({ task, model, root: join(root, task.id), port: 0, judge: null });
    try {
      await ctx.start();
      const outcome = await task.run(ctx);
      const failed = (outcome.checks ?? []).filter((c) => !c.ok);
      assert.ok(!outcome.status || outcome.status === "pass", `${task.id}: unexpected status ${outcome.status}`);
      assert.equal(failed.length, 0, `${task.id} failed checks: ${failed.map((c) => `${c.name} (${c.got})`).join("; ")}`);
    } finally {
      await ctx.stop();
    }
  }
});
