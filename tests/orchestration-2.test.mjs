import test from "node:test";

import assert from "node:assert/strict";

import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";

import { createBranch } from "../dist/index.js";

import { startServer } from "../dist/server.js";



const say = (content) => ({ content, toolCalls: [] });

const call = (name, args) => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 9)}`, name, arguments: JSON.stringify(args) }] });

const kinds = (app, runId) => app.store.events(runId).map((e) => e.kind);

const data = (app, runId, kind) => app.store.events(runId).filter((e) => e.kind === kind).map((e) => e.data);



/** A provider whose answer is chosen from the system prompt and the last message of the request. */

function scripted(reply) {

  const provider = { name: "scripted", requests: [], async complete(request) {

    provider.requests.push(request);

    const system = request.messages[0].content;

    const user = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";

    const last = request.messages.at(-1);

    return reply({ system, user, last, request });

  } };

  return provider;

}

async function fixture(t, reply = () => say("done"), options = {}) {

  const root = await mkdtemp(join(tmpdir(), "branch-orch2-"));

  const provider = scripted(reply);

  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  app.coding.setMode("read-first", "off"); // read-first ships on (Q250); these tests are about orchestration, not reading first

  t.after(async () => {

    await app.processes.stopAll().catch(() => undefined);

    await app.close();

    await discardTemp(root);

  });

  return { app, provider, root };

}

async function served(t, reply, options = {}) {

  const made = await fixture(t, reply, options);

  const server = await startServer(made.app, { dataDir: join(made.root, "data"), port: 0 });

  t.after(async () => { await server.close(); });

  const api = async (path, body, method) => {

    const response = await fetch(`${server.url}/api/${path}`, {

      method: method ?? (body === undefined ? "GET" : "POST"),

      headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },

      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),

    });

    const json = await response.json();

    if (!response.ok) throw new Error(json.error);

    return json;

  };

  return { ...made, api, server };

}

/** An evaluated, promoted specialist the runtime will delegate to, with a working style. */

async function specialist(app, name, style, permissions = ["files.read"]) {

  const context = app.runtime.context();

  const proposed = await app.registry.execute("specialists.propose", {

    name, style, instructions: `You are the ${name}.`, permissions,

    evaluation: { prompt: "say ready", checks: [{ path: `${name}.txt`, expected: "ready" }] },

  }, context);

  await writeFile(join(app.runtime.workspace, `${name}.txt`), "ready");

  await app.registry.execute("specialists.evaluate", { id: proposed.id }, context);

  await app.registry.execute("specialists.promote", { id: proposed.id }, context);

  return proposed.id;

}

/** A context bound to a real task, so tools that need a conversation have one. */

function taskContext(app, prompt = "a task", temporary = false) {

  const run = app.store.createRun(app.runtime.owner, prompt, undefined, temporary);

  return { run, context: app.runtime.context({ runId: run.id }) };

}



// ---------------------------------------------------------------- O1: styles



test("a react specialist thinks one line at a time: the line is on the task, not in the answer", async (t) => {

  const { app } = await fixture(t, ({ system }) => {

    if (/You are the thinker/.test(system)) return say("Thought: I will look at the note first.\nThe note says ready.");

    return say("parent done");

  });

  const id = await specialist(app, "thinker", "react");

  const { context } = taskContext(app);

  const { run } = await app.knowledge.delegate(context, id, "read the note");

  assert.equal(run.status, "completed");

  assert.equal(run.output, "The note says ready.", "the thinking line never reaches the answer");

  assert.deepEqual(data(app, run.id, "react.scratch").map((d) => d.text), ["I will look at the note first."]);

  assert.equal(data(app, run.id, "specialist.style")[0].style, "react");

  const kept = app.store.messages(run.sessionId).filter((m) => m.role === "assistant");

  assert.match(kept.at(-1).content, /Thought:/, "the transcript still holds the trail the model left");

});



test("a critic specialist may look but not change, whatever it was given permission for", async (t) => {

  const { app } = await fixture(t, ({ system, user }) => {

    if (/You are the reviewer/.test(system) && /review the note/.test(user))

      return call("files.write", { path: "note.txt", content: "changed" });

    return say("ready");

  });

  const id = await specialist(app, "reviewer", "critic", ["files.read", "files.write"]);

  const { context } = taskContext(app);

  const { run } = await app.knowledge.delegate(context, id, "review the note");

  const failures = data(app, run.id, "tool.failed");

  assert.match(failures[0].error, /Permission denied: files\.write/);

  assert.equal(await readFile(join(app.runtime.workspace, "note.txt"), "utf8").catch(() => null), null);

});



test("a plan-execute specialist plans its own sub-task and works through the steps", async (t) => {

  const { app } = await fixture(t, ({ system, user }) => {

    if (/You are planning a task/.test(system)) return say('{"steps":[{"title":"Read it"},{"title":"Say what it said"}]}');

    if (/You are the worker/.test(system)) {

      if (/^Step 1 of 2/.test(user)) return say("I read it.");

      if (/^Step 2 of 2/.test(user)) return say("It said ready.");

      return say("Both steps are done: it said ready.");

    }

    return say("parent done");

  });

  const id = await specialist(app, "worker", "plan-execute");

  const { context } = taskContext(app);

  const { run } = await app.knowledge.delegate(context, id, "read the note and say what it said");

  assert.equal(run.output, "Both steps are done: it said ready.");

  assert.deepEqual(data(app, run.id, "plan.created")[0].steps, ["Read it", "Say what it said"]);

  assert.equal(data(app, run.id, "plan.step.finished").length, 2);

});



test("a researcher opens the looking-things-up toolboxes and a coder the code ones, before the first round", async (t) => {

  const { app } = await fixture(t, () => say("done"));

  for (const [name, style, expected] of [["finder", "researcher", "web"], ["builder", "coder", "git"]]) {

    const id = await specialist(app, name, style, ["files.read", "web.read", "git.read"]);

    const { context } = taskContext(app);

    const { run } = await app.knowledge.delegate(context, id, "have a look");

    const preselected = data(app, run.id, "catalog.preselected")[0];

    assert.ok(preselected.style.includes(expected), `${style} opens ${expected}: got ${JSON.stringify(preselected.style)}`);

  }

});



// ------------------------------------------------- O2: patches and change sets



const patchFor = (path, before, after) => [

  `--- a/${path}`, `+++ b/${path}`, `@@ -1,${before.length} +1,${after.length} @@`,

  ...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`), "",

].join("\n");



