/**
 * selfdev: Settings › Branch itself, what Branch may do about itself (src/self-rules.ts), restarting its own engine
 * (branch.restart_engine), and Reload without dropping work (POST /api/dashboard/restart { whenIdle: true }).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { readPolicy } from "../dist/policy.js";
import { changeSelfRule, selfRulesView, SelfRuleRefusal } from "../dist/self-rules.js";
import { dashboardApi, registerRestartTool } from "../dist/dashboard-api.js";
import { restartPlan } from "../dist/dashboard-summary.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-self-rules-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: { name: "scripted", complete: async () => ({ content: "Done.", toolCalls: [] }) } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, owner: app.runtime.owner, store: app.store };
}
const sent = [];
const supervised = { platform: "linux", env: { INVOCATION_ID: "x" }, pid: 4242, idleCheckMs: 20,
  running: async () => ({ mode: "daemon", pid: 4242, port: 1, url: "", version: "1", startedAt: new Date().toISOString() }),
  signal: (pid, name) => sent.push(["signal", pid, name]), setExitCode: (code) => sent.push(["exit", code]) };

test("each row is the rule in force for its own tools; a less careful change waits for the owner's yes", async (t) => {
  const { app, owner, store } = await fixture(t);
  registerRestartTool(app, "unused", supervised);
  const names = app.registry.names();
  const view = selfRulesView(store, owner, names);
  assert.equal(view.ownSettings, "ask");
  assert.equal(view.gatewayTimings, "suggest");
  assert.equal(view.loosening, "ask");
  assert.deepEqual(view.selfDev, { on: false, available: false }, "working on its own code needs remote Git first");
  // Tighter changes go through at once.
  assert.equal(changeSelfRule(store, owner, { control: "ownSettings", value: "never" }, false, app.registry, names).ownSettings, "never");
  assert.ok(readPolicy(store, owner).rules.some((rule) => rule.tool === "settings.change" && rule.decision === "deny"));
  assert.equal(changeSelfRule(store, owner, { control: "gatewayTimings", value: "never" }, false, app.registry, names).gatewayTimings, "never");
  assert.equal(changeSelfRule(store, owner, { control: "restart", value: "ask" }, false, app.registry, names).restart, "ask");
  // Less careful ones are refused until the owner says yes, and then kept.
  assert.throws(() => changeSelfRule(store, owner, { control: "ownSettings", value: "ask" }, false, app.registry, names), SelfRuleRefusal);
  assert.equal(selfRulesView(store, owner, names).ownSettings, "never", "a refused change changes nothing");
  assert.equal(changeSelfRule(store, owner, { control: "ownSettings", value: "ask" }, true, app.registry, names).ownSettings, "ask");
  assert.throws(() => changeSelfRule(store, owner, { control: "restart", value: "allowed" }, false, app.registry, names), SelfRuleRefusal);
  assert.equal(changeSelfRule(store, owner, { control: "restart", value: "allowed" }, true, app.registry, names).restart, "allowed");
  assert.throws(() => changeSelfRule(store, owner, { control: "selfDev", value: "on", extra: 1 }, true, app.registry, names));
});

test("the window's route is the owner's, refuses a short-lived key's change, and says why a loosening waits", async (t) => {
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(() => server.close());
  const call = (body) => fetch(new URL("/api/self-rules", server.url), { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await (await call()).json()).ownSettings, "ask");
  assert.equal((await call({ control: "ownSettings", value: "never" })).status, 200);
  const refused = await call({ control: "ownSettings", value: "ask" });
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /less careful/);
  assert.equal((await (await call({ control: "ownSettings", value: "ask", confirmLoosening: true })).json()).ownSettings, "ask");
});

test("a restart is possible under the desktop app's engine host or the gateway, on Windows too", () => {
  const base = { platform: "win32", env: {}, pid: 1, running: null };
  assert.equal(restartPlan(base).possible, false);
  assert.deepEqual(restartPlan({ ...base, hosted: true }), { possible: true, reason: "restart.ready" });
  assert.deepEqual(restartPlan({ ...base, env: { BRANCH_GATEWAY_CHILD: "1" } }), { possible: true, reason: "restart.ready" });
});

test("reload without dropping work waits until no task is working, then restarts once", async (t) => {
  const { app, root, store, owner } = await fixture(t);
  sent.length = 0;
  const run = store.createRun(owner, "working");
  store.sqlite.prepare("UPDATE tasks SET status='running' WHERE id=?").run(run.id);
  const request = { method: "POST", headers: {} };
  const ask = () => dashboardApi(app, request, "/api/dashboard/restart", { dataDir: join(root, "data"), access: "full", readBody: async () => ({ whenIdle: true }), deps: supervised });
  const waiting = await ask();
  assert.deepEqual(waiting, { restarting: false, waiting: true, working: 1 });
  await ask(); // asked twice, it waits once
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(sent, [], "nothing is cut off while a task works");
  store.finish(run.id, "completed", "done");
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(sent, [["exit", 75], ["signal", 4242, "SIGTERM"]], "then it restarts, once");
});

test("branch.restart_engine restarts for the owner's own task and never for a Trunk's or a person's", async (t) => {
  const { app, root } = await fixture(t);
  sent.length = 0;
  registerRestartTool(app, join(root, "data"), supervised);
  const run = app.store.createRun(app.runtime.owner, "restart");
  app.store.event(run.id, "run.started", { source: "owner", parentRunId: null });
  const context = (extra = {}) => ({ ...app.runtime.context({ runId: run.id }), permissions: new Set(["process.manage"]), ...extra });
  await assert.rejects(app.registry.execute("branch.restart_engine", { why: "stuck" }, context({ trunk: "other" })), /Only the owner/);
  assert.deepEqual(await app.registry.execute("branch.restart_engine", { why: "stuck" }, context()), { restarting: true });
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.deepEqual(sent, [["exit", 75], ["signal", 4242, "SIGTERM"]]);
});

test("working on its own code goes live the moment GitHub is connected, with no switch of its own; remote false keeps it off", async (t) => {
  const { app, root, owner, store } = await fixture(t);
  const { loadIntegrations } = await import("../dist/integrations/bootstrap.js");
  const { writeFile } = await import("node:fs/promises");
  assert.deepEqual(selfRulesView(store, owner, app.registry.names()).selfDev, { on: false, available: false }, "not before GitHub");
  const explicitOff = join(root, "off.json");
  await writeFile(explicitOff, JSON.stringify({ git: { remote: false, github: { tokenSecret: "GITHUB_TOKEN" } } }));
  const off = await loadIntegrations(app.registry, explicitOff, {}, app.secretsFor, app.channelHost);
  assert.equal(app.registry.names().includes("git.push"), false, "an explicit remote false still keeps sending off");
  assert.equal(selfRulesView(store, owner, app.registry.names()).selfDev.available, false);
  await off.close();
  for (const name of app.registry.names().filter((one) => one.startsWith("github."))) app.registry.unregister(name);
  const connected = join(root, "github.json");
  await writeFile(connected, JSON.stringify({ git: { github: { tokenSecret: "GITHUB_TOKEN" } } }));
  const on = await loadIntegrations(app.registry, connected, {}, app.secretsFor, app.channelHost);
  t.after(() => on.close());
  const names = app.registry.names();
  assert.ok(names.includes("git.push"), "connecting GitHub turns sending on");
  assert.ok(names.includes("branch.prepare_source_change"), "and with it, working on its own code");
  assert.deepEqual(selfRulesView(store, owner, names).selfDev, { on: true, available: true });
});
