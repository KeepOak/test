/**
 * Tools, skills, plugins and MCP servers load when needed and reload without a restart (src/tool-context-modes.ts,
 * src/tool-loading.ts, src/skill-tools.ts, src/integrations/mcp.ts, src/mcp-lifecycle.ts).
 *
 * Each test names the change to the engine that turns it red.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, ToolLoader, toolSearchName, toolDescribeName } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const slowServer = resolve("tests/fixtures/mcp-slow-server.mjs");

function scripted(steps) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push({ names: request.tools.map((tool) => tool.name), tools: request.tools,
      system: request.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n") });
    const step = steps[Math.min(provider.requests.length - 1, steps.length - 1)];
    return typeof step === "function" ? step(request) : step;
  } };
  return provider;
}
const say = (content) => () => ({ content, toolCalls: [] });
const call = (name, args) => () => ({ content: "", toolCalls: [{ id: "c" + Math.random().toString(36).slice(2, 8), name, arguments: JSON.stringify(args) }] });

async function fixture(t, steps = [say("ok")], { http = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-ctxmodes-"));
  await mkdir(join(root, "pids"));
  const provider = scripted(steps);
  const dataDir = join(root, "data");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir, provider });
  const server = http ? await startServer(app, { dataDir, port: 0 }) : null;
  const pidfiles = [];
  t.after(async () => {
    await server?.close(); await app.close();
    for (const file of pidfiles) for (const pid of await pidsIn(file)) { try { process.kill(pid, "SIGKILL"); } catch { /* ended */ } }
    await discardTemp(root);
  });
  const api = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error ?? "request failed");
    return json;
  };
  const pidfile = (name) => { const file = join(root, "pids", `${name}.pid`); pidfiles.push(file); return file; };
  return { app, provider, api, pidfile, root };
}
const pidsIn = async (file) => existsSync(file) ? (await readFile(file, "utf8")).split("\n").filter(Boolean).map(Number) : [];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (check, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await sleep(50); }
  return false;
};

/** A connected server's tools, the way they register: `mcp.<server>.<name>`, from outside, permission = own name. */
function standIn(app, server, verbs, calls = []) {
  return verbs.map((verb) => {
    const name = `mcp.${server}.${verb}`;
    app.registry.register({ name, external: true, permission: name,
      description: `${verb[0].toUpperCase()}${verb.slice(1)} parcels with the ${server} courier service by tracking number.`,
      parameters: z.object({ tracking: z.string() }).strict(),
      execute: async (args) => { calls.push([name, args]); return { ok: true, name }; } });
    return name;
  });
}
const searcher = (request) => request.tools.find((tool) => tool.name === toolSearchName)?.description ?? "";

test("a connected server's tools wait in the short index by default: listed, not loaded", async (t) => {
  const { app, provider } = await fixture(t);
  const names = standIn(app, "acme", ["track", "reroute", "hold"]);
  await app.runtime.run({ prompt: "Write a short note to myself about tomorrow." });
  const first = provider.requests[0];
  for (const name of names) {
    assert.ok(!first.names.includes(name), `${name} is not sent in full`); // red: `reachable` ignoring the mode
    assert.ok(searcher(first).includes(name), `${name} has its line in the index`); // red: dropping sourceIndex from render
  }
  // A server's tools are in the "skills" toolbox. When a request's words point at them and that toolbox is guessed, the
  // old rule sent them in full; waiting for a search, none goes. Red: bonusFor and `reachable` treating a waiting
  // tool like any other.
  const tools = app.registry.descriptions(new Set(app.registry.permissions()));
  const guessed = { budgetTokens: 50000, expanded: ["skills"], groupOf: (name) => app.registry.groupOf(name),
    signals: { prompt: "Track, reroute or hold my parcels with the acme courier" } };
  const waiting = new ToolLoader(tools, { ...guessed, sourceOf: (name) => app.registry.sourceOf(name) });
  assert.deepEqual(waiting.descriptions().map((tool) => tool.name).filter((name) => name.startsWith("mcp.acme.")), []);
  const before = new ToolLoader(tools, guessed);
  assert.deepEqual(before.descriptions().map((tool) => tool.name).filter((name) => name.startsWith("mcp.acme.")).sort(), [...names].sort(),
    "without sources the old rule still holds, so the check above can fail");
  // Ten servers: one line per server, not one per tool.
  const { app: many, provider: manyProvider } = await fixture(t);
  for (let n = 0; n < 10; n++) standIn(many, `courier-${n}`, ["track", "reroute", "hold", "return", "label", "price", "pickup", "claim"]);
  await many.runtime.run({ prompt: "Write a short note to myself about tomorrow." });
  const index = searcher(manyProvider.requests[0]);
  for (let n = 0; n < 10; n++) assert.ok(index.includes(`mcp:courier-${n} (8)`), `courier-${n} has one line`);
  assert.ok(!manyProvider.requests[0].names.some((name) => name.startsWith("mcp.courier-")), "none of the eighty is sent in full");
});

