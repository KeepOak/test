/**
 * Live engine updates: a newer engine, built from its own live folder, takes over from the running one at the window's
 * own address. Work drains on the old engine, what is still working stops after a whole step and carries on in the new
 * one exactly once, the two never hold the database at the same time, and a new engine that fails is rolled back.
 * Run under Node with the real engine process (tests/fixtures/engine-in-node.mjs), playing the window's main process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discardTemp } from "./temp-dir.mjs";
import { EngineHost } from "../dist/desktop/engine-host.js";
import { stageLive } from "../dist/hot-update/live-folder.js";
import { scriptedModel } from "./fixtures/hot-model.mjs";

const entry = fileURLToPath(new URL("./fixtures/engine-in-node.mjs", import.meta.url));
const NEW = "b".repeat(40);

/** An engine's process under Node, as Electron's utility process looks to EngineHost. */
function nodeChild(home, file, started, extra = {}) {
  const child = fork(entry, [], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP,
      HOME: home, USERPROFILE: home, APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "local"),
      ...(file ? { BRANCH_TEST_ENGINE_FILE: file } : {}), ...extra },
  });
  started.push({ child, file: file ?? null });
  return {
    get pid() { return child.pid; },
    postMessage: (message) => { if (child.connected) child.send(message); },
    on: (event, listener) => (event === "exit" ? child.on("exit", (code) => listener(code ?? 1)) : child.on("message", listener)),
    kill: () => child.kill(),
  };
}

/** A live build of this very checkout, as a newer change's (its own folder, its own record, its own change id). */
let staged = null;
async function liveBuild() {
  if (staged) return staged;
  const appRoot = await mkdtemp(join(process.cwd(), ".hot-test-"));
  const built = await stageLive({ source: process.cwd(), appRoot, commit: NEW, version: "0.0.1-dev.1-gbbbbbbbbbbbb" });
  staged = { appRoot, dir: built.dir, engine: join(built.dir, "dist", "desktop", "engine-process.js") };
  return staged;
}
test.after(async () => { if (staged) await discardTemp(staged.appRoot); });

async function setUp(t, model, extra = {}) {
  const home = await mkdtemp(join(tmpdir(), "branch-hot-engine-"));
  const started = [];
  const host = new EngineHost({
    fork: () => nodeChild(home, null, started, extra),
    config: { dataDir: join(home, "state"), workspace: join(home, "work"), version: "0.0.0", executable: null, installRoot: null,
      packaged: false, loginItem: null, appPid: process.pid, testHooks: false,
      providerEnv: { BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: model.endpoint, BRANCH_MODEL: "m", BRANCH_API_KEY: "test-key" } },
    handlers: { "vault-read": () => null },
  });
  const url = await host.start();
  t.after(async () => { await host.end(3000); for (const { child } of started) if (child.exitCode === null) child.kill(); await discardTemp(home); });
  const call = (path, body) => fetch(`${host.url}${path}`, { method: body ? "POST" : "GET",
    headers: { authorization: `Bearer ${host.token}`, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));
  return { home, host, url, started, call };
}
const events = async (call, runId) => (await call(`/api/runs/${runId}`)).body?.events ?? [];
const until = async (check) => { for (;;) { const value = await check(); if (value) return value; await new Promise((resolve) => setImmediate(resolve)); } };

test("a task that finishes while the old engine drains finishes there once, and its answer arrives whole", { timeout: 240000 }, async (t) => {
  const model = await scriptedModel(t, [{ text: "The whole answer.", held: true }]);
  const { host, url, started, call } = await setUp(t, model);
  const live = await liveBuild();
  const answer = call("/api/run", { prompt: "Say something" });
  await model.until(1);
  const handing = host.handOver({ fork: () => nodeChild(join(live.appRoot, "h"), live.engine, started), commit: NEW, drainMs: 60000, settleMs: 5000 });
  await until(() => started.length === 2);
  model.release(0);
  const run = await answer;
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.status, "completed", "the task finished on the engine it started on");
  const outcome = await handing;
  assert.deepEqual({ ok: outcome.ok, drained: outcome.drained, handedOver: outcome.handedOver, rolledBack: outcome.rolledBack },
    { ok: true, drained: true, handedOver: [], rolledBack: false });
  assert.equal(host.url, url, "the window's address did not change");
  assert.equal(started.at(-1).file, live.engine, "the engine now runs from the live build");
  const session = (await call(`/api/sessions/${run.body.sessionId}`)).body;
  const replies = session.messages.filter((message) => message.role === "assistant" && message.content === "The whole answer.");
  assert.equal(replies.length, 1, "one answer, once");
  assert.equal(model.asked.length, 1, "the model was asked once");
});

