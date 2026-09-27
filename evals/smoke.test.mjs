/**
 * The eval harness's own smoke test, small enough for CI (under 30 seconds, one engine shared across three tasks, a
 * scripted stand-in model — no GPU, no network, no real model). It proves the harness and the engine's plumbing hold:
 * a tool call writes a file, a guarded tool waits for and gets an approval, and an unsafe demand is refused. The full
 * real-model suite (evals/run.mjs, ~30 tasks) runs nightly, never in CI. See docs/tests-and-deterministic-time.md.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeContext } from "../evals/lib/harness.mjs";
import { describeModel } from "../evals/lib/models.mjs";
import { startStandin } from "../evals/lib/standin.mjs";
import { smokeTasks } from "../evals/tasks/index.mjs";

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