test("finding a tool loads its schema; the model can then call it, and it stays for the rest of the task", async (t) => {
  const calls = [];
  const { app, provider } = await fixture(t, [
    call(toolDescribeName, { names: ["mcp.acme.track"] }),
    call("mcp.acme.track", { tracking: "PX-1" }),
    call("files.list", { path: "." }),
    say("Done."),
  ]);
  const [track] = standIn(app, "acme", ["track", "reroute", "hold"], calls);
  // The owner's approval rules for this tool: allowed, so the call goes straight through.
  await app.store.save("settings", app.runtime.owner, "policy", { rules: [{ tool: track, decision: "allow" }] });
  const run = await app.runtime.run({ prompt: "Where is my parcel?" });
  assert.ok(!provider.requests[0].names.includes(track), "not loaded before it was asked for");
  const described = app.store.events(run.id).find((event) => event.kind === "tools.described" && event.data.loaded.includes(track));
  assert.ok(described, "the describe answer names it");
  assert.ok(provider.requests[1].names.includes(track), "loaded from the next round");
  assert.deepEqual(calls, [[track, { tracking: "PX-1" }]], "and called");
  for (const later of provider.requests.slice(1)) assert.ok(later.names.includes(track), "and still there afterwards");
});

test("a source set to Always in context travels in full from the first round; a switched-off tool still does not", async (t) => {
  const { app, provider, api } = await fixture(t, [say("ok")], { http: true });
  const names = standIn(app, "acme", ["track", "reroute", "hold"]);
  const saved = await api("tools/context", { source: "mcp:acme", mode: "always" });
  assert.equal(saved.sources.find((source) => source.source === "mcp:acme").mode, "always");
  await app.runtime.run({ prompt: "Write a short note to myself about tomorrow." });
  for (const name of names) assert.ok(provider.requests[0].names.includes(name), `${name} is sent in full`); // red: `always` not joining the core
  // Directly on the loader: a hidden tool stays out even with its source on "always".
  const tools = app.registry.descriptions(new Set(app.registry.permissions()));
  const loader = new ToolLoader(tools, { sourceOf: (name) => app.registry.sourceOf(name),
    contextModes: () => ({ "mcp:acme": "always" }), hidden: ["mcp.acme.hold"] });
  const sent = loader.descriptions().map((tool) => tool.name);
  assert.ok(sent.includes("mcp.acme.track") && !sent.includes("mcp.acme.hold"));
  // And back to the default.
  const back = await api("tools/context", { source: "mcp:acme", mode: "when-needed" });
  assert.equal(back.sources.find((source) => source.source === "mcp:acme").mode, "when-needed");
  assert.ok(back.sources.find((source) => source.source === "mcp:acme").tokens.always > back.sources.find((source) => source.source === "mcp:acme").tokens.whenNeeded);
});

test("a mode change, a new server and a removed one all reach a task that is already working, from its next round", async (t) => {
  let app;
  const { app: made, provider } = await fixture(t, [
    () => { standIn(app, "late", ["track"]); return call("files.list", { path: "." })(); },
    () => { app.store.save("settings", app.runtime.owner, "tool-context-modes", { modes: { "mcp:late": "always" } }); return call("files.list", { path: "." })(); },
    () => { app.registry.unregister("mcp.late.track"); return call("files.list", { path: "." })(); },
    say("Done."),
  ]);
  app = made;
  const pid = process.pid;
  await app.runtime.run({ prompt: "Have a look around." });
  const [r1, r2, r3, r4] = provider.requests;
  assert.ok(!searcher(r1).includes("mcp.late.track"), "not there before it was added");
  assert.ok(searcher(r2).includes("mcp.late.track") && !r2.names.includes("mcp.late.track"), "added: in the index at the next round");
  assert.ok(r3.names.includes("mcp.late.track"), "switched to always: in full at the next round"); // red: modes read once per task
  assert.ok(!r4.names.includes("mcp.late.track") && !searcher(r4).includes("mcp.late.track"), "removed: gone at the next round");
  assert.equal(process.pid, pid);
});

