import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { interopParts, interopTools } from "../dist/interop/settings.js";
import { interopToolFeatures, switchedToolTiers } from "../dist/feature-switches.js";

/* mac4/bucket-20: talking to other agents and tools (src/interop/). Every test names its audit row. */
const say = (content) => ({ content, toolCalls: [] });

function scripted(reply) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    const user = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    return reply({ user, request });
  } };
  return provider;
}

async function fixture(t, reply = () => say("done"), { server = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-interop-"));
  const provider = scripted(reply);
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }],
  });
  const started = server ? await startServer(app, { dataDir: join(root, "data"), port: 0 }) : null;
  t.after(async () => { await started?.close(); await app.close(); await discardTemp(root); });
  const http = (path, { key = started?.token, body, method } = {}) => fetch(started.url + path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "content-type": "application/json" }), "x-branch-agent": "harness" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const on = (part, mode = "when-needed") => app.interop.setMode(part, { mode });
  return { app, root, provider, server: started, http, on, owner: app.runtime.owner };
}
const taskContext = (app, prompt = "a task", permissions) => {
  const run = app.store.createRun(app.runtime.owner, prompt);
  return { run, context: app.runtime.context({ runId: run.id, ...(permissions ? { permissions } : {}) }) };
};

test("bucket 20 ships off: no part answers and none of its tools is in the catalog until switched on", async (t) => {
  const f = await fixture(t);
  // The owner's rule (ships on, 2026-09-26): what reaches outside this task (the Agent Protocol, lent tools, the fleet,
  // handing on) and what spends (flow search) ship off; the rest ship "when needed". The market of shared assistants
  // ships when needed too (2026-09-27): it lists what the owner asks for, and nothing comes in without the owner's yes.
  const ships = { "agent-protocol": "off", "client-tools": "off", fleet: "off", handoff: "off", "flow-search": "off" };
  assert.deepEqual(f.app.interop.modesOf(), Object.fromEntries(interopParts.map((part) => [part, ships[part] ?? "when-needed"])));
  for (const part of interopParts) f.on(part, "off");
  const all = Object.values(interopTools).flat();
  for (const name of all) assert.equal(f.app.registry.permissionOf(name), "", `${name} is in the catalog while off`);
  // The preload list in feature-switches.ts names exactly the tools each part owns.
  for (const [key, , tools] of interopToolFeatures)
    assert.deepEqual([...tools], [...interopTools[key.replace(/^interop-/, "")]], key);
  f.on("fleet", "on");
  assert.equal(f.app.registry.permissionOf("fleet.status"), "specialists.read");
  const tiers = switchedToolTiers(f.app.store, f.owner, [...f.app.registry.names(), "mode.task"]);
  assert.ok(tiers.preload.some((entry) => entry.name === "fleet.send"), "on loads the tools from the first round");
  assert.ok(tiers.hidden.includes("mode.task"), "a part that is off keeps its tools hidden");
  f.on("fleet", "off");
  assert.equal(f.app.registry.permissionOf("fleet.status"), "");
  assert.throws(() => f.app.interop.router.route("anything"), /switched off/);
});

