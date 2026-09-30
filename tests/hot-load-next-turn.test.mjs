/**
 * The owner's acceptance for hot loading: a plugin, an MCP server or a skill installed, updated or removed through the
 * running app is in (or out of) the very next turn, with no engine or gateway restart. Each kind goes the owner's way
 * (the app's own routes), then a real task through the runtime shows what the model is offered and what it can call.
 * One process for the whole file: its id is checked at the end of each test, so nothing restarted in between.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, toolDescribeName } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const slowServer = resolve("tests/fixtures/mcp-slow-server.mjs");
const say = (content) => () => ({ content, toolCalls: [] });
const call = (name, args) => () => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }] });

async function engine(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-hotload-"));
  const provider = { name: "scripted", requests: [], steps: [], async complete(request) {
    provider.requests.push({ names: request.tools.map((tool) => tool.name), search: request.tools.map((tool) => tool.description).join("\n"),
      system: request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n") });
    const step = provider.steps.shift() ?? say("Done.");
    return step(request);
  } };
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider });
  const server = await startServer(app, { dataDir, port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error ?? "request failed");
    return json;
  };
  /** One turn: the model's steps, then what the first request offered and every tool that ran. */
  const turn = async (prompt, steps) => {
    provider.requests.length = 0;
    provider.steps.push(...steps);
    const run = await app.runtime.run({ prompt });
    const events = app.store.events(run.id);
    return { run, first: provider.requests[0], ran: events.filter((event) => event.kind === "tool.completed").map((event) => [event.data.name, event.data.output ?? event.data.result]),
      failed: events.filter((event) => event.kind === "tool.failed").map((event) => event.data.name) };
  };
  const offered = (request, name) => request.names.includes(name) || request.search.includes(name);
  return { app, api, turn, offered, dataDir, engineServer: server };
}

const pluginFile = (reply) => `export default {
  id: "weather", name: "Weather", description: "Says the weather.", permissions: ["files.read"],
  tools: [{ name: "plugin.weather.today", description: "Today's weather where the owner lives.", permission: "files.read",
    input: {}, run: async () => ({ weather: ${JSON.stringify(reply)} }) }],
};
`;

test("a plugin switched on is callable in the very next turn; updated, the next turn runs the new code; switched off, it is gone", async (t) => {
  const pid = process.pid, { app, api, turn, offered, dataDir } = await engine(t);
  // RES-251: a hand-placed plugin runs walled as shipped (tests/add-ons-review.test.mjs); this is about the next turn seeing a plugin, so the owner
  // lets plugins run inside Branch, as a Linux build machine without bubblewrap could not start the wall.
  app.addOns.save({ wallEveryPlugin: false, confirmLoosening: true });
  await mkdir(join(dataDir, "plugins"), { recursive: true });
  await writeFile(join(dataDir, "plugins", "weather.mjs"), pluginFile("sunny"));
  const before = await turn("What is the weather?", [say("I cannot tell.")]);
  assert.equal(offered(before.first, "plugin.weather.today"), false, "not offered before it is switched on");
  await api("plugins/weather/enable", {});
  const on = await turn("What is the weather?", [call(toolDescribeName, { names: ["plugin.weather.today"] }), call("plugin.weather.today", {}), say("Sunny.")]);
  assert.ok(offered(on.first, "plugin.weather.today"), "offered in the next turn");
  assert.deepEqual(on.ran.filter(([name]) => name === "plugin.weather.today").length, 1, "and it ran");
  assert.deepEqual(on.failed, []);
  // An update is the new file, then off and on again (a loaded file is never swapped under a running tool).
  await writeFile(join(dataDir, "plugins", "weather.mjs"), pluginFile("rainy"));
  await sleep(20); // a new modification time, so the new file is what loads
  await api("plugins/weather/disable", {});
  await api("plugins/weather/enable", {});
  assert.deepEqual(await app.registry.execute("plugin.weather.today", {}, app.runtime.context()), { weather: "rainy" }, "the new code is what runs");
  await api("plugins/weather/disable", {});
  const off = await turn("What is the weather?", [say("I cannot tell.")]);
  assert.equal(offered(off.first, "plugin.weather.today"), false, "switched off: gone from the next turn");
  assert.equal(process.pid, pid, "no restart");
});

test("a plugin switched on while a task works is usable in that task's next round", async (t) => {
  const { app, api, turn, dataDir } = await engine(t);
  // RES-251: a hand-placed plugin runs walled as shipped (tests/add-ons-review.test.mjs); this is about the next round seeing a plugin, so the owner
  // lets plugins run inside Branch, as a Linux build machine without bubblewrap could not start the wall.
  app.addOns.save({ wallEveryPlugin: false, confirmLoosening: true });
  await mkdir(join(dataDir, "plugins"), { recursive: true });
  // A permission no tool had when the task started: the plugin declares its own.
  await writeFile(join(dataDir, "plugins", "weather.mjs"), pluginFile("sunny").replaceAll('"files.read"', '"weather.read"'));
  const during = await turn("What is the weather?", [
    async () => { await api("plugins/weather/enable", {}); return call("files.list", { path: "." })(); },
    call(toolDescribeName, { names: ["plugin.weather.today"] }), call("plugin.weather.today", {}), say("Sunny."),
  ]);
  assert.deepEqual(during.failed, [], "nothing was refused");
  assert.equal(during.ran.filter(([name]) => name === "plugin.weather.today").length, 1, "the plugin's tool ran in the task that was already working");
  assert.ok(app.registry.names().includes("plugin.weather.today"));
});

