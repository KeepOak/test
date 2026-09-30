/* Q59: the four conversation modes, weighed tool by tool through the real runtime.
   Plan is never looser than Ask first, Ask first never looser than Auto, Auto never looser than No
   approvals, and the design's rows hold: Ask first asks before any change, command or web action
   (Q59-Q60-PRESETS-DESIGN.md and Legion's rulings). A web action is any tool that reaches beyond the
   workspace (src/tool-reach.ts). "follow" is the owner's own rules, not a mode. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, evaluatePolicy, isReadOnlyPermission, savePolicy } from "../dist/index.js";
import { saveConversationMode } from "../dist/conversation-mode.js";
import { permissionClassified, reachOf } from "../dist/tool-reach.js";
import { noStandingRefusal } from "../dist/runtime.js";
import { loadIntegrations } from "../dist/integrations/bootstrap.js";
import { registerHttpTools } from "../dist/skill-http-tools.js";
import { HttpToolSchema } from "../dist/skill-package.js";

const modes = ["plan", "ask", "auto", "full"];
const care = { allow: 0, ask: 1, deny: 2 };
const page = "https://example.com/a";

/**
 * A real Branch with every switched part on, and the families that need a launch setting or a
 * connection, wired the way production wires them: the browser (with sign-in fill), a command line,
 * git remotes, GitHub, GitLab and both issue trackers from a launch file (src/integrations/bootstrap.ts),
 * a service's tools from a saved OpenAPI description, a skill package's web tool, a tool lent by a
 * program, and add-on search. Nothing here is called, so nothing reaches the network.
 */