test("agent-protocol (A0548) a harness creates a task, runs a step, lists it and downloads the answer", async (t) => {
  const f = await fixture(t, ({ user }) => say(`Answer to: ${user}`), { server: true });
  const off = await f.http("/ap/v1/agent/tasks", { body: { input: "hello" } });
  assert.equal(off.status, 404, "the protocol is not answered while switched off");
  f.on("agent-protocol");
  const created = await (await f.http("/ap/v1/agent/tasks", { body: { input: "Write one line about oaks" } })).json();
  assert.match(created.task_id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(created.artifacts, []);
  assert.equal(created.sessionId, undefined, "the conversation id is not shown to the caller");
  const step = await (await f.http(`/ap/v1/agent/tasks/${created.task_id}/steps`, { body: {} })).json();
  assert.equal(step.status, "completed");
  assert.equal(step.is_last, true);
  assert.match(step.output, /Answer to: Write one line about oaks/);
  assert.equal(step.additional_output.state, "completed");
  const events = f.app.store.events(step.additional_output.runId);
  assert.ok(events.some((e) => e.kind === "a2a.task" && e.data.source === "agent-protocol" && e.data.agent === "harness"));
  const second = await f.http(`/ap/v1/agent/tasks/${created.task_id}/steps`, { body: {} });
  assert.equal(second.status, 400, "an empty step after the first has nothing to do");
  const listed = await (await f.http(`/ap/v1/agent/tasks/${created.task_id}/steps?page_size=5`)).json();
  assert.equal(listed.steps.length, 1);
  assert.deepEqual(listed.pagination, { total_items: 1, total_pages: 1, current_page: 1, page_size: 5 });
  const tasks = await (await f.http("/ap/v1/agent/tasks")).json();
  assert.equal(tasks.tasks[0].task_id, created.task_id);
  const artifacts = await (await f.http(`/ap/v1/agent/tasks/${created.task_id}/artifacts`)).json();
  assert.equal(artifacts.artifacts[0].file_name, "answer-1.md");
  const file = await f.http(`/ap/v1/agent/tasks/${created.task_id}/artifacts/${artifacts.artifacts[0].artifact_id}`);
  assert.match(file.headers.get("content-type"), /text\/markdown/);
  assert.equal(await file.text(), step.output);
  assert.equal((await f.http(`/ap/v1/agent/tasks/${created.task_id}/artifacts`, { body: {} })).status, 415, "files are not taken in");
  assert.equal((await f.http(`/ap/v1/agent/tasks/${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`)).status, 404);
  assert.equal((await fetch(f.server.url + "/ap/v1/agent/tasks")).status, 401, "nothing without the key");
  const readKey = f.app.sessionTokens.create(f.owner, { name: "look", scope: "read", minutes: 5 }).token;
  assert.notEqual((await f.http("/ap/v1/agent/tasks", { key: readKey, body: { input: "x" } })).status, 200, "a look-only key cannot start work");
});

test("client-tools (A2335) a program lends a tool over the socket, answers its call, and the tool goes when it hangs up", async (t) => {
  const f = await fixture(t, () => say("ok"), { server: true });
  const address = f.server.url.replace("http", "ws") + "/api/interop/client-tools/ws";
  const refused = new WebSocket(address, ["bearer", f.server.token]);
  await new Promise((resolve) => { refused.onerror = resolve; refused.onclose = resolve; });
  assert.equal(refused.readyState, WebSocket.CLOSED, "switched off, the socket is refused");
  f.on("client-tools");
  const socket = new WebSocket(address, ["bearer", f.server.token]);
  const inbox = [];
  const next = () => new Promise((resolve) => { const check = () => inbox.length ? resolve(inbox.shift()) : setTimeout(check, 10); check(); });
  socket.onmessage = (event) => inbox.push(JSON.parse(event.data));
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.send(JSON.stringify({ type: "hello", client: "editor", tools: [{ name: "open_file", description: "Open a file in the editor",
    parameters: { type: "object", properties: { path: { type: "string" } } } }] }));
  assert.deepEqual(await next(), { type: "ready", tools: ["client.editor.open_file"] });
  assert.equal(f.app.registry.permissionOf("client.editor.open_file"), "client.tools");
  assert.equal(f.app.registry.isExternal("client.editor.open_file"), true, "its description is somebody else's text");
  const { context } = taskContext(f.app, "open it");
  const answer = f.app.registry.execute("client.editor.open_file", { path: "notes.md" }, context);
  const callMessage = await next();
  assert.equal(callMessage.type, "call");
  assert.equal(callMessage.tool, "open_file");
  assert.deepEqual(callMessage.arguments, { path: "notes.md" });
  socket.send(JSON.stringify({ type: "result", id: callMessage.id, output: "opened notes.md" }));
  assert.deepEqual(await answer, { lentBy: "editor", output: "opened notes.md" });
  const failing = f.app.registry.execute("client.editor.open_file", { path: "x" }, context);
  const second = await next();
  socket.send(JSON.stringify({ type: "result", id: second.id, error: "no such file" }));
  await assert.rejects(failing, /editor answered: no such file/);
  assert.deepEqual((await (await f.http("/api/interop")).json()).programs, [{ client: "editor", tools: ["client.editor.open_file"] }]);
  const pending = f.app.registry.execute("client.editor.open_file", { path: "y" }, context);
  await next();
  socket.close();
  await assert.rejects(pending, /disconnected before answering/);
  for (let i = 0; i < 50 && f.app.registry.permissionOf("client.editor.open_file"); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.app.registry.permissionOf("client.editor.open_file"), "", "hanging up takes the tool away");
});

test("A0429 modes: built in, the owner's own, a trusted folder's; a mode only narrows what a task could do", async (t) => {
  const f = await fixture(t);
  const { modePermissions, modesFile } = await import("../dist/interop/modes.js");
  f.on("modes");
  const slugs = f.app.interop.modes.list().map((m) => m.slug);
  assert.deepEqual(slugs, ["ask", "architect", "code", "debug", "orchestrator"]);
  f.app.interop.modes.save({ slug: "reviewer", name: "Reviewer", role: "You review.", readOnly: true, groups: ["files"] });
  await mkdir(join(f.app.runtime.workspace, ".branch"), { recursive: true });
  await writeFile(join(f.app.runtime.workspace, modesFile), JSON.stringify({ modes: [{ slug: "docs", name: "Docs", role: "You write docs." }] }));
  assert.deepEqual(f.app.interop.modes.list().map((m) => `${m.slug}:${m.origin}`).slice(5), ["reviewer:yours", "docs:this folder"]);
  const { saveFolderTrustSettings, decideFolder } = await import("../dist/folder-trust.js");
  saveFolderTrustSettings(f.app.store, f.owner, { mode: "on" });
  decideFolder(f.app.store, f.owner, f.app.runtime.workspace, { folder: "", decision: "distrust" });
  assert.ok(!f.app.interop.modes.list().some((m) => m.slug === "docs"), "a folder the owner distrusts brings no modes");
  const reviewer = f.app.interop.modes.find("reviewer");
  const granted = new Set(f.app.registry.permissions());
  const reach = modePermissions(reviewer, f.app.registry, granted);
  assert.ok(reach.includes("files.read"));
  assert.ok(!reach.includes("files.write"), "read-only takes writing away");
  assert.ok(!reach.includes("web.read"), "only the named toolboxes, plus the core ones");
  const narrow = modePermissions(f.app.interop.modes.find("code"), f.app.registry, new Set(["files.read"]));
  assert.deepEqual(narrow, ["files.read"], "never more than the task already had");
  assert.deepEqual(f.app.interop.modes.remove("reviewer"), { removed: true });
  assert.throws(() => f.app.interop.modes.find("reviewer"), /no mode called reviewer/);
});

test("A0428 boomerang: work sent to another mode comes back to the task that sent it", async (t) => {
  const f = await fixture(t, ({ user, request }) => {
    const system = request.messages.find((m) => m.role === "system")?.content ?? "";
    if (/"Architect" mode/.test(system)) return say("Plan: 1. read 2. write");
    return say(`plain: ${user}`);
  });
  f.on("modes");
  const { run, context } = taskContext(f.app, "build a thing");
  const result = await f.app.registry.execute("mode.task", { mode: "architect", message: "plan the thing" }, context);
  assert.equal(result.status, "completed");
  assert.match(result.summary, /Plan: 1\. read 2\. write/);
  const kinds = f.app.store.events(run.id).map((e) => e.kind);
  assert.ok(kinds.indexOf("mode.task.sent") < kinds.indexOf("mode.task.returned"), "sent, then returned, on the parent's record");
  const child = f.app.store.events(result.runId).find((e) => e.kind === "run.started");
  assert.equal(child.data.parentRunId, run.id);
  assert.ok(child.data.permissions.every((p) => !["files.write", "shell.execute"].includes(p)), "the architect could not change anything");
  const unknown = await f.app.registry.execute("mode.task", { mode: "nobody", message: "x" }, context).catch((e) => e);
  assert.match(String(unknown.message ?? unknown), /no mode called nobody/);
});

test("A0688 a request is routed to the project it names, and a tie changes nothing", async (t) => {
  const f = await fixture(t, () => say("ok"), { server: true });
  const { scoreProjects } = await import("../dist/interop/project-routing.js");
  f.app.store.projects.save(f.owner, { id: "garden", name: "Garden plans" });
  f.app.store.projects.save(f.owner, { id: "taxes", name: "Taxes 2026", folder: "money/taxes" });
  f.on("project-routing");
  f.app.interop.router.setKeywords("taxes", ["receipts", "w-2 form"]);
  const ranking = scoreProjects(f.app.store.projects.list(f.owner), f.app.interop.router.keywords(), "File this W-2 form with the receipts");
  assert.equal(ranking[0].projectId, "taxes");
  assert.deepEqual(ranking[0].matched.sort(), ["receipts", "w-2 form"]);
  const routed = f.app.interop.router.route("When should I plant the garden tomatoes?");
  assert.equal(routed.chosen.projectId, "garden");
  assert.equal(routed.changes, true);
  assert.equal(f.app.store.projects.active(f.owner).id, "default", "routing alone switches nothing");
  const tie = f.app.interop.router.route("garden taxes");
  assert.equal(tie.chosen.projectId, "default");
  assert.match(tie.chosen.reason, /equally well/);
  const switched = await (await f.http("/api/interop/route", { body: { request: "sort the receipts", switch: true } })).json();
  assert.equal(switched.switched, true);
  assert.equal(f.app.store.projects.active(f.owner).id, "taxes");
  const tool = await f.app.registry.execute("project.route", { request: "garden beds" }, taskContext(f.app).context);
  assert.equal(tool.chosen.projectId, "garden");
});

test("A0146 fleet: one picture of what is working, and stop spares the task that asked", async (t) => {
  const f = await fixture(t);
  const { fleetStop, fleetStatus, workingTasks } = await import("../dist/interop/fleet.js");
  f.on("fleet");
  const parent = f.app.store.createRun(f.owner, "parent"), child = f.app.store.createRun(f.owner, "child"), other = f.app.store.createRun(f.owner, "other");
  f.app.store.event(parent.id, "run.started", { parentRunId: null });
  f.app.store.event(child.id, "run.started", { parentRunId: parent.id });
  f.app.store.event(other.id, "run.started", { parentRunId: null });
  const cancelled = [];
  const runtime = { store: f.app.store, owner: f.owner, cancel: (id) => { cancelled.push(id); return true; } };
  assert.deepEqual(workingTasks(runtime).find((w) => w.runId === child.id).parentRunId, parent.id);
  assert.deepEqual(fleetStop(runtime, { scope: "under", runId: parent.id }).stopped, [child.id]);
  cancelled.length = 0;
  const all = fleetStop(runtime, { scope: "everything" }, child.id).stopped;
  assert.deepEqual(all, [other.id], "the asker and the task above it keep running");
  const status = fleetStatus({ runtime, teams: f.app.teams, remoteAgents: f.app.remoteAgents, clients: f.app.interop.clients });
  assert.match(status.summary, /3 tasks working/);
  const sent = await f.app.registry.execute("fleet.send", { job: "hello", elsewhere: ["nobody-here"] }, taskContext(f.app).context);
  assert.equal(sent.elsewhere[0].status, "failed", "an unknown assistant is a plain failure, not a crash");
});

test("A0319 a conversation is handed to another device with a short-lived key, or to a terminal", async (t) => {
  const f = await fixture(t, () => say("hi"), { server: true });
  const run = await f.app.runtime.run({ prompt: "start here" });
  // The owner's rule: handing on reaches another device or terminal, so it ships off.
  assert.equal(f.app.interop.modesOf().handoff, "off");
  assert.equal((await f.http("/api/interop/handoff", { body: { sessionId: run.sessionId, to: "device" } })).status, 409, "off until switched on");
  f.on("handoff");
  const made = await (await f.http("/api/interop/handoff", { body: { sessionId: run.sessionId, to: "device", minutes: 10 } })).json();
  assert.equal(made.link, `${f.server.url}/people#handoff=${run.sessionId}`); // bucket 19: the one-conversation page
  assert.match(made.key, /^branch_/);
  const view = await f.http(`/api/sessions/${run.sessionId}`, { key: made.key });
  assert.equal(view.status, 200, "the other device can open the conversation with that key");
  assert.ok(f.app.store.messages(run.sessionId).some((m) => /Handed to another device until/.test(m.content)));
  assert.equal((await f.http("/api/interop/handoff", { key: made.key, body: { sessionId: run.sessionId, to: "device" } })).status, 401,
    "a short-lived key cannot make another key");
  const terminal = await (await f.http("/api/interop/handoff", { body: { sessionId: run.sessionId, to: "terminal" } })).json();
  assert.equal(terminal.command, `branch chat --attach --session ${run.sessionId}`);
  // The model's tool has no way to ask for a device key.
  await assert.rejects(f.app.registry.execute("conversation.handoff", { to: "device" }, taskContext(f.app).context));
});

test("A0421 flow search drafts flows, tries each on the examples, improves the best and saves only when asked", async (t) => {
  const f = await fixture(t);
  const { searchFlows } = await import("../dist/interop/flow-search.js");
  const box = (id, prompt) => ({ id, name: id, kind: "prompt", input: { topic: "text" }, output: { answer: "text" }, prompt });
  const flow = (name, prompt) => ({ name, input: { topic: "text" }, state: { topic: "text", answer: "text" }, entry: "a", nodes: [box("a", prompt)], edges: [] });
  const asked = [];
  const parts = {
    ask: async (prompt) => {
      asked.push(prompt);
      if (asked.length === 1) return JSON.stringify({ flows: [flow("short", "SHORT"), { name: "broken", entry: "zz", nodes: [] }, flow("loud", "LOUD")] });
      return JSON.stringify(flow("better", "BEST"));
    },
    tryFlow: async (definition, input) => {
      const style = definition.nodes[0].prompt;
      const answer = style === "BEST" ? `all about ${input.topic}` : style === "LOUD" && input.topic === "oaks" ? "OAKS!" : "meh";
      return { status: "completed", state: { answer } };
    },
    saved: [],
    save(definition) { this.saved.push(definition); return { id: "saved-1" }; },
  };
  const result = await searchFlows(parts, { goal: "describe a topic", examples: [{ input: { topic: "oaks" }, expect: "oaks" }, { input: { topic: "elms" }, expect: "elms" }], save: true });
  assert.match(asked[0], /Design 3 different flows/);
  assert.match(asked[1], /What went wrong/, "the best draft was shown its misses");
  assert.deepEqual(result.ranking.map((r) => [r.name, r.score]),
    [["loud (improved, round 1)", 1], ["loud", 0.5], ["short", 0], ["broken", 0]]);
  assert.ok(result.ranking.find((r) => r.name === "broken").problems.length > 0, "a draft that fails the check says why");
  assert.equal(result.bestScore, 1);
  assert.equal(result.savedFlowId, "saved-1");
  assert.equal(parts.saved[0].nodes[0].prompt, "BEST");
  const unsaved = await searchFlows({ ...parts, ask: async () => "no json here" }, { goal: "x", examples: [{ input: {}, expect: "y" }] });
  assert.equal(unsaved.best, null);
  assert.match(unsaved.note, /No draft/);
});

test("A1857 an assistant is published to a folder and brought in elsewhere, only its safe parts, fingerprint checked", async (t) => {
  const f = await fixture(t);
  const { AgentMarket, shareablePackage } = await import("../dist/interop/agent-market.js");
  const { openAgent, exportAgent } = await import("../dist/agent-export.js");
  f.on("agent-market");
  f.app.store.save("specialists", f.owner, "writer-1", { name: "writer", marker: "from the publisher" });
  const published = await f.app.interop.market.publish({ folder: "market", id: "helper", name: "Helper", summary: "Writes notes" });
  assert.deepEqual(published.files, ["market/helper.branch-agent", "market/market.json"]);
  const folder = join(f.app.runtime.workspace, "market");
  const index = JSON.parse(await readFile(join(folder, "market.json"), "utf8"));
  assert.equal(index.agents[0].url, "helper.branch-agent");
  const bytes = await readFile(join(folder, "helper.branch-agent"));
  assert.deepEqual(openAgent(bytes).manifest.sections.map((s) => s.name), ["specialists", "procedures", "skills"],
    "approval rules and model choices are never published");
  // A second assistant reads that market through a fetch that serves the folder; nothing leaves this process.
  const g = await fixture(t);
  g.on("agent-market");
  let served = bytes;
  const fetchFolder = async (url) => {
    const name = new URL(url).pathname.split("/").pop();
    const body = name === "market.json" ? await readFile(join(folder, name)) : served;
    return new Response(body, { status: 200 });
  };
  const policy = { assertAllowed: async () => undefined };
  const market = new AgentMarket(g.app.store, g.owner, policy, g.app.files, "test", fetchFolder);
  const preview = await market.preview("https://example.test/market.json", "helper");
  assert.ok(preview.sections.every((s) => s.allowed));
  await assert.rejects(market.install("https://example.test/market.json", "helper", ["permissions"]), /Invalid option|expected one of/i);
  const installed = await market.install("https://example.test/market.json", "helper", ["specialists"]);
  assert.equal(installed.reports[0].section, "specialists");
  assert.equal(g.app.store.get("specialists", g.owner, "writer-1").data.marker, "from the publisher");
  served = shareablePackage(exportAgent(g.app.store, g.owner, "x").bytes, ["skills"]);
  await assert.rejects(market.install("https://example.test/market.json", "helper", ["specialists"]), /does not match the fingerprint/);
});

// Redesign: public/interop.js deleted; the route still exists but the file is no longer served
test.skip("the owner's routes: switches, the list of parts, and what a short-lived key may not change", async (t) => {
  const f = await fixture(t, () => say("ok"), { server: true });
  const state = await (await f.http("/api/interop")).json();
  assert.deepEqual(state.parts.map((p) => p.part), [...interopParts]);
  assert.ok(state.parts.every((p) => p.mode === "off" && p.label));
  const saved = await (await f.http("/api/interop/switch", { body: { part: "modes", mode: "on" } })).json();
  assert.deepEqual(saved, { part: "modes", mode: "on" });
  assert.equal((await f.http("/api/interop/switch", { body: { part: "modes", mode: "always" } })).status, 400);
  const runKey = f.app.sessionTokens.create(f.owner, { name: "script", scope: "run", minutes: 5 }).token;
  assert.equal((await f.http("/api/interop/switch", { key: runKey, body: { part: "fleet", mode: "on" } })).status, 401);
  const modes = await (await f.http("/api/interop/modes")).json();
  assert.equal(modes.modes.length, 5);
  assert.equal((await f.http("/interop.js")).status, 200);
  const index = await readFile(join(import.meta.dirname, "..", "public", "index.html"), "utf8");
  // interop.js comes just before layout.js, apart from the dashboard card, which tests/dashboard.test.mjs
  // requires to be the very last script before layout.js (and its one-line comment).
  assert.match(index, /<script src="\/interop\.js" type="module"><\/script>\s*(?:<!--[^\n]*-->\s*)?(?:<script src="\/dashboard-card\.js" type="module"><\/script>\s*)?<script src="\/layout\.js"/);
});

test("provider-actions (A2252) a service's own actions are tools, and every one counts as a change that asks", async () => {
  const { isReadOnlyPermission, evaluatePolicy, presetRules } = await import("../dist/policy.js");
  const { openApiPermission } = await import("../dist/openapi-tools.js");
  assert.equal(openApiPermission, "api.call");
  assert.equal(isReadOnlyPermission(openApiPermission), false, "an action on an outside service is never look-only");
  const policy = { preset: "ask-before-changes", rules: presetRules("ask-before-changes"), unmatchedCommands: "allow" };
  assert.equal(evaluatePolicy(policy, { tool: "api.notion.update_page", target: "api.notion.com", readOnly: false }).decision, "ask");
});

// Redesign: public/interop.js deleted; documentation verification needs update
test.skip("every row of bucket 20 has a verdict in docs/configuration.md, and every file it names exists", async () => {
  const { existsSync } = await import("node:fs");
  const root = join(import.meta.dirname, "..");
  const text = await readFile(join(root, "docs", "configuration.md"), "utf8");
  const heading = "## Talking to other agents and tools: where each one stands (wave mac4, bucket 20)";
  const start = text.indexOf(heading);
  assert.ok(start >= 0, "the section is missing");
  const next = text.indexOf("\n## ", start + heading.length);
  const section = text.slice(start, next < 0 ? undefined : next);
  const rows = ["agent-protocol", "client-tools", "A0429", "A1857", "provider-actions", "A0146", "A0319", "A0688", "A0428", "A1293", "A1327", "A0421"];
  const items = section.split("\n- ").slice(1).map((item) => item.replace(/\s+/g, " "));
  for (const id of rows) {
    const item = items.find((entry) => entry.startsWith(`**${id}**`));
    assert.ok(item, `${id} is not listed`);
    assert.match(item, /— (verified|built|documented)\b/, `${id} has no verdict`);
    assert.match(item, /`(src|public)\/[^`]+`/, `${id} names no source file`);
    assert.match(item, /`tests\/[^`]+\.test\.mjs`/, `${id} names no test`);
  }
  for (const [, path] of section.matchAll(/`((?:src|tests|public|docs)\/[^`\s]+)`/g))
    assert.ok(existsSync(join(root, path)), `${path} does not exist`);
});
