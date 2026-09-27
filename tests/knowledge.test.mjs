import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-knowledge-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
  });
  app.coding.setMode("read-first", "off"); // read-first ships on (Q250); these tests are about procedures, not reading first
  t.after(async () => {
    await app.close();
    await discardTemp(root);
  });
  return app;
}

test("memory is source/time attributed and isolated by owner", async (t) => {
  const app = await fixture(t),
    context = app.runtime.context();
  const saved = await app.registry.execute(
    "memory.put",
    { text: "Prefers tea", source: "user message" },
    context,
  );
  assert.ok(saved.createdAt);
  assert.equal(saved.data.source, "user message");
  assert.equal(
    (await app.registry.execute("memory.search", { query: "tea" }, context))
      .length,
    1,
  );
  assert.equal(
    (
      await app.registry.execute(
        "memory.search",
        { query: "tea" },
        { ...context, owner: "other" },
      )
    ).length,
    0,
  );
  assert.equal(
    await app.registry.execute("memory.delete", { id: saved.id }, context),
    true,
  );
});

test("procedure verification uses actual results; replay enforces preconditions and versions", async (t) => {
  const app = await fixture(t),
    context = app.runtime.context();
  await app.registry.execute(
    "files.write",
    { path: "input.txt", content: "ready" },
    context,
  );
  const definition = {
    name: "write greeting",
    preconditions: [{ path: "input.txt", expected: "ready" }],
    steps: [
      {
        tool: "files.write",
        args: { path: "out.txt", content: "hello" },
        expected: { path: "out.txt", bytes: 5 },
      },
      {
        tool: "files.verify",
        args: { path: "out.txt", expected: "hello" },
        expected: { path: "out.txt", verified: true },
      },
    ],
  };
  const proposed = app.knowledge.proposeProcedure(context, definition);
  await assert.rejects(
    app.knowledge.replayProcedure(context, proposed.id),
    /verified/i,
  );
  assert.equal(
    (await app.knowledge.verifyProcedure(context, proposed.id)).data.status,
    "verified",
  );
  await app.knowledge.replayProcedure(context, proposed.id);
  await app.registry.execute(
    "files.write",
    { path: "input.txt", content: "changed" },
    context,
  );
  await assert.rejects(
    app.knowledge.replayProcedure(context, proposed.id),
    /precondition/i,
  );
  const next = app.knowledge.proposeProcedure(context, {
    ...definition,
    id: proposed.id,
  });
  assert.equal(next.data.version, 2);
  assert.equal(next.data.status, "proposed");
  await assert.rejects(
    app.knowledge.replayProcedure(context, next.id),
    /verified/i,
  );
});

test("procedure with wrong expected output is never verified", async (t) => {
  const app = await fixture(t),
    context = app.runtime.context();
  const p = app.knowledge.proposeProcedure(context, {
    name: "bad",
    preconditions: [],
    steps: [
      {
        tool: "files.write",
        args: { path: "x", content: "x" },
        expected: { bytes: 999 },
      },
    ],
  });
  await assert.rejects(
    app.knowledge.verifyProcedure(context, p.id),
    /expected/i,
  );
  assert.notEqual(
    app.store.get("procedures", "local", p.id).data.status,
    "verified",
  );
});

test("specialists require evidence to promote and delegation cannot escalate", async (t) => {
  const app = await fixture(t),
    context = app.runtime.context();
  const definition = {
    name: "file helper",
    instructions: "Write and verify a greeting.",
    permissions: ["files.read", "files.write"],
    evaluation: {
      prompt: "demo",
      checks: [{ path: "branch-demo.txt", expected: "Hello from Branch.\n" }],
    },
  };
  const specialist = app.knowledge.proposeSpecialist(context, definition);
  assert.throws(
    () => app.knowledge.promoteSpecialist(context, specialist.id),
    /evaluation/i,
  );
  const evidence = await app.knowledge.evaluateSpecialist(
    context,
    specialist.id,
  );
  assert.equal(evidence.data.evaluationPassed, true);
  app.knowledge.promoteSpecialist(context, specialist.id);
  const { run, result } = await app.knowledge.delegate(context, specialist.id, "demo");
  assert.equal(run.status, "completed");
  assert.equal(result.status, "resolved");
  await assert.rejects(
    app.knowledge.delegate(
      { ...context, permissions: new Set(["files.read", "specialists.use"]) },
      specialist.id,
      "demo",
    ),
    /escalation/i,
  );
  const v2 = app.knowledge.proposeSpecialist(context, {
    ...definition,
    id: specialist.id,
    instructions: "Version two",
  });
  assert.equal(v2.data.version, 2);
  await app.knowledge.evaluateSpecialist(context, specialist.id);
  app.knowledge.promoteSpecialist(context, specialist.id);
  assert.equal(
    app.knowledge.rollbackSpecialist(context, specialist.id).data.activeVersion,
    1,
  );
});

test("due schedule claims persist and prevent duplicate execution", async (t) => {
  const app = await fixture(t),
    context = app.runtime.context();
  const s = app.scheduler.create(context, {
    prompt: "remember tea",
    dueAt: "2020-01-01T00:00:00.000Z",
    kind: "reminder",
  });
  const results = await Promise.all([
    app.scheduler.tick(),
    app.scheduler.tick(),
  ]);
  assert.equal(results.flat().length, 1);
  assert.equal(
    app.store.get("schedules", "local", s.id).data.status,
    "completed",
  );
  assert.equal(app.store.runs("local").length, 1);
  assert.match(app.store.runs("local")[0].output, /remember tea/);
});

test("recurring schedules advance once, pause, and resume without catch-up duplication", async (t) => {
  const app = await fixture(t),
    context = app.runtime.context();
  const record = app.scheduler.create(context, {
    prompt: "recurring",
    dueAt: "2020-01-01T00:00:00.000Z",
    kind: "reminder",
    intervalMs: 60000,
  });
  await app.scheduler.tick(new Date("2020-01-01T00:00:00.000Z"));
  assert.equal(
    app.store.get("schedules", "local", record.id).data.dueAt,
    "2020-01-01T00:01:00.000Z",
  );
  app.scheduler.setPaused(context, record.id, true);
  assert.equal(
    (await app.scheduler.tick(new Date("2020-01-02T00:00:00.000Z"))).length,
    0,
  );
  app.scheduler.setPaused(context, record.id, false);
  assert.equal(
    (await app.scheduler.tick(new Date("2020-01-02T00:00:00.000Z"))).length,
    1,
  );
  assert.equal(
    app.store.get("schedules", "local", record.id).data.dueAt,
    "2020-01-02T00:01:00.000Z",
  );
});
