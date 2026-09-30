import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { recoverAfterRestart } from "../dist/never-break/resume.js";
import { discardTemp } from "./temp-dir.mjs";

test("rejected asynchronous continuation admission is actionable and never recorded as resumed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-recovery-admission-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "unused", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = app.store.createRun(app.runtime.owner, "bounded interrupted task");
  app.store.event(run.id, "run.started", { source: "owner", parentRunId: null,
    permissions: [], deadlineMs: 30_000, depth: 0, delegates: false });
  app.store.finish(run.id, "interrupted", "fixture interruption");
  app.runtime.resume = async () => { await Promise.resolve(); throw new Error("fixture admission refused"); };
  const [report] = await recoverAfterRestart({ store: app.store, runtime: app.runtime,
    journal: app.neverBreak.journal, mode: "on", only: new Set([run.id]) });
  assert.equal(report.outcome, "asked");
  assert.equal(app.store.run(run.id).status, "needs_input");
  const events = app.store.events(run.id);
  assert.equal(events.some((event) => event.kind === "run.auto_resumed"), false);
  assert.ok(events.some((event) => event.kind === "attention.needed"
    && String(event.data.question).includes("fixture admission refused")));
});