test("code.patch shows the whole change first, then writes it all at once and keeps every file's history", async (t) => {

  const { app } = await fixture(t);

  const workspace = app.runtime.workspace;

  await writeFile(join(workspace, "one.txt"), "first\n");

  await writeFile(join(workspace, "two.txt"), "second\n");

  const patch = patchFor("one.txt", ["first"], ["FIRST"]) + patchFor("two.txt", ["second"], ["SECOND"]);

  const { context, run } = taskContext(app);

  const preview = await app.registry.execute("code.patch", { patch, dryRun: true }, context);

  assert.equal(preview.applied, false);

  assert.deepEqual(preview.files.map((f) => f.path), ["one.txt", "two.txt"]);

  assert.equal(await readFile(join(workspace, "one.txt"), "utf8"), "first\n", "a dry run writes nothing");

  const applied = await app.registry.execute("code.patch", { patch }, context);

  assert.equal(applied.applied, true);

  assert.equal(await readFile(join(workspace, "one.txt"), "utf8"), "FIRST\n");

  assert.equal(await readFile(join(workspace, "two.txt"), "utf8"), "SECOND\n");

  assert.deepEqual(data(app, run.id, "code.changed")[0].files, ["one.txt", "two.txt"]);

  const history = await app.registry.execute("files.history", { path: "one.txt" }, context);

  assert.ok(history.length >= 1, "the earlier text is kept so the change can be put back");

  const back = await app.registry.execute("files.restore", { versionId: history[0].id }, context);

  assert.equal(back.restored, true);

  assert.equal(await readFile(join(workspace, "one.txt"), "utf8"), "first\n", "one file of the set can be put back on its own");

});



