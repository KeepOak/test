import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { currentAccountCall } from "../dist/accounts/context.js";
import { FanoutTaskSchema, helperRouteWords } from "../dist/delegation.js";
import { ParallelSchema } from "../dist/orchestration-tools.js";
import { discardTemp } from "./temp-dir.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-helper-routing-"));
  const calls = [], gate = deferred();
  const provider = (name) => ({ name, async complete(request) {
    const prompt = request.messages.filter((message) => message.role === "user").at(-1).content;
    calls.push({ name, prompt, accountCall: structuredClone({ ...currentAccountCall(), note: undefined }) });
    if (prompt.startsWith("held helper")) await gate.promise;
    return { content: `${name} answered ${prompt}`, toolCalls: [] };
  } });
  const presets = [
    { id: "alpha", name: "Alpha", model: "alpha-1", provider: provider("alpha") },
    { id: "beta", name: "Beta", model: "beta-2", provider: provider("beta") },
  ];
  const options = { workspace: join(root, "workspace"), dataDir: join(root, "data"), presets };
  let app = await createBranch(options);
  t.after(async () => { gate.resolve(); await app.close(); await discardTemp(root); });
  return { get app() { return app; }, calls, gate, async reopen() { await app.close(); app = await createBranch(options); } };
}

test("concurrent helpers use their requested models without changing the parent model", async (t) => {
  const f = await fixture(t), parent = await f.app.runtime.run({ prompt: "parent" });
  const context = f.app.runtime.context({ runId: parent.id });
  const left = f.app.runtime.delegate("held helper alpha", context, ["files.read"], "", { model: "alpha" });
  const right = f.app.runtime.delegate("held helper beta", context, ["files.read"], "", { model: "beta" });
  try {
    for (let tries = 0; tries < 100 && f.calls.filter((call) => call.prompt.startsWith("held helper")).length < 2; tries++)
      await new Promise((done) => setTimeout(done, 5));
    const active = f.calls.filter((call) => call.prompt.startsWith("held helper"));
    assert.deepEqual(active.map((call) => call.name).sort(), ["alpha", "beta"]);
    assert.equal(new Set(active.map((call) => call.accountCall.sessionId)).size, 2, "each helper has its own model/account conversation");
  } finally { f.gate.resolve(); }
  const [a, b] = await Promise.all([left, right]);
  assert.equal(a.status, "completed"); assert.equal(b.status, "completed");
  assert.match(a.output, /^alpha answered/); assert.match(b.output, /^beta answered/);
  assert.equal(f.app.runtime.models.settings("local").activePreset, null);
  assert.equal(f.app.runtime.models.session("local", parent.sessionId).preset, null);
});

test("helper model stays pinned across new defaults and a real restart", async (t) => {
  const f = await fixture(t), parent = await f.app.runtime.run({ prompt: "parent" });
  const child = await f.app.runtime.delegate("helper beta", f.app.runtime.context({ runId: parent.id }), ["files.read"], "", { model: "beta" });
  assert.match(child.output, /^beta answered/);
  f.app.runtime.models.configure("local", { activePreset: "alpha", fallbackOrder: ["alpha"] });
  await f.reopen();
  const follow = await f.app.runtime.run({ prompt: "carry on", sessionId: child.sessionId });
  assert.match(follow.output, /^beta answered/);
  await assert.rejects(f.app.runtime.run({ prompt: "change route", sessionId: child.sessionId, model: "alpha" }), /helper.*model|pinned.*model/i);
});

test("a helper keeps its parent's project when the active project changes", async (t) => {
  const f = await fixture(t);
  f.app.store.projects.save("local", { id: "garden", name: "Garden" });
  f.app.store.projects.save("local", { id: "taxes", name: "Taxes" });
  f.app.store.projects.setActive("local", { active: "garden" });
  const parent = await f.app.runtime.run({ prompt: "parent" });
  f.app.store.projects.setActive("local", { active: "taxes" });
  const child = await f.app.runtime.delegate("helper", f.app.runtime.context({ runId: parent.id }), [], "", { model: "beta" });
  assert.equal(child.project, parent.project);
});

test("unknown helper models refuse before creating or calling a child", async (t) => {
  const f = await fixture(t), parent = await f.app.runtime.run({ prompt: "parent" });
  const before = f.app.store.runs("local").length;
  await assert.rejects(f.app.runtime.delegate("helper", f.app.runtime.context({ runId: parent.id }), [], "", { model: "missing" }), /Unknown.*model/i);
  assert.equal(f.calls.length, 1);
  assert.equal(f.app.store.runs("local").length, before);
});