test("skills wait as one short line; Always lists one in full; a skill added mid-task can be read in that task", async (t) => {
  const doc = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# Steps\n1. Do it.\n`;
  let app, added;
  const { app: made, provider } = await fixture(t, [
    () => { added = app.store.skills.install(app.runtime.owner, { document: doc("late-skill", "Arrived while the task was working.") });
      return call("skills.read", { id: added.id, version: 1 })(); },
    say("Done."),
  ]);
  app = made;
  const long = "Use when the person asks for the quarterly house style with its headings and every rule about tone and order";
  const quiet = app.store.skills.install(app.runtime.owner, { document: doc("house-style", long) });
  const loud = app.store.skills.install(app.runtime.owner, { document: doc("always-here", "Listed in full every time.") });
  app.store.save("settings", app.runtime.owner, "tool-context-modes", { modes: { [`skill:${loud.id}`]: "always" } });
  const run = await app.runtime.run({ prompt: "Tidy my report." });
  const system = provider.requests[0].system;
  assert.ok(system.includes("house-style (Use when the person asks for the quarterly)"), "a short line for the default");
  assert.ok(!system.includes(long) && !system.includes(quiet.id), "not its whole description, not its id"); // red: listing every skill as JSON
  assert.ok(system.includes(loud.id) && system.includes("Listed in full every time."), "the one on always is listed in full");
  const read = app.store.events(run.id).find((event) => event.kind === "tool.completed" && event.data.name === "skills.read");
  const refused = app.store.events(run.id).find((event) => event.kind === "tool.failed" && event.data.name === "skills.read");
  assert.ok(read && !refused, "skills.read of the skill added mid-task works"); // red: catalogForRun returning only the first list
});

test("an MCP server added from the window is usable at once, a crashed one starts again on next use, removing it ends it", async (t) => {
  const { app, api, pidfile } = await fixture(t, [say("ok")], { http: true });
  const pids = pidfile("hot");
  const { server: { id } } = await api("mcp/servers", { name: "Hot", server: { transport: "stdio", command: process.execPath, args: [slowServer, "--delay", "0", "--pidfile", pids] } });
  await api(`mcp/servers/${id}/start`, {});
  const question = (await api("policy")).waiting.find((q) => q.tool === "mcp.start" && q.target === id);
  assert.ok(question, "switching it on still asks the owner");
  await api("policy/approve", { sessionId: question.sessionId, decision: "allow", remember: "never", fingerprint: question.fingerprint });
  const toolsOf = () => app.registry.names().filter((name) => name.startsWith(`mcp.${id}.`));
  assert.ok(await until(() => toolsOf().length === 2), "its tools are registered with no restart");
  const echo = toolsOf()[0];
  const context = () => ({ ...app.runtime.context(), permissions: new Set([echo]) });
  await app.registry.execute(echo, {}, context());
  const [, first] = await pidsIn(pids); // the listing program, then the one that stays
  assert.ok(first && alive(first));
  process.kill(first, "SIGKILL");
  assert.ok(await until(() => !alive(first)));
  await sleep(1500); // Branch hears that the program ended; the next call is then the "next use"
  const answer = await app.registry.execute(echo, {}, context()); // red: restarting() calling the dead client
  assert.match(JSON.stringify(answer), /called/);
  const all = await pidsIn(pids);
  assert.ok(all.length === 3 && alive(all[2]), "a new program answered");
  await api(`mcp/servers/${id}/remove`, {});
  assert.deepEqual(toolsOf(), [], "removed: its tools are gone");
  assert.ok(await until(() => !alive(all[2]), 5000), "and its program ended");
});

test("a tool found this way still asks first when the owner's rules say so", async (t) => {
  const calls = [];
  const { app } = await fixture(t, [
    call(toolDescribeName, { names: ["mcp.acme.reroute"] }),
    call("mcp.acme.reroute", { tracking: "PX-1" }),
    say("Done."),
  ]);
  const [, reroute] = standIn(app, "acme", ["track", "reroute"], calls);
  await app.store.save("settings", app.runtime.owner, "policy", { rules: [{ tool: reroute, decision: "ask" }] });
  const run = await app.runtime.run({ prompt: "Send my parcel somewhere else." });
  const asked = app.store.events(run.id).filter((event) => event.kind === "policy.ask" && event.data.name === reroute);
  assert.equal(asked.length, 1, "the approval rule applies to it");
  assert.deepEqual(calls, [], "and nothing ran without the yes");
});

