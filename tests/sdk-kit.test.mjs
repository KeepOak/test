/**
 * Bucket 21: building on Branch.
 *
 *   app-building    the sdk.* tools (src/sdk-kit.ts, src/sdk-starters.ts), shared through Branch's
 *                   own MCP server, behind a three-way switch that ships off
 *   serialization   flows written out and read back as YAML (src/flow-yaml.ts)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  apiRoutes, createBranch, flowFromYaml, flowToYaml, FlowYamlError, flowYamlFormat, routeSnippets,
  sdkKitMode, sdkKitTools, sdkLanguages, starterProgram,
} from "../dist/index.js";
import { switchedToolTiers } from "../dist/feature-switches.js";
import { startServer } from "../dist/server.js";
import { discardTemp } from "./temp-dir.mjs";

const say = { name: "scripted", async complete() { return { content: "ok", toolCalls: [] }; } };

async function served(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-sdk-kit-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: say });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${server.url}${path}`, {
      method, headers: { authorization: `Bearer ${server.token}`, origin: server.url, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { app, server, call };
}

const stepsFlow = {
  name: "Morning tidy", description: "Two steps, in order",
  steps: [
    { name: "Read the notes", kind: "prompt", prompt: "Summarise notes/today.md: keep it short" },
    { name: "Ask first", kind: "approval", question: "Carry on?" },
  ],
};
const graphFlow = {
  name: "Two boxes", input: { topic: "text" }, state: { first: "text" }, entry: "a",
  nodes: [
    { id: "a", name: "Ask once", kind: "prompt", prompt: "Something about {topic}", input: { topic: "text" }, output: { first: "text" } },
    { id: "b", name: "Ask again", kind: "prompt", prompt: "More on {first}", input: { first: "text" }, output: {} },
  ],
  edges: [{ from: "a", to: "b" }],
};

/* ---------- the switch ---------- */

test("building on Branch ships when needed; switched off, the tools are hidden and refuse, and YAML routes say so", async (t) => {
  const { app, call } = await served(t);
  const owner = app.runtime.owner;
  // Defaults audit (2026-09-28): the tools only read Branch's route list and write example code, none of (a)–(f).
  assert.equal(sdkKitMode(app.store, owner), "when-needed");
  assert.equal((await call("/api/sdk-kit")).body.settings.mode, "when-needed");
  assert.equal((await call("/api/sdk-kit", { mode: "off" })).body.settings.mode, "off");
  assert.equal(sdkKitMode(app.store, owner), "off", "the owner's off is kept");
  for (const name of sdkKitTools) assert.ok(app.registry.names().includes(name), `${name} is registered`);
  const tiers = () => switchedToolTiers(app.store, owner, [...sdkKitTools]);
  assert.deepEqual(tiers().hidden.sort(), [...sdkKitTools].sort(), "off: not advertised");

  await assert.rejects(app.registry.execute("sdk.routes", {}, app.runtime.context({})), /switched off/);
  const kit = await call("/api/sdk-kit");
  assert.equal(kit.status, 200);
  assert.equal(kit.body.settings.mode, "off");
  assert.deepEqual(Object.keys(kit.body.packages).sort(), [...sdkLanguages].sort());
  const exported = await call("/api/flows/00000000-0000-4000-8000-000000000000/yaml");
  assert.equal(exported.status, 409);
  assert.match(exported.body.error, /switched off/);
  assert.equal((await call("/api/flows/yaml", { yaml: "name: x" })).status, 409);

  assert.equal((await call("/api/sdk-kit", { mode: "loud" })).status, 400, "only the three modes");
  assert.equal((await call("/api/sdk-kit", { mode: "on" })).body.settings.mode, "on");
  assert.deepEqual(tiers().hidden, []);
  assert.deepEqual(tiers().preload.map((entry) => entry.name).sort(), [...sdkKitTools].sort(), "on: loaded from the first round");
  await call("/api/sdk-kit", { mode: "when-needed" });
  assert.deepEqual(tiers(), { preload: [], hidden: [] }, "when needed: the ordinary tiering");
});