test("an account selector on a model without an account pool refuses before child work", async (t) => {
  const f = await fixture(t), parent = await f.app.runtime.run({ prompt: "parent" });
  const before = f.app.store.runs("local").length;
  await assert.rejects(f.app.runtime.delegate("helper", f.app.runtime.context({ runId: parent.id }), [], "", {
    model: "alpha", accountRef: { pool: "alpha", account: "1234abcd" },
  }), /account/i);
  assert.equal(f.calls.length, 1);
  assert.equal(f.app.store.runs("local").length, before);
});

test("fanout task selections reach the real child models", async (t) => {
  const f = await fixture(t), parent = await f.app.runtime.run({ prompt: "parent" });
  const tasks = [
    FanoutTaskSchema.parse({ id: "a", prompt: "fanout alpha", model: "alpha" }),
    FanoutTaskSchema.parse({ id: "b", prompt: "fanout beta", model: "beta", dependsOn: ["a"] }),
  ];
  const outcome = await f.app.runtime.fanout(f.app.runtime.context({ runId: parent.id }), tasks,
    () => ({ permissions: ["files.read"], instructions: "" }));
  assert.match(outcome.tasks.a.output, /^alpha answered/);
  assert.match(outcome.tasks.b.output, /^beta answered/);
});

test("parallel selectors accept exact account references and reject malformed references", () => {
  const parsed = ParallelSchema.parse({ tasks: [{ specialist: "worker", prompt: "work", model: "alpha", accountRef: { pool: "alpha", account: "1234abcd" } }] });
  assert.deepEqual(parsed.tasks[0].accountRef, { pool: "alpha", account: "1234abcd" });
  for (const accountRef of [{ pool: "alpha", account: "someone" }, { pool: "../alpha", account: "primary" }, { pool: "alpha", account: "primary", owner: "another" }])
    assert.throws(() => ParallelSchema.parse({ tasks: [{ specialist: "worker", prompt: "work", accountRef }] }));
});

test("delegation approvals name every selected specialist model and account", async (t) => {
  const f = await fixture(t);
  const context = f.app.runtime.context({});
  const first = { specialist: "reviewer", prompt: "check", model: "alpha", accountRef: { pool: "alpha", account: "1234abcd" } };
  const second = { specialist: "writer", prompt: "write", model: "beta", accountRef: { pool: "beta", account: "deadbeef" } };
  const calls = [
    ["delegate.handoff", { ...first, brief: "check" }],
    ["delegate.parallel", { tasks: [first, second] }],
    ["specialists.fanout", { tasks: [{ ...first, id: "first" }, { ...second, id: "second" }] }],
  ];
  for (const [tool, args] of calls) {
    const target = f.app.registry.targetOf(tool, args, context);
    assert.ok(target.includes("reviewer") && target.includes("alpha") && target.includes("1234abcd"), `${tool} lost its first route`);
    if (tool !== "delegate.handoff") assert.ok(target.includes("writer") && target.includes("beta") && target.includes("deadbeef"), `${tool} lost its second route`);
    const words = helperRouteWords(target, (id) => id === "reviewer" ? "Reviewer" : null);
    assert.match(words, /^Reviewer on alpha, account 1234abcd/, `${tool}: the question names the route in words`);
    assert.doesNotMatch(words, /[{"]/, `${tool}: the question never shows the raw target`);
    const changed = structuredClone(args);
    if (tool === "delegate.handoff") changed.accountRef.account = "deadbeef";
    else changed.tasks[0].accountRef.account = "deadbeef";
    assert.notEqual(f.app.registry.targetOf(tool, changed, context), target, `${tool} reused another account's approval target`);
  }
});

test("a helper-route target with no named route adds no words, and any other target is left alone", () => {
  assert.equal(helperRouteWords(JSON.stringify([{ specialist: "a", model: null, accountRef: null }]), () => null), "");
  assert.equal(helperRouteWords("src/index.ts", () => null), null);
  assert.equal(helperRouteWords('{"specialist":"a"}', () => null), null);
});

test("background helpers outlive the parent signal and spend their own budget", async (t) => {
  const f = await fixture(t), parent = await f.app.runtime.run({ prompt: "parent" });
  const controller = new AbortController();
  const context = { ...f.app.runtime.context({ runId: parent.id }), signal: controller.signal };
  const before = context.budget.tokens;
  const started = await f.app.runtime.delegateBackground("held helper beta", context, [], "", { model: "beta" });
  controller.abort(new Error("The parent finished"));
  f.gate.resolve();
  for (let tries = 0; tries < 100 && f.app.store.run(started.childRunId)?.status === "running"; tries++)
    await new Promise((done) => setTimeout(done, 5));
  const child = f.app.store.run(started.childRunId);
  assert.equal(child.status, "completed");
  assert.match(child.output, /^beta answered/);
  assert.equal(context.budget.tokens, before, "the background child keeps its own spending cap");
});