async function fullBranch(t, provider = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } }) {
  const root = await mkdtemp(join(tmpdir(), "branch-mode-order-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const launch = join(root, "integrations.json");
  await writeFile(launch, JSON.stringify({
    browser: { allowedOrigins: ["https://example.com"], maxRuns: 1 },
    shell: { executables: { node: { path: process.execPath } } },
    git: { remote: true, github: {}, gitlab: {} },
    issues: { github: true, gitlab: true },
  }));
  const integrations = await loadIntegrations(app.registry, launch, process.env, app.secretsFor, app.channelHost);
  t.after(async () => { await integrations.close(); await app.close(); await discardTemp(root); });
  for (const part of Object.values(app)) {
    if (!part || typeof part.setMode !== "function") continue;
    const names = typeof part.modes === "function" ? Object.keys(part.modes())
      : typeof part.modesOf === "function" ? Object.keys(part.modesOf()) : [null];
    // Some switches take { mode }, others the mode itself.
    const on = (input) => (name) => name === null ? part.setMode(input) : part.setMode(name, input);
    for (const name of names) { try { on({ mode: "on" })(name); } catch { on("on")(name); } }
  }
  app.addOns.save({ modes: { search: "on" } });
  registerHttpTools(app.registry, { store: app.store, policy: app.web.policy }, "weather",
    [HttpToolSchema.parse({ name: "forecast", description: "The forecast for tomorrow.", url: "https://api.example.com/forecast" })]);
  app.store.save("settings", app.runtime.owner, "openapi-service:weather", { name: "weather", allowlist: ["forecast"], from: "weather.json",
    document: JSON.stringify({ openapi: "3.0.0", info: { title: "Weather", version: "1" }, servers: [{ url: "https://api.example.com" }],
      paths: { "/forecast": { get: { operationId: "forecast", summary: "The forecast for tomorrow." } } } }) });
  assert.deepEqual(app.openApiTools.restore(app.runtime.owner), ["weather"]);
  app.interop.clients.open({ send() {}, close() {} })
    .receive(JSON.stringify({ type: "hello", client: "lender", tools: [{ name: "look_up", description: "Looks something up." }] }));
  return app;
}
/** One conversation per mode, and what each would decide. */
async function modeConversations(app) {
  const runs = {}, contexts = {};
  for (const mode of modes) {
    const run = await app.runtime.run({ prompt: `a ${mode} conversation` });
    saveConversationMode(app.store, app.runtime.owner, run.sessionId, { mode, planSet: mode === "plan" });
    runs[mode] = run.id;
    contexts[mode] = app.runtime.context({ runId: run.id });
  }
  return {
    /** The rules each mode holds this tool to, with nothing about what it touches. */
    ruled: (tool, mode) => evaluatePolicy(app.runtime.policy("owner", runs[mode]),
      { tool, target: "", readOnly: isReadOnlyPermission(app.registry.permissionOf(tool)), resource: null }).decision,
    /** The whole check a model's call goes through. */
    check: (tool, args, mode) => app.runtime.checkPolicy(tool, args, contexts[mode]),
  };
}
/**
 * The permissions that hold tools of both kinds, with every tool in each, as reviewed. A new tool
 * under one of these turns the test red until somebody looks at what it does: it declares
 * `reach: "outbound"` when it goes out, or is added to `local` here when it does not.
 */
const mixedPermissions = {
  "files.read": { local: ["artifacts.list","branch.run_contract_tests","code.definition","code.diagnostics","code.hover","code.map","code.references","context.list","context.read","debug.variables","documents.ocr","files.find","files.glob","files.grep","files.history","files.list","files.read","files.read_lines","files.read_many","files.search","files.validate","files.verify","notebook.read","output.read","remote.list","rules.for_path","workspace.map"], outbound: ["remote.files","remote.read"] },
  "memory.read": { local: ["checklist.read","knowledge.list","learning.journey","learning.suggest","lessons.list","memory.at","memory.block_view","memory.files","memory.find","memory.read_file","memory.search","memory.timeline","memory.version_note","memory.versions","project.route","templates.export","todos.list","wiki.history","wiki.read","wiki.search"], outbound: ["hindsight.recall","hindsight.reflect","memory.outside_ask","memory.outside_recall"] },
  "memory.write": { local: ["checklist.write","memory.block_edit","memory.delete","memory.delete_file","memory.keep","memory.label","memory.put","memory.tidy","memory.update","memory.write_file","todos.add","todos.done","wiki.write"], outbound: ["hindsight.retain","memory.outside_keep"] },
  "browser.read": { local: ["browser.annotate","browser.console","browser.extract","browser.images","browser.network","browser.notes","browser.pdf","browser.recording","browser.screenshot","browser.scroll","browser.shape","browser.site","browser.snapshot","browser.unmark","browser.wait","browser.watch_change","computer.look"], outbound: ["browser.navigate"] },
  "media.write": { local: ["media.convert","media.frames","media.image","media.speak","media.trim","voice.say"], outbound: ["media.download","video.generate"] },
  "skills.read": { local: ["environment.about","sdk.route","sdk.routes","sdk.starter","skills.list","skills.read","skills.usage","tools.services"], outbound: ["skills.bundle.preview"] },
  "skills.write": { local: ["tools.forget_service"], outbound: ["tools.from_openapi"] },
  "specialists.use": { local: ["delegate.debate","delegate.handoff","delegate.parallel","delegate.route","delegate.supervise","delegate.swarm","delegate.teams","helpers.list","helpers.message","helpers.start","helpers.stop","helpers.tell_lead","mode.task","specialists.delegate","specialists.fanout"], outbound: ["fleet.send","trunks.remote.message"] },
  "specialists.read": { local: ["fleet.status","mode.list"], outbound: ["trunks.remote.roster"] },
  "monitors.manage": { local: ["monitor.remove","monitors.screen.check","monitors.screen.create"], outbound: ["monitor.check","monitor.create"] },
  "data.read": { local: ["data.chart","data.describe","data.query"], outbound: ["data.load"] },
  "brief.manage": { local: ["brief.configure"], outbound: ["brief.send"] },
  "desktop.view": { local: ["desktop.read","desktop.screenshot","usb.devices"], outbound: ["desktop.windows"] },
  "nodes.read": { local: ["machines.list"], outbound: ["machines.look","nodes.status"] },
};
const assertOrder = (tool, row) => {
  for (let i = 1; i < modes.length; i++)
    assert.ok(care[row[modes[i - 1]]] >= care[row[modes[i]]],
      `${tool}: ${modes[i - 1]} (${row[modes[i - 1]]}) must be at least as careful as ${modes[i]} (${row[modes[i]]})`);
};

test("every tool is classified by what it does: its permission, or its own declaration", async (t) => {
  const app = await fullBranch(t);
  const tools = app.registry.inventory();
  assert.ok(tools.length >= 300, `the whole registry is loaded (${tools.length} tools)`);
  const unclassified = [...new Set(tools.map((tool) => tool.permission))].filter((permission) => !permissionClassified(permission));
  assert.deepEqual(unclassified, [], "every permission says local or outbound in src/tool-reach.ts");
  const reach = (name) => app.registry.reachOf(name);
  for (const name of ["web.fetch", "web.search", "x.search", "spotify.search", "gmail.search", "gdrive.read", "gcal.events",
    "outlook.search", "mail.search", "hindsight.recall", "memory.outside_recall", "remote.files", "remote.read", "nodes.status",
    "machines.look", "browser.navigate", "browser.act", "browser.tab", "browser.borrow", "browser.profile", "computer.press",
    "computer.type", "media.download", "research.run", "data.load", "monitor.create", "channels.broadcast"])
    assert.equal(reach(name), "outbound", `${name} reaches beyond the workspace`);
  for (const name of ["files.read", "files.search", "files.grep", "git.status", "git.diff", "git.log", "memory.search",
    "documents.search", "browser.snapshot", "remote.list", "machines.list", "files.write", "shell.execute"])
    assert.equal(reach(name), "local", `${name} stays on this computer`);
  for (const [permission, expected] of Object.entries(mixedPermissions)) {
    const held = tools.filter((tool) => tool.permission === permission).map((tool) => tool.name);
    const got = { local: held.filter((name) => reach(name) === "local").sort(), outbound: held.filter((name) => reach(name) === "outbound").sort() };
    assert.deepEqual(got, expected, `${permission} holds tools of both kinds: a tool added under it says what it does`);
  }
  // The outbound permissions whose tools need a launch setting or a connection: each is loaded above,
  // and each is pinned here on its own, so moving one to the local list cannot pass unseen.
  const connected = { "api.call": "api.weather.forecast", "skills.http": "skill.weather.forecast", "client.tools": "client.lender.look_up",
    "gitlab.read": "gitlab.issues", "issues.read": "issues.search", "issues.write": "issues.comment", "github.manage": "github.create_issue",
    "git.remote": "git.push", "addons.search": "addon.search", "signin.fill": "signin.fill" };
  for (const [permission, name] of Object.entries(connected)) {
    assert.equal(reachOf({ permission }), "outbound", `${permission} reaches beyond the workspace`);
    assert.equal(app.registry.permissionOf(name), permission, `${name} is loaded, with ${permission}`);
    assert.equal(reach(name), "outbound", `${name} reaches beyond the workspace`);
  }
  assert.equal(reachOf({ permission: "something.new" }), "outbound", "a permission nobody classified counts as outbound");
  assert.equal(reachOf({ permission: "files.read", reach: "local", external: true }), "outbound", "somebody else's tool counts as outbound");
  assert.equal(app.registry.reachOf("no.such.tool"), "outbound");
});

test("across the real registry, each mode is at least as careful as the next looser one", async (t) => {
  const app = await fullBranch(t);
  // A tool from somebody else (here, as an MCP server's would be): Branch cannot see what it does.
  app.registry.register({ name: "mcp.elsewhere.lookup", permission: "mcp.elsewhere.lookup", external: true,
    description: "A connected server's lookup.", parameters: z.object({}).passthrough(), execute: async () => ({}) });
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  const { ruled } = await modeConversations(app);
  assert.deepEqual(Object.fromEntries(modes.map((mode) => [mode, ruled("mcp.elsewhere.lookup", mode)])),
    { plan: "deny", ask: "ask", auto: "ask", full: "allow" }, "somebody else's tool asks in Auto too");
  for (const { name, permission } of app.registry.inventory()) {
    const row = Object.fromEntries(modes.map((mode) => [mode, ruled(name, mode)]));
    assertOrder(name, row);
    const readOnly = isReadOnlyPermission(permission), outbound = app.registry.reachOf(name) === "outbound";
    if (outbound) {
      assert.equal(row.ask, "ask", `Ask first asks before ${name}, which reaches beyond the workspace`);
      assert.equal(row.auto, "ask", `Auto asks before ${name}, which reaches beyond the workspace`);
      assert.equal(row.plan, readOnly ? "ask" : "deny", `Plan asks before ${name} when it only looks, and refuses it when it changes something`);
    } else if (readOnly) {
      assert.deepEqual(row, { plan: "allow", ask: "allow", auto: "allow", full: "allow" }, `${name} only looks on this computer, so it is free`);
    } else {
      assert.equal(row.plan, "deny", `Plan refuses the change ${name}`);
      assert.equal(row.ask, "ask", `Ask first asks before the change ${name}`);
    }
    assert.notEqual(row.full, "deny", `No approvals refuses nothing the owner did not refuse (${name})`);
  }
});

test("per tool, the whole check agrees: the design's rows hold with real arguments", async (t) => {
  const app = await fullBranch(t);
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  const { check } = await modeConversations(app);
  const calls = {
    "files.read": { path: "notes.txt" },
    "files.write": { path: "notes.txt", content: "x" },
    "git.status": { folder: "." },
    "shell.execute": { executable: "node", args: ["--version"] },
    "web.fetch": { url: page },
    "web.search": { query: "branch agent" },
    "x.search": { query: "branch agent" },
    "remote.read": { computer: "tower", path: "notes.txt" },
    "browser.navigate": { url: page },
    "browser.snapshot": {},
    "browser.click": { role: "button", name: "Go" },
    "browser.tab": { action: "open" },
    "media.download": { url: page },
  };
  const table = {};
  for (const [tool, args] of Object.entries(calls)) {
    table[tool] = {};
    for (const mode of modes) {
      const result = check(tool, args, mode);
      assert.equal(result.decision === "deny" ? result.reason : undefined, undefined,
        `${tool} under ${mode} is judged by the rules, not refused by a guard: ${result.reason}`);
      table[tool][mode] = result.decision;
    }
    assertOrder(tool, table[tool]);
  }
  assert.deepEqual(table["files.read"], { plan: "allow", ask: "allow", auto: "allow", full: "allow" }, "reading is free everywhere");
  assert.deepEqual(table["git.status"], { plan: "allow", ask: "allow", auto: "allow", full: "allow" }, "a repository's status only looks");
  assert.deepEqual(table["browser.snapshot"], { plan: "allow", ask: "allow", auto: "allow", full: "allow" }, "reading the open page is free");
  assert.deepEqual(table["files.write"], { plan: "deny", ask: "ask", auto: "allow", full: "allow" }, "Auto writes in the workspace; Plan refuses");
  assert.deepEqual(table["shell.execute"], { plan: "deny", ask: "ask", auto: "ask", full: "allow" }, "owner-selected Full Access lets an uncovered command run");
  for (const tool of ["web.fetch", "web.search", "x.search", "remote.read", "browser.navigate"])
    assert.deepEqual(table[tool], { plan: "ask", ask: "ask", auto: "ask", full: "allow" }, `${tool} is a web action`);
  for (const tool of ["browser.click", "browser.tab", "media.download"])
    assert.deepEqual(table[tool], { plan: "deny", ask: "ask", auto: "ask", full: "allow" }, `${tool} changes something outside the workspace`);
});

test("Plan keeps the owner's own questions on reads, and never turns its refusal of a change into one", async (t) => {
  const app = await fullBranch(t);
  savePolicy(app.store, app.runtime.owner, { rules: [
    { tool: "files.read", match: "finance/*", decision: "ask" },
    { tool: "files.write", match: "finance/*", decision: "ask" },
    { tool: "files.*", resource: { kind: "path", pattern: "payroll" }, decision: "ask" },
    { tool: "files.read", match: "secrets/*", decision: "deny" },
  ] });
  const { check } = await modeConversations(app);
  const row = (tool, args) => Object.fromEntries(modes.map((mode) => [mode, check(tool, args, mode).decision]));
  const cases = [
    ["files.read", { path: "finance/q1.txt" }, { plan: "ask", ask: "ask", auto: "ask", full: "ask" }, "the owner's question on a read holds in Plan too"],
    ["files.write", { path: "finance/q1.txt", content: "x" }, { plan: "deny", ask: "ask", auto: "ask", full: "ask" }, "a question on a write never loosens Plan's refusal"],
    ["files.read", { path: "payroll/june.txt" }, { plan: "ask", ask: "ask", auto: "ask", full: "ask" }, "a folder rule's question on a read holds in Plan"],
    ["files.write", { path: "payroll/june.txt", content: "x" }, { plan: "deny", ask: "ask", auto: "ask", full: "ask" }, "a folder rule's question, weighed first, still cannot loosen Plan's refusal"],
    ["files.read", { path: "secrets/key.txt" }, { plan: "deny", ask: "deny", auto: "deny", full: "deny" }, "the owner's refusal holds everywhere"],
    ["files.read", { path: "notes.txt" }, { plan: "allow", ask: "allow", auto: "allow", full: "allow" }, "and everything else stays free"],
  ];
  for (const [tool, args, expected, why] of cases) {
    const got = row(tool, args);
    assert.deepEqual(got, expected, `${tool} ${args.path}: ${why}`);
    assertOrder(`${tool} ${args.path}`, got);
  }
});

test("a question in Ask first or Plan offers no standing yes; Auto still does", async (t) => {
  const model = { name: "scripted", async complete(request) {
    const last = request.messages[request.messages.length - 1];
    if (last?.role === "tool") return { content: "done", toolCalls: [] };
    // Plan refuses a command outright, so its question is about reading a web page.
    const plan = /\(plan\)/.test(String(request.messages.find((m) => m.role === "user")?.content ?? ""));
    const call = plan ? { name: "web.fetch", arguments: JSON.stringify({ url: page }) }
      : { name: "shell.execute", arguments: JSON.stringify({ executable: "node", args: ["--version"] }) };
    return { content: "", toolCalls: [{ id: `w${Math.random().toString(36).slice(2, 8)}`, ...call }] };
  } };
  const app = await fullBranch(t, model);
  savePolicy(app.store, app.runtime.owner, { preset: "off" });
  for (const mode of ["ask", "plan", "auto"]) {
    const run = await app.runtime.run({ prompt: `run it (${mode})`, conversationMode: mode });
    assert.equal(run.status, "needs_input", `${mode}: the call asks`);
    const question = app.runtime.approvals.waiting().find((one) => one.sessionId === run.sessionId);
    const held = mode !== "auto";
    assert.equal(question.noStanding === true, held, `${mode}: the card ${held ? "offers no" : "may offer a"} standing yes`);
    if (held) {
      assert.throws(() => app.runtime.approve(run.sessionId, "allow", "always", question.fingerprint), { message: noStandingRefusal });
      assert.equal(app.runtime.approvals.waiting().some((one) => one.sessionId === run.sessionId), true, "the refused answer leaves the question waiting");
      const before = app.store.get("settings", app.runtime.owner, "policy")?.data?.rules?.length ?? 0;
      app.runtime.approve(run.sessionId, "allow", "session", question.fingerprint);
      assert.equal(app.store.get("settings", app.runtime.owner, "policy")?.data?.rules?.length ?? 0, before, "no rule was written");
      // The yes kept for the conversation is honoured there: the same call goes ahead without asking again.
      const [tool, args] = mode === "plan" ? ["web.fetch", { url: page }] : ["shell.execute", { executable: "node", args: ["--version"] }];
      assert.equal(app.runtime.checkPolicy(tool, args, app.runtime.context({ runId: run.id }), question.fingerprint).decision, "allow",
        `${mode}: a yes for this conversation holds for it`);
    }
  }
});
