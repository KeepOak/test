import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  mkdir,
  symlink,
  writeFile,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { Budget, createBranch, DemoProvider, RateLimiter } from "../dist/index.js";

async function fixture(t, provider = new DemoProvider()) {
  const root = await mkdtemp(join(tmpdir(), "branch-test-"));
  const workspace = join(root, "workspace");
  const dataDir = join(root, "private");
  const app = await createBranch({ workspace, dataDir, provider });
  t.after(async () => {
    await app.close();
    await discardTemp(root);
  });
  return { app, root, workspace, dataDir };
}
const calls = (...responses) => ({
  name: "fixture",
  async complete() {
    return responses.shift() ?? { content: "done", toolCalls: [] };
  },
});
const tool = (name, args, id = "one") => ({
  content: "",
  toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
});

test("demo writes, reads, verifies, and persists a multi-step session", async (t) => {
  const { app, workspace, dataDir } = await fixture(t);
  const run = await app.runtime.run({ prompt: "demonstrate" });
  assert.equal(run.status, "completed");
  assert.match(run.output, /verified/i);
  assert.equal(
    await readFile(join(workspace, "branch-demo.txt"), "utf8"),
    "Hello from Branch.\n",
  );
  assert.equal(
    app.store.events(run.id).filter((e) => e.kind === "tool.completed").length,
    3,
  );
  assert.ok(app.store.messages(run.sessionId).some((m) => m.role === "tool"));
  assert.ok(app.store.usage(run.id).estimatedInput > 0);
  await app.close();
  const reopened = await createBranch({ workspace, dataDir });
  assert.equal(reopened.store.run(run.id).status, "completed");
  await reopened.close();
});

test("malformed arguments produce a recorded tool error without side effects", async (t) => {
  const provider = calls({
    content: "",
    toolCalls: [{ id: "bad", name: "files.write", arguments: "{broken" }],
  });
  const { app } = await fixture(t, provider);
  const run = await app.runtime.run({ prompt: "bad" });
  assert.equal(run.status, "completed");
  assert.ok(
    app.store
      .events(run.id)
      .some((e) => e.kind === "tool.failed" && /JSON/.test(e.data.error)),
  );
});

test("files reject traversal, secrets, and symlink paths", async (t) => {
  const { app, root, workspace } = await fixture(t, calls());
  const context = app.runtime.context();
  for (const path of [
    "../outside",
    ".env",
    "keys.pem",
    "C:/Windows/system.ini",
    "nested/../x",
  ]) {
    await assert.rejects(
      app.registry.execute("files.read", { path }, context),
      /path|secret|denied/i,
    );
  }
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "x"), "secret");
  await symlink(
    outside,
    join(workspace, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    app.registry.execute("files.read", { path: "linked/x" }, context),
    /link|path/i,
  );
});

test("permission check occurs before tool execution", async (t) => {
  const { app } = await fixture(t);
  const context = app.runtime.context({ permissions: ["files.read"] });
  await assert.rejects(
    app.registry.execute("files.write", { path: "x", content: "x" }, context),
    /permission/i,
  );
});

test("cancellation and exhausted shared budget stop runs", async (t) => {
  const { app } = await fixture(t);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(
    (await app.runtime.run({ prompt: "cancel", signal: aborted.signal }))
      .status,
    "cancelled",
  );
  assert.equal(
    (
      await app.runtime.run({
        prompt: "budget",
        budget: { maxSteps: 1, maxTokens: 10000 },
      })
    ).status,
    "budget_exceeded",
  );
});

test("startup marks previously running work interrupted without replay", async (t) => {
  const { app, workspace, dataDir } = await fixture(t);
  const run = app.store.createRun("local", "pending");
  await app.close();
  const next = await createBranch({ workspace, dataDir });
  assert.equal(next.store.run(run.id).status, "interrupted");
  await next.close();
});

