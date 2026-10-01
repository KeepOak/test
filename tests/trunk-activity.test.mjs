import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { z } from "zod";
import { createBranch, savePolicy, addPolicyRule } from "../dist/index.js";
import { trunkActivity } from "../dist/trunk-activity.js";
import { discardTemp } from "./temp-dir.mjs";

const call = (name, id = "activity-call") => ({ content: "", toolCalls: [{ id, name, arguments: "{}" }] });
async function fixture(t, name) {
  const root = await mkdtemp(join(tmpdir(), "branch-trunk-activity-"));
  let at = 0, executions = 0;
  const provider = { name: "scripted", async complete() { return at++ === 0 ? call(name) : { content: "Finished fixture", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.coding.setMode("read-first", "off");
  // Only the local test registry is replaced. The real runtime records all gate/start/terminal events.
  app.registry.unregister(name);
  app.registry.register({ name, description: "Isolated activity fixture", permission: name === "web.search" ? "web.read" : "channels.send",
    parameters: z.object({}).strict(), target: () => "fixture", execute: async () => { executions++; return { ok: true }; } });
  return { app, executions: () => executions };
}

function terminalPrefix(app, run, kind, expectedActive) {
  const events = app.store.events(run.id);
  const at = events.findIndex(event => event.kind === kind);
  assert.ok(at >= 0, `real runtime emitted ${kind}`);
  const terminal = events[at];
  const started = events.findIndex(event => event.kind === "tool.started" && event.data.id === terminal.data.id);
  assert.ok(started >= 0 && started < at, "terminal matches an actual started invocation");
  assert.equal(trunkActivity(events.slice(0, at)), expectedActive, "the call is visibly active before its terminal");
  assert.equal(trunkActivity(events.slice(0, at + 1)), "work", "terminal clears the pose before a later model event can hide it");
  return { start: events[started], terminal };
}

for (const [name, pose] of [["web.search", "search"], ["channels.broadcast", "talk"]]) {
  test(`denied ${name} actually ends its recorded ${pose} invocation`, async t => {
    const f = await fixture(t, name);
    savePolicy(f.app.store, f.app.runtime.owner, { preset: "workspace" });
    addPolicyRule(f.app.store, f.app.runtime.owner, { tool: name, decision: "deny", match: "*" });
    const run = await f.app.runtime.run({ prompt: "Run the isolated activity fixture" });
    terminalPrefix(f.app, run, "policy.denied", pose);
    assert.equal(f.executions(), 0, "denied fixture executes no tool or network action");
  });
}

test("simulated outgoing activity ends without sending", async t => {
  const f = await fixture(t, "channels.broadcast");
  const run = await f.app.runtime.run({ prompt: "Practice the isolated outgoing fixture", dryRun: true });
  terminalPrefix(f.app, run, "tool.simulated", "talk");
  assert.equal(f.executions(), 0);
});

test("unknown-outcome outgoing invocation ends at its actual reconciliation refusal", async t => {
  const f = await fixture(t, "channels.broadcast"), owner = f.app.runtime.owner;
  const first = f.app.store.createRun(owner, "Interrupted fixture");
  f.app.store.event(first.id, "run.started", { source: "owner", permissions: ["channels.send"], deadlineMs: 30_000,
    depth: 0, delegates: false, dryRun: false, ownCopy: false });
  f.app.store.message(first.sessionId, { role: "user", content: "Interrupted fixture" });
  f.app.store.message(first.sessionId, { role: "assistant", ...call("channels.broadcast", "unknown-call") });
  f.app.store.finish(first.id, "interrupted", "Fixture interrupted before outcome was known");
  const run = await f.app.runtime.resume(first.id);
  terminalPrefix(f.app, run, "reconciliation.required", "talk");
  assert.equal(f.executions(), 0, "ambiguous outgoing action is never repeated");
});

const event = (kind, id, name) => ({ id: 1, kind, data: { ...(id === undefined ? {} : { id }), ...(name ? { name } : {}) } });
for (const kind of ["policy.denied", "tool.simulated", "reconciliation.required"]) {
  test(`${kind} clears only its exact invocation and preserves parallel start order`, () => {
    const events = [event("tool.started", "read", "files.read"), event("tool.started", "send", "channels.broadcast")];
    assert.equal(trunkActivity(events), "talk");
    assert.equal(trunkActivity([...events, event(kind, "another", "channels.broadcast")]), "talk");
    assert.equal(trunkActivity([...events, event(kind, undefined, "channels.broadcast")]), "talk", "name alone cannot end a concurrent call");
    assert.equal(trunkActivity([...events, event(kind, "send", "channels.broadcast")]), "read");
    assert.equal(trunkActivity([...events, event(kind, "send"), event("model.started")]), "read", "active call keeps precedence over model");
    assert.equal(trunkActivity([...events, event(kind, "send"), event("tool.completed", "read"), event("model.started")]), "think");
  });
}

test("activity remains a generic five-state value and the unknown 2000-event tail falls back", () => {
  assert.equal(trunkActivity([]), "work");
  assert.equal(trunkActivity([event("model.started")]), "think");
  assert.equal(trunkActivity([event("tool.started", "search", "web.search")]), "search");
  assert.equal(trunkActivity([event("tool.started", "read", "files.read")]), "read");
  assert.equal(trunkActivity([event("tool.started", "send", "channels.broadcast")]), "talk");
  assert.equal(trunkActivity(Array.from({ length: 2000 }, () => event("tool.started", "send", "channels.broadcast"))), "work");
});

test("real UI mapper keeps question and paused precedence and ignores another conversation's activity", async () => {
  const source = await readFile(new URL("../public/app/core/doing.js", import.meta.url), "utf8");
  const E = { state: { runs: [{ sessionId: "mine", status: "running", activityState: "talk" }], attention: [] } };
  const context = { E, Date, render() {}, setTimeout, clearTimeout };
  runInNewContext(source.replace(/^import .*;\r?\n/gm, "").replace(/export /g, "") + "\nglobalThis.actual = agentState;", context);
  assert.equal(context.actual({ chatSessionId: "mine" }), "talk");
  assert.equal(context.actual({ chatSessionId: "other" }), "idle");
  assert.equal(context.actual({ chatSessionId: "mine", paused: true }), "sleep");
  E.state.attention = [{ sessionId: "mine", canContinue: false }];
  assert.equal(context.actual({ chatSessionId: "mine", paused: true }), "wait");
});