test("code.patch refuses a part that does not fit and a file that is not text, and changes nothing", async (t) => {

  const { app } = await fixture(t);

  const workspace = app.runtime.workspace;

  await writeFile(join(workspace, "one.txt"), "first\n");

  await writeFile(join(workspace, "two.txt"), "second\n");

  const { context } = taskContext(app);

  const wrong = patchFor("one.txt", ["first"], ["FIRST"]) + patchFor("two.txt", ["nothing like this"], ["x"]);

  await assert.rejects(() => app.registry.execute("code.patch", { patch: wrong }, context), /does not match the file/);

  assert.equal(await readFile(join(workspace, "one.txt"), "utf8"), "first\n", "the first file was never written");

  await writeFile(join(workspace, "picture.dat"), Buffer.from([0x50, 0x00, 0x4e, 0x47]));

  await assert.rejects(

    () => app.registry.execute("code.patch", { patch: patchFor("picture.dat", ["P\u0000NG"], ["x"]) }, context),

    /not a text file|does not match/);

});



test("a change that fails part-way puts back every file it had already written", async (t) => {

  const { app } = await fixture(t);

  const { CodeEditor } = await import("../dist/code-edit.js");

  const { WorkspaceFiles } = await import("../dist/files.js");

  const workspace = app.runtime.workspace;

  await writeFile(join(workspace, "first.txt"), "original\n");

  const editor = new CodeEditor(new WorkspaceFiles(workspace));

  const { context } = taskContext(app);

  // The first file writes; the second is outside the workspace and is refused as the write is attempted.

  await assert.rejects(() => editor.writeAll([

    { path: "first.txt", before: "original\n", after: "changed\n" },

    { path: "../escape.txt", before: null, after: "nope\n" },

  ], context), /denied|traversal/i);

  assert.equal(await readFile(join(workspace, "first.txt"), "utf8"), "original\n", "the file written first was put back");

});



test("a change set names its files for one approval, is all-or-nothing, and reports the project's check", async (t) => {

  const { app } = await fixture(t);

  const workspace = app.runtime.workspace;

  await writeFile(join(workspace, "a.txt"), "keep alpha\n");

  await writeFile(join(workspace, "b.txt"), "keep beta\n");

  const edits = [{ path: "a.txt", find: "alpha", replace: "ALPHA" }, { path: "b.txt", find: "beta", replace: "BETA" }];

  const { context } = taskContext(app);

  const target = app.registry.targetOf("code.change_set", { reason: "tidy up", edits, dryRun: false }, context);

  assert.equal(target, "2 files: a.txt, b.txt", "the person is told which files before they say yes");

  // A check that always passes, run through the app's own Node so nothing else has to be installed.

  await writeFile(join(workspace, "ok.mjs"), "process.exit(0)\n");

  app.store.save("settings", app.runtime.owner, "code-check",

    { enabled: true, command: process.execPath, args: ["--check", join(workspace, "ok.mjs")], timeoutMs: 20000 });

  const result = await app.registry.execute("code.change_set", { reason: "tidy up", edits }, context);

  assert.equal(result.applied, true);

  assert.equal(result.check.ran, true);

  assert.equal(result.check.ok, true, `check said: ${JSON.stringify(result.check)}`);

  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "keep ALPHA\n");

  await assert.rejects(

    () => app.registry.execute("code.change_set", { reason: "again", edits: [{ path: "a.txt", find: "ALPHA", replace: "x" }, { path: "b.txt", find: "missing", replace: "y" }] }, context),

    /contains that text 0 time/);

  assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "keep ALPHA\n", "nothing was written when one edit did not fit");

});



test("what the project's check said reaches the assistant's next round", async (t) => {

  let asked = 0;

  const { app } = await fixture(t, ({ last }) => {

    if (last.role === "tool") { asked++; return say(`the check said: ${JSON.parse(last.content).result.check.ok}`); }

    return call("code.patch", { patch: patchFor("one.txt", ["first"], ["FIRST"]) });

  });

  await writeFile(join(app.runtime.workspace, "one.txt"), "first\n");

  app.store.save("settings", app.runtime.owner, "code-check",

    { enabled: true, command: process.execPath, args: ["-e", "process.exit(3)"], timeoutMs: 20000 });

  const run = await app.runtime.run({ prompt: "change the file" });

  assert.equal(asked, 1);

  assert.equal(run.output, "the check said: false");

  assert.equal(data(app, run.id, "code.check")[0].ok, false);

});



// --------------------------------------------- O3: programs left running



async function allowNode(app, alias = "node") {

  app.store.save("settings", app.runtime.owner, "background-processes",

    { programs: { [alias]: { path: process.execPath, args: [] } }, maxRunning: 3, maxMinutes: 5,

      maxMemoryMb: 512, maxCpuSeconds: 60, bufferBytes: 4096 });

}