test("failed and cancelled provider attempts retain estimated cost and unknown usage", async (t) => {
  const { app } = await fixture(t, {
    name: "failing-fixture",
    async complete() {
      throw new Error("connection lost");
    },
  });
  const run = await app.runtime.run({ prompt: "try" });
  const usage = app.store.usage(run.id);
  assert.equal(run.status, "failed");
  assert.equal(usage.attempts, 1);
  assert.equal(usage.unreportedCalls, 1);
  assert.equal(usage.incompleteCalls, 1);
  assert.ok(usage.estimatedInput > 0);
  assert.ok(app.store.events(run.id).some((e) => e.kind === "model.started"));
  assert.ok(app.store.events(run.id).some((e) => e.kind === "model.failed"));
});

test("invalid completion retains available reported usage", async (t) => {
  const { app } = await fixture(t, {
    name: "invalid-fixture",
    async complete() {
      return {
        content: "x",
        toolCalls: "invalid",
        usage: { input: 321, output: 12 },
      };
    },
  });
  const run = await app.runtime.run({ prompt: "try" }),
    usage = app.store.usage(run.id);
  assert.equal(run.status, "failed");
  assert.equal(usage.reportedInput, 321);
  assert.equal(usage.unreportedCalls, 0);
});

test("a second instance cannot interrupt an active data directory", async (t) => {
  const { app, workspace, dataDir } = await fixture(t);
  const run = app.store.createRun("local", "active");
  await assert.rejects(
    createBranch({ workspace, dataDir }),
    /already open/i,
  );
  assert.equal(app.store.run(run.id).status, "running");
});

test("hardlinks cannot expose or overwrite files outside workspace", async (t) => {
  const { app, root, workspace } = await fixture(t);
  await writeFile(join(root, "outside.txt"), "private");
  await link(join(root, "outside.txt"), join(workspace, "alias.txt"));
  await assert.rejects(
    app.registry.execute(
      "files.read",
      { path: "alias.txt" },
      app.runtime.context(),
    ),
    /link/i,
  );
  await assert.rejects(
    app.registry.execute(
      "files.write",
      { path: "alias.txt", content: "overwrite" },
      app.runtime.context(),
    ),
    /link/i,
  );
  assert.equal(await readFile(join(root, "outside.txt"), "utf8"), "private");
});

test("aborting an in-flight provider cancels work and preserves attempt record", async (t) => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const { app } = await fixture(t, {
    name: "waiting-fixture",
    async complete({ signal }) {
      started();
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
      return { content: "unreachable", toolCalls: [] };
    },
  });
  const controller = new AbortController(),
    pending = app.runtime.run({ prompt: "wait", signal: controller.signal });
  await ready;
  controller.abort(new Error("test stop"));
  const run = await pending;
  assert.equal(run.status, "cancelled");
  assert.equal(app.store.usage(run.id).incompleteCalls, 1);
  assert.ok(
    app.store.events(run.id).some((event) => event.kind === "model.cancelled"),
  );
});

test("delegated work charges its parent budget and cannot reset depth", async (t) => {
  const { app } = await fixture(t);
  const context = app.runtime.context();
  context.budget = new Budget({ maxSteps: 60, maxTokens: 200 }); // limits are read-only: the budget is replaced
  const delegated = await app.runtime.delegate(
    "demo",
    context,
    ["files.read"],
    "read only",
  );
  assert.equal(delegated.status, "budget_exceeded");
  assert.ok(context.budget.tokens > 200);
  await assert.rejects(
    app.runtime.delegate("demo", { ...context, depth: 3 }, ["files.read"], ""),
    /depth/i,
  );
});

test("rate limiting guard: normally-built Runtime has no mutable clock escape hatch", async (t) => {
  const { app } = await fixture(t);
  // Guard: normally-built Runtime should not have testNow field
  assert.strictEqual(
    app.runtime.testNow,
    undefined,
    "normally-built Runtime should not have testNow field",
  );
  // Verify tool calls are strictly sequential (via rate queue)
  const limiter = new RateLimiter(1000);
  const beforeFirst = Date.now();
  limiter.record("key", beforeFirst);
  const beforeSecond = beforeFirst + 500; // 500ms later, within window
  const wait = limiter.waitMs("key", 1, beforeSecond);
  assert.ok(wait > 0, "two calls within the window should require a pause");
  // Mutation guard: if testNow were set on a normally-built runtime, it would
  // silently break rate limiting by freezing the clock. This test catches that.
  // DO NOT add a testNow field to production Runtime: use a clock function parameter instead.
});