test("a task still working stops after a whole step, carries on in the new engine, and no step is done twice", { timeout: 240000 }, async (t) => {
  const model = await scriptedModel(t, [
    { tool: "checklist.read", args: {} },
    { tool: "files.list", args: {}, held: true },
    { text: "Finished after the update." },
  ]);
  const { host, started, call } = await setUp(t, model);
  const live = await liveBuild();
  void call("/api/run", { prompt: "Look twice" }).catch(() => undefined);
  await model.until(2);
  const run = (await call("/api/state")).body.runs.find((each) => each.prompt === "Look twice");
  const handing = host.handOver({ fork: () => nodeChild(join(live.appRoot, "h"), live.engine, started), commit: NEW, drainMs: 0, settleMs: 60000 });
  // Asked to stop after its step, the task still finishes the step it is on (the model's answer, then its tool).
  await until(async () => (await events(call, run.id)).some((event) => event.kind === "run.handover_asked"));
  model.release(1);
  const outcome = await handing;
  assert.equal(outcome.ok, true, outcome.why ?? "");
  assert.deepEqual(outcome.handedOver, [run.id]);
  await model.until(3);
  const carried = await until(async () => {
    const runs = (await call("/api/state")).body.runs.filter((each) => each.sessionId === run.sessionId);
    return runs.find((each) => each.id !== run.id && each.status === "completed") ? runs : null;
  });
  assert.equal(carried.find((each) => each.id === run.id).status, "interrupted");
  assert.equal(carried.filter((each) => each.id !== run.id).length, 1, "carried on once");
  const oldEvents = await events(call, run.id);
  assert.ok(oldEvents.some((event) => event.kind === "run.handed_over"));
  assert.ok(!oldEvents.some((event) => event.kind === "run.paused"), "never shown to the owner as paused");
  // Each tool call was done exactly once, across both engines.
  const all = [];
  for (const each of carried) all.push(...await events(call, each.id));
  const startedCalls = all.filter((event) => event.kind === "tool.started").map((event) => event.data?.id);
  assert.deepEqual(startedCalls.sort(), ["call0", "call1"]);
  const question = model.asked[2].body.messages;
  assert.equal(question.filter((message) => message.role === "tool").length, 2, "the new engine carried on with both results");
  const session = (await call(`/api/sessions/${run.sessionId}`)).body;
  assert.equal(session.messages.filter((message) => message.content === "Finished after the update.").length, 1);
});

/** A chat service's side (Mattermost-shaped): the answers Branch posts back to its webhook. */
async function chatService(t) {
  const replies = [];
  const server = createServer((request, response) => {
    let raw = ""; request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => { try { replies.push(JSON.parse(raw)); } catch { replies.push({ raw }); } response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }));
  return { hook: `http://127.0.0.1:${server.address().port}/hooks/branch`, replies };
}