test("an MCP server added from the app is callable in the very next turn, and removed it is gone from the next", async (t) => {
  const pid = process.pid, { app, api, turn, offered } = await engine(t);
  const { server: { id } } = await api("mcp/servers", { name: "Hot", server: { transport: "stdio", command: process.execPath, args: [slowServer, "--delay", "0"] } });
  await api(`mcp/servers/${id}/start`, {});
  const question = (await api("policy")).waiting.find((q) => q.tool === "mcp.start" && q.target === id);
  await api("policy/approve", { sessionId: question.sessionId, decision: "allow", remember: "never", fingerprint: question.fingerprint });
  const end = Date.now() + 15000;
  while (!app.registry.names().some((name) => name.startsWith(`mcp.${id}.`)) && Date.now() < end) await sleep(50);
  const tool = app.registry.names().find((name) => name.startsWith(`mcp.${id}.`));
  assert.ok(tool, "its tools arrived with no restart");
  await app.store.save("settings", app.runtime.owner, "policy", { rules: [{ tool, decision: "allow" }] });
  const on = await turn("Use the new server.", [call(toolDescribeName, { names: [tool] }), call(tool, {}), say("Done.")]);
  assert.ok(offered(on.first, tool), "offered in the next turn");
  assert.equal(on.ran.filter(([name]) => name === tool).length, 1, "and called");
  await api(`mcp/servers/${id}/remove`, {});
  const off = await turn("Use the new server.", [say("It is gone.")]);
  assert.equal(offered(off.first, tool), false, "removed: gone from the next turn");
  assert.equal(process.pid, pid, "no restart");
});

test("a skill installed is read in the very next turn; a new version activated is what the next turn reads; removed it is gone", async (t) => {
  const pid = process.pid, { api, turn } = await engine(t);
  const doc = (steps) => `---\nname: packing-list\ndescription: Make a packing list for a trip.\n---\n\n# Steps\n${steps}\n`;
  const installed = await api("skills/install", { document: doc("1. Pack socks.") });
  const first = await turn("Help me pack.", [call("skills.read", { id: installed.id, version: 1 }), say("Socks.")]);
  assert.ok(first.first.system.includes("packing-list"), "listed in the next turn");
  assert.equal(first.ran.filter(([name]) => name === "skills.read").length, 1, "and read");
  const updated = await api(`skills/${installed.id}/update`, { document: doc("1. Pack a raincoat."), expectedRevision: installed.revision });
  const active = await api(`skills/${installed.id}/activate`, { version: 2, expectedRevision: updated.revision });
  const second = await turn("Help me pack.", [call("skills.read", { id: installed.id, version: 2 }), say("A raincoat.")]);
  const read = second.ran.find(([name]) => name === "skills.read");
  assert.match(JSON.stringify(read?.[1] ?? ""), /raincoat/, "the next turn reads the new version");
  await api(`skills/${installed.id}/remove`, { expectedRevision: active.revision });
  const third = await turn("Help me pack.", [say("No list.")]);
  assert.equal(third.first.system.includes("packing-list"), false, "removed: gone from the next turn");
  assert.equal(process.pid, pid, "no restart");
});

test("an MCP server added to the launch file is in the very next turn; taken out, it is gone; nothing restarts", async (t) => {
  const pid = process.pid, { app, turn, offered, dataDir } = await engine(t);
  const { loadIntegrations } = await import("../dist/integrations/bootstrap.js");
  const file = join(dataDir, "..", "integrations.json");
  const server = (id) => ({ id, transport: "stdio", command: process.execPath, args: [slowServer, "--delay", "0"], tools: ["echo", "ping"], expectedVersion: "1.0.0" });
  await writeFile(file, JSON.stringify({ mcp: [server("first")] }));
  const integrations = await loadIntegrations(app.registry, file, process.env);
  t.after(() => integrations.close());
  const has = (id) => app.registry.names().some((name) => name.startsWith(`mcp.${id}.`));
  const waitFor = async (check) => { const end = Date.now() + 20000; while (!check() && Date.now() < end) await sleep(100); return check(); };
  assert.ok(has("first"), "the file's server is there at start");
  // The file changes while Branch runs: a new server in, the first one out.
  await sleep(1100); // a modification time the watcher can tell apart
  await writeFile(file, JSON.stringify({ mcp: [server("second")] }));
  assert.ok(await waitFor(() => has("second") && !has("first")), "the change is followed with no restart");
  const tool = app.registry.names().find((name) => name.startsWith("mcp.second."));
  await app.store.save("settings", app.runtime.owner, "policy", { rules: [{ tool, decision: "allow" }] });
  const next = await turn("Use the new server.", [call(toolDescribeName, { names: [tool] }), call(tool, {}), say("Done.")]);
  assert.ok(offered(next.first, tool), "offered in the next turn");
  assert.equal(next.ran.filter(([name]) => name === tool).length, 1, "and called");
  assert.equal(offered(next.first, "mcp.first.echo"), false, "the one taken out is gone");
  // A file that does not read changes nothing.
  await sleep(1100);
  await writeFile(file, "{ half written");
  await sleep(2500);
  assert.ok(has("second"), "a broken save leaves what runs alone");
  assert.equal(process.pid, pid, "no restart");
});
