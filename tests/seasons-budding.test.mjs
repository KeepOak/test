import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createBranch } from "../dist/index.js";
import { Budding, gapMarker } from "../dist/seasons/budding.js";
import { setLockdown } from "../dist/lockdown.js";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t, { gap = false, platform = "linux", passed = 1 } = {}) {
  const temp = process.platform === "win32" ? "C:/Users/bishi/AppData/Local/Temp/Codex-session-files" : tmpdir();
  await mkdir(temp, { recursive: true });
  const root = await mkdtemp(join(temp, "branch-budding-"));
  const provider = { name: "stand-in", async complete() { return { content: "Owner task", toolCalls: [] }; } };
  const app = await createBranch({ dataDir: join(root, "data"), workspace: join(root, "workspace"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const original = await app.runtime.run({ prompt: "Compute and save a report" });
  const context = app.runtime.context({ runId: original.id });
  const seen = { delegated: [], scripts: [], installs: [], source: [] };
  app.runtime.delegate = async (task, ctx, permissions, instructions) => {
    seen.delegated.push({ task, permissions, instructions });
    return { ...original, output: gap && seen.delegated.length === 1 ? `${gapMarker} no capability` : "Original task finished", status: "completed" };
  };
  const scripts = { async run(input) { seen.scripts.push(input); return { ok: passed > 0, result: [{ value: 6, complete: true }], calls: [], output: "", ...(passed > 0 ? {} : { error: "test failed" }) }; } };
  const servers = { async add(input) { seen.installs.push(input); return { server: { id: "approved-server" } }; }, async start() { return {}; } };
  const sourceRequests = { file(input) { seen.source.push(input); return { id: "source-request" }; },
    fileOwnerTask(text) { seen.source.push({ text }); return { id: "source-request" }; }, installed() { return false; }, list() { return []; } };
  const deps = { store: app.store, runtime: app.runtime, registry: app.registry, gardener: app.gardener, scripts, servers, sourceRequests, platform, version: "test-v1" };
  const budding = new Budding(deps);
  return { app, budding, context, seen, deps };
}
const build = (id) => ({ id, name: "report", description: "Compute reports", source: "async function build(input) { return input.count * 2; }", tools: ["files.read"], tests: [{ input: { count: 3 }, expected: 6 }] });

test("a missing setting preserves its task and opens one source review without pretending to change it", async (t) => {
  const { budding, context, seen } = await fixture(t);
  const input = { request: "quantum report style", task: "Set quantum report style and make my report", value: "on" };
  const bud = budding.requestSetting(input, context);
  assert.equal(bud.stage, "branch-review");
  assert.equal(bud.task, input.task);
  assert.equal(bud.settingRequest.request, input.request);
  assert.match(seen.source[0].text, /quantum report style/);
  assert.equal(budding.requestSetting(input, context).id, bud.id);
  assert.equal(seen.source.length, 1);
  assert.throws(() => budding.requestSetting({ ...input, request: "do not change quantum report style" }, context), /clarify/);
  assert.throws(() => budding.requestSetting({ ...input, request: "wake word" }, context), /already|clarify/);
});

test("an installed merge still cannot resume a setting request until the setting exists", async (t) => {
  const { app, budding, context, deps } = await fixture(t);
  const bud = budding.requestSetting({ request: "quantum report style", task: "Make a report", value: "on" }, context);
  deps.version = "test-v2";
  deps.sourceRequests.installed = () => true;
  let resumed = false;
  app.runtime.run = async () => { resumed = true; throw new Error("must not resume"); };
  await budding.tick();
  assert.equal(resumed, false);
  assert.equal(budding.get(bud.id).stage, "branch-review");
});

test("manual confirmation cannot substitute an unrelated version for a missing-setting merge receipt", async t => {
  const { app, budding, context, deps } = await fixture(t);
  const bud = budding.requestSetting({ request: "quantum report style", task: "Make a report", value: "on" }, context);
  // Represents a saved request from a build before wake word settings existed.
  app.store.sqlite.prepare("UPDATE seasons_buds SET data=? WHERE id=?").run(JSON.stringify({ ...bud,
    settingRequest: { ...bud.settingRequest, request: "wake word mode" }, branchConfirmed: true }), bud.id);
  deps.version = "test-v2";
  let resumed = 0;
  app.runtime.run = async () => { resumed++; return { id: bud.runId, status: "completed", output: "done" }; };
  await budding.tick();
  assert.equal(resumed, 0);
  deps.sourceRequests.installed = () => true;
  await budding.tick(); await budding.tick();
  assert.equal(resumed, 1);
});

test("Budding composes first, finishes the preserved task, and creates only an eval-waiting skill seed", async (t) => {
  const { app, budding, context, seen } = await fixture(t);
  const bud = await budding.start("Save my report", "calculate reports", context);
  assert.equal(bud.stage, "completed");
  assert.equal(seen.delegated[0].task, "Save my report");
  assert.ok(!seen.delegated[0].permissions.includes("learning.bud"));
  assert.deepEqual(seen.scripts, []);
  assert.deepEqual(seen.installs, []);
  assert.equal(app.gardener.book.seeds()[0].trigger, "budding");
  assert.equal(app.gardener.book.seeds()[0].status, "waiting");
});

test("a failed composition offers matching connectors without installing; approval is per exact offered item", async (t) => {
  const { budding, context, seen } = await fixture(t, { gap: true });
  const bud = await budding.start("Search GitHub issues", "github", context);
  assert.equal(bud.stage, "connector-review");
  assert.ok(bud.connectors.length);
  assert.deepEqual(seen.installs, []);
  await assert.rejects(budding.approveConnector(bud.id, "not-offered"), /not waiting/);
  assert.deepEqual(seen.installs, []);
  await assert.rejects(budding.build(build(bud.id), context), /cheaper rungs/);
  const declined = budding.declineConnector(bud.id);
  assert.equal(declined.stage, "sandbox-ready");
});

test("simultaneous exact connector approvals create only one persisted server and keep unrelated buds independent", async (t) => {
  const { app, budding, context, deps } = await fixture(t, { gap: true });
  const bud = await budding.start("Search Linear issues", "linear", context);
  assert.ok(bud.connectors.some((one) => one.id === "linear"));
  const other = { ...bud, id: randomUUID() };
  app.store.sqlite.prepare("INSERT INTO seasons_buds VALUES(?,?,?,?)").run(other.id, "local", JSON.stringify(other), other.updatedAt);
  let release, entered, adds = 0;
  const held = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { entered = resolve; });
  const starts = [];
  deps.servers.add = async () => { const id = `server-${++adds}`; if (adds === 1) { entered(); await held; } return { server: { id } }; };
  deps.servers.start = async (id) => { starts.push(id); return {}; };
  const one = budding.approveConnector(bud.id, "linear"), two = budding.approveConnector(bud.id, "linear");
  await began;
  const independent = await budding.approveConnector(other.id, "linear");
  assert.equal(independent.serverId, "server-2", "another bud is not blocked behind this approval");
  release();
  const results = await Promise.all([one, two]);
  assert.deepEqual(results.map((one) => one.serverId), ["server-1", "server-1"]);
  assert.equal(budding.get(bud.id).serverId, "server-1");
  assert.equal(adds, 2, "one server per distinct approved bud, none orphaned");
  assert.ok(starts.every((id) => ["server-1", "server-2"].includes(id)));
});

test("a queued connector approval rechecks owner authorization and failed starts retry the already-persisted server", async (t) => {
  const { app, budding, context, deps } = await fixture(t, { gap: true });
  const bud = await budding.start("Search Linear issues", "linear", context);
  let release, entered, adds = 0;
  const held = new Promise((resolve) => { release = resolve; });
  const began = new Promise((resolve) => { entered = resolve; });
  deps.servers.add = async () => { adds++; entered(); await held; return { server: { id: "retained-server" } }; };
  let starts = 0;
  deps.servers.start = async () => { starts++; return {}; };
  const one = budding.approveConnector(bud.id, "linear"), two = budding.approveConnector(bud.id, "linear");
  const settled = Promise.allSettled([one, two]);
  await began;
  setLockdown(app.store, "local", { on: true });
  release();
  assert.ok((await settled).every((one) => one.status === "rejected"));
  assert.equal(adds, 1);
  assert.equal(starts, 0);
  assert.equal(budding.get(bud.id).serverId, "retained-server");
  setLockdown(app.store, "local", { on: false });
  assert.equal((await budding.approveConnector(bud.id, "linear")).serverId, "retained-server");
  assert.equal(adds, 1);
  assert.equal(starts, 1);
});

test("held tools register only after successful fixtures and finish the original request", async (t) => {
  const { app, budding, context, seen } = await fixture(t, { gap: true });
  const bud = await budding.start("Compute reports", "zzx-unsupported-capability", context);
  assert.equal(bud.stage, "sandbox-ready");
  const completed = await budding.build(build(bud.id), context);
  assert.equal(completed.stage, "completed");
  assert.equal(completed.tool, "plugin.bud-report.run");
  assert.equal(seen.scripts.length, 1);
  assert.equal(app.registry.sourceOf(completed.tool), "plugin:bud-report");
  assert.equal(seen.delegated.at(-1).task, bud.task);
  assert.equal(completed.evaluation.candidate.passed, 1);
  assert.match(completed.evaluation.candidate.sha256, /^[a-f0-9]{64}$/);
});

test("generated-tool revisions compare old fixtures, reject regressions, and retain a rollback", async (t) => {
  const { app, budding, context, deps } = await fixture(t, { gap: true });
  deps.scripts.run = async () => ({ ok: true, result: [{ value: 6, complete: true }], calls: [], output: "" });
  const bud = await budding.start("Compute reports", "zzx-unsupported-capability", context);
  await budding.build(build(bud.id), context);
  let outputs = [[6, 8], [99, 8]];
  deps.scripts.run = async () => ({ ok: true, result: outputs.shift().map(value => ({ value, complete: true })), calls: [], output: "" });
  const revision = { ...build(bud.id), source: "async function build(input) { return input.count === 3 ? 99 : 8; }", tests: [{ input: { count: 4 }, expected: 8 }] };
  const rejected = await budding.revise(revision, context);
  assert.equal(rejected.built.source, build(bud.id).source);
  assert.equal(rejected.evaluation.promoted, false);
  assert.equal(rejected.evaluation.baseline.passed, 2);
  outputs = [[6, null], [6, 8]];
  const improved = await budding.revise({ ...revision, source: "async function build(input) { return input.count * 2; } // improved" }, context);
  assert.equal(improved.evaluation.promoted, true);
  assert.equal(improved.evaluation.candidate.passed, 2);
  assert.equal(improved.built.tests.length, 2);
  const rolledBack = budding.rollback(bud.id, context);
  assert.equal(rolledBack.built.source, build(bud.id).source);
  assert.equal(rolledBack.built.tests.length, 2, "rollback retains the regression suite");
  assert.ok(app.registry.names().includes("plugin.bud-report.run"));
});

test("failing held-tool tests never register it; Branch changes only file a review request after owner action", async (t) => {
  const { app, budding, context, seen } = await fixture(t, { gap: true, passed: 0 });
  const bud = await budding.start("Compute reports", "zzx-unsupported-capability", context);
  assert.throws(() => budding.requestBranch(bud.id), /Try the held tool/);
  await budding.build(build(bud.id), context);
  assert.ok(!app.registry.names().includes("plugin.bud-report.run"));
  assert.deepEqual(seen.source, []);
  const requested = budding.requestBranch(bud.id);
  assert.equal(requested.stage, "branch-review");
  assert.equal(seen.source.length, 1);
  assert.match(seen.source[0].text, /Original task: Compute reports/);
  await assert.rejects(budding.retry(bud.id, context), /has not arrived/);
});

test("Windows uses the held runner, and household or Lockdown cannot approve new capabilities", async (t) => {
  const { app, budding, context, seen } = await fixture(t, { gap: true, platform: "win32" });
  const bud = await budding.start("Compute reports", "zzx-unsupported-capability", context);
  const built = await budding.build(build(bud.id), context);
  assert.equal(built.stage, "completed");
  assert.equal(seen.scripts.length, 1);
  const sam = app.store.profiles.create({ name: "Sam", pin: "2468" });
  app.store.profiles.switch({ profileId: sam.id, pin: "2468" });
  assert.throws(() => budding.requestBranch(bud.id), /owner/);
  app.store.profiles.switch({ profileId: null });
  setLockdown(app.store, "local", { on: true });
  await assert.rejects(budding.start("A new request", "github", context), /Lockdown/);
});

test("approved MCP hot reload resumes once with only that connector's new permissions", async (t) => {
  const { app, budding, context, seen } = await fixture(t, { gap: true });
  const bud = await budding.start("Search Linear issues", "linear", context);
  await budding.approveConnector(bud.id, bud.connectors[0].id);
  await budding.approveConnector(bud.id, bud.connectors[0].id);
  assert.equal(seen.installs.length, 1);
  const runs = [];
  app.runtime.run = async (options) => { runs.push(options); return { status: "completed", output: "Issues found", id: bud.runId }; };
  const register = (id) => app.registry.register({ name: `mcp.${id}.search`, permission: `mcp.${id}.search`, source: `mcp:${id}`, parameters: z.object({}).strict(), description: "Search issues", execute: async () => [] });
  register("unrelated");
  await budding.tick();
  assert.equal(runs.length, 0);
  register("approved-server");
  await budding.tick();
  await budding.tick();
  assert.equal(runs.length, 1);
  assert.ok(runs[0].permissions.includes("mcp.approved-server.search"));
  assert.ok(!runs[0].permissions.includes("mcp.unrelated.search"));
  assert.match(runs[0].prompt, /Search Linear issues/);
  assert.equal(budding.get(bud.id).stage, "completed");
});

test("building cannot widen the task's code or named-tool permissions", async (t) => {
  const { budding, context, seen } = await fixture(t, { gap: true });
  const bud = await budding.start("Compute reports", "zzx-unsupported-capability", context);
  await assert.rejects(budding.build(build(bud.id), { ...context, permissions: new Set(["files.read"]) }), /allowed to run held code/);
  await assert.rejects(budding.build(build(bud.id), { ...context, permissions: new Set(["code.execute"]) }), /cannot gain tools/);
  await assert.rejects(budding.build({ ...build(bud.id), tools: ["tools.script"] }, context), /cannot start another script/);
  assert.deepEqual(seen.scripts, []);
});

test("a restart preserves the interrupted task without replaying its uncertain work", async (t) => {
  const { app, budding, context } = await fixture(t, { gap: true });
  const bud = await budding.start("Search Linear issues", "linear", context);
  const resumed = app.store.createRun("local", "Search Linear issues");
  app.store.finish(resumed.id, "interrupted", "Saved work");
  app.store.sqlite.prepare("UPDATE seasons_buds SET data=? WHERE id=?").run(JSON.stringify({ ...bud, resuming: true, resumeRunId: resumed.id }), bud.id);
  let replayed = 0;
  app.runtime.run = async () => { replayed++; throw new Error("must not replay"); };
  await budding.tick();
  await budding.tick();
  assert.equal(replayed, 0);
  assert.equal(budding.get(bud.id).stage, "failed");
  assert.match(budding.get(bud.id).error, /Continue its interrupted conversation/);
  assert.equal(app.store.run(resumed.id).output, "Saved work");
});

test("simultaneous scheduler ticks share one resumed task and save its run identity", async (t) => {
  const { app, budding, context } = await fixture(t, { gap: true });
  app.runtime.delegate = async () => ({ status: "completed", output: `${gapMarker} not connected` });
  const bud = await budding.start("Search Linear issues", "linear", context);
  const other = await budding.start("Search another Linear project", "linear", context);
  await budding.approveConnector(bud.id, bud.connectors[0].id);
  await budding.approveConnector(other.id, other.connectors[0].id);
  app.registry.register({ name: "mcp.approved.search", permission: "mcp.approved.search", source: "mcp:approved-server", parameters: z.object({}).strict(), description: "Search", execute: async () => [] });
  let runs = 0, release;
  const waiting = new Promise((resolve) => { release = resolve; });
  app.runtime.run = async (options) => {
    runs++;
    const run = app.store.createRun("local", options.prompt);
    options.onStarted(run);
    await waiting;
    return app.store.finish(run.id, "completed", "Issues found");
  };
  const first = budding.tick(), second = budding.tick();
  assert.equal(runs, 1);
  assert.ok(budding.get(bud.id).resumeRunId);
  release();
  await Promise.all([first, second]);
  assert.equal(budding.get(bud.id).stage, "completed");
  await budding.close();
  await budding.tick();
  assert.equal(runs, 1);
});

test("a prepared Branch contract and an unrelated update do not prove this change arrived", async (t) => {
  const { app, budding, context, deps } = await fixture(t, { gap: true, passed: 0 });
  const bud = await budding.start("Compute reports", "zzx-unsupported-capability", context);
  await budding.build(build(bud.id), context);
  budding.requestBranch(bud.id);
  assert.throws(() => budding.confirmBranch(bud.id), /Approve and install/);
  deps.sourceRequests.list = () => [{ id: "source-request", status: "approved" }];
  assert.throws(() => budding.confirmBranch(bud.id), /Approve and install/);
  deps.version = "test-v2";
  let runs = 0;
  app.runtime.run = async () => { runs++; return { id: bud.runId, status: "completed", output: "Report finished" }; };
  await budding.tick();
  assert.equal(runs, 0);
  await assert.rejects(budding.retry(bud.id, context), /has not arrived/);
  budding.confirmBranch(bud.id);
  await budding.tick();
  assert.equal(runs, 1);
  assert.equal(budding.get(bud.id).stage, "completed");
});

test("a composition exception is recorded and the preserved request proceeds to a cheaper connector decision", async (t) => {
  const { app, budding, context } = await fixture(t);
  app.runtime.delegate = async () => { throw new Error("Provider stopped"); };
  const bud = await budding.start("Search Linear issues", "linear", context);
  assert.equal(bud.stage, "connector-review");
  assert.equal(bud.error, "Provider stopped");
  assert.equal(bud.task, "Search Linear issues");
});

test("closing Budding cancels its foreground continuation before the database closes", async (t) => {
  const { app, budding, context } = await fixture(t, { gap: true });
  const bud = await budding.start("Search Linear issues", "linear", context);
  await budding.approveConnector(bud.id, bud.connectors[0].id);
  app.registry.register({ name: "mcp.approved.search", permission: "mcp.approved.search", source: "mcp:approved-server", parameters: z.object({}).strict(), description: "Search", execute: async () => [] });
  let signal;
  app.runtime.run = async (options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
  };
  const work = budding.tick();
  await budding.close();
  await work;
  assert.equal(signal.aborted, true);
  assert.equal(budding.get(bud.id).stage, "failed");
  assert.match(budding.get(bud.id).error, /Branch is closing/);
});