// The chat here is a group (a Mattermost channel), and a group's task never reads what Branch remembers
// (src/channels/chat-permissions.ts), so its steps list the workspace's files instead of reading the checklist.
test("a chat app's turn handed to a newer engine is answered in that chat once, by the new engine, never with a failure", { timeout: 240000 }, async (t) => {
  const model = await scriptedModel(t, [{ tool: "files.list", args: {} }, { tool: "files.list", args: {}, held: true }, { text: "Answered after the update." }]);
  const chat = await chatService(t), secret = "hot-chat-token-0123456789";
  const config = await mkdtemp(join(tmpdir(), "branch-hot-chat-"));
  t.after(() => discardTemp(config));
  const integrations = join(config, "integrations.json");
  await writeFile(integrations, JSON.stringify({ web: { allowPrivateAddresses: true }, channels: [{ id: "mattermost", type: "chat", service: "mattermost",
    webhookUrlSecret: "HOT_CHAT_HOOK", secretSecret: "HOT_CHAT_SECRET", activation: "always", pairing: false, allowlist: ["user-9"] }] }));
  const extra = { BRANCH_INTEGRATIONS: integrations, HOT_CHAT_HOOK: chat.hook, HOT_CHAT_SECRET: secret };
  const { host, url, started, call } = await setUp(t, model, extra);
  const live = await liveBuild();
  const address = (await call("/api/channels/addresses")).body.addresses.find((one) => one.channel === "mattermost")?.address;
  assert.ok(address, "the chat service's address is there");
  const posted = fetch(new URL(new URL(address, url).pathname, url), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: secret, post_id: "p-hot-1", channel_id: "c1", channel_name: "town-square", user_id: "user-9", user_name: "alice", text: "What is on today?" }) });
  posted.catch(() => undefined);
  await model.until(2);
  const run = (await call("/api/state")).body.runs.find((each) => each.prompt.includes("What is on today?"));
  const handing = host.handOver({ fork: () => nodeChild(join(live.appRoot, "h"), live.engine, started, extra), commit: NEW, drainMs: 0, settleMs: 60000 });
  await until(async () => (await events(call, run.id)).some((event) => event.kind === "run.handover_asked"));
  model.release(1);
  const outcome = await handing;
  assert.equal(outcome.ok, true, outcome.why ?? "");
  assert.deepEqual(outcome.handedOver, [run.id]);
  assert.equal((await posted).status, 200, "the chat service's post was answered by the engine it reached");
  for (const end = Date.now() + 60000; chat.replies.length < 1 && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(chat.replies.length >= 1, "the chat got its answer");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(chat.replies.length, 1, `one answer, once: ${JSON.stringify(chat.replies)}`);
  assert.match(JSON.stringify(chat.replies[0]), /Answered after the update\./);
  assert.doesNotMatch(JSON.stringify(chat.replies), /could not finish/);
  assert.equal(model.asked.length, 3, "no step was asked of the model twice");
});

test("a chat app's turn carried through two engine updates back to back is answered once, by the last engine", { timeout: 300000 }, async (t) => {
  const model = await scriptedModel(t, [{ tool: "files.list", args: {} }, { tool: "files.list", args: {}, held: true },
    { tool: "files.list", args: {}, held: true }, { text: "Answered after two updates." }]);
  const chat = await chatService(t), secret = "hot-chat-token-0123456789";
  const config = await mkdtemp(join(tmpdir(), "branch-hot-chat-"));
  t.after(() => discardTemp(config));
  const integrations = join(config, "integrations.json");
  await writeFile(integrations, JSON.stringify({ web: { allowPrivateAddresses: true }, channels: [{ id: "mattermost", type: "chat", service: "mattermost",
    webhookUrlSecret: "HOT_CHAT_HOOK", secretSecret: "HOT_CHAT_SECRET", activation: "always", pairing: false, allowlist: ["user-9"] }] }));
  const extra = { BRANCH_INTEGRATIONS: integrations, HOT_CHAT_HOOK: chat.hook, HOT_CHAT_SECRET: secret };
  const { host, url, started, call } = await setUp(t, model, extra);
  const live = await liveBuild();
  const address = (await call("/api/channels/addresses")).body.addresses.find((one) => one.channel === "mattermost")?.address;
  const posted = fetch(new URL(new URL(address, url).pathname, url), { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: secret, post_id: "p-hot-2", channel_id: "c1", channel_name: "town-square", user_id: "user-9", user_name: "alice", text: "What is on this week?" }) });
  posted.catch(() => undefined);
  // Each engine in turn is working on the task when the next takes over: it stops after its step and is carried on.
  const working = async () => (await call("/api/state")).body.runs.find((each) => each.status === "running");
  for (const [hop, step] of [[1, 1], [2, 2]]) {
    await model.until(step + 1);
    const run = await until(working);
    const handing = host.handOver({ fork: () => nodeChild(join(live.appRoot, `h${hop}`), live.engine, started, extra), commit: NEW, drainMs: 0, settleMs: 60000 });
    await until(async () => (await events(call, run.id)).some((event) => event.kind === "run.handover_asked"));
    model.release(step);
    const outcome = await handing;
    assert.equal(outcome.ok, true, outcome.why ?? "");
    assert.deepEqual(outcome.handedOver, [run.id], `update ${hop} carried the chat's task on`);
  }
  assert.equal((await posted).status, 200);
  await model.until(4);
  for (const end = Date.now() + 60000; chat.replies.length < 1 && Date.now() < end;) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(chat.replies.length >= 1, "the chat got its answer");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(chat.replies.length, 1, `one answer, once: ${JSON.stringify(chat.replies)}`);
  assert.match(JSON.stringify(chat.replies[0]), /Answered after two updates\./);
  assert.equal(model.asked.length, 4, "no step was asked of the model twice");
});