/* ---------- the app-builder tools ---------- */

test("the sdk tools answer from the same routes the OpenAPI description is made of", async (t) => {
  const { app, call } = await served(t);
  await call("/api/sdk-kit", { mode: "when-needed" });
  const tool = (name, args) => app.registry.execute(name, args, app.runtime.context({}));

  const flows = await tool("sdk.routes", { tag: "flows" });
  assert.ok(flows.routes.length >= 5);
  assert.ok(flows.routes.every((route) => route.group === "flows"));
  assert.ok(flows.groups.includes("runs") && flows.groups.includes("developer"));
  const searched = await tool("sdk.routes", { search: "rewind files" });
  assert.ok(searched.routes.some((route) => route.path === "/api/sessions/{sessionId}/rewind"));

  const run = await tool("sdk.route", { method: "POST", path: "/api/run" });
  assert.deepEqual(run.body.required, ["prompt"], "the body comes from the app's own check");
  assert.equal(run.examples.python, 'branch.request("POST", f"/api/run", {"prompt": "..."})');
  assert.equal(run.examples.typescript, 'await branch.request("POST", `/api/run`, {"prompt":"..."});');
  assert.equal(run.examples.go, 'client.Request(ctx, "POST", "/api/run", branch.Object{"prompt": "..."})');
  const one = await tool("sdk.route", { method: "get", path: "/api/runs/{runId}" });
  assert.equal(one.examples.go, 'client.Request(ctx, "GET", "/api/runs/" + url.PathEscape(runId), nil)');
  assert.equal(one.examples.python, 'branch.request("GET", f"/api/runs/{run_id}")');
  assert.match(one.examples.react, /useBranchGet\(`\/api\/runs\/\$\{encodeURIComponent\(runId\)\}`\)/);
  await assert.rejects(tool("sdk.route", { method: "GET", path: "/api/nowhere" }), /does not describe GET \/api\/nowhere/);

  for (const language of sdkLanguages) {
    const starter = await tool("sdk.starter", { language });
    assert.ok(starter.text.length > 100 && starter.file && starter.install.includes(starter.folder), language);
  }
});

test("every described route has a snippet in every language, with no address part left unfilled", () => {
  for (const route of apiRoutes) {
    const snippets = routeSnippets(route);
    assert.deepEqual(Object.keys(snippets).sort(), [...sdkLanguages].sort());
    assert.doesNotMatch(snippets.go, /\{[a-z]+Id\}/, `${route.path} in Go`);
    assert.doesNotMatch(snippets.typescript, /[^$]\{[a-z]+Id\}/, `${route.path} in TypeScript`);
    if (route.method !== "get") assert.match(snippets.react, /useBranch\(\)/);
  }
  assert.match(starterProgram("go").text, /client\.Runs\.Stream/);
  assert.match(starterProgram("react").text, /useBranchRun/);
});

