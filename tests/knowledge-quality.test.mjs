import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { z } from "zod";
import { createBranch } from "../dist/index.js";

async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-quality-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
    ...(provider ? { provider } : {}),
  });
  t.after(async () => {
    await app.close();
    await discardTemp(root);
  });
  return app;
}
const recipe = {
  name: "partially failing recipe",
  preconditions: [{ path: "ready.txt", expected: "ready" }],
  steps: [
    {
      tool: "files.write",
      args: { path: "changed.txt", content: "changed" },
      expected: { path: "changed.txt", bytes: 7 },
    },
    {
      tool: "files.read",
      args: { path: "missing.txt" },
      expected: { path: "missing.txt", content: "missing" },
    },
  ],
};

test("failed procedure retains inner precondition and partial side-effect audit", async (t) => {
  const app = await fixture(t),
    context = app.runtime.context();
  await app.files.write("ready.txt", "ready", context.signal);
  const proposed = app.knowledge.proposeProcedure(context, recipe);
  await assert.rejects(
    app.runtime.executeTool("procedures.verify", { id: proposed.id }),
    /ENOENT/,
  );
  assert.equal((await app.files.read("changed.txt")).content, "changed");
  const run = app.store.runs("local")[0],
    events = app.store.events(run.id);
  const inner = events.filter(
    (event) => event.data.source?.kind === "procedure",
  );
  assert.equal(
    inner.filter((event) => event.kind === "tool.started").length,
    3,
  );
  assert.ok(
    inner.some(
      (event) =>
        event.kind === "tool.completed" &&
        event.data.name === "files.write" &&
        event.data.result.bytes === 7,
    ),
  );
  assert.ok(
    inner.some(
      (event) =>
        event.kind === "tool.failed" && event.data.name === "files.read",
    ),
  );
  assert.ok(
    inner.every(
      (event) =>
        event.data.source.id === proposed.id && event.data.source.version === 1,
    ),
  );
  assert.equal(
    events.filter(
      (event) =>
        event.kind === "tool.started" &&
        event.data.name === "procedures.verify",
    ).length,
    1,
  );
});

test("direct procedure calls create an audit run and cancellation records uncertain inner outcome", async (t) => {
  const app = await fixture(t);
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  app.registry.register({
    name: "fixture.mutate",
    description: "Mutation fixture",
    permission: "fixture.mutate",
    parameters: z.object({}),
    execute: async (_args, context) => {
      await app.files.write("changed.txt", "changed", context.signal);
      entered();
      await new Promise((_, reject) =>
        context.signal.addEventListener(
          "abort",
          () => reject(context.signal.reason),
          { once: true },
        ),
      );
      return {};
    },
  });
  const controller = new AbortController(),
    context = app.runtime.context({ signal: controller.signal });
  const p = app.knowledge.proposeProcedure(context, {
    name: "interrupted recipe",
    preconditions: [],
    steps: [{ tool: "fixture.mutate", args: {}, expected: {} }],
  });
  const pending = app.knowledge.verifyProcedure(context, p.id);
  await ready;
  controller.abort();
  await assert.rejects(pending);
  const run = app.store.runs("local")[0];
  assert.ok(run);
  assert.equal(run.status, "cancelled");
  const failed = app.store
    .events(run.id)
    .find(
      (event) =>
        event.kind === "tool.failed" && event.data.name === "fixture.mutate",
    );
  assert.equal(failed.data.outcome, "unknown");
  assert.equal(failed.data.source.id, p.id);
  assert.equal((await app.files.read("changed.txt")).content, "changed");
});

