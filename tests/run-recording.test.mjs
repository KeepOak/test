/**
 * Public list, bucket 13: seeing what a task did, step by step, afterwards. The recording and its
 * page, the path picture, the run monitor (boxes, exchanges and words used), saving a recording as a
 * workflow, the bound on pictures a task keeps in view, and the event-loop watch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { buildRecording, isRecording, recordingSettings } from "../dist/run-recording.js";
import { pathPicture, recordingPage } from "../dist/run-recording-page.js";
import { runMonitor } from "../dist/run-monitor.js";
import { boundPictures, droppedPictureWords, markTaken, takenPictureWords } from "../dist/visual-window.js";
import { EventLoopWatch, judge } from "../dist/event-loop-watch.js";

const hostile = "</script><script>alert(1)</script> hunter2";

function writesAFile(name) {
  let round = 0;
  return {
    name: "scripted",
    async complete() {
      round += 1;
      return round === 1
        ? { content: "", toolCalls: [{ id: "c1", name: "files.write", arguments: JSON.stringify({ path: name, content: "one" }) }] }
        : { content: "done", toolCalls: [] };
    },
  };
}

async function served(t, provider) {
  const scratch = join(tmpdir(), "branch-bucket13");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "rec-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), ...(provider ? { provider } : {}) });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (method, path, body) => {
    const response = await fetch(server.url + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* a page */ }
    return { status: response.status, body: json, text, headers: response.headers };
  };
  return { app, call, server, root };
}