test("a new engine that fails its check is ended and the app's own engine carries the work on instead", { timeout: 240000 }, async (t) => {
  const model = await scriptedModel(t, [{ tool: "checklist.read", args: {} }, { tool: "files.list", args: {}, held: true }, { text: "Carried on by the engine that stayed." }]);
  const { host, url, started, call } = await setUp(t, model);
  const live = await liveBuild();
  void call("/api/run", { prompt: "Keep going" }).catch(() => undefined);
  await model.until(2);
  const run = (await call("/api/state")).body.runs.find((each) => each.prompt === "Keep going");
  const handing = host.handOver({ fork: () => nodeChild(join(live.appRoot, "h"), live.engine, started), commit: NEW, drainMs: 0, settleMs: 60000,
    check: async () => { throw new Error("the new engine did not pass its check"); } });
  await until(async () => (await events(call, run.id)).some((event) => event.kind === "run.handover_asked"));
  model.release(1);
  const outcome = await handing;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.rolledBack, true);
  assert.match(outcome.why, /did not pass its check/);
  assert.equal(host.url, url);
  assert.equal(started.at(-1).file, null, "the app's own engine runs again");
  assert.equal(host.running, true);
  await model.until(3);
  const runs = await until(async () => {
    const all = (await call("/api/state")).body.runs.filter((each) => each.sessionId === run.sessionId);
    return all.some((each) => each.status === "completed") ? all : null;
  });
  assert.equal(runs.filter((each) => each.id !== run.id).length, 1, "carried on once, by the engine that stayed");
});

test("a new engine that is not the change that was checked is never handed anything", { timeout: 240000 }, async (t) => {
  const model = await scriptedModel(t, []);
  const { host, started } = await setUp(t, model);
  const live = await liveBuild();
  const before = started[0].child.pid;
  await assert.rejects(host.handOver({ fork: () => nodeChild(join(live.appRoot, "h"), live.engine, started), commit: "c".repeat(40) }), /not the change that was checked/);
  assert.equal(host.running, true, "the running engine was never asked to let go");
  assert.equal(started[0].child.exitCode, null);
  assert.equal(started[0].child.pid, before);
});

test("the new engine never opens the database while the old one holds it", { timeout: 240000 }, async (t) => {
  // The database refuses a second process outright, which is what makes a double write impossible (src/store.ts).
  const { Store } = await import("../dist/store.js");
  const home = await mkdtemp(join(tmpdir(), "branch-hot-lock-"));
  t.after(() => discardTemp(home));
  await mkdir(join(home, "state"), { recursive: true });
  const path = join(home, "state", "branch.sqlite");
  const first = new Store(path);
  first.createRun("owner", "held");
  const probe = fork(fileURLToPath(new URL("./fixtures/hot-store-probe.mjs", import.meta.url)), [path], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
  let said = "";
  probe.stdout.on("data", (chunk) => { said += chunk; });
  await new Promise((resolve) => probe.on("exit", resolve));
  assert.match(said, /refused: .*already open/s, said);
  first.close();
  const again = fork(fileURLToPath(new URL("./fixtures/hot-store-probe.mjs", import.meta.url)), [path], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
  let second = "";
  again.stdout.on("data", (chunk) => { second += chunk; });
  await new Promise((resolve) => again.on("exit", resolve));
  assert.match(second, /opened/, "once the first has let go");
  await writeFile(join(home, "done"), "");
});