test("a server connected mid-task: a narrowed task never gets its tools; the owner's full task does, and still asks first", async (t) => {
  // Narrowed: every permission but one. The new tool is neither listed nor callable. Red: `wholeKit.add` for every task.
  const narrowCalls = [];
  let app;
  const { app: made, provider } = await fixture(t, [
    () => { standIn(app, "late", ["track"], narrowCalls); return call("files.list", { path: "." })(); },
    call("mcp.late.track", { tracking: "PX-1" }),
    say("Done."),
  ]);
  app = made;
  const narrowed = await app.runtime.run({ prompt: "Have a look around.", permissions: app.registry.permissions().filter((p) => p !== "files.write") });
  assert.ok(!searcher(provider.requests[1]).includes("mcp.late.track"), "not in the narrowed task's index");
  assert.ok(!provider.requests[1].names.includes("mcp.late.track"));
  assert.deepEqual(narrowCalls, [], "and its call never ran");
  assert.ok(app.store.events(narrowed.id).some((event) => event.kind === "tool.failed" && event.data.name === "mcp.late.track"), "the call was refused");

  // The owner's full task: the tool is usable from the next round, and the owner's "ask first" rule for it holds.
  const fullCalls = [];
  let owner;
  const { app: made2 } = await fixture(t, [
    () => { standIn(owner, "late", ["reroute"], fullCalls);
      owner.store.save("settings", owner.runtime.owner, "policy", { rules: [{ tool: "mcp.late.reroute", decision: "ask" }] });
      return call("files.list", { path: "." })(); },
    call("mcp.late.reroute", { tracking: "PX-1" }),
    say("Done."),
  ]);
  owner = made2;
  const full = await owner.runtime.run({ prompt: "Send my parcel somewhere else." });
  assert.equal(owner.store.events(full.id).filter((event) => event.kind === "policy.ask" && event.data.name === "mcp.late.reroute").length, 1,
    "the approval rule applies to a tool that arrived mid-task");
  assert.deepEqual(fullCalls, [], "nothing ran without the yes");
});

test("on demand, a crashed server starts again on its next call after the checks a start makes; under Lockdown it does not", async (t) => {
  const { app, api, pidfile } = await fixture(t, [say("ok")], { http: true });
  await api("mcp/connections", { connect: "on-demand" });
  // The waits between tries and before a restart are stepped over; what is checked is what happens, not how long it takes.
  app.mcpConnections.backoffMs = () => 0;
  app.mcpConnections.restartMs = () => 0;
  const pids = pidfile("demand");
  const { server: { id } } = await api("mcp/servers", { name: "Demand", server: { transport: "stdio", command: process.execPath, args: [slowServer, "--delay", "0", "--pidfile", pids] } });
  const switchOn = async () => {
    await api(`mcp/servers/${id}/start`, {});
    const question = (await api("policy")).waiting.find((q) => q.tool === "mcp.start" && q.target === id);
    await api("policy/approve", { sessionId: question.sessionId, decision: "allow", remember: "never", fingerprint: question.fingerprint });
  };
  const toolsOf = () => app.registry.names().filter((name) => name.startsWith(`mcp.${id}.`));
  // The first start connects once and notes its tools; switched on again, they are listed from that and nothing runs.
  await switchOn();
  assert.ok(await until(() => toolsOf().length === 2), "the first start is on");
  await api(`mcp/servers/${id}/stop`, {});
  await switchOn();
  assert.ok(await until(() => toolsOf().length === 2), "on again, on demand");
  const echo = toolsOf()[0];
  const context = () => ({ ...app.runtime.context(), permissions: new Set([echo]) });
  const calls = async () => { try { return /called/.test(JSON.stringify(await app.registry.execute(echo, {}, context()))); } catch { return false; } };
  const count = (await pidsIn(pids)).length;
  assert.ok(await calls(), "the first call opens it");
  const first = (await pidsIn(pids)).at(-1);
  assert.equal((await pidsIn(pids)).length, count + 1);
  process.kill(first, "SIGKILL");
  assert.ok(await until(() => !alive(first)));
  // The next call reaches a new program. Red: the on-demand opener in startMcp dropping `alive` (src/integrations/bootstrap.ts).
  assert.ok(await until(calls), "a call after the crash is answered");
  const second = (await pidsIn(pids)).at(-1);
  assert.ok(second !== first && alive(second), "by a new program");
  // Under Lockdown a crashed command server is not started again. Red: the on-demand opener not running `beforeRestart`.
  await app.store.save("settings", app.runtime.owner, "lockdown", { on: true });
  const before = (await pidsIn(pids)).length;
  process.kill(second, "SIGKILL");
  assert.ok(await until(() => !alive(second)));
  const lastError = () => app.mcpConnections.health().find((server) => server.id === id)?.lastError ?? "";
  assert.ok(await until(async () => !(await calls()) && /Lockdown/.test(lastError())), "the next call's start is refused for Lockdown");
  assert.equal((await pidsIn(pids)).length, before, "no program was started");
});