async function asKey(server, token, method, path, body) {
  const response = await fetch(server.url + path, {
    method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test("recordings ship off, and every task route refuses in plain words until switched on", async (t) => {
  const { app, call } = await served(t, writesAFile("a.txt"));
  const run = (await call("POST", "/api/run", { prompt: "write it" })).body;
  assert.equal(recordingSettings(app.store, app.runtime.owner).mode, "off");
  const listed = (await call("GET", "/api/recordings")).body;
  assert.deepEqual(listed.tasks, [], "nothing is listed while off");
  for (const part of ["recording", "recording/page", "recording/path", "recording/flow", "monitor"]) {
    const answer = await call("GET", `/api/runs/${run.id}/${part}`);
    assert.equal(answer.status, 403, part);
    assert.match(answer.body.error, /switched off/);
  }
  assert.equal((await call("GET", "/api/runs/00000000-0000-4000-8000-000000000000/recording")).status, 404);
});

test("a finished task plays back as frames: asked, thought, acted, thought, finished, with secrets taken out", async (t) => {
  const { app, call } = await served(t, writesAFile("notes.txt"));
  app.runtime.hideSecrets = (value) => JSON.parse(JSON.stringify(value).replaceAll("hunter2", "[hidden]"));
  const run = (await call("POST", "/api/run", { prompt: hostile })).body;
  assert.equal(run.status, "completed");
  const saved = (await call("POST", "/api/recordings", { mode: "when-needed" })).body;
  assert.equal(saved.settings.mode, "when-needed");
  assert.ok(saved.tasks.some((task) => task.id === run.id), "the task is offered to pick");
  const recording = (await call("GET", `/api/runs/${run.id}/recording`)).body;
  assert.ok(isRecording(recording));
  assert.deepEqual(recording.frames.map((frame) => frame.kind), ["asked", "model", "tool", "model", "ended"]);
  const tool = recording.frames[2];
  assert.equal(tool.status, "done");
  assert.equal(typeof tool.seconds, "number", "a finished action knows how long it took");
  assert.match(tool.label, /notes\.txt/);
  assert.equal(recording.counts.actions, 1);
  assert.equal(recording.counts.rounds, 2);
  assert.ok(recording.frames.every((frame, i) => i === 0 || frame.at >= 0), "every frame has a time from the start");
  assert.ok(!JSON.stringify(recording).includes("hunter2"), "the secret never leaves");
  assert.ok(recording.frames[1].tokens, "a round carries the words it used");
});

test("the path picture and the saved page use tokens only, escape everything, and can reach nothing", async (t) => {
  const { app, call } = await served(t, writesAFile("page.txt"));
  app.runtime.hideSecrets = (value) => JSON.parse(JSON.stringify(value).replaceAll("hunter2", "[hidden]"));
  const run = (await call("POST", "/api/run", { prompt: hostile })).body;
  await call("POST", "/api/recordings", { mode: "on" });
  const { svg } = (await call("GET", `/api/runs/${run.id}/recording/path`)).body;
  assert.match(svg, /^<svg[^>]+role="img"/);
  assert.match(svg, /var\(--good\)/);
  assert.doesNotMatch(svg, /#[0-9a-f]{3,8}\b|rgba?\(/i, "no colour is written down");
  assert.doesNotMatch(svg, /<script/i);
  const page = await call("GET", `/api/runs/${run.id}/recording/page`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.headers.get("content-disposition"), /attachment; filename="task-recording-/);
  assert.match(page.text, /Content-Security-Policy" content="default-src 'none'/);
  assert.match(page.text, /--ground:/, "the page carries the tokens");
  assert.equal(page.text.match(/<script/g).length, 2, "only the data block and the player");
  assert.ok(!page.text.includes("alert(1)</script>"), "the task's words cannot close a script");
  assert.ok(!page.text.includes("hunter2"));
  assert.match(page.text, /A task, step by step/, "fixed words come from the language file");
  const exported = app.store.audit.list(app.runtime.owner, { action: "data.exported" });
  assert.ok(exported.some((entry) => entry.subject === "a recording of one task" && entry.runId === run.id), "saving the page is written into the record");
});

test("the recording page escapes a hostile recording even when built directly", () => {
  const recording = {
    format: "branch-agent-recording", formatVersion: 1, runId: "x", prompt: hostile, status: "completed",
    startedAt: new Date(0).toISOString(), seconds: 1, truncated: false,
    counts: { rounds: 0, actions: 1, failed: 0, steps: 0, helpers: 0, pictures: 0 },
    frames: [{ at: 0, kind: "tool", status: "failed", label: "<img src=x onerror=alert(1)>", detail: "</script>", ref: "", seconds: 1 }],
  };
  const html = recordingPage({ recording, tokensCss: ":root{--ground:x}</style><script>bad()</script>", theme: "daylight", t: (key) => key });
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("</style><script>bad"), "a stylesheet cannot close the style block");
  assert.match(html, /data-theme="daylight"/);
  assert.match(html, /<html[^>]* data-palette="forest"/, "a saved page keeps the Forest it always had, not tokens.css's Slate first paint");
  assert.match(pathPicture(recording), /var\(--bad\)/, "a failed step is drawn in the bad colour");
});

test("the monitor follows a flow box by box, counts the words each used, and hands back only what is new", async (t) => {
  const { app, call } = await served(t, writesAFile("m.txt"));
  const owner = app.runtime.owner;
  const child = (await call("POST", "/api/run", { prompt: "the box's own task" })).body;
  const graph = app.store.createRun(owner, "a flow");
  app.store.event(graph.id, "flow.node.started", { node: "a", name: "Gather", kind: "prompt", seq: 1 });
  app.store.event(graph.id, "flow.node.finished", { node: "a", name: "Gather", seq: 1, output: "gathered hunter2", childRunId: child.id });
  app.store.event(graph.id, "flow.node.started", { node: "b", name: "Send", kind: "tool", seq: 2 });
  app.store.event(graph.id, "flow.node.failed", { node: "b", name: "Send", seq: 2, error: "no address" });
  app.store.event(graph.id, "tool.started", { id: "t1", name: "web.fetch" });
  app.store.event(graph.id, "tool.failed", { id: "t1", name: "web.fetch", error: "offline" });
  const scrub = (value) => JSON.parse(JSON.stringify(value).replaceAll("hunter2", "[hidden]"));
  const seen = runMonitor(app.store, graph.id, { scrub });
  assert.deepEqual(seen.vertices.map((box) => [box.name, box.status]), [["Gather", "done"], ["Send", "failed"]]);
  assert.equal(seen.vertices[0].childRunId, child.id);
  assert.ok(seen.vertices[0].tokens.input > 0, "the box's own task's words are counted against the box");
  assert.equal(seen.vertices[0].message, "gathered [hidden]");
  assert.equal(seen.usage.total.input, seen.usage.task.input + seen.usage.boxes.input);
  assert.deepEqual(seen.transactions.map((one) => [one.kind, one.name, one.status]), [["tool", "web.fetch", "failed"]]);
  assert.deepEqual(runMonitor(app.store, graph.id, { after: seen.lastEventId }).transactions, [], "nothing is repeated");
  await call("POST", "/api/recordings", { mode: "on" });
  const over = (await call("GET", `/api/runs/${child.id}/monitor?after=0`)).body;
  assert.ok(over.transactions.some((one) => one.kind === "model" && one.tokens), "model exchanges carry their words");
});

test("a recorded task becomes a workflow that repeats its actions with the same settings", async (t) => {
  const { app, call } = await served(t, writesAFile("again.txt"));
  const run = (await call("POST", "/api/run", { prompt: "write it once" })).body;
  await call("POST", "/api/recordings", { mode: "when-needed" });
  const draft = (await call("GET", `/api/runs/${run.id}/recording/flow`)).body;
  assert.deepEqual(draft.definition.steps.map((step) => [step.kind, step.tool, step.args]),
    [["tool", "files.write", { path: "again.txt", content: "one" }]]);
  const saved = (await call("POST", `/api/runs/${run.id}/recording/flow`, { name: "Write it again" })).body;
  assert.equal(saved.steps, 1);
  const flow = app.workflows.list(app.runtime.owner).find((one) => one.id === saved.workflow.id);
  assert.equal(flow.name, "Write it again");
  assert.equal(flow.status, "idle", "saving never runs it");
  const empty = app.store.createRun(app.runtime.owner, "did nothing");
  assert.equal((await call("GET", `/api/runs/${empty.id}/recording/flow`)).status, 400);
});

test("only the newest few of a task's own pictures stay in view; the owner's own are never touched", () => {
  const picture = () => ({ role: "user", content: takenPictureWords, images: [{ mediaType: "image/png", data: "AA==" }] });
  const owners = { role: "user", content: "look at this", images: [{ mediaType: "image/png", data: "AA==" }] };
  const messages = [owners, picture(), picture(), picture(), picture(), picture()];
  const added = new Set(messages.filter((one) => one.content === takenPictureWords));
  assert.equal(boundPictures(messages, 3, added), 2);
  assert.equal(messages.filter((one) => one.images).length, 4, "three of the task's and the owner's one");
  assert.ok(owners.images, "the owner's picture stays");
  assert.equal(messages[1].content, droppedPictureWords);
  assert.equal(boundPictures(messages, 3, new Set(messages.filter((one) => one.content === takenPictureWords))), 0, "a second pass changes nothing");
});

test("the event-loop verdict reads fine, slow and stuck at the right edges", () => {
  assert.equal(judge(10, 0.2, 250).verdict, "fine");
  assert.equal(judge(250, 0.2, 250).verdict, "slow");
  assert.equal(judge(10, 0.95, 250).verdict, "slow");
  assert.equal(judge(1000, 0.1, 250).verdict, "stuck");
  assert.match(judge(1000, 0.1, 250).words, /1000 ms/);
});

function fakeTools(delays) {
  let now = 0, enabled = 0;
  const histogram = {
    enable() { enabled += 1; }, disable() { enabled -= 1; }, reset() { delays.shift(); },
    get mean() { return (delays[0] ?? 0) * 1e6; }, get max() { return (delays[0] ?? 0) * 1e6; },
    percentile() { return (delays[0] ?? 0) * 1e6; },
  };
  return {
    tools: {
      histogram: () => histogram,
      utilization: () => ({ idle: 0, active: 0, utilization: 0.5 }),
      now: () => now,
      wait: async (ms) => { now += ms; },
    },
    enabled: () => enabled,
  };
}

test("the event-loop watch: off refuses, when needed measures once and stops, on keeps watching and counts stalls", async () => {
  const fake = fakeTools([40, 400, 400]);
  const watch = new EventLoopWatch(fake.tools);
  await assert.rejects(watch.reading({ mode: "off", stallMs: 250 }), /switched off/);
  const once = await watch.reading({ mode: "when-needed", stallMs: 250 }, 1000);
  assert.equal(once.verdict, "fine");
  assert.equal(once.sampledSeconds, 1);
  assert.equal(fake.enabled(), 0, "nothing keeps measuring after a one-off reading");
  watch.follow({ mode: "on", stallMs: 250 });
  assert.equal(fake.enabled(), 1);
  watch.countStall(250);
  const on = await watch.reading({ mode: "on", stallMs: 250 });
  assert.equal(on.verdict, "slow");
  assert.ok(on.stalls >= 1);
  assert.equal(on.busy, 0.5);
  watch.follow({ mode: "off", stallMs: 250 });
  assert.equal(fake.enabled(), 0, "switching off stops the watch");
});

test("the event-loop route: off gives no reading, when needed reads only when asked", async (t) => {
  const { call } = await served(t);
  assert.equal((await call("GET", "/api/event-loop")).body.reading, null);
  assert.equal((await call("GET", "/api/event-loop?read=1")).status, 403);
  const saved = (await call("POST", "/api/event-loop", { mode: "when-needed" })).body;
  assert.equal(saved.settings.mode, "when-needed");
  assert.equal(saved.reading, null, "saving does not measure");
  const read = (await call("GET", "/api/event-loop?read=1")).body.reading;
  assert.ok(["fine", "slow", "stuck"].includes(read.verdict));
  assert.equal(typeof read.delay.p99, "number");
  assert.equal((await call("POST", "/api/event-loop", { mode: "off" })).body.settings.mode, "off");
});

test("a recording of a task with more steps than it keeps says so and still ends with how it finished", async (t) => {
  const { app } = await served(t);
  const run = app.store.createRun(app.runtime.owner, "many");
  for (let i = 0; i < 30; i += 1) {
    app.store.event(run.id, "tool.started", { id: `c${i}`, name: "files.read", label: `Reading ${i}` });
    app.store.event(run.id, "tool.completed", { id: `c${i}`, name: "files.read", result: "x" });
  }
  app.store.finish(run.id, "completed", "ok");
  app.store.event(run.id, "run.finished", { status: "completed", output: "ok" });
  const recording = buildRecording(app.store, run.id, { maxFrames: 10 });
  assert.equal(recording.truncated, true);
  assert.equal(recording.frames.length, 10);
  assert.equal(recording.frames.at(-1).kind, "ended");
  assert.equal(recording.counts.actions, 30, "the counts are of the whole task");
});

/** The first line a run socket answers with, for a given Sec-WebSocket-Protocol header (or none). */
async function socketAnswer(url, runId, protocol) {
  const { connect } = await import("node:net");
  const target = new URL(url);
  const socket = connect(Number(target.port), target.hostname);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write([`GET /api/runs/${runId}/ws HTTP/1.1`, `Host: ${target.host}`, "Upgrade: websocket", "Connection: Upgrade",
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13",
    ...(protocol === null ? [] : [`Sec-WebSocket-Protocol: ${protocol}`]), "", ""].join("\r\n"));
  const head = await new Promise((resolve) => {
    let text = "";
    socket.on("data", (chunk) => { text += chunk.toString("utf8"); if (text.includes("\r\n")) resolve(text.split("\r\n")[0]); });
    socket.on("close", () => resolve(text.split("\r\n")[0]));
  });
  socket.destroy();
  return head;
}

test("A1637 the live run socket refuses a missing or wrong key, and a task that is not there", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-bucket13-ws-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: writesAFile("ws.txt") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "write it" });
  assert.equal(await socketAnswer(server.url, run.id, null), "HTTP/1.1 401 Unauthorized");
  assert.equal(await socketAnswer(server.url, run.id, "bearer, wrong"), "HTTP/1.1 401 Unauthorized");
  assert.equal(await socketAnswer(server.url, run.id, server.token), "HTTP/1.1 401 Unauthorized", "the key must be offered as bearer");
  assert.equal(await socketAnswer(server.url, "00000000-0000-4000-8000-000000000000", `bearer, ${server.token}`), "HTTP/1.1 401 Unauthorized");
  assert.equal(await socketAnswer(server.url, run.id, `bearer, ${server.token}`), "HTTP/1.1 101 Switching Protocols");
});

test("integration: another household profile cannot see or play the owner's task, nor switch the app's own watch", async (t) => {
  const { app, call } = await served(t, writesAFile("mine.txt"));
  const run = (await call("POST", "/api/run", { prompt: "the owner's task" })).body;
  await call("POST", "/api/recordings", { mode: "on" });
  const sam = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: sam.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  await call("POST", "/api/recordings", { mode: "on" });
  // Q261: reading fails closed for a household person at the window. The recordings list is not in householdReads,
  // so it is refused; a task's recording is, and finds only Sam's own (404 for the owner's), the rest are refused.
  const listed = await call("GET", "/api/recordings");
  assert.equal(listed.status, 400, "the owner's recordings list is not Sam's to read");
  assert.doesNotMatch(listed.text, /the owner's task/);
  for (const part of ["recording", "recording/page", "recording/path", "recording/flow", "monitor"]) {
    const answer = await call("GET", `/api/runs/${run.id}/${part}`);
    assert.equal(answer.status, part === "recording" ? 404 : 400, part);
    assert.doesNotMatch(answer.text, /the owner's task/);
  }
  assert.equal((await call("POST", "/api/event-loop", { mode: "on" })).status, 400, "the app-wide watch is the owner's switch"); // profile-audit: refused at one place in src/server.ts, as requireOwner answers
});

test("integration: a short-lived key cannot change the recording or watch switches; a read key cannot make a workflow", async (t) => {
  const { app, call, server } = await served(t, writesAFile("keyed.txt"));
  const run = (await call("POST", "/api/run", { prompt: "keyed" })).body;
  await call("POST", "/api/recordings", { mode: "on" });
  const owner = app.runtime.owner;
  const runKey = app.sessionTokens.create(owner, { scope: "run", minutes: 5 }).token;
  const readKey = app.sessionTokens.create(owner, { scope: "read", minutes: 5 }).token;
  assert.equal((await asKey(server, runKey, "POST", "/api/recordings", { mode: "off", pictures: true })).status, 401);
  assert.equal((await asKey(server, runKey, "POST", "/api/event-loop", { mode: "on" })).status, 401);
  assert.equal(recordingSettings(app.store, owner).pictures, false, "nothing changed");
  assert.equal((await asKey(server, readKey, "POST", `/api/runs/${run.id}/recording/flow`, {})).status, 401);
  assert.equal((await asKey(server, readKey, "GET", `/api/runs/${run.id}/recording`)).status, 200, "looking is allowed");
});

test("integration: pictures go into a saved page only when ticked, only the task's own, and never with a path", async (t) => {
  const { app, call } = await served(t, writesAFile("pic.txt"));
  const run = (await call("POST", "/api/run", { prompt: "look" })).body;
  const other = (await call("POST", "/api/run", { prompt: "another" })).body;
  const artifacts = app.runtime.artifacts;
  const mine = await artifacts.write(run.id, "shot.png", "image/png", Buffer.from("MINEPICTURE"));
  const theirs = await artifacts.write(other.id, "theirs.png", "image/png", Buffer.from("OTHERPICTURE"));
  app.store.event(run.id, "image.attached", { path: mine.path, bytes: 11 });
  app.store.event(run.id, "image.attached", { path: theirs.path, bytes: 12 });
  const encoded = (text) => Buffer.from(text).toString("base64");
  await call("POST", "/api/recordings", { mode: "on" });
  const plainPage = (await call("GET", `/api/runs/${run.id}/recording/page`)).text;
  assert.ok(!plainPage.includes(encoded("MINEPICTURE")), "not ticked: no picture");
  assert.ok(plainPage.includes("shot.png"), "the picture is still named");
  const json = (await call("GET", `/api/runs/${run.id}/recording`)).text;
  assert.ok(!json.includes(artifacts.root) && !json.includes(encoded("MINEPICTURE")), "the JSON never carries a path or bytes");
  await call("POST", "/api/recordings", { pictures: true });
  const withPictures = (await call("GET", `/api/runs/${run.id}/recording/page`)).text;
  assert.ok(withPictures.includes(encoded("MINEPICTURE")), "ticked: the task's own picture is carried");
  assert.ok(!withPictures.includes(encoded("OTHERPICTURE")), "another task's picture is never read");
  assert.ok(!withPictures.includes(artifacts.root), "no folder on this computer is written into the page");
});

test("integration: secrets in an action's settings and hostile words are taken out of playback, the path and the page", async (t) => {
  const { app, call } = await served(t, writesAFile("hunter2-</script><svg onload=alert(1)>.txt"));
  app.runtime.hideSecrets = (value) => JSON.parse(JSON.stringify(value).replaceAll("hunter2", "[hidden]"));
  const run = (await call("POST", "/api/run", { prompt: "[link](javascript:alert(1)) <img src=x onerror=alert(2)>" })).body;
  app.store.event(run.id, "flow.node.started", { node: "n", name: "box hunter2", kind: "tool", seq: 1 });
  app.store.event(run.id, "flow.node.finished", { node: "n", name: "box hunter2", seq: 1, output: "ok" });
  await call("POST", "/api/recordings", { mode: "on" });
  for (const part of ["recording", "recording/path", "recording/page", "monitor"])
    assert.ok(!(await call("GET", `/api/runs/${run.id}/${part}`)).text.includes("hunter2"), part);
  const page = (await call("GET", `/api/runs/${run.id}/recording/page`)).text;
  assert.match(page, /base-uri 'none'; form-action 'none'/);
  assert.doesNotMatch(page, /<svg onload|<img src=x|href=|<a /i, "nothing from the task becomes markup or a link");
  assert.equal(page.match(/<script/g).length, 2);
  const body = page.slice(page.indexOf("</style>")).replaceAll("http://www.w3.org/2000/svg", "");
  assert.doesNotMatch(body, /https?:\/\//, "past the tokens, the page names no address it could reach");
});

test("integration: the saved page and the player's step names follow the window's language", async (t) => {
  const { call } = await served(t, writesAFile("fr.txt"));
  const run = (await call("POST", "/api/run", { prompt: "en français" })).body;
  await call("POST", "/api/recordings", { mode: "on" });
  const recording = (await call("GET", `/api/runs/${run.id}/recording`)).body;
  assert.deepEqual(recording.frames.map((frame) => frame.words?.key ?? null),
    ["recording.frame.asked", "recording.frame.model", null, "recording.frame.model", "recording.frame.finished"]);
  const page = (await call("GET", `/api/runs/${run.id}/recording/page?lang=fr`)).text;
  assert.match(page, /<html lang="fr"/);
  assert.match(page, /Une tâche, étape par étape/);
  assert.match(page, /<li>Demande</);
  assert.match(page, /Réflexion avec /);
  const unknown = (await call("GET", `/api/runs/${run.id}/recording/page?lang=../../x`)).text;
  assert.match(unknown, /<html lang="en"/);
  assert.match(unknown, /A task, step by step/);
});

test("integration: a workflow made from a recording runs nothing on save and still meets Lockdown when run", async (t) => {
  const { app, call, root } = await served(t, writesAFile("replayed.txt"));
  const run = (await call("POST", "/api/run", { prompt: "write it" })).body;
  const written = join(root, "workspace", "replayed.txt");
  const { rm } = await import("node:fs/promises");
  await rm(written, { force: true });
  await call("POST", "/api/recordings", { mode: "on" });
  const saved = (await call("POST", `/api/runs/${run.id}/recording/flow`, {})).body;
  await assert.rejects(access(written), "saving did not write the file again");
  assert.equal((await call("POST", "/api/lockdown", { on: true })).status, 200);
  const after = await app.workflows.run(app.runtime.owner, saved.workflow.id).catch((error) => ({ status: "refused", error }));
  assert.notEqual(after.status, "completed", "Lockdown still stands between the step and the file");
  await assert.rejects(access(written), "the step did not write the file under Lockdown");
});

test("integration: a picture the owner attached is never thinned out, even with the taken-picture sentence", () => {
  const taken = () => markTaken({ role: "user", content: takenPictureWords, images: [{ mediaType: "image/png", data: "AA==" }] });
  const owners = { role: "user", content: takenPictureWords, images: [{ mediaType: "image/png", data: "AA==" }] };
  const messages = [owners, taken(), taken(), taken(), taken()];
  assert.equal(boundPictures(messages, 3), 1);
  assert.ok(owners.images, "the owner's picture stays although its words match");
  assert.equal(messages[1].images, undefined);
  assert.equal(messages.filter((one) => one.images).length, 4);
});

test("integration: a real task that takes five pictures shows the model only its newest three", async (t) => {
  const { z } = await import("zod");
  const seen = [];
  let round = 0;
  const provider = {
    name: "fake-vision", acceptsImages: true,
    async complete(request) {
      seen.push(request.messages.filter((m) => (m.images ?? []).length).length);
      round += 1;
      return round <= 5
        ? { content: "", toolCalls: [{ id: `s${round}`, name: "files.fake_snapshot", arguments: JSON.stringify({ n: round }) }] }
        : { content: "looked", toolCalls: [] };
    },
  };
  const { app } = await served(t, provider);
  app.registry.register({
    name: "files.fake_snapshot", permission: "files.read", description: "a picture", readOnly: true,
    parameters: z.object({ n: z.number() }).strict(),
    execute: async (value, context) => app.runtime.artifacts.write(context.runId, `shot-${value.n}.png`, "image/png", Buffer.from(`P${value.n}`)),
  });
  const run = await app.runtime.run({ prompt: "take five pictures" });
  assert.equal(run.status, "completed");
  assert.deepEqual(seen, [0, 1, 2, 3, 3, 3], "never more than three of its own pictures travel");
  const dropped = app.store.events(run.id).filter((event) => event.kind === "image.dropped");
  assert.equal(dropped.length, 2);
});