const ticker = ["-e", "setInterval(() => console.log('tick'), 40)"];



test("a program started in the background outlives its tool call, is listed, read and stopped", async (t) => {

  const { app } = await fixture(t);

  await allowNode(app);

  const { context, run } = taskContext(app);

  const started = await app.registry.execute("process.start", { program: "node", args: ticker, name: "the ticker" }, context);

  t.after(() => app.processes.stop(started.id).catch(() => undefined));

  assert.equal(started.status, "running");

  assert.ok(started.pid, "it really started");

  await delay(250);

  const listed = await app.registry.execute("process.list", {}, context);

  assert.equal(listed.processes.filter((p) => p.status === "running").length, 1, "it is still going after the tool call ended");

  // A slow computer can take a few seconds to start Node and print the first line: wait for it.

  let read = await app.registry.execute("process.read", { id: started.id }, context);

  for (let attempt = 0; attempt < 60 && !/tick/.test(read.output); attempt++) {

    await delay(100);

    read = await app.registry.execute("process.read", { id: started.id }, context);

  }

  assert.match(read.output, /tick/);

  const stopped = await app.registry.execute("process.stop", { id: started.id }, context);

  assert.equal(stopped.status, "stopped");

  await delay(100);

  assert.equal(app.processes.list({ active: true }).length, 0);

  assert.deepEqual(data(app, run.id, "process.started").map((d) => d.name), ["the ticker"]);

});



test("a program is stopped when its conversation is thrown away, and when the app closes", async (t) => {

  const { app } = await fixture(t);

  await allowNode(app);

  const { context: temporaryContext, run: temporaryRun } = taskContext(app, "temporary task", true);

  const inSession = await app.registry.execute("process.start", { program: "node", args: ticker, name: "first" }, temporaryContext);

  app.store.finish(temporaryRun.id, "completed", "done");

  app.store.discardSession(app.runtime.owner, temporaryRun.sessionId);

  const stateOf = (id) => app.processes.list().find((p) => p.id === id).status;

  for (let at = 0; at < 200 && stateOf(inSession.id) === "running"; at++) await delay(25);

  assert.equal(stateOf(inSession.id), "stopped", "it went with the conversation");

  const { context } = taskContext(app);

  const second = await app.registry.execute("process.start", { program: "node", args: ticker, name: "second" }, context);

  await app.close();

  assert.deepEqual(app.processes.list(), [], "closing the app leaves nothing behind at all");

  const alive = () => { try { process.kill(second.pid, 0); return true; } catch { return false; } };

  for (let at = 0; at < 200 && alive(); at++) await delay(25);

  assert.equal(alive(), false, "and the program itself really is gone");

});



test("only programs the owner allowed may be started, and only so many at once", async (t) => {

  const { app } = await fixture(t);

  const { context } = taskContext(app);

  await assert.rejects(() => app.registry.execute("process.start", { program: "node", args: [] }, context), /not one of the programs/);

  app.store.save("settings", app.runtime.owner, "background-processes",

    { programs: { node: { path: process.execPath, args: [] } }, maxRunning: 1, maxMinutes: 5, bufferBytes: 2048 });

  const first = await app.registry.execute("process.start", { program: "node", args: ticker, name: "one" }, context);

  t.after(() => app.processes.stop(first.id).catch(() => undefined));

  await assert.rejects(() => app.registry.execute("process.start", { program: "node", args: ticker }, context), /already running/);

});



// ------------------------------------------------------------ O4: deferred calls



test("a tool may hand its work over and finish later through the follow-up queue", async (t) => {

  let round = 0;

  const { app } = await fixture(t, ({ user }) => {

    if (/handed over earlier has finished/.test(user)) return say(`they did it: ${user.split("What came of it: ")[1]}`);

    round++;

    if (round === 1) return call("user.task", { description: "sign the form" });

    return say("I have asked them and carried on.");

  });

  const run = await app.runtime.run({ prompt: "get the form signed" });

  assert.equal(run.output, "I have asked them and carried on.", "the task did not wait");

  const handed = data(app, run.id, "tool.deferred");

  assert.equal(handed.length, 1);

  assert.equal(handed[0].description, "sign the form");

  const waiting = app.runtime.deferrals.list({ waiting: true });

  assert.equal(waiting.length, 1);

  const settled = app.runtime.settleDeferred(waiting[0].id, "signed and posted");

  assert.equal(settled.sessionId, run.sessionId);

  for (let at = 0; at < 100 && app.store.runs(app.runtime.owner).length < 2; at++) await delay(20);

  const follow = app.store.runs(app.runtime.owner).find((r) => r.id !== run.id);

  for (let at = 0; at < 100 && follow.status === "running"; at++) await delay(20);

  assert.match(app.store.run(follow.id).output, /signed and posted/);

  assert.equal(app.runtime.deferrals.list({ waiting: true }).length, 0);

});



