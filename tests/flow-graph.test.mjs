/**
 * Wave 9: flows that really run as a graph. Boxes declare what they read and write, the picture is
 * checked before anything happens, arrows are chosen from what the last box found, circles are gone
 * round only as often as the owner allowed, a box can be another whole flow, the state is written
 * down after every box so a stopped flow carries on rather than starting again, every box reports
 * itself down the run socket, and a saved flow is a tool the assistant can call by name.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { discardTemp } from "./temp-dir.mjs";
import { z } from "zod";
import { createBranch, compileGraph, FlowGraphError, maximumGraphDepth } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** A provider whose every answer is scripted, so a flow's shape is what is under test. */
function scripted(answers) {
  let at = 0;
  return { name: "scripted", async complete() {
    const content = answers[Math.min(at++, answers.length - 1)];
    if (content instanceof Promise) return content;
    return { content, toolCalls: [] };
  } };
}
async function fixture(t, answers = ["ok"]) {
  const root = await mkdtemp(join(tmpdir(), "branch-flow-graph-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    provider: scripted(answers) });
  app.coding.setMode("read-first", "off"); // read-first ships on (Q250); these tests are about the flow graph, not reading first
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
/** A tool a box can use whose answer is entirely predictable. */
function shouter(app, name = "tests.shout") {
  app.registry.register({ name, permission: "workflows.read",
    description: "Says one item back in capitals. Only the tests use it.",
    parameters: z.object({ item: z.unknown().optional() }).passthrough(),
    execute: async (value) => ({ said: String(value.item ?? "").toUpperCase() }) });
}
const settle = async (app, runId) => app.flows.settled(runId);

/* ---------- 1. the check before anything runs ---------- */

const twoBoxes = {
  name: "Two boxes", input: { topic: "text" }, state: { first: "text", second: "text" },
  entry: "a",
  nodes: [
    { id: "a", name: "Ask once", kind: "prompt", prompt: "Something about {topic}", input: { topic: "text" }, output: { first: "text" } },
    { id: "b", name: "Ask again", kind: "prompt", prompt: "More on {first}", input: { first: "text" }, output: { second: "text" } },
  ],
  edges: [{ from: "a", to: "b" }],
};
const refusal = (graph) => {
  try { compileGraph(graph); return null; } catch (error) {
    assert.ok(error instanceof FlowGraphError, `expected a plain refusal, got ${error}`);
    return error.problems.join(" ");
  }
};

test("G1 a good picture compiles, and each bad one is refused with the box named", () => {
  assert.ok(compileGraph(twoBoxes).nodes.has("a"), "a picture that is fine was refused");

  const mismatch = structuredClone(twoBoxes);
  mismatch.nodes[1].output = { first: "number" };
  const said = refusal(mismatch);
  assert.match(said, /Ask again/, `the box was not named: ${said}`);
  assert.match(said, /number/);
  assert.match(said, /text/);

  const stranded = structuredClone(twoBoxes);
  stranded.nodes.push({ id: "c", name: "Tidy up", kind: "prompt", prompt: "tidy", output: {} });
  const orphan = refusal(stranded);
  assert.match(orphan, /"Tidy up" can never be reached/);

  const circle = structuredClone(twoBoxes);
  circle.edges.push({ from: "b", to: "a" });
  const endless = refusal(circle);
  assert.match(endless, /"Ask once", "Ask again"/, `both boxes should be named: ${endless}`);
  assert.match(endless, /never end/);

  const unset = structuredClone(twoBoxes);
  unset.nodes[0].input = { second: "text" };
  assert.match(refusal(unset), /"Ask once" needs "second"/);

  const nowhere = structuredClone(twoBoxes);
  nowhere.entry = "z";
  assert.match(refusal(nowhere), /starts at "z"/);
});

test("G1 a circle with a way out is still refused unless an arrow in it is marked as a loop", () => {
  const graph = structuredClone(twoBoxes);
  graph.nodes.push({ id: "c", name: "Check", kind: "condition", field: "second", contains: "stop", input: { second: "text" }, output: {} });
  graph.nodes.push({ id: "d", name: "Finish", kind: "prompt", prompt: "done", output: {} });
  graph.edges.push({ from: "b", to: "c" }, { from: "c", to: "d", when: "matched" }, { from: "c", to: "a", when: "otherwise" });
  assert.match(refusal(graph), /no arrow in it is marked as a loop/);
  graph.edges.at(-1).loop = true;
  assert.equal(refusal(graph), null, "a loop with a bound should be allowed");
});

/* ---------- 2. branching ---------- */

const branching = (id) => ({
  id, name: "Branching", input: { question: "text" }, state: { answer: "text", taken: "text" },
  entry: "ask",
  nodes: [
    { id: "ask", name: "Ask", kind: "prompt", prompt: "{question}", input: { question: "text" }, output: { answer: "text" } },
    { id: "check", name: "Check", kind: "condition", field: "answer", contains: "yes", input: { answer: "text" }, output: {} },
    { id: "yes", name: "Went yes", kind: "prompt", prompt: "yes road", output: { taken: "text" } },
    { id: "no", name: "Went no", kind: "prompt", prompt: "no road", output: { taken: "text" } },
  ],
  edges: [{ from: "ask", to: "check" }, { from: "check", to: "yes", when: "matched" },
    { from: "check", to: "no", when: "otherwise" }],
});

test("G2 a condition picks each of its two ways out", async (t) => {
  for (const [answer, expected] of [["yes please", "Went yes"], ["not today", "Went no"]]) {
    const { app } = await fixture(t, [answer, "road taken"]);
    const saved = app.flows.saveGraph(branching(undefined));
    const started = app.flows.startGraph(saved.id, { question: "shall we?" });
    const finished = await settle(app, started.runId);
    assert.equal(finished.status, "completed", finished.error ?? "");
    assert.deepEqual(finished.nodes.map((node) => node.name), ["Ask", "Check", expected]);
  }
});

/* ---------- 3. loops ---------- */

test("G3 a loop stops at the bound the owner set, and says so plainly", async (t) => {
  const { app } = await fixture(t, ["still going"]);
  const saved = app.flows.saveGraph({
    name: "Round and round", loopLimit: 3, input: {}, state: { note: "text" }, entry: "work",
    nodes: [
      { id: "work", name: "Work", kind: "prompt", prompt: "carry on", output: { note: "text" } },
      { id: "check", name: "Check", kind: "condition", field: "note", contains: "finished", input: { note: "text" }, output: {} },
      { id: "done", name: "Done", kind: "prompt", prompt: "over", output: {} },
    ],
    edges: [{ from: "work", to: "check" }, { from: "check", to: "done", when: "matched" },
      { from: "check", to: "work", when: "otherwise", loop: true }],
  });
  const finished = await settle(app, app.flows.startGraph(saved.id, {}).runId);
  assert.equal(finished.status, "failed");
  assert.match(finished.error, /3 time\(s\)/, finished.error ?? "");
  assert.match(finished.error, /limit set on this flow/);
  assert.equal(finished.nodes.filter((node) => node.nodeId === "work").length, 4,
    "the box before the loop should have run once more than the bound");
});

/* ---------- 4. map and gather ---------- */

test("G4 a map works through a list and a gather joins the answers back together", async (t) => {
  const { app } = await fixture(t);
  shouter(app);
  const saved = app.flows.saveGraph({
    name: "Shout them all", input: { items: "list of text" },
    state: { collected: "list of text", joined: "text" }, entry: "each",
    nodes: [
      { id: "each", name: "Each item", kind: "map", tool: "tests.shout", overField: "items",
        intoField: "collected", input: { items: "list of text" }, output: { collected: "list of text" } },
      { id: "join", name: "Put together", kind: "gather", overField: "collected", intoField: "joined",
        input: { collected: "list of text" }, output: { joined: "text" } },
    ],
    edges: [{ from: "each", to: "join" }],
  });
  const finished = await settle(app, app.flows.startGraph(saved.id, { items: ["one", "two", "three"] }).runId);
  assert.equal(finished.status, "completed", finished.error ?? "");
  assert.equal(finished.state.collected.length, 3);
  assert.match(finished.state.collected[0], /ONE/);
  assert.match(finished.state.joined, /ONE[\s\S]*TWO[\s\S]*THREE/, "the list was not gathered in order");
});

/* ---------- 5. sub-graphs ---------- */

const echoFlow = (name, inner) => ({
  name, input: { word: "text" }, state: { said: "text" }, entry: "one",
  nodes: inner
    ? [{ id: "one", name: `Into ${name}`, kind: "subflow", flowId: inner, input: { word: "text" }, output: { said: "text" } }]
    : [{ id: "one", name: "Say it", kind: "prompt", prompt: "{word}", input: { word: "text" }, output: { said: "text" } }],
  edges: [],
});

test("G5 a box whose body is another flow runs with a state of its own", async (t) => {
  const { app } = await fixture(t, ["a parent note", "deep answer"]);
  const leaf = app.flows.saveGraph(echoFlow("Leaf", null));
  const outer = app.flows.saveGraph({
    name: "Outer", input: { word: "text" }, state: { parentNote: "text", said: "text" }, entry: "note",
    nodes: [
      { id: "note", name: "Note to self", kind: "prompt", prompt: "note it", output: { parentNote: "text" } },
      { id: "one", name: "Into Leaf", kind: "subflow", flowId: leaf.id, input: { word: "text" }, output: { said: "text" } },
    ],
    edges: [{ from: "note", to: "one" }],
  });
  const started = app.flows.startGraph(outer.id, { word: "hello" });
  const finished = await settle(app, started.runId);
  assert.equal(finished.status, "completed", finished.error ?? "");
  assert.equal(finished.state.said, "deep answer", "the inner flow's answer never came back out");
  assert.equal(finished.state.parentNote, "a parent note");

  /* The inner flow ran as its own task, with a state of its own: only the values its box declared
     went in, and nothing the outer flow was keeping leaked into it. */
  const rows = app.store.sqlite.prepare("SELECT run_id, flow_id, state FROM flow_graph_runs ORDER BY updated_at").all();
  assert.equal(rows.length, 2, "the flow inside it did not get a run of its own");
  const innerRow = rows.find((row) => String(row.run_id) !== started.runId);
  assert.equal(String(innerRow.flow_id), leaf.id);
  const innerState = JSON.parse(String(innerRow.state));
  assert.equal(innerState.parentNote, undefined, "the outer flow's state leaked into the one inside it");
  assert.equal(innerState.word, "hello", "the inner flow was not given the value its box declared");
  assert.equal(innerState.said, "deep answer");
  assert.deepEqual(app.flows.graphs.unfinished(), [], "the inner flow was left unfinished");
});

test("G5 flows may not go deeper than the cap, nor lead back round to one already running", async (t) => {
  const { app } = await fixture(t, ["deep answer"]);
  const leaf = app.flows.saveGraph(echoFlow("Leaf", null));
  let below = leaf.id;
  for (const name of ["Level two", "Level three", "Level four"]) below = app.flows.saveGraph(echoFlow(name, below)).id;
  const tooDeep = await settle(app, app.flows.startGraph(below, { word: "hi" }).runId);
  assert.equal(tooDeep.status, "failed");
  assert.match(tooDeep.error, new RegExp(`only go ${maximumGraphDepth} deep`), tooDeep.error ?? "");

  /* A flow that reaches back to itself is refused by name rather than going round for ever. */
  const circular = app.flows.saveGraph(echoFlow("Itself", leaf.id));
  app.flows.saveGraph({ ...echoFlow("Itself", circular.id), id: circular.id });
  const round = await settle(app, app.flows.startGraph(circular.id, { word: "hi" }).runId);
  assert.equal(round.status, "failed");
  assert.match(round.error, /leads back to one already running/, round.error ?? "");
});

/* ---------- 6. checkpoint and resume ---------- */

/** A tool that fails until it is told to stop failing, so a run can be stopped in the middle. */
function flaky(app) {
  const state = { failing: true };
  app.registry.register({ name: "tests.flaky", permission: "workflows.read",
    description: "Fails until the test says otherwise. Only the tests use it.",
    parameters: z.object({}).passthrough(),
    execute: async () => { if (state.failing) throw new Error("not yet"); return { note: "worked" }; } });
  return state;
}
const threeBoxes = {
  name: "Three boxes", input: {}, state: { first: "text", note: "text", last: "text" }, entry: "a",
  nodes: [
    { id: "a", name: "First", kind: "prompt", prompt: "one", output: { first: "text" } },
    { id: "b", name: "Middle", kind: "tool", tool: "tests.flaky", input: { first: "text" }, output: { note: "text" } },
    { id: "c", name: "Last", kind: "prompt", prompt: "three", input: { note: "text" }, output: { last: "text" } },
  ],
  edges: [{ from: "a", to: "b" }, { from: "b", to: "c" }],
};

/** The one saved graph flow in a fixture. */
const graphId = (app) => app.flows.list().find((flow) => flow.kind === "graph")?.id ?? app.flows.list()[0].id;

test("G6 a flow stopped in the middle carries on from the box after the last one that finished", async (t) => {
  const { app } = await fixture(t, ["first answer", "last answer"]);
  const broken = flaky(app);
  const saved = app.flows.saveGraph(threeBoxes);
  const stopped = await settle(app, app.flows.startGraph(saved.id, {}).runId);
  assert.equal(stopped.status, "failed");
  assert.match(stopped.error, /"Middle"/, stopped.error ?? "");
  assert.equal(stopped.state.first, "first answer", "the state after the first box was not written down");
  assert.equal(app.flows.graphs.checkpoint(stopped.runId).nextNode, "b",
    "the checkpoint does not point at the box that failed");

  broken.failing = false;
  /* Carrying on is reached through the tool that already carries any saved thing on, so the
     schedules toolbox does not grow a second tool that says the same thing. */
  const carried = await app.runtime.executeTool("workflows.resume", { id: saved.id });
  assert.equal(carried.runId, stopped.runId, "carrying on started a different run");
  assert.equal(carried.flowId, saved.id);
  const finished = await settle(app, carried.runId);
  assert.equal(finished.status, "completed", finished.error ?? "");
  assert.equal(finished.state.first, "first answer", "the state changed while it was stopped");
  assert.equal(finished.state.last, "last answer");
  assert.equal(finished.nodes.filter((node) => node.nodeId === "a").length, 1,
    "the first box ran a second time instead of being carried on from");
});

/**
 * The app really is closed in the middle: a second process starts the flow, gets through the first
 * box, and is killed outright while the second box is still working — which is what a power cut or
 * a closed window leaves behind. The next launch is then expected to pick it up.
 */
const restartScript = (paths, graph) => [
  'const { createBranch } = await import(' + JSON.stringify(pathToFileURL(join(process.cwd(), "dist", "index.js")).href) + ');',
  'let asked = 0;',
  'const app = await createBranch({ workspace: ' + JSON.stringify(paths.workspace) + ',',
  '  dataDir: ' + JSON.stringify(paths.dataDir) + ',',
  '  provider: { name: "scripted", async complete() {',
  '    asked += 1;',
  '    if (asked === 1) return { content: "first answer", toolCalls: [] };',
  '    return new Promise(() => {});',
  '  } } });',
  'const saved = app.flows.saveGraph(' + JSON.stringify(graph) + ');',
  'const started = app.flows.startGraph(saved.id, {});',
  'console.log("RUN " + started.runId);',
  'setInterval(() => {',
  '  if (app.flows.graphs.checkpoint(started.runId).nextNode === "b") console.log("AT-B");',
  '}, 50);',
].join("\n");

test("G6 a flow interrupted by the app closing is carried on by the next start", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-flow-restart-"));
  const paths = { workspace: join(root, "workspace"), dataDir: join(root, "data") };
  let opened = null;
  t.after(async () => {
    await opened?.close();
    await discardTemp(root);
  });
  const graph = { ...threeBoxes, nodes: threeBoxes.nodes.map((node) =>
    (node.id === "b" ? { id: "b", name: "Middle", kind: "prompt", prompt: "two",
      input: { first: "text" }, output: { note: "text" } } : node)) };

  const child = spawn(process.execPath, ["--input-type=module", "-e", restartScript(paths, graph)],
    { stdio: ["ignore", "pipe", "pipe"] });
  const runId = await new Promise((done, failed) => {
    let seen = "", id = "";
    const stop = setTimeout(() => failed(new Error(`the first launch never got to the second box: ${seen}`)), 60000);
    child.stdout.on("data", (chunk) => {
      seen += String(chunk);
      id ||= (/RUN ([0-9a-f-]{36})/.exec(seen) ?? [])[1] ?? "";
      if (id && seen.includes("AT-B")) { clearTimeout(stop); child.kill("SIGKILL"); done(id); }
    });
    child.on("exit", () => { clearTimeout(stop); if (!id) failed(new Error(`the first launch stopped early: ${seen}`)); });
  });
  await new Promise((done) => child.on("exit", done));

  /* The next launch picks it up at the box after the last one that finished, with the same state. */
  const second = await createBranch({ ...paths, provider: scripted(["second answer", "third answer"]) });
  opened = second;
  let view = second.flows.graphs.view(runId);
  for (let waited = 0; waited < 300 && view.status !== "completed" && view.status !== "failed"; waited++) {
    await new Promise((done) => setTimeout(done, 20));
    view = second.flows.graphs.view(runId);
  }
  // The middle box was still running when the app was killed, so whether its work happened is not
  // knowable from here. It is not guessed at: the flow stops and asks, naming the box.
  assert.equal(view.status, "waiting_approval", view.error ?? "");
  assert.match(view.question ?? "", /"Middle" was still running when Branch stopped/);
  assert.match(view.question ?? "", /do it again or to carry on past it/);
  assert.equal(view.state.first, "first answer", "the state from before the restart was lost");
  assert.equal(view.nodes.filter((node) => node.nodeId === "a" && node.status === "done").length, 1,
    "the first box was done again after the restart rather than carried on from");
  assert.equal(view.state.note, undefined, "the interrupted box was done again without being asked about");

  /* Saying "do it again" carries on through that box. */
  await second.flows.run(graphId(second), { resume: true, interrupted: "again" });
  view = await settle(second, runId);
  assert.equal(view.status, "completed", view.error ?? "");
  assert.equal(view.state.note, "second answer", "answering did not carry the flow on");
});

test("G6 saying the interrupted box already happened carries on past it instead of repeating it", async (t) => {
  const { app } = await fixture(t, ["first answer", "second answer", "third answer", "spare"]);
  const definition = { ...threeBoxes, nodes: threeBoxes.nodes.map((node) =>
    (node.id === "b" ? { id: "b", name: "Middle", kind: "prompt", prompt: "two",
      input: { first: "text" }, output: { note: "text" } } : node)) };
  const saved = app.flows.save(definition);
  const started = await app.flows.run(saved.id, { input: {} });
  await app.flows.settled(started.runId);

  // Put the run back the way a kill in the middle of box b leaves it: b's row says running, nothing
  // later exists, and the checkpoint still points at b.
  const top = app.store.sqlite.prepare(
    "SELECT seq FROM flow_graph_nodes WHERE run_id=? AND node_id='b' ORDER BY seq DESC LIMIT 1").get(started.runId);
  app.store.sqlite.prepare("DELETE FROM flow_graph_nodes WHERE run_id=? AND seq>?").run(started.runId, top.seq);
  app.store.sqlite.prepare("UPDATE flow_graph_nodes SET status='running' WHERE run_id=? AND seq=?")
    .run(started.runId, top.seq);
  app.store.sqlite.prepare("UPDATE flow_graph_runs SET status='running', next_node='b' WHERE run_id=?")
    .run(started.runId);

  const asked = await app.flows.graphs.resume(started.runId, definition, { source: "owner" });
  assert.equal(asked.status, "waiting_approval", "the interrupted box was repeated rather than asked about");
  assert.match(asked.question ?? "", /"Middle" was still running/);

  const after = await app.flows.graphs.resume(started.runId, definition, { source: "owner", interrupted: "past" });
  const box = after.nodes.filter((node) => node.nodeId === "b");
  assert.equal(box.length, 1, "the box the owner said had already happened was started a second time");
  assert.equal(box[0].status, "skipped", "the box was not written off as already done");
  assert.ok(after.nodes.some((node) => node.nodeId === "c"), "the flow never reached the box after it");
});

test("G7 every box reports itself down the run socket, in order", async (t) => {
  const { app, root } = await fixture(t, ["one", "two"]);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); });
  const saved = app.flows.saveGraph(twoBoxes);
  const start = await fetch(`${server.url}/api/flows/${saved.id}/run`, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ topic: "kettles" }) });
  const { runId } = await start.json();
  assert.ok(runId, "starting a graph flow did not hand back a task to watch");

  const heard = [];
  await new Promise((done, failed) => {
    const socket = new WebSocket(`${server.url.replace(/^http/, "ws")}/api/runs/${runId}/ws`, ["bearer", server.token]);
    socket.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data);
      if (payload.kind === "end") { socket.close(); done(); return; }
      if (String(payload.kind).startsWith("flow.node")) heard.push(`${payload.kind}:${payload.data.node}`);
    });
    socket.addEventListener("error", failed);
    setTimeout(() => { try { socket.close(); } catch { /* gone */ } done(); }, 15000);
  });
  await settle(app, runId);
  assert.deepEqual(heard, ["flow.node.started:a", "flow.node.finished:a",
    "flow.node.started:b", "flow.node.finished:b"], `heard ${JSON.stringify(heard)}`);
});