test("a server connected mid-task goes only to a task the owner started, read from the task, not from whoever is at the window", async (t) => {
  const calls = [];
  let app;
  const { app: made, provider } = await fixture(t, [
    () => { standIn(app, "late", ["track"], calls); return call("files.list", { path: "." })(); },
    call("mcp.late.track", { tracking: "PX-1" }),
    say("Done."),
  ]);
  app = made;
  const sam = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: sam.id, pin: "1234" });
  // Sam starts a task holding every permission; the window is back on the owner before its first round.
  const run = await app.runtime.run({ prompt: "Have a look around.", permissions: app.registry.permissions(),
    onStarted: () => app.store.profiles.switch({ profileId: null }) });
  assert.equal(app.store.events(run.id).find((event) => event.kind === "run.started").data.personProfileId, sam.id, "the task is Sam's");
  assert.ok(app.store.profiles.isOwner(), "while the owner is at the window");
  // Red: `wholeKit` read from `profiles.isOwner()` instead of the task's own record (src/runtime.ts openCatalog).
  assert.ok(!searcher(provider.requests[1]).includes("mcp.late.track"), "not in Sam's task's index");
  assert.ok(!provider.requests[1].names.includes("mcp.late.track"));
  assert.deepEqual(calls, [], "and its call never ran");

  // The same in a conversation lent from a household person, started from the owner's window. Red: no `lentTo` check.
  const lentCalls = [];
  let lender;
  const { app: made2, provider: lentProvider } = await fixture(t, [
    () => { standIn(lender, "late", ["track"], lentCalls); return call("files.list", { path: "." })(); },
    call("mcp.late.track", { tracking: "PX-1" }),
    say("Done."),
  ]);
  lender = made2;
  const kim = lender.store.profiles.create({ name: "Kim", pin: "1234" });
  await lender.runtime.run({ prompt: "Have a look around.", permissions: lender.registry.permissions(), lentTo: `profile:${kim.id}` });
  assert.ok(!searcher(lentProvider.requests[1]).includes("mcp.late.track"), "not in the lent conversation's index");
  assert.deepEqual(lentCalls, [], "and its call never ran");
});

test("a server connected mid-task never goes to a Trunk's task, even one holding every permission", async (t) => {
  const calls = [];
  let app, armed = false; // Ada's introduction answers first; the server connects only during the task below
  const { app: made, provider } = await fixture(t, [
    () => { if (armed) standIn(app, "late", ["track"], calls); return armed ? call("files.list", { path: "." })() : say("Hello.")(); },
    call("mcp.late.track", { tracking: "PX-1" }),
    say("Done."),
  ]);
  app = made;
  // A Trunk allowed to run commands, with Trunks since switched off (so nothing is kept from its shape): it holds everything.
  const ada = app.trunks.create({ name: "Ada" });
  app.trunks.edit(ada.id, { reach: { channels: [], commands: true } });
  await app.trunks.introduced();
  app.trunks.setMode("trunks", { mode: "off" });
  provider.requests.length = 0; // the steps above are this task's, not Ada's introduction's
  armed = true;
  const all = app.registry.permissions();
  assert.deepEqual(all.filter((permission) => !app.runtime.trunkShape({ prompt: "", trunkId: ada.id }).permissions.includes(permission)), [],
    "Ada's turn holds every permission there is");
  await app.runtime.run({ prompt: "Have a look around.", trunkId: ada.id });
  // Red: dropping `!context.trunk` from `wholeKit` (src/runtime.ts openCatalog). A Trunk reaches only the servers given to it.
  assert.ok(!searcher(provider.requests[1]).includes("mcp.late.track"), "not in Ada's index");
  assert.ok(!provider.requests[1].names.includes("mcp.late.track"));
  assert.deepEqual(calls, [], "and its call never ran");
});