async function mcp(server, sessionId, method, params, id) {
  const response = await fetch(`${server.url}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json", "mcp-session-id": sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  return response.json();
}

test("shared with another AI tool, the sdk tools make Branch's MCP server an app-builder's server", async (t) => {
  const { server, call } = await served(t);
  const sessionId = `sdk-kit-${Math.random()}`;
  await mcp(server, sessionId, "initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "editor", version: "1" } }, 1);
  const shared = await call("/api/mcp/settings", { enabled: true, exposedTools: [...sdkKitTools] });
  assert.equal(shared.status, 200);
  assert.deepEqual([...shared.body.exposedTools].sort(), [...sdkKitTools].sort());
  assert.ok(shared.body.tools.filter((tool) => tool.name.startsWith("sdk.")).every((tool) => !tool.changesThings), "the sdk tools only read");

  const listed = await mcp(server, sessionId, "tools/list", {}, 2);
  for (const name of sdkKitTools) assert.ok(listed.result.tools.some((tool) => tool.name === name), `${name} is offered`);

  await call("/api/sdk-kit", { mode: "off" });
  const off = await mcp(server, sessionId, "tools/call", { name: "sdk.starter", arguments: { language: "go" } }, 3);
  assert.equal(off.result.isError, true);
  assert.match(off.result.content[0].text, /switched off/);

  await call("/api/sdk-kit", { mode: "when-needed" });
  const on = await mcp(server, sessionId, "tools/call", { name: "sdk.route", arguments: { method: "POST", path: "/api/flows/yaml" } }, 4);
  assert.equal(on.result.isError, false);
  assert.match(on.result.content[0].text, /ImportYAML|flows\/yaml/);
});

/* ---------- flows as YAML ---------- */

test("a flow of steps and a graph flow go out as YAML and come back as new flows, unchanged", async (t) => {
  const { app, call } = await served(t);
  await call("/api/sdk-kit", { mode: "when-needed" });
  for (const input of [stepsFlow, graphFlow]) {
    const saved = (await call("/api/flows", input)).body;
    const out = await call(`/api/flows/${saved.id}/yaml`);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.name, input.name);
    assert.match(out.body.yaml, /^# A Branch Agent flow/);
    const written = parse(out.body.yaml);
    assert.equal(written.format, flowYamlFormat);
    assert.equal(written.id, undefined, "a written flow carries nothing that belongs to this computer");
    assert.equal(written.status, undefined);

    const back = await call("/api/flows/yaml", { yaml: out.body.yaml });
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.notEqual(back.body.id, saved.id, "read back as a new flow, never over the old one");
    const again = await call(`/api/flows/${back.body.id}/yaml`);
    assert.equal(again.body.yaml, out.body.yaml, "YAML → flow → YAML is stable");
  }
  assert.equal(app.flows.list().length, 4);
});

test("a flow written by hand is read, and a bad file is refused in plain words", async (t) => {
  const { call } = await served(t);
  await call("/api/sdk-kit", { mode: "on" });
  const byHand = [
    "name: Written by hand",
    "steps:",
    "  - name: Say hello",
    "    kind: prompt",
    "    prompt: Say hello",
  ].join("\n");
  const saved = await call("/api/flows/yaml", { yaml: byHand });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.steps[0].name, "Say hello");

  const refusals = [
    ["format: branch-flow/9\nname: x\nsteps: []", /branch-flow\/9/],
    ["name: x\nname: y\nsteps: []", /not readable YAML/],
    ["base: &b {name: x}\nname: *b\nsteps: []", /aliases/],
    ["- a list", /holds one flow/],
    ["kind: steps\nname: x\nsteps: []\nextra: 1", /also has extra/],
    ["kind: spiral\nname: x", /"steps" or "graph"/],
    ["name: x\nsteps:\n  - name: y\n    kind: prompt", /prompt/i],
  ];
  for (const [yaml, said] of refusals) {
    const refused = await call("/api/flows/yaml", { yaml });
    assert.equal(refused.status, 400, `${yaml} → ${JSON.stringify(refused.body)}`);
    assert.match(refused.body.error, said, yaml);
  }
  assert.equal((await call("/api/flows/yaml", { yaml: "x".repeat(600 * 1024) })).status, 413, "a huge file is refused before it is read");
});

test("the YAML functions on their own: an id in a file is dropped, and the kind is worked out when missing", () => {
  const read = flowFromYaml("id: 00000000-0000-4000-8000-000000000000\nname: x\nentry: a\nnodes: []\nedges: []");
  assert.equal(read.id, undefined);
  assert.equal(read.entry, "a");
  assert.throws(() => flowFromYaml("!!js/function 'x'"), FlowYamlError);
  assert.throws(() => flowFromYaml(`name: "${"é".repeat(300 * 1024)}"`), /too large/, "the limit is counted in bytes");
  const view = { id: "f1", name: "N", description: "", steps: [{ name: "s", kind: "prompt", prompt: "p" }], status: "idle" };
  assert.match(flowToYaml(view), /kind: steps/);
});

test("integration review: a hostile flow file is refused, not quietly read", () => {
  const graph = (extra) => `kind: graph\nname: x\nentry: a\nedges: []\nnodes:\n  - id: a\n    name: A\n    kind: tool\n    tool: files.read\n${extra}`;
  const hostile = [
    // Explicit tags the core schema still knows (a Buffer, a set, a date) are not flow data.
    ["name: !!binary aGVsbG8=\nsteps: []", /tag/i],
    ["name: x\nsteps: !!set {a, b}", /tag/i],
    ["name: !!timestamp 2001-12-14\nsteps: []", /tag/i],
    ["name: !!str x\nsteps: []", /tag/i],
    // An anchor on its own repeats nothing yet, but a file that uses them is not written by hand.
    ["name: &x n\nsteps: []", /anchor|alias/i],
    // Keys that name an object's insides, at the top or deep in a tool box's arguments.
    [`kind: graph\nname: x\nentry: a\nedges: []\n__proto__: {admin: true}\nnodes: []`, /__proto__/],
    [graph("    args:\n      __proto__: {polluted: true}\n"), /__proto__/],
    [graph("    args:\n      constructor: {prototype: {x: 1}}\n"), /constructor/],
    [graph("    args:\n      deep: {prototype: 1}\n"), /prototype/],
    // Numbers too large to keep exactly.
    ["name: x\nsteps: []\n", null],
    [graph("    timeoutMs: 1e999\n"), /number/i],
    [graph("    args: {n: 99999999999999999999999}\n"), /number/i],
    [graph("    args: {n: .nan}\n"), /number/i],
  ];
  for (const [yaml, said] of hostile) {
    if (said === null) { assert.doesNotThrow(() => flowFromYaml(yaml)); continue; }
    assert.throws(() => flowFromYaml(yaml), (error) => error instanceof FlowYamlError && said.test(error.message), yaml);
  }
  assert.equal({}.polluted, undefined);
});

test("integration review: a file's id never replaces a saved flow, and a short-lived key cannot read one in", async (t) => {
  const { app, server, call } = await served(t);
  await call("/api/sdk-kit", { mode: "on" });
  const saved = (await call("/api/flows", graphFlow)).body;
  const yaml = (await call(`/api/flows/${saved.id}/yaml`)).body.yaml;
  const withId = `id: ${saved.id}\n${yaml.replace(/^name: .*$/m, "name: Replaced")}`;
  const back = await call("/api/flows/yaml", { yaml: withId });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.notEqual(back.body.id, saved.id);
  assert.equal(app.flows.get(saved.id).name, graphFlow.name, "the saved flow is untouched");

  const key = app.sessionTokens.create(app.runtime.owner, { scope: "run", minutes: 5 }).token;
  const withKey = (path, body) => fetch(`${server.url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key}`, origin: server.url, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await withKey("/api/flows/yaml", { yaml })).status, 401, "reading a flow in is refused");
  assert.equal((await withKey("/api/sdk-kit", { mode: "off" })).status, 401, "the switch is the owner's");
  assert.equal(app.flows.list().length, 2);
});

test("integration review: an imported tool box is the same as one saved by hand, and a missing flow is a 404", async (t) => {
  const { app, call } = await served(t);
  await call("/api/sdk-kit", { mode: "on" });
  const missing = await call("/api/flows/00000000-0000-4000-8000-000000000000/yaml");
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
  const toolFlow = {
    name: "Reads a secret", entry: "a", edges: [],
    nodes: [{ id: "a", name: "A", kind: "tool", tool: "secrets.get", args: { name: "OPENAI_API_KEY" } }],
  };
  const byHand = await call("/api/flows", toolFlow);
  const imported = await call("/api/flows/yaml", { yaml: stringify({ kind: "graph", ...toolFlow }) });
  assert.equal(imported.status, byHand.status, JSON.stringify([byHand.body, imported.body]));
  if (byHand.status === 200) {
    const strip = ({ id: _id, ...rest }) => rest;
    assert.deepEqual(strip(imported.body.definition), strip(byHand.body.definition), "nothing extra rides in on an import");
    const saved = app.store.get("flow_graphs", app.runtime.owner, imported.body.id).data;
    const hand = app.store.get("flow_graphs", app.runtime.owner, byHand.body.id).data;
    assert.deepEqual(strip(saved), strip(hand), "stored the same, so it runs the same");
  }
});
