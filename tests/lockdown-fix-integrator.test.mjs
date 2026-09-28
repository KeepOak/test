/**
 * mac7/lockdown-fix, integration review: the holes found in the adversarial pass, each pinned by a
 * test. Lockdown refuses handing work to another computer and steps that send to other apps, the
 * terminal switch ends earlier yeses, and device sockets are closed. A Trunk's side jobs, mixtures and
 * keep-alive pings never reach a sign-in. A task's workflow limit survives saving the steps again,
 * reaches drafted flows, and a finished flow run's limit is cleaned up. Stand-ins and temp folders only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy, setLockdown } from "../dist/index.js";
import { runTerminalCommand } from "../dist/terminal-cli.js";
import { registerCliAgent } from "../dist/providers/cli-agent.js";
import { currentAccountCall, withAccountCall } from "../dist/accounts/context.js";
import { MixtureProvider } from "../dist/model-savings/mixture.js";
import { afterRound } from "../dist/model-savings/hook.js";
import { flowSearchParts } from "../dist/interop/flow-search.js";
import { neverTouched } from "../dist/settings-kit/catalogue.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { fakeClaudeAccounts } from "./fixtures/claude-account-adapter.mjs";

async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-lockdown-integrator-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, owner: app.runtime.owner };
}
const io = () => ({ interactive: false, env: {}, json: false, lines: [], write(line) { this.lines.push(line); } });

test("Lockdown refuses handing work to another computer and a step that sends to another app, without asking", async (t) => {
  const { app, owner } = await fixture(t);
  savePolicy(app.store, owner, { preset: "custom", rules: [{ tool: "*", decision: "allow", remember: "always" }] });
  app.asks.setMode("nodes", { mode: "on" });
  app.asks.setMode("app-blocks", { mode: "on" });
  const context = app.runtime.context();
  for (const tool of ["nodes.ask", "blocks.run"]) assert.ok(app.registry.permissionOf(tool), `${tool} is a real tool`);
  setLockdown(app.store, owner, { on: true });
  for (const tool of ["nodes.ask", "blocks.run"]) {
    const check = app.runtime.checkPolicy(tool, {}, context);
    assert.equal(check.decision, "deny", tool);
    assert.match(check.reason ?? "", /Lockdown is on/);
  }
});

test("turning Lockdown on from the terminal ends the yeses already given, as the route does", async (t) => {
  const { app } = await fixture(t);
  let forgotten = 0;
  const original = app.runtime.approvals.forgetAll.bind(app.runtime.approvals);
  app.runtime.approvals.forgetAll = () => { forgotten++; return original(); };
  await runTerminalCommand(app, "lockdown", ["on"], io());
  assert.equal(forgotten, 1);
  await runTerminalCommand(app, "lockdown", ["off"], io());
  assert.equal(forgotten, 1, "turning it off forgets nothing");
});

test("Lockdown closes a device's open socket at once and nothing more is sent to a device", async (t) => {
  const { app, owner } = await fixture(t);
  app.devices.setMode({ mode: "on" });
  const closed = [];
  app.devices.hub.links.set("dev-1", { device: "dev-1", waiting: new Map(), send() { throw new Error("nothing is sent"); }, close: (why) => closed.push(why) });
  setLockdown(app.store, owner, { on: true });
  assert.deepEqual(closed, ["Lockdown is on."]);
  await assert.rejects(app.devices.hub.invoke("dev-1", "notify", {}), /switched off, or Lockdown is on/);
});

/** An installed program signed in to the owner's own account, and a key connection behind it. */
function signInFirst(app, owner) {
  const started = [];
  const program = async () => { started.push("program"); return { code: 0, stdout: JSON.stringify({ result: "from the sign-in" }), stderr: "" }; };
  registerCliAgent(app.runtime.models, { id: "claude-code" }, {}, program);
  accountsServiceFor(app.runtime.models).deps.spawnAgent = program; // Claude Code answers through its native transport (see fakeClaudeAccounts)
  const script = [];
  const keyed = { name: "openai-chat", async complete() { return script.shift() ?? { content: "from the key", toolCalls: [] }; } };
  app.runtime.models.register({ id: "key-conn", name: "Key", model: "gpt-4o-mini", catalogId: "openai", provider: keyed });
  app.runtime.models.configure(owner, { activePreset: "cli-claude-code", fallbackOrder: ["key-conn"] });
  return { started, script };
}