function gatedProvider() {
  let gate = null;
  return {
    name: "gated-fixture",
    hold() {
      let entered, release;
      const ready = new Promise((resolve) => {
          entered = resolve;
        }),
        done = new Promise((resolve) => {
          release = resolve;
        });
      gate = { entered, done };
      return { ready, release };
    },
    async complete() {
      const current = gate;
      gate = null;
      if (current) {
        current.entered();
        await current.done;
      }
      return { content: "evaluation finished", toolCalls: [] };
    },
  };
}
const specialist = {
  name: "file checker",
  instructions: "Check the known file",
  permissions: ["files.read"],
  evaluation: {
    prompt: "check",
    checks: [{ path: "evidence.txt", expected: "correct" }],
  },
};

async function promotedV1WithEvaluatedV2(app) {
  const context = app.runtime.context();
  await app.files.write("evidence.txt", "correct", context.signal);
  const first = app.knowledge.proposeSpecialist(context, specialist);
  await app.knowledge.evaluateSpecialist(context, first.id);
  app.knowledge.promoteSpecialist(context, first.id);
  app.knowledge.proposeSpecialist(context, {
    ...specialist,
    id: first.id,
    instructions: "Candidate two",
  });
  await app.knowledge.evaluateSpecialist(context, first.id);
  return { context, id: first.id };
}

test("reevaluation preserves concurrent promotion and records source and child evidence", async (t) => {
  const provider = gatedProvider(),
    app = await fixture(t, provider);
  const { context, id } = await promotedV1WithEvaluatedV2(app),
    gate = provider.hold();
  const pending = app.runtime.executeTool("specialists.evaluate", { id });
  await gate.ready;
  app.knowledge.promoteSpecialist(context, id);
  gate.release();
  const evaluated = await pending;
  assert.equal(evaluated.data.activeVersion, 2);
  assert.equal(evaluated.data.previousActive, 1);
  assert.equal(evaluated.data.evaluationPassed, true);
  assert.ok(evaluated.data.evidence.runId);
  assert.ok(evaluated.data.evidence.sourceRunId);
  assert.notEqual(
    evaluated.data.evidence.runId,
    evaluated.data.evidence.sourceRunId,
  );
  assert.equal(
    app.knowledge.rollbackSpecialist(context, id).data.activeVersion,
    1,
  );
});

test("reevaluation preserves concurrent rollback and rejects results for a revised candidate", async (t) => {
  const provider = gatedProvider(),
    app = await fixture(t, provider);
  const { context, id } = await promotedV1WithEvaluatedV2(app);
  app.knowledge.promoteSpecialist(context, id);
  const gate = provider.hold(),
    pending = app.knowledge.evaluateSpecialist(context, id);
  await gate.ready;
  app.knowledge.rollbackSpecialist(context, id);
  gate.release();
  assert.equal((await pending).data.activeVersion, 1);
  const editedGate = provider.hold(),
    stale = app.knowledge.evaluateSpecialist(context, id);
  await editedGate.ready;
  app.knowledge.proposeSpecialist(context, {
    ...specialist,
    id,
    instructions: "Candidate three",
  });
  editedGate.release();
  await assert.rejects(stale, /changed during evaluation/);
  const revised = app.store.get("specialists", "local", id);
  assert.equal(revised.data.version, 3);
  assert.equal(revised.data.evaluationPassed, false);
  assert.equal(revised.data.activeVersion, 1);
});

test("public close aborts active work and drains cleanup before closing storage", async (t) => {
  let entered, release;
  const ready = new Promise((resolve) => {
      entered = resolve;
    }),
    gate = new Promise((resolve) => {
      release = resolve;
    });
  const app = await fixture(t, {
    name: "held-provider",
    async complete() {
      entered();
      await gate;
      return { content: "finished late", toolCalls: [] };
    },
  });
  let cleaned = false;
  app.registry.onRunFinished(async () => {
    cleaned = true;
  });
  const pending = app.runtime.run({ prompt: "hold" });
  await ready;
  let closed = false;
  const closing = app.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  const run = await pending;
  await closing;
  // Stopped by the close and kept to be carried on at the next start ("carry on after a restart" ships on, #483).
  assert.equal(run.status, "interrupted");
  assert.equal(cleaned, true);
  await app.close();
});
