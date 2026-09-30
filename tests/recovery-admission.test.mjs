import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { recoverAfterRestart, resumeHandedOver } from "../dist/never-break/resume.js";
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

test("handed-over admission refusal stays actionable without a false resumed receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-handover-admission-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "unused", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = app.store.createRun(app.runtime.owner, "handed-over task");
  app.store.event(run.id, "run.handed_over", {});
  app.store.finish(run.id, "interrupted", "engine handover");
  app.runtime.resume = async () => { await Promise.resolve(); throw new Error("fixture handover refused"); };
  const [pending] = resumeHandedOver({ store: app.store, runtime: app.runtime });
  assert.equal(app.store.events(run.id).some((event) => event.kind === "run.auto_resumed"), false);
  await pending.resumed;
  assert.equal(app.store.run(run.id).status, "needs_input");
  assert.equal(app.store.events(run.id).some((event) => event.kind === "run.auto_resumed"), false);
  assert.ok(app.store.events(run.id).some((event) => event.kind === "attention.needed"
    && String(event.data.question).includes("fixture handover refused")));
  assert.deepEqual(resumeHandedOver({ store: app.store, runtime: app.runtime }), []);
});

test("failed continuation placement never produces a successful admission receipt", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-recovery-placement-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "fixture done", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "bounded isolated task" });
  assert.equal(run.status, "completed");
  app.store.finish(run.id, "interrupted", "fixture interruption");
  app.runtime.coding.placeTask = async () => { throw new Error("fixture placement refused"); };
  const [report] = await recoverAfterRestart({ store: app.store, runtime: app.runtime,
    journal: app.neverBreak.journal, mode: "on", only: new Set([run.id]) });
  assert.equal(report.outcome, "asked");
  assert.equal(app.store.run(run.id).status, "needs_input");
  assert.equal(app.store.events(run.id).some((event) => event.kind === "run.auto_resumed"), false);
  const failed = app.store.runs(app.runtime.owner).find((one) => one.id !== run.id
    && app.store.events(one.id).some((event) => event.kind === "run.started" && event.data.resumedFrom === run.id));
  assert.equal(failed?.status, "failed");
  assert.match(failed.output, /fixture placement refused/);
  assert.match(app.store.run(run.id).output, /fixture placement refused/);
});

test("failed durable handover receipt settles as held instead of waiting forever", { timeout: 10_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-handover-receipt-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", async complete() { return { content: "fixture done", toolCalls: [] }; } } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "bounded isolated handover", timeoutMs: 30_000 });
  app.store.event(run.id, "run.handed_over", {});
  app.store.finish(run.id, "interrupted", "fixture handover");
  const event = app.store.event.bind(app.store);
  app.store.event = (id, kind, data) => {
    if (kind === "run.auto_resumed") throw new Error("fixture durable receipt unavailable");
    return event(id, kind, data);
  };
  const [pending] = resumeHandedOver({ store: app.store, runtime: app.runtime });
  assert.equal(await pending.admission, false);
  await pending.resumed;
  assert.equal(app.store.run(run.id).status, "needs_input");
  assert.match(app.store.run(run.id).output, /fixture durable receipt unavailable/);
  assert.equal(app.store.events(run.id).some((one) => one.kind === "run.auto_resumed"), false);
});
