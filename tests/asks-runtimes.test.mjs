/**
 * mac6/bucket-23, group 3: the model-gateway layer and the Vercel AI Gateway (A1012), PaLM's plain
 * retirement (A2367), Codex's app-server as a backend (A0601), Branch speaking the app-server
 * protocol (A0032) and more than one agent runtime (A2258). Fakes, temporary folders and a stand-in
 * `codex` program only; no real service or real Codex is ever reached.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { catalogEntry } from "../dist/provider-catalog.js";
import { buildConnection } from "../dist/provider-factory.js";
import { connectFromPreset } from "../dist/connections-preset.js";
import { ModelRouter } from "../dist/models.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { Store } from "../dist/store.js";
import { gatewayModel, vendorOf } from "../dist/asks/model-gateway.js";
import { CodexAppServerProvider, startCodexAppServer } from "../dist/asks/codex-app-server.js";
import { AppServerConnection, serveAppServerStdio } from "../dist/asks/app-server.js";
import { onPath, runtimeRows } from "../dist/asks/runtimes.js";

function scripted() {
  const provider = { name: "scripted", toolCall: null, async complete(request) {
    const called = request.messages.some((m) => m.role === "tool");
    if (provider.toolCall && !called)
      return { content: "", toolCalls: [{ id: "c1", name: provider.toolCall.name, arguments: JSON.stringify(provider.toolCall.args) }] };
    const user = request.messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    const words = `Echo: ${user.slice(0, 60)}`;
    request.onTextDelta?.(words.slice(0, 6)); request.onTextDelta?.(words.slice(6));
    return { content: words, toolCalls: [] };
  } };
  return provider;
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-asks-rt-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: scripted() });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}

test("A1012 a model name is spelled for where it goes: vendor/ for a gateway, bare for the vendor", () => {
  assert.equal(gatewayModel("vercel-ai-gateway", "claude-sonnet-4"), "anthropic/claude-sonnet-4");
  assert.equal(gatewayModel("vercel-ai-gateway", "gpt-5"), "openai/gpt-5");
  assert.equal(gatewayModel("vercel-ai-gateway", "qwen3-coder"), "alibaba/qwen3-coder");
  assert.equal(gatewayModel("openrouter", "llama-3.3-70b-instruct"), "meta-llama/llama-3.3-70b-instruct");
  assert.equal(gatewayModel("openrouter", "grok-4"), "x-ai/grok-4");
  assert.equal(gatewayModel("vercel-ai-gateway", "google/gemini-2.5-pro"), "google/gemini-2.5-pro", "a full name is left alone");
  assert.equal(gatewayModel("vercel-ai-gateway", "my-own-model"), "my-own-model", "nothing is guessed for an unknown name");
  assert.equal(gatewayModel("anthropic", "anthropic/claude-sonnet-4"), "claude-sonnet-4");
  assert.equal(gatewayModel("gemini", "google/gemini-2.5-flash"), "gemini-2.5-flash");
  assert.equal(gatewayModel("anthropic", "openai/gpt-5"), "openai/gpt-5", "another vendor's prefix is not taken off");
  assert.equal(gatewayModel("groq", "meta-llama/llama-4"), "meta-llama/llama-4", "a service that is not one vendor keeps the name");
  assert.equal(vendorOf("o3-mini"), "openai");
  assert.equal(vendorOf("  "), null);
  const gateway = catalogEntry("vercel-ai-gateway");
  assert.equal(gateway.shape, "openai-chat");
  assert.equal(gateway.baseUrl, "https://ai-gateway.vercel.sh/v1");
  assert.equal(gateway.terms.standing, "official");
});

test("A1012 connecting the gateway with a bare name saves the gateway's full name", async (t) => {
  const store = new Store(":memory:");
  store.openLocker({ key: async () => Buffer.alloc(32, 7) });
  t.after(() => store.close?.());
  const models = new ModelRouter(store, [{ id: "demo", name: "Demo", provider: scripted(), model: "demo" }]);
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push(String(url)); return new Response(JSON.stringify({ data: [{ id: "anthropic/claude-sonnet-4" }] }), { headers: { "content-type": "application/json" } }); };
  const result = await connectFromPreset({ models, locker: store.locker, owner: "local", policy: new NetworkPolicy({}, async () => ["93.184.216.34"]), fetchImpl },
    { provider: "vercel-ai-gateway", key: "vk-secret", model: "claude-sonnet-4" });
  assert.equal(result.model, "anthropic/claude-sonnet-4");
  assert.equal(models.presets.get(result.id).model, "anthropic/claude-sonnet-4");
  assert.equal(seen[0], "https://ai-gateway.vercel.sh/v1/models");
});

test("A2367 PaLM is on the list with a plain note pointing at Gemini, and never reaches the network", async (t) => {
  const palm = catalogEntry("google-palm");
  assert.equal(palm.terms.standing, "retired");
  assert.match(palm.terms.warning, /connect Gemini instead/);
  const built = buildConnection({ provider: "google-palm", key: "AIza-anything" });
  assert.equal(built.provider.retired, true);
  await assert.rejects(built.provider.complete({ messages: [], tools: [], maxTokens: 10, signal: AbortSignal.timeout(1000) }), /connect Gemini instead/);
  const store = new Store(":memory:");
  store.openLocker({ key: async () => Buffer.alloc(32, 7) });
  t.after(() => store.close?.());
  const models = new ModelRouter(store, [{ id: "demo", name: "Demo", provider: scripted(), model: "demo" }]);
  let asked = 0;
  await assert.rejects(connectFromPreset({ models, locker: store.locker, owner: "local", policy: new NetworkPolicy({}), fetchImpl: async () => { asked++; return new Response("{}"); } },
    { provider: "google-palm", key: "AIza" }), /turned the PaLM API off/);
  assert.equal(asked, 0);
});

/** A stand-in Codex app-server, in-process: it follows the protocol and records what it was told. */
function fakeCodex({ ask = false, fail = false } = {}) {
  const told = [];
  let listener = () => {}, exit = () => {};
  const reply = (message) => setImmediate(() => listener(message));
  const child = {
    stopped: false,
    send(message) {
      told.push(message);
      if (message.method === "initialize") reply({ id: message.id, result: { userAgent: "codex/1" } });
      if (message.method === "thread/start") reply({ id: message.id, result: { thread: { id: "thr_1" } } });
      if (message.method === "turn/start") {
        reply({ id: message.id, result: { turn: { id: "turn_1", status: "inProgress" } } });
        if (ask) reply({ id: 99, method: "item/commandExecution/requestApproval", params: { command: "rm -rf /" } });
        reply({ method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_1", itemId: "i", delta: "Hello " } });
        reply({ method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_1", itemId: "i", delta: "there" } });
        reply({ method: "turn/completed", params: { threadId: "thr_1", turn: fail ? { status: "failed", error: { message: "usage limit" } } : { status: "completed" } } });
      }
    },
    onMessage: (fn) => { listener = fn; }, onExit: (fn) => { exit = fn; }, stop() { child.stopped = true; },
    exit: (code, missing) => exit(code, missing),
  };
  return { child, told, start: () => child };
}
const ask = (text, onTextDelta) => ({ messages: [{ role: "system", content: "Be brief." }, { role: "user", content: text }], tools: [], maxTokens: 100, signal: AbortSignal.timeout(5000), onTextDelta });

test("A0601 Codex answers over app-server, read-only, streamed, and its approval requests are declined", async () => {
  const codex = fakeCodex({ ask: true });
  const pieces = [];
  const answer = await new CodexAppServerProvider("codex", codex.start, "0.17.0").complete(ask("say hi", (d) => pieces.push(d)));
  assert.deepEqual(answer, { content: "Hello there", toolCalls: [] });
  assert.deepEqual(pieces, ["Hello ", "there"]);
  const methods = codex.told.map((m) => m.method ?? `reply:${m.id}`);
  assert.deepEqual(methods, ["initialize", "initialized", "thread/start", "turn/start", "reply:99"]);
  assert.equal(codex.told[0].params.clientInfo.name, "branch_agent");
  assert.deepEqual({ approval: codex.told[2].params.approvalPolicy, sandbox: codex.told[2].params.sandbox }, { approval: "never", sandbox: "read-only" });
  assert.match(codex.told[3].params.input[0].text, /system: Be brief\.\n\nuser: say hi/);
  assert.deepEqual(codex.told[4].result, { decision: "decline" }, "Codex is never allowed to run anything this way");
  assert.equal(codex.child.stopped, true, "the program is stopped after the turn");
  await assert.rejects(new CodexAppServerProvider("codex", fakeCodex({ fail: true }).start).complete(ask("x")), /usage limit/);
  const gone = fakeCodex();
  gone.child.send = () => setImmediate(() => gone.child.exit(1, true));
  await assert.rejects(new CodexAppServerProvider("codex", gone.start).complete(ask("x")), /"codex" is not on this computer/);
});

test("A0601 a real stand-in codex program is started with app-server and no shell", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-codex-"));
  t.after(() => discardTemp(root));
  const program = join(root, "codex");
  await writeFile(program, `#!${process.execPath}
const readline = require("node:readline");
if (process.argv[2] !== "app-server") { process.exit(3); }
const say = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") say({ id: m.id, result: { userAgent: "fake" } });
  if (m.method === "thread/start") say({ id: m.id, result: { thread: { id: "t" } } });
  if (m.method === "turn/start") {
    say({ id: m.id, result: { turn: { id: "u" } } });
    say({ method: "item/completed", params: { item: { type: "agentMessage", text: "from a real process; key " + (process.env.OPENAI_API_KEY ? "leaked" : "absent") } } });
    say({ method: "turn/completed", params: { turn: { status: "completed" } } });
  }
});
`);
  await chmod(program, 0o755);
  process.env.OPENAI_API_KEY = "sk-should-not-pass";
  t.after(() => { delete process.env.OPENAI_API_KEY; });
  const answer = await new CodexAppServerProvider(program, startCodexAppServer).complete(ask("hi"));
  assert.equal(answer.content, "from a real process; key absent");
});

function appServerPair(t, app) {
  const toServer = new PassThrough(), fromServer = new PassThrough();
  const connection = new AppServerConnection(app.runtime, { input: toServer, output: fromServer, log: () => {} }, "0.17.0");
  const messages = [];
  let buffer = "";
  fromServer.setEncoding("utf8");
  fromServer.on("data", (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at).trim(); buffer = buffer.slice(at + 1);
      if (line) messages.push(JSON.parse(line));
    }
  });
  const serving = connection.serve();
  t.after(async () => { toServer.end(); await serving; });
  const send = (message) => toServer.write(`${JSON.stringify(message)}\n`);
  const until = async (match) => {
    for (let i = 0; i < 400; i++) { const found = messages.find(match); if (found) return found; await delay(10); }
    throw new Error(`Timed out; saw ${JSON.stringify(messages).slice(0, 800)}`);
  };
  return { messages, send, until };
}

test("A0032 an app-server client says hello, opens a thread and gets a turn word by word", async (t) => {
  const { app } = await fixture(t);
  const client = appServerPair(t, app);
  client.send({ id: 1, method: "thread/start", params: {} });
  assert.match((await client.until((m) => m.id === 1)).error.message, /initialize first/);
  client.send({ id: 2, method: "initialize", params: { clientInfo: { name: "test", title: null, version: "1" }, capabilities: null } });
  assert.equal((await client.until((m) => m.id === 2)).result.userAgent, "branch-agent/0.17.0");
  client.send({ method: "initialized" });
  client.send({ id: 3, method: "thread/start", params: { cwd: "/elsewhere" } });
  const started = await client.until((m) => m.id === 3);
  const threadId = started.result.thread.id;
  assert.match(threadId, /^[0-9a-f-]{36}$/);
  assert.equal(started.result.cwd, app.runtime.workspace, "the thread works in Branch's workspace, not wherever the client says");
  assert.ok(client.messages.some((m) => m.method === "thread/started" && m.params.thread.id === threadId));
  client.send({ id: 4, method: "turn/start", params: { threadId, input: [{ type: "text", text: "hello there", text_elements: [] }] } });
  const turn = (await client.until((m) => m.id === 4)).result.turn;
  assert.equal(turn.status, "inProgress");
  const completed = await client.until((m) => m.method === "turn/completed");
  assert.equal(completed.params.turn.id, turn.id);
  assert.equal(completed.params.turn.status, "completed");
  const deltas = client.messages.filter((m) => m.method === "item/agentMessage/delta");
  assert.ok(deltas.length >= 2, "the answer arrives in pieces");
  assert.equal(deltas.map((d) => d.params.delta).join(""), "Echo: hello there");
  const item = client.messages.find((m) => m.method === "item/completed");
  assert.deepEqual({ type: item.params.item.type, text: item.params.item.text }, { type: "agentMessage", text: "Echo: hello there" });
  assert.equal(client.messages.every((m) => !("jsonrpc" in m)), true, "the app-server shape carries no jsonrpc field");
  client.send({ id: 5, method: "turn/start", params: { threadId, input: [{ type: "localImage", path: "/etc/passwd" }] } });
  assert.match((await client.until((m) => m.id === 5)).error.message, /written instructions only/);
  client.send({ id: 6, method: "turn/start", params: { threadId: "not-a-thread", input: [{ type: "text", text: "x" }] } });
  assert.match((await client.until((m) => m.id === 6)).error.message, /not one of Branch's/);
  client.send({ id: 7, method: "thread/fork", params: {} });
  assert.equal((await client.until((m) => m.id === 7)).error.code, -32601);
});

test("A0032 a step that needs a yes is asked of the client, and a decline is honoured", async (t) => {
  const { app, root } = await fixture(t);
  app.store.save("settings", app.runtime.owner, "policy", {
    preset: "ask-before-changes",
    rules: [{ tool: "*", match: "*", applies: "changes", decision: "ask", remember: "session" }],
    limits: { toolCallsPerMinute: 0, modelRoundsPerMinute: 0 },
  });
  app.runtime.models.default.provider.toolCall = { name: "files.write", args: { path: "asked.txt", content: "hi" } };
  const client = appServerPair(t, app);
  client.send({ id: 1, method: "initialize", params: {} });
  await client.until((m) => m.id === 1);
  client.send({ id: 2, method: "thread/start", params: {} });
  const threadId = (await client.until((m) => m.id === 2)).result.thread.id;
  client.send({ id: 3, method: "turn/start", params: { threadId, input: [{ type: "text", text: "write asked.txt" }] } });
  const question = await client.until((m) => m.method === "item/commandExecution/requestApproval");
  assert.match(question.params.reason, /asked\.txt/);
  client.send({ id: question.id, result: { decision: "decline" } });
  const completed = await client.until((m) => m.method === "turn/completed");
  assert.equal(completed.params.turn.status, "completed");
  assert.equal(app.runtime.approvals.waiting(threadId).length, 0, "the question was answered once");
  const { access } = await import("node:fs/promises");
  await assert.rejects(access(join(root, "workspace", "asked.txt")), "nothing was written");
});

test("A0032 branch app-server will not start while its switch is off", async (t) => {
  const { app } = await fixture(t);
  await assert.rejects(serveAppServerStdio(app.runtime, "1", { input: new PassThrough(), output: new PassThrough(), log: () => {} }), /switched off/);
});

test("A2258 installed agents are listed, added as connections, remembered, and follow the switch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-asks-rt2-"));
  const data = join(root, "data"), workspace = join(root, "workspace");
  const bin = join(root, "bin");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(bin);
  if (process.platform !== "win32") { await writeFile(join(bin, "claude"), "#!/bin/sh\n"); await chmod(join(bin, "claude"), 0o755); }
  assert.equal(await onPath("claude", { PATH: bin }), process.platform !== "win32");
  assert.equal(await onPath("gemini", { PATH: bin }), false);
  assert.equal(await onPath("claude", { PATH: bin, PATHEXT: ".CMD" }, "win32"), false);
  assert.deepEqual(runtimeRows.map((r) => r.id), ["branch", "claude-code", "codex", "copilot", "gemini-cli", "codex-app-server"]);

  let app = await createBranch({ workspace, dataDir: data, provider: scripted() });
  const server = await startServer(app, { dataDir: data, port: 0 });
  const post = async (path, body) => {
    const response = await fetch(server.url + path, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + server.token, origin: server.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  // Installed agents ship "when needed" (the ship-on rule); the owner switches them off to see the refusal.
  await post("/api/asks/switch", { part: "runtimes", mode: "off" });
  assert.equal((await post("/api/asks/runtimes/add", { id: "codex-app-server" })).status, 409);
  await post("/api/asks/switch", { part: "runtimes", mode: "when-needed" });
  assert.equal((await post("/api/asks/runtimes/add", { id: "codex-app-server" })).body.connection, "runtime-codex-app-server");
  assert.equal((await post("/api/asks/runtimes/add", { id: "claude-code" })).body.connection, "cli-claude-code");
  assert.equal((await post("/api/asks/runtimes/add", { id: "branch" })).status, 404);
  const listed = (await post("/api/asks/runtimes")).body.runtimes;
  assert.deepEqual(listed.filter((r) => r.added).map((r) => r.id), ["branch", "claude-code", "codex-app-server"]);
  assert.ok(app.runtime.models.presets.has("runtime-codex-app-server"));
  // A conversation can be pointed at it like any other connection.
  const switched = await post("/api/models/switch", { sessionId: app.store.createRun("local", "x").sessionId, model: "runtime-codex-app-server" });
  assert.equal(switched.status, 200, JSON.stringify(switched.body));
  await post("/api/asks/switch", { part: "runtimes", mode: "off" });
  assert.equal(app.runtime.models.presets.has("runtime-codex-app-server"), false, "switched off, it leaves the model list");
  await post("/api/asks/switch", { part: "runtimes", mode: "on" });
  await server.close(); await app.close();
  app = await createBranch({ workspace, dataDir: data, provider: scripted() });
  t.after(async () => { await app.close(); await discardTemp(root); });
  assert.ok(app.runtime.models.presets.has("runtime-codex-app-server"), "it comes back after a restart");
  assert.ok(app.runtime.models.presets.has("cli-claude-code"));
  assert.deepEqual(app.asks.runtimes.remove("claude-code"), { removed: true });
  assert.equal(app.runtime.models.presets.has("cli-claude-code"), false);
});
