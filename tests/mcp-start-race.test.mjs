/**
 * The owner's own MCP servers when the owner acts while one is still starting: switched off or removed, it ends with
 * nothing on, nothing running and no tools of it left; the same name added again asks the owner again; and on demand,
 * a connection still opening when its server is switched off is closed, so no program of it outlives Branch.
 * The server is a small stand-in on this computer that is slow to answer (tests/fixtures/mcp-slow-server.mjs).
 *
 * Review 2 of #371 added the tests from "a connection closed while it waits" on. Each one names the one-line change to
 * the engine that turns it red while every other test here stays green.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { McpConnections } from "../dist/mcp-lifecycle.js";

const slowServer = resolve("tests/fixtures/mcp-slow-server.mjs");
/** How long the stand-in waits before it answers: long enough for the owner's click to land while it starts. */
const delay = 1500;
/** Longer than a start already under way takes to finish: the program its tools are listed from, then the one that stays. */
const wouldHaveFinished = 2 * delay + 2500;

const pidsIn = async (file) => existsSync(file) ? (await readFile(file, "utf8")).split("\n").filter(Boolean).map(Number) : [];
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const stillRunning = async (file) => (await pidsIn(file)).filter(alive);
const until = async (check, ms = 20000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await sleep(50); }
  return false;
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-mcprace-"));
  await mkdir(join(root, "pids")); // outside the workspace, so no launch is refused for pointing into it
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  let closing;
  const close = () => (closing ??= (async () => { await server.close(); await app.close(); })());
  const pidfiles = [];
  t.after(async () => {
    await close();
    // Whatever a stand-in left running is ended here, so none outlives the test even when an assertion failed.
    for (const file of pidfiles) for (const pid of await pidsIn(file)) { try { process.kill(pid, "SIGKILL"); } catch { /* ended already */ } }
    await discardTemp(root);
  });
  const pidfile = (name) => { const file = join(root, "pids", `${name}.pid`); pidfiles.push(file); return file; };
  return { app, close, pidfile, url: server.url, token: server.token };
}
const api = (fx, path, body) => fetch(`${fx.url}${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { authorization: `Bearer ${fx.token}`, origin: fx.url, ...(body === undefined ? {} : { "content-type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}).then(async (response) => {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "request failed");
  return data;
});
const toolsOf = (app, id) => app.registry.names().filter((name) => name.startsWith(`mcp.${id}.`));
const serverOf = async (fx, id) => (await api(fx, "/api/mcp/servers")).servers.find((server) => server.id === id);
const slow = (name, pidfile, wait = delay) => ({ name, server: { transport: "stdio", command: process.execPath,
  args: [slowServer, "--delay", String(wait), "--pidfile", pidfile] } });

/** Switches a server on and gives the owner's yes at the window. */
async function switchOn(fx, id) {
  await api(fx, `/api/mcp/servers/${id}/start`, {});
  const question = (await api(fx, "/api/policy")).waiting.find((q) => q.tool === "mcp.start" && q.target === id);
  assert.ok(question, "switching it on asks the owner");
  await api(fx, "/api/policy/approve", { sessionId: question.sessionId, decision: "allow", remember: "never", fingerprint: question.fingerprint });
}
/** Adds a slow server, says yes to it, and waits until that many of its programs have started. */
async function startSlowly(fx, name, pidfile, programs) {
  const { server: { id } } = await api(fx, "/api/mcp/servers", slow(name, pidfile));
  await switchOn(fx, id);
  assert.ok(await until(async () => (await pidsIn(pidfile)).length >= programs), "its program started");
  return id;
}
/** Every program of that server has ended, given a moment to. */
async function assertEnded(pidfile, message) {
  await until(async () => (await stillRunning(pidfile)).length === 0, 5000);
  assert.deepEqual(await stillRunning(pidfile), [], message);
}

test("a server switched off while it is still starting stays off, with no tools and no program running", async (t) => {
  const fx = await fixture(t);
  const pidfile = fx.pidfile("off");
  // Its first program is the one its tools are listed from: switched off while that is still under way.
  const id = await startSlowly(fx, "Slow off", pidfile, 1);
  const off = await api(fx, `/api/mcp/servers/${id}/stop`, {});
  assert.equal(off.said, "Slow off is off.");
  await sleep(wouldHaveFinished);
  const after = await serverOf(fx, id);
  assert.equal(after.on, false, "it stays off");
  assert.equal(after.running, false, "and is not running");
  assert.deepEqual(toolsOf(fx.app, id), [], "no tool of it is registered");
  await assertEnded(pidfile, "no program of it is left running");
});

test("a server removed while it is still starting is gone, with no tools and no program running", async (t) => {
  const fx = await fixture(t);
  const pidfile = fx.pidfile("removed");
  // Its second program is the one that would stay running: removed while that one is still starting.
  const id = await startSlowly(fx, "Slow remove", pidfile, 2);
  const removed = await api(fx, `/api/mcp/servers/${id}/remove`, {});
  assert.equal(removed.said, "Slow remove is removed.");
  await sleep(wouldHaveFinished);
  assert.equal(await serverOf(fx, id), undefined, "it is not listed");
  assert.deepEqual(toolsOf(fx.app, id), [], "no tool of it is registered");
  await assertEnded(pidfile, "no program of it is left running");
});

test("the same name added again after a remove during its start asks the owner before it is on", async (t) => {
  const fx = await fixture(t);
  const first = fx.pidfile("first");
  const id = await startSlowly(fx, "Slow again", first, 2);
  await api(fx, `/api/mcp/servers/${id}/remove`, {});
  await sleep(wouldHaveFinished);
  const second = fx.pidfile("second");
  const added = await api(fx, "/api/mcp/servers", slow("Slow again", second, 0));
  assert.equal(added.server.id, id, "the name is free again, so the same id is used");
  const turned = await api(fx, `/api/mcp/servers/${id}/start`, {});
  assert.match(turned.said, /Before I go ahead: Start a program on this computer/, "switching it on asks");
  assert.ok(turned.server.waiting, "and waits for the owner's answer");
  assert.equal(turned.server.running, false, "nothing of the removed server runs in its place");
  assert.deepEqual(toolsOf(fx.app, id), []);
  assert.equal(existsSync(second), false, "its own program has not started");
  await assertEnded(first, "no program of the removed server is left running");
});

test("on demand, a connection still opening when its server is switched off is closed, and nothing outlives Branch", async (t) => {
  const fx = await fixture(t);
  await api(fx, "/api/mcp/connections", { connect: "on-demand" });
  const pidfile = fx.pidfile("on-demand");
  const id = await startSlowly(fx, "Slow on demand", pidfile, 1);
  assert.ok(await until(() => toolsOf(fx.app, id).length === 2), "the first start connects once and notes its tools");
  // Off and on again: now its tools are listed from what it said last time, and it connects only when a task needs it.
  await api(fx, `/api/mcp/servers/${id}/stop`, {});
  await switchOn(fx, id);
  assert.ok(await until(async () => (await serverOf(fx, id)).running && toolsOf(fx.app, id).length === 2), "it is on again");
  await assertEnded(pidfile, "nothing of it is connected yet");
  const before = (await pidsIn(pidfile)).length;
  const opening = fx.app.mcpConnections.acquire("a-task", id).then(() => "connected", (error) => error.message);
  assert.ok(await until(async () => (await pidsIn(pidfile)).length > before), "a task's connection is opening");
  await api(fx, `/api/mcp/servers/${id}/stop`, {});
  const outcome = await opening; // the open that was under way has finished, one way or the other
  await fx.close();
  await assertEnded(pidfile, "no program of it outlives Branch");
  assert.notEqual(outcome, "connected", "the connection that was opening is not handed to the task");
});

/** One connection manager on its own, its settings read from nothing (the defaults), for the tests of one connection. */
function manager(t) {
  // The wait between tries is an unref'd timer; this keeps the test's process up while that is all that is left.
  const keep = setInterval(() => undefined, 1000);
  t.after(() => clearInterval(keep));
  return new McpConnections({ get: () => undefined }, () => "owner");
}

// Mutation: drop `&& !entry.closed` from the loop in McpConnections.openWithRetry (src/mcp-lifecycle.ts).
test("a connection closed while it waits between tries is not tried again", async (t) => {
  const connections = manager(t);
  connections.backoffMs = () => 300;
  let tries = 0;
  // Closing everything, unlike forget, keeps the opener, so only the loop's own check stops a second try (a second program).
  connections.register("flaky", async () => {
    tries += 1;
    if (tries === 1) throw new Error("not answering yet");
    return { close: async () => undefined };
  });
  const opening = connections.acquire("a-task", "flaky").then(() => "connected", (error) => error.message);
  assert.ok(await until(() => tries === 1), "the first try failed and it waits to try again");
  await connections.closeAll();
  assert.equal(await opening, 'The "flaky" server was switched off before it finished connecting.');
  assert.equal(tries, 1, "it is not opened again once it was closed");
});

// Mutation: drop `if (opening) await opening.catch(() => undefined);` from McpConnections.shut (src/mcp-lifecycle.ts).
test("forgetting a server waits for a connection still opening, and that connection is closed before it returns", async (t) => {
  const connections = manager(t);
  let arrive;
  const connection = { closed: false, close: async () => { connection.closed = true; } };
  connections.register("slow", () => new Promise((resolve) => { arrive = resolve; }));
  const opening = connections.acquire("a-task", "slow").then(() => "connected", (error) => error.message);
  assert.ok(await until(() => arrive !== undefined), "the connection is opening");
  let closedWhenForgotten;
  const forgotten = connections.forget("slow").then(() => { closedWhenForgotten = connection.closed; });
  setTimeout(() => arrive(connection), 200); // it arrives after forget was asked, as a slow program's would
  await forgotten;
  assert.equal(closedWhenForgotten, true, "no connection it opens outlives forgetting the server");
  assert.notEqual(await opening, "connected", "and it is not handed to the task");
  assert.equal(connections.openCount(), 0);
});

// Mutation: drop the first line of OwnMcpServers.closeAll, `for (const id of [...this.generations.keys()]) this.nextGeneration(id);`
// (src/mcp-own-servers.ts). closeAll is called on its own here, so nothing else Branch does as it closes ends the start instead.
test("closing the owner's servers while one is still starting leaves no tools of it and no program running", async (t) => {
  const fx = await fixture(t);
  const pidfile = fx.pidfile("closing");
  // Its second program is the one that would stay running: closed while that one is still starting.
  const id = await startSlowly(fx, "Slow close", pidfile, 2);
  await fx.app.ownMcp.closeAll();
  await sleep(wouldHaveFinished);
  assert.deepEqual(toolsOf(fx.app, id), [], "no tool of it is registered");
  assert.equal((await serverOf(fx, id)).running, false, "and it is not running");
  await assertEnded(pidfile, "no program of it is left running");
});

/** Stands in front of the malware check and holds its `at`-th look from now until `release` is called. */
function holdVet(app, at) {
  const malware = app.security.malware, real = malware.vet.bind(malware);
  let looks = 0, held = false, done = false, release;
  const gate = new Promise((resolve) => { release = resolve; });
  malware.vet = async (command, args) => {
    looks += 1;
    if (looks !== at) return real(command, args);
    held = true;
    await gate;
    try { return await real(command, args); } finally { done = true; }
  };
  return { held: () => held, done: () => done, release: () => release() };
}

// Review 2's LOW. Mutation: in OwnMcpServers.hostFor's register (src/mcp-own-servers.ts), drop
// `if (!this.stillWanted(entry, generation)) throw new Error(overtaken);`.
test("on demand, an older start that finishes after a newer one leaves the newer one's tools and launch in place", async (t) => {
  const fx = await fixture(t);
  await api(fx, "/api/mcp/connections", { connect: "on-demand" });
  const older = fx.pidfile("older");
  // A first start connects once and notes its tools, so later starts list them without keeping a program running.
  const { server: { id } } = await api(fx, "/api/mcp/servers", slow("Slow twice", older, 0));
  await switchOn(fx, id);
  assert.ok(await until(async () => (await serverOf(fx, id)).running && toolsOf(fx.app, id).length === 2), "the first start is on");
  await api(fx, `/api/mcp/servers/${id}/stop`, {});
  // The older start, held at the malware check inside startMcp: the third look after the switch's own and the start's.
  const vet = holdVet(fx.app, 3);
  await switchOn(fx, id);
  assert.ok(await until(vet.held), "the older start is held inside startMcp");
  // Removed while it is held, and added again under the same name with a launch of its own, which the owner says yes to.
  await api(fx, `/api/mcp/servers/${id}/remove`, {});
  const newer = fx.pidfile("newer");
  assert.equal((await api(fx, "/api/mcp/servers", slow("Slow twice", newer, 0))).server.id, id, "the same id");
  await switchOn(fx, id);
  assert.ok(await until(async () => (await serverOf(fx, id)).running && toolsOf(fx.app, id).length === 2), "the newer start finished first");
  vet.release();
  // The older start carries on from the malware check: whatever startMcp puts in place next happens in that same step.
  assert.ok(await until(vet.done), "the older start's held look has returned");
  await sleep(100);
  const after = await serverOf(fx, id);
  assert.equal(after.running, true, "the newer start is still running");
  assert.equal(after.error, null, "and nothing of the older start was put on it");
  assert.equal(toolsOf(fx.app, id).length, 2, "its tools are still registered");
  // A task's call opens the connection: it has to be the launch the owner said yes to last, never the removed one.
  const [olderBefore, newerBefore] = [(await pidsIn(older)).length, (await pidsIn(newer)).length];
  const opened = await fx.app.mcpConnections.acquire("a-task", id).then(() => "connected", (error) => error.message);
  await fx.app.mcpConnections.releaseRun("a-task");
  assert.equal(opened, "connected");
  assert.equal((await pidsIn(older)).length, olderBefore, "no program of the removed launch was started");
  assert.equal((await pidsIn(newer)).length, newerBefore + 1, "the newer launch was");
});

// The same when the server starts with Branch (the default): the older start's program answers once the newer start
// is on. Mutation: in OwnMcpServers.open's catch, make the overtaken branch `if (!this.stillWanted(entry, generation) && started)`,
// so an overtaken start that had started nothing keeps its failure as the server's problem and switches it off (the
// on-demand test above goes red on it too).
test("an older start whose program answers after a newer start finished leaves the newer one on and running", async (t) => {
  const fx = await fixture(t);
  const older = fx.pidfile("older");
  const slowest = 3000;
  const { server: { id } } = await api(fx, "/api/mcp/servers", slow("Slow twice", older, slowest));
  await switchOn(fx, id);
  assert.ok(await until(async () => (await pidsIn(older)).length >= 2), "the older start's program that stays is starting");
  await api(fx, `/api/mcp/servers/${id}/remove`, {});
  const newer = fx.pidfile("newer");
  assert.equal((await api(fx, "/api/mcp/servers", slow("Slow twice", newer, 0))).server.id, id, "the same id");
  await switchOn(fx, id);
  assert.ok(await until(async () => (await serverOf(fx, id))?.running && toolsOf(fx.app, id).length === 2), "the newer start finished first");
  assert.ok((await stillRunning(older)).length > 0, "while the older start's program is still starting");
  await sleep(slowest + 2000); // the older program answers, and its start finds it was overtaken
  const after = await serverOf(fx, id);
  assert.equal(after.on, true, "the newer start is still on");
  assert.equal(after.running, true, "and running");
  assert.equal(after.error, null, "with nothing of the older start put on it");
  assert.equal(toolsOf(fx.app, id).length, 2, "its tools are still registered");
  assert.equal((await stillRunning(newer)).length, 1, "its program is still running");
  await assertEnded(older, "no program of the removed launch is left running");
});