test("a side job a Trunk's tool starts is the Trunk's: the owner's sign-in only when the owner is behind it", async (t) => {
  const { app, owner } = await fixture(t);
  savePolicy(app.store, owner, { preset: "custom", rules: [{ tool: "*", decision: "allow", remember: "always" }] });
  app.trunks.setMode("trunks", { mode: "on" });
  const { started, script } = signInFirst(app, owner);
  await fakeClaudeAccounts(t, accountsServiceFor(app.runtime.models));
  let sideJob = null;
  app.registry.register({ name: "files.summarise_side", permission: "files.read", description: "stand-in side job",
    parameters: z.object({}).passthrough(),
    execute: async () => {
      // As the document, knowledge and answer tools do: the owner's first connection, asked directly.
      const provider = app.runtime.models.plan(owner, "").candidates[0].provider;
      try { sideJob = (await provider.complete({ messages: [{ role: "user", content: "sum up" }], tools: [], maxTokens: 50, signal: AbortSignal.timeout(30000) })).content; }
      catch (error) { sideJob = `refused: ${error.message}`; }
      return { ok: true };
    } });
  const ed = app.trunks.create({ name: "Ed" });
  app.trunks.edit(ed.id, { permissions: ["files.read"] });
  await app.trunks.introduced();
  // trunks-use-subscriptions: somebody else behind the Trunk's turn (a message from another computer): refused.
  const before = started.length;
  script.push({ content: "", toolCalls: [{ id: "c1", name: "files.summarise_side", arguments: "{}" }] });
  const run = await app.runtime.run({ prompt: "sum it up", sessionId: ed.chatSessionId, source: "a2a", model: "key-conn" });
  assert.equal(run.status, "completed", run.output);
  assert.match(sideJob ?? "", /^refused: A Trunk answers through your sign-in accounts only for your own work/);
  assert.equal(started.length, before, "the program was never started for the Trunk");
  // The owner behind the Trunk's turn: its side job may use the owner's sign-in.
  script.push({ content: "", toolCalls: [{ id: "c3", name: "files.summarise_side", arguments: "{}" }] });
  const own = await app.runtime.run({ prompt: "sum it up", sessionId: ed.chatSessionId, model: "key-conn" });
  assert.equal(own.status, "completed", own.output);
  assert.equal(sideJob, "from the sign-in");
  // The owner's own side job still uses the owner's sign-in.
  script.push({ content: "", toolCalls: [{ id: "c2", name: "files.summarise_side", arguments: "{}" }] });
  await app.runtime.run({ prompt: "sum it up", model: "key-conn" });
  assert.equal(sideJob, "from the sign-in");
});

test("a mixture with a sign-in member refuses a Trunk's call, and a keep-alive ping is marked as the Trunk's", async (t) => {
  const { app, owner } = await fixture(t);
  const { started } = signInFirst(app, owner);
  const presets = app.runtime.models.presets;
  const mixture = new MixtureProvider({ id: "mix", name: "Mix", references: ["cli-claude-code", "key-conn"], aggregator: "key-conn", referenceMaxTokens: 64 },
    (id) => presets.get(id));
  const trunk = { keys: { copyFromOwner: true, accounts: {} } };
  const call = { owner, sessionId: "s", runId: "r", trunk };
  const request = { messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 64 };
  const answer = await withAccountCall(call, () => mixture.complete(request));
  assert.equal(answer.content, "from the key", "the key member answered");
  assert.equal(started.length, 0, "the sign-in member was never started for the Trunk");

  let armed = null;
  const keepAlive = { arm: (_owner, _session, _provider, ping) => { armed = ping; } };
  const seen = [];
  const preset = { id: "key-conn", name: "Key", model: "gpt-4o-mini", provider: { name: "p", async complete() { seen.push(currentAccountCall()?.trunk); return { content: "", toolCalls: [] }; } } };
  const run = await app.runtime.run({ prompt: "hello", model: "key-conn" });
  afterRound(app.runtime, keepAlive, { run, owner, preset, messages: [], tools: [], estimatedInput: 10, reported: undefined, mainRound: true, trunk });
  assert.ok(armed, "a ping was armed");
  await armed.send();
  assert.deepEqual(seen, [trunk]);
});