/* ---------- 8. a flow as a tool ---------- */

test("G8 a saved flow is a tool, and it holds its arguments to the shape it declared", async (t) => {
  const { app } = await fixture(t, ["a fine answer"]);
  const saved = app.flows.saveGraph({ ...twoBoxes, name: "Daily tidy" });
  assert.ok(app.registry.names().includes("flows.daily-tidy"),
    `the saved flow is not a tool: ${app.registry.names().filter((n) => n.startsWith("flows.")).join(", ")}`);
  assert.equal(app.registry.groupOf("flows.daily-tidy"), "schedules", "the flow tool is in no toolbox");

  await assert.rejects(() => app.runtime.executeTool("flows.daily-tidy", { topic: 42 }),
    /expected string|Invalid input|received number/i, "a wrong kind of argument was let through");
  await assert.rejects(() => app.runtime.executeTool("flows.daily-tidy", {}),
    /required|Invalid input/i, "a missing argument was let through");

  const finished = await app.runtime.executeTool("flows.daily-tidy", { topic: "the kitchen" });
  assert.equal(finished.status, "completed", finished.error ?? "");
  assert.equal(finished.flowId, saved.id);
  assert.equal(finished.state.topic, "the kitchen", "the argument never reached the flow's state");
  assert.equal(finished.state.first, "a fine answer", "the flow did not actually run its boxes");

  app.flows.remove(saved.id);
  assert.ok(!app.registry.names().includes("flows.daily-tidy"), "the tool stayed after the flow was removed");
});

/* ---------- 9. the hook that fires when a patch is applied ---------- */

test("G9 applying a patch is its own event, so a hook can fire on it", async (t) => {
  const { app } = await fixture(t);
  const { hookEvents } = await import("../dist/hooks.js");
  assert.ok(hookEvents.includes("patch.applied"), "there is no event for a patch going in");
  await app.files.write("note.txt", "one\n", AbortSignal.timeout(5000));
  const patch = ["--- a/note.txt", "+++ b/note.txt", "@@ -1,1 +1,1 @@", "-one", "+two", ""].join("\n");
  const result = await app.runtime.executeTool("code.patch", { patch });
  assert.equal(result.files.length, 1);
  const runs = app.store.recentEvents(app.runtime.owner, 50).filter((event) => event.kind === "patch.applied");
  assert.equal(runs.length, 1, "no event was written when the patch went in");
  assert.equal(runs[0].data.files, 1);
  assert.deepEqual(runs[0].data.paths, ["note.txt"]);
});