// ------------------------------------------------------------ O6: code.run



test("code.run runs a small script under its limits, and refuses until the owner allows it", async (t) => {

  const { app } = await fixture(t);

  const { context } = taskContext(app);

  await assert.rejects(() => app.registry.execute("code.run", { language: "javascript", source: "console.log(1)" }, context),

    /switched off/);

  app.store.save("settings", app.runtime.owner, "code-run",

    { enabled: true, python: "", network: false, timeoutMs: 8000, maxMemoryMb: 256, maxCpuSeconds: 10, maxOutputBytes: 2048 });

  const result = await app.registry.execute("code.run", { language: "javascript", source: "console.log(6 * 7)" }, context);

  assert.equal(result.status, "completed");

  assert.match(result.output, /42/);

  assert.equal(result.network, false);

  await assert.rejects(() => app.registry.execute("code.run", { language: "python", source: "print(1)" }, context), /No Python/);

  const slow = await app.registry.execute("code.run",

    { language: "javascript", source: "const until = Date.now() + 30000; while (Date.now() < until) {}" }, context);

  assert.notEqual(slow.status, "completed", "a script that will not stop is stopped for it");

});



// -------------------------------------------------- O5: flows as an API



/** A fake endpoint that records what arrives, so a callback can be waited for. */

async function fakeEndpoint(t) {

  const { createServer } = await import("node:http");

  const received = [];

  const server = createServer((request, response) => {

    const chunks = [];

    request.on("data", (chunk) => chunks.push(chunk));

    request.on("end", () => { received.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); response.writeHead(200).end("{}"); });

  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  t.after(() => new Promise((resolve) => server.close(resolve)));

  return {

    url: `http://127.0.0.1:${server.address().port}/hook`,

    received,

    async wait(event, count = 1) {

      const deadline = Date.now() + 4000;

      const found = () => received.filter((entry) => entry.event === event);

      while (found().length < count) {

        if (Date.now() > deadline) throw new Error(`Only ${found().length} ${event} deliveries arrived`);

        await delay(20);

      }

      return found();

    },

  };

}



test("flows are made, read, changed, run and removed over HTTP, and every step is drawn", async (t) => {

  const { api } = await served(t, ({ user }) => say(/gather/i.test(user) ? "found nothing at all" : "wrote it up"));

  const graph = {

    name: "Weekly look",

    description: "Gather, then decide whether to write it up.",

    nodes: [

      { name: "Gather", kind: "prompt", prompt: "gather what happened" },

      { name: "Anything to say?", kind: "branch", contains: "something", skipAhead: 1 },

      { name: "Write it up", kind: "prompt", prompt: "write it up" },

      { name: "Finish", kind: "prompt", prompt: "say we are done" },

    ],

  };

  const made = await api("flows", graph);

  assert.equal(made.name, "Weekly look");

  assert.deepEqual(made.graph.nodes.map((n) => [n.id, n.kind]), [["n1", "prompt"], ["n2", "branch"], ["n3", "prompt"], ["n4", "prompt"]]);

  assert.deepEqual(made.graph.edges, [

    { from: "n1", to: "n2", when: "next" },

    { from: "n2", to: "n3", when: "matched" },

    { from: "n2", to: "n4", when: "skipped" },

    { from: "n3", to: "n4", when: "next" },

  ], "a branch has one arrow for each way it can go");

  assert.equal((await api("flows")).flows.length, 1);

  await api(`flows/${made.id}`, { ...graph, description: "Changed." }, "PUT");

  assert.equal((await api(`flows/${made.id}`)).description, "Changed.");

  const ran = await api(`flows/${made.id}/run`, {});

  assert.equal(ran.status, "completed");

  const states = Object.fromEntries(ran.graph.nodes.map((n) => [n.name, n.status]));

  assert.equal(states.Gather, "done");

  assert.equal(states["Write it up"], "waiting", "the branch skipped it: the answer never said \"something\"");

  assert.equal(states.Finish, "done");

  assert.deepEqual(await api(`flows/${made.id}`, undefined, "DELETE"), { removed: true });

  assert.equal((await api("flows")).flows.length, 0);

});



test("whoever asked is told as each step of a flow finishes", async (t) => {

  const { app, api } = await served(t, () => say("all done here"));

  app.web.policy.configure({ allowPrivateAddresses: true });

  app.webhooks.retryDelays = [1, 1];

  const endpoint = await fakeEndpoint(t);

  await api("webhooks", { name: "watcher", url: endpoint.url, events: ["flow.node"] });

  const made = await api("flows", { name: "Two steps", description: "", nodes: [

    { name: "First", kind: "prompt", prompt: "do the first thing" },

    { name: "Second", kind: "prompt", prompt: "do the second thing" },

  ] });

  await api(`flows/${made.id}/run`, {});

  const notes = await endpoint.wait("flow.node", 2);

  assert.deepEqual(notes.map((n) => [n.node, n.name, n.status]), [["n1", "First", "done"], ["n2", "Second", "done"]]);

  assert.equal(notes[0].flowId, made.id);

});



test("a flow that stops for the owner says so, and carries on when they say yes", async (t) => {

  const { api } = await served(t, () => say("done"));

  const made = await api("flows", { name: "Ask first", description: "", nodes: [

    { name: "Check with them", kind: "approval", question: "Shall I go on?" },

    { name: "Do it", kind: "prompt", prompt: "do it" },

  ] });

  const waiting = await api(`flows/${made.id}/run`, {});

  assert.equal(waiting.status, "waiting_approval");

  assert.equal(waiting.question, "Shall I go on?");

  assert.equal(waiting.graph.nodes[0].status, "waiting");

  const carried = await api(`flows/${made.id}/resume`, {});

  assert.equal(carried.status, "completed");

  assert.deepEqual(carried.graph.nodes.map((n) => n.status), ["approved", "done"]);

});



test("a second person's profile reaches no flow and none of the switches behind host execution", async (t) => {

  const { app, api } = await served(t, () => say("done"));

  await api("flows", { name: "The owner's flow", description: "", nodes: [{ name: "One", kind: "prompt", prompt: "do it" }] });

  const made = await api("profiles", { name: "Ash", pin: "2468" });

  await api("profiles/switch", { profileId: made.id, pin: "2468" });

  const refused = async (path, body, method) =>

    assert.rejects(() => api(path, body, method), /belongs to the owner/, `${path} is refused while somebody else is switched on`);

  await refused("flows");

  await refused("flows", { name: "Theirs", description: "", nodes: [{ name: "One", kind: "prompt", prompt: "x" }] });

  await refused("code-run", { enabled: true });

  await refused("background-programs", { programs: { theirs: { path: process.execPath, args: [] } } });

  await refused("code-check", { enabled: false, command: "", args: [] });

  await refused("processes");

  await refused("deferred");

  await refused("plugin-catalog");

  await refused("skill-revisions");

  // The assistant always works as the owner, so the tool must check the profile too, not just the route.
  // The tool gate (mac5/manual-actions) now refuses the switched-on person's role first; either refusal will do.

  await assert.rejects(() => app.runtime.executeTool("flows.list", {}), /belongs to the owner|is set up as "Adult"/);

  await api("profiles/switch", { profileId: null });

  assert.equal((await api("flows")).flows.length, 1, "the owner still sees their own");

  assert.equal((await api("code-run")).enabled, false);

});



// ------------------------- O7: skills that improve themselves, and plugins



const skillDocument = (name, body) => `---\nname: ${name}\ndescription: How to do the ${name} thing properly.\n---\n${body}\n`;



/**

 * A skill, a real task that read it (so the app knows the task used it), and a drafted better

 * version of that skill waiting for the owner's answer.

 */

async function draftedRevision(app, reading) {

  const skill = app.store.skills.install(app.runtime.owner, { document: skillDocument("tidying", "Put things away.") });

  reading.id = skill.id;

  const used = await app.runtime.run({ prompt: "tidy the kitchen" });

  assert.equal(used.status, "completed");

  const drafted = await app.store.governanceFor(app.runtime.owner).proposeFromRun(app.runtime, skill.id, used.id);

  return { skill, used, version: drafted.candidateVersion };

}



test("a drafted skill is shown as changed lines, tried on recent tasks without doing anything, then kept or thrown away", async (t) => {

  const reading = { id: null, read: false };

  const { app, api } = await served(t, ({ system, user, last }) => {

    if (/Write the improved SKILL.md/.test(user)) return say(skillDocument("tidying", "Put things away, newest first."));

    // Inside the trial the assistant tries to write a file; nothing may actually be written.

    if (/The skill being tried/.test(system) && last.role !== "tool") return call("files.write", { path: "trial-proof.txt", content: "written" });

    if (reading.id && !reading.read && last.role !== "tool") { reading.read = true; return call("skills.read", { id: reading.id, version: 1 }); }

    return say("tidied");

  });

  const { skill, version } = await draftedRevision(app, reading);

  const listed = await api("skill-revisions");

  const waiting = listed.revisions.find((r) => r.skillId === skill.id && r.version === version);

  assert.ok(waiting, "the draft is offered to the owner");

  assert.match(waiting.diff, /newest first/, "the owner sees the lines that changed");

  assert.equal(waiting.trial, null);

  assert.equal(waiting.decision, null);

  await assert.rejects(() => api("skill-revisions/accept", { skillId: skill.id, version }), /Try the draft/);

  const trial = await api("skill-revisions/try", { skillId: skill.id, version });

  assert.ok(trial.tasks >= 1, "it was tried against a real task");

  assert.equal(trial.baseline.finished, trial.tasks);

  assert.equal(trial.candidate.finished, trial.tasks);

  assert.equal(trial.noWorse, true);

  const practice = app.store.run(trial.parentRunId);

  assert.ok(app.store.events(practice.id).some((e) => e.kind === "dryrun.report"), "the trial was a practice run");

  // Each side of the trial runs as its own task; every one of them inherited the practice run’s dry run.

  const inTrial = app.store.runs(app.runtime.owner).filter((run) => run.createdAt >= practice.createdAt);

  const simulated = inTrial.map((run) => run.id)

    .flatMap((id) => app.store.events(id)).filter((e) => e.kind === "tool.simulated");

  assert.equal(simulated.length, trial.tasks * 2, "both sides of the trial only pretended to write");

  assert.ok(simulated.every((e) => e.data.name === "files.write"));

  await assert.rejects(() => readFile(join(app.runtime.workspace, "trial-proof.txt"), "utf8"), "and nothing was actually written");

  const kept = await api("skill-revisions/accept", { skillId: skill.id, version });

  assert.equal(kept.decision, "accepted");

  assert.equal(app.store.skills.view(app.runtime.owner, skill.id).activeVersion, version);

});



test("a drafted skill that is thrown away never becomes the one in use", async (t) => {

  const reading = { id: null, read: false };

  const { app, api } = await served(t, ({ user }) =>

    say(/Write the improved SKILL.md/.test(user) ? skillDocument("tidying", "Throw everything out.") : "tidied"));

  const { skill, version } = await draftedRevision(app, reading);

  const before = app.store.skills.view(app.runtime.owner, skill.id).activeVersion;

  const thrown = await api("skill-revisions/reject", { skillId: skill.id, version });

  assert.equal(thrown.decision, "rejected");

  assert.equal(app.store.skills.view(app.runtime.owner, skill.id).activeVersion, before);

  assert.equal((await api("skill-revisions")).revisions[0].decision, "rejected");

});



test("skills go out to a folder as files and come back in again, so they can be kept in version control", async (t) => {

  const { app } = await fixture(t);

  const owner = app.runtime.owner;

  app.store.skills.install(owner, { document: skillDocument("packing", "Put it in the box.") });

  const { context } = taskContext(app);

  const out = await app.registry.execute("skills.sync", { folder: "skills", direction: "out" }, context);

  assert.deepEqual(out.written, ["skills/packing.md"]);

  const file = join(app.runtime.workspace, "skills", "packing.md");

  assert.match(await readFile(file, "utf8"), /Put it in the box/);

  const back = await app.registry.execute("skills.sync", { folder: "skills", direction: "in" }, context);

  assert.deepEqual(back.unchanged, ["skills/packing.md"]);

  await writeFile(file, skillDocument("packing", "Put it in the box, the heavy things first."));

  await writeFile(join(app.runtime.workspace, "skills", "new.md"), skillDocument("posting", "Take it to the post office."));

  const again = await app.registry.execute("skills.sync", { folder: "skills", direction: "in" }, context);

  assert.deepEqual(again.updated, ["skills/packing.md"]);

  assert.deepEqual(again.installed, ["skills/new.md"]);

  assert.equal(app.store.skills.list(owner).length, 2);

});



test("a plugin is shown in full before it is copied in, and its fingerprint is checked", async (t) => {

  const { app, api, root } = await served(t);

  const folder = join(root, "handed-over");

  await mkdir(folder, { recursive: true });

  const code = "export default { id: 'tidy', name: 'Tidy', permissions: [], tools: [] };\n";

  await writeFile(join(folder, "tidy.mjs"), code);

  await writeFile(join(folder, "branch-plugin.json"),

    JSON.stringify({ id: "tidy", name: "Tidy", description: "Tidies things up.", permissions: ["files.read"], version: "2" }));

  const offer = await api("plugin-catalog/inspect", { source: folder });

  assert.equal(offer.manifest.name, "Tidy");

  assert.deepEqual(offer.manifest.permissions, ["files.read"]);

  assert.match(offer.sha256, /^[0-9a-f]{64}$/);

  assert.equal(app.store.list("settings", app.runtime.owner).filter((r) => r.id.startsWith("plugin-catalog:")).length, 0,

    "looking at it installs nothing");

  await assert.rejects(() => api("plugin-catalog/install", { source: folder, sha256: "f".repeat(64) }), /not the one you were shown/);

  const installed = await api("plugin-catalog/install", { source: folder, sha256: offer.sha256 });

  assert.equal(installed.id, "tidy");

  const listed = await api("plugin-catalog");

  assert.equal(listed.plugins[0].unchanged, true);

  assert.ok((await app.plugins.list()).some((entry) => entry.id === "tidy" && entry.enabled === false),

    "it arrives switched off, as every plugin does");

  await writeFile(join(app.runtime.workspace, "..", "data", "plugins", "tidy.mjs"), code + "// changed by hand\n");

  assert.equal((await api("plugin-catalog")).plugins[0].unchanged, false, "a file changed afterwards is noticed");

});



test("a plugin handed over as one file is opened, shown and copied in just the same", async (t) => {

  const { zipWrite } = await import("../dist/skill-package.js");

  const { app, api, root } = await served(t);

  const code = "export default { id: 'boxed', name: 'Boxed', permissions: [], tools: [] };\n";

  const file = join(root, "boxed.zip");

  await writeFile(file, zipWrite([

    ["branch-plugin.json", JSON.stringify({ id: "boxed", name: "Boxed", description: "Came in one file.", permissions: [] })],

    ["boxed.mjs", code],

  ]));

  const offer = await api("plugin-catalog/inspect", { source: file });

  assert.equal(offer.manifest.name, "Boxed");

  const installed = await api("plugin-catalog/install", { source: file, sha256: offer.sha256 });

  assert.equal(installed.id, "boxed");

  assert.ok((await app.plugins.list()).some((entry) => entry.id === "boxed"), "the file is now one of the plugins on offer");

});



test("a plugin whose manifest disagrees with its code, or that is not a plugin at all, is refused", async (t) => {

  const { api, root } = await served(t);

  const folder = join(root, "wrong");

  await mkdir(folder, { recursive: true });

  await writeFile(join(folder, "odd.mjs"), "export default { id: 'odd', name: 'Odd' };\n");

  await writeFile(join(folder, "branch-plugin.json"), JSON.stringify({ id: "odd", name: "Odd", sha256: "a".repeat(64) }));

  await assert.rejects(() => api("plugin-catalog/install", { source: folder }), /does not match the fingerprint/);

  const empty = join(root, "empty");

  await mkdir(empty, { recursive: true });

  await assert.rejects(() => api("plugin-catalog/inspect", { source: empty }), /not a plugin/);

  await assert.rejects(() => api("plugin-catalog/inspect", { source: "relative/path" }), /in full/);

});