const TASK = ["workflows.manage", "workflows.read", "files.read"];

async function limitFixture(t) {
  const provider = { name: "scripted", script: [], async complete() { return provider.script.shift() ?? { content: "Done.", toolCalls: [] }; } };
  const fx = await fixture(t, provider);
  savePolicy(fx.app.store, fx.owner, { preset: "custom", rules: [{ tool: "*", decision: "allow", remember: "always" }] });
  const ran = [];
  fx.app.registry.unregister("shell.execute");
  fx.app.registry.register({ name: "shell.execute", permission: "shell.execute", description: "stand-in",
    parameters: z.object({}).passthrough(), execute: async () => { ran.push("shell.execute"); return { exitCode: 0 }; } });
  return { ...fx, provider, ran };
}

test("saving a workflow's steps again does not drop the limit a task put on it", async (t) => {
  const fx = await limitFixture(t);
  const { app, owner } = fx;
  const steps = [{ name: "Check", kind: "approval", question: "Go on?" }, { name: "Command", kind: "tool", tool: "shell.execute", args: {} }];
  const flow = app.workflows.create(owner, { name: "Runs a command", steps });
  fx.provider.script.push({ content: "", toolCalls: [{ id: "c1", name: "workflows.run", arguments: JSON.stringify({ id: flow.id }) }] });
  await app.runtime.run({ prompt: "run it", permissions: TASK });
  assert.equal(app.workflows.view(owner, flow.id).status, "waiting_approval");
  app.workflows.create(owner, { id: flow.id, name: "Runs a command", steps });
  const after = await app.workflows.resume(owner, flow.id);
  assert.equal(after.status, "failed");
  assert.match(after.error ?? "", /may not use shell\.execute/);
  assert.deepEqual(fx.ran, []);
});

test("a flow drafted and tried for a task keeps to that task's tools", async (t) => {
  const fx = await limitFixture(t);
  const context = fx.app.runtime.context({ permissions: TASK });
  const parts = flowSearchParts(fx.app.runtime, fx.app.flows, context);
  const tried = await parts.tryFlow({
    name: "Drafted", input: {}, state: { out: "text" }, entry: "a",
    nodes: [{ id: "a", name: "Command", kind: "tool", tool: "shell.execute", args: {}, input: {}, output: { out: "text" } }],
    edges: [],
  }, {});
  assert.equal(tried.status, "failed");
  assert.deepEqual(fx.ran, [], "the drafted flow did not run a command for a task that may not");
});

test("a finished flow run's limit is cleaned up, a failed one keeps it, and neither can be written from a settings file", async (t) => {
  const fx = await limitFixture(t);
  const { app, owner } = fx;
  // Going back to a step ships when needed (the ship-on rule), and a run whose steps are kept keeps its limit for the
  // copy going back makes; this test is about a run with no steps kept, so the owner switches it off.
  app.store.save("settings", owner, "flowboards-time-travel", { mode: "off" });
  const graph = (name, tool) => app.flows.saveGraph({
    name, input: {}, state: { out: "text" }, entry: "a",
    nodes: [{ id: "a", name: "Box", kind: "tool", tool, args: {}, input: {}, output: { out: "text" } }], edges: [],
  });
  const look = graph("Look", "files.list");
  const done = await app.flows.settled(app.flows.startGraph(look.id, {}, TASK).runId);
  assert.equal(done.status, "completed", done.error ?? "");
  assert.ok(!app.store.get("settings", owner, `flow-run-limit:${done.runId}`), "a finished run's limit is gone");
  const command = graph("Command", "shell.execute");
  const failed = await app.flows.settled(app.flows.startGraph(command.id, {}, TASK).runId);
  assert.equal(failed.status, "failed");
  assert.ok(app.store.get("settings", owner, `flow-run-limit:${failed.runId}`), "a failed run may be carried on, so it keeps its limit");
  assert.ok(neverTouched.some((pattern) => pattern.test(`flow-run-limit:${failed.runId}`)), "the settings kit never touches it");
  app.flows.remove(command.id);
  assert.ok(!app.store.get("settings", owner, `flow-run-limit:${failed.runId}`), "removing the flow removes its runs' limits");
});
