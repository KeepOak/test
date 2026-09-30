// QA Q065–Q069, Q071: a model running on this computer can use its tools, and nothing it names can reach a tool it
// was not offered. Every model here is a stand-in; the real runs are in the PR.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch, ToolLoader, OpenAIProvider, wireName, originalName, unofferedMark, openaiBody,
  announcesNextStep, madeByBranch, modelDisplayName,
} from "../dist/index.js";
import { wireRuleFor } from "../dist/providers.js";
import { OllamaProvider, contextRoom, roomFacts } from "../dist/providers/ollama.js";
import { LocalRuntimes } from "../dist/local-runtimes.js";
import { announcedEnding, unofferedEnding, textCallEnding, writesToolCallAsText, endsWithToolCallAsText } from "../dist/runtime.js";

// ---------------------------------------------------------------- wire names

test("a model on this computer sees each tool under the name it reads everywhere else; a cloud model sees a hash", () => {
  assert.equal(wireName("files.read", "local"), "files.read");
  assert.equal(wireName("trunk.message", "local"), "trunk.message");
  assert.match(wireName("files.read"), /^branch_[0-9a-f]{24}$/, "cloud stays hashed");
  assert.equal(wireName("files.read", "cloud"), wireName("files.read"));
  const long = "mcp.server." + "x".repeat(80);
  assert.equal(wireName(long, "local"), long, "every registered name, up to 100 characters, travels as itself");
  assert.equal(wireName("foo_deadbeef", "local"), "foo_deadbeef");
  const odd = "Server/Tool " + "y".repeat(120);
  assert.match(wireName(odd, "local"), /^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/, "anything else is cut to the allowed characters and length");
});

test("the readable names are a strict one-to-one map: a name that looks sanitised never travels as itself", () => {
  const tools = ["foo_deadbeef", "foo", "a.b", "a_b", "x".repeat(100), "x".repeat(101), "x".repeat(102), "a/b", "a b",
    "foo_Xdeadbeef", `foo_X${"0".repeat(8)}`];
  const wires = tools.map((name) => wireName(name, "local"));
  assert.equal(new Set(wires).size, tools.length, JSON.stringify(wires));
  assert.notEqual(wireName("foo_Xdeadbeef", "local"), "foo_Xdeadbeef");
  const request = { tools: tools.map((name) => ({ name })) };
  for (const name of tools) assert.equal(originalName(wireName(name, "local"), request, "local"), name);
});

test("a called name is read only against the tools that request offered", () => {
  const request = { tools: [{ name: "files.read" }, { name: "files.edit" }] };
  assert.equal(originalName(wireName("files.read"), request), "files.read", "the wire name");
  assert.equal(originalName("files.edit", request), "files.edit", "a cloud model that wrote the tool's own name");
  assert.equal(originalName("shell.execute", request, "local"), unofferedMark + "shell.execute", "a real tool, not offered");
  assert.equal(originalName(wireName("shell.execute"), request), unofferedMark + wireName("shell.execute"));
  assert.equal(originalName("made_up", request, "local"), unofferedMark + "made_up");
  // Two offered tools under one wire name: neither is guessed.
  assert.equal(originalName("same", { tools: [{ name: "same" }, { name: "same" }] }, "local"), unofferedMark + "same");
});

test("an OpenAI-shaped server on this computer gets readable names; the same shape anywhere else stays hashed", async () => {
  const request = { messages: [{ role: "user", content: "hi" }], tools: [{ name: "files.read", description: "d", parameters: {} }], maxTokens: 10 };
  assert.equal(openaiBody(request, "m", "local").tools[0].function.name, "files.read");
  assert.match(openaiBody(request, "m").tools[0].function.name, /^branch_/);
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [
      { id: "c1", type: "function", function: { name: "files.read", arguments: "{}" } }] } }] }), { status: 200 });
  };
  const local = new OpenAIProvider({ endpoint: "http://127.0.0.1:11434/v1", model: "m", apiKey: "local", fetchImpl });
  const done = await local.complete({ ...request, signal: AbortSignal.timeout(5000) });
  assert.equal(bodies[0].tools[0].function.name, "files.read");
  assert.equal(done.toolCalls[0].name, "files.read");
  const cloud = new OpenAIProvider({ endpoint: "https://api.example.com/v1", model: "m", apiKey: "k", fetchImpl, lookupImpl: async () => ["93.184.216.34"] });
  await cloud.complete({ ...request, signal: AbortSignal.timeout(5000) });
  assert.match(bodies[1].tools[0].function.name, /^branch_/);
});

test("Ollama: readable names both ways, and two calls streamed apart never share an id", async () => {
  const lines = [
    { message: { content: "", tool_calls: [{ function: { name: "files.read", arguments: { path: "a" } } }] }, done: false },
    { message: { content: "", tool_calls: [{ function: { name: "files.list", arguments: { path: "." } } }] }, done: false },
    { message: { content: "" }, done: true, prompt_eval_count: 5, eval_count: 9 },
  ].map((line) => JSON.stringify(line) + "\n").join("");
  let sent;
  const fetchImpl = async (_url, init) => { sent = JSON.parse(init.body); return new Response(lines, { status: 200 }); };
  const provider = new OllamaProvider({ endpoint: "http://127.0.0.1:11434/v1", model: "m", fetchImpl });
  const tools = [{ name: "files.read", description: "d", parameters: {} }, { name: "files.list", description: "d", parameters: {} }];
  const done = await provider.complete({ messages: [{ role: "user", content: "hi" }], tools, maxTokens: 10,
    signal: AbortSignal.timeout(5000), onTextDelta: () => undefined });
  assert.deepEqual(sent.tools.map((tool) => tool.function.name), ["files.read", "files.list"]);
  assert.deepEqual(done.toolCalls.map((call) => call.name), ["files.read", "files.list"]);
  assert.notEqual(done.toolCalls[0].id, done.toolCalls[1].id);
  assert.deepEqual(done.usage, { input: 5, output: 9 }, "a streamed reply still says what it spent, which the dropped-call check reads");
});

// ---------------------------------------------------------------- the runtime, through a stand-in Ollama

/** An Ollama that answers from a script, one reply per request; the requests are kept. */
const NL = String.fromCharCode(10);
function standIn(replies) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    if (String(url).endsWith("/api/show")) return new Response("{}", { status: 404 }); // says nothing of its room
    const body = JSON.parse(init.body);
    requests.push(body);
    const step = replies[Math.min(requests.length - 1, replies.length - 1)];
    const reply = typeof step === "function" ? step(body) : step;
    const content = reply.chunks ? reply.chunks.join("") : reply.content ?? "";
    const message = { content, ...(reply.calls ? { tool_calls: reply.calls.map(([name, args]) => ({ function: { name, arguments: args } })) } : {}) };
    // Streamed as Ollama streams: the reply first (in `chunks`, when a test gives them), what it spent only on the last line.
    const lines = reply.chunks ? reply.chunks.map((chunk) => JSON.stringify({ message: { content: chunk }, done: false }) + NL).join("")
      : JSON.stringify({ message, done: false }) + NL;
    if (body.stream) return new Response(lines
      + JSON.stringify({ message: { content: "" }, done: true, prompt_eval_count: 100, eval_count: reply.spent ?? 20 }) + NL, { status: 200 });
    return new Response(JSON.stringify({ message, done: true, prompt_eval_count: 100, eval_count: reply.spent ?? 20 }), { status: 200 });
  };
  return { requests, provider: new OllamaProvider({ endpoint: "http://127.0.0.1:11434/v1", model: "stand-in", fetchImpl }) };
}
async function app(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-realtools-"));
  const made = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await made.close(); await discardTemp(root); });
  await writeFile(join(root, "workspace", "list.txt"), "eggs\n");
  return made;
}
const offeredIn = (body) => (body.tools ?? []).map((tool) => tool.function.name);
const events = (branch, run, kind) => branch.store.events(run.id).filter((event) => event.kind === kind).map((event) => event.data);

test("a call to a real tool the model was not offered is answered, never run, never journaled; the retry works", async (t) => {
  const { requests, provider } = standIn([
    { calls: [["desktop.danger", {}]] },
    { calls: [["files.read", { path: "list.txt" }]] },
    { content: "list.txt holds eggs." },
  ]);
  const branch = await app(t, provider);
  let ran = false;
  branch.registry.register({ name: "desktop.danger", group: "desktop", description: "Does something nobody offered.", permission: "files.read",
    parameters: z.object({}).strict(), execute: async () => { ran = true; return { ok: true }; } });
  const journaled = [];
  const intend = branch.runtime.journal.intend.bind(branch.runtime.journal);
  branch.runtime.journal.intend = (input) => { journaled.push(...input.calls.map((entry) => entry.call.name)); return intend(input); };
  const run = await branch.runtime.run({ prompt: "read list.txt", permissions: ["files.read"] });
  assert.ok(!offeredIn(requests[0]).includes("desktop.danger"), "the tool exists but this request did not offer it");
  assert.ok(offeredIn(requests[0]).includes("files.read"), "tools travel under readable names");
  assert.equal(ran, false, "a tool that was not offered never runs");
  assert.ok(!journaled.includes("desktop.danger"), "and is never journaled, so a restart cannot run it");
  assert.ok(!events(branch, run, "tool.started").some((event) => event.name === "desktop.danger"));
  assert.deepEqual(events(branch, run, "tool.unoffered").map((event) => event.name), ["desktop.danger"]);
  const answer = requests[1].messages.at(-1);
  assert.equal(answer.role, "user", "a note from Branch, not a result for a call that never ran");
  assert.match(answer.content, /not one of the tools offered to you right now/);
  assert.match(answer.content, /files\.read/);
  assert.ok(!answer.content.includes("Does something"), "it never says what the unoffered tool is");
  const kept = branch.store.messages(run.sessionId).flatMap((message) => message.toolCalls ?? []).map((call) => call.name);
  assert.ok(!kept.includes("desktop.danger"), "the conversation keeps no call that never ran, so nothing can replay it");
  assert.deepEqual(journaled, ["files.read"]);
  assert.equal(run.status, "completed");
  assert.equal(run.output, "list.txt holds eggs.");
});

test("in a reply mixing an offered call and an unoffered one, only the offered call runs, is journaled and is kept", async (t) => {
  const { requests, provider } = standIn([
    { calls: [["files.read", { path: "list.txt" }], ["desktop.danger", {}]] },
    { content: "list.txt holds eggs." },
  ]);
  const branch = await app(t, provider);
  let ran = false;
  branch.registry.register({ name: "desktop.danger", group: "desktop", description: "Does something nobody offered.", permission: "files.read",
    parameters: z.object({}).strict(), execute: async () => { ran = true; return { ok: true }; } });
  const journaled = [];
  const intend = branch.runtime.journal.intend.bind(branch.runtime.journal);
  branch.runtime.journal.intend = (input) => { journaled.push(...input.calls.map((entry) => entry.call.name)); return intend(input); };
  const run = await branch.runtime.run({ prompt: "read list.txt", permissions: ["files.read"] });
  assert.equal(ran, false);
  assert.deepEqual(journaled, ["files.read"]);
  const kept = branch.store.messages(run.sessionId).flatMap((message) => message.toolCalls ?? []).map((call) => call.name);
  assert.deepEqual(kept, ["files.read"]);
  const after = requests[1].messages;
  assert.equal(after.at(-2).role, "tool", "the offered call's result");
  assert.match(after.at(-1).content, /"desktop\.danger" is not one of the tools offered/);
  assert.equal(run.status, "completed");
});

test("a model that keeps calling tools it was not offered ends failed in plain words", async (t) => {
  const { provider } = standIn([{ calls: [["shell.whatever", {}]] }]);
  const branch = await app(t, provider);
  const run = await branch.runtime.run({ prompt: "read list.txt", permissions: ["files.read"] });
  assert.equal(run.status, "failed");
  assert.equal(run.output, unofferedEnding);
});

test("an empty reply that spent tokens is asked again once, naming what can be called", async (t) => {
  const { requests, provider } = standIn([
    { content: "", spent: 60 },
    { calls: [["files.read", { path: "list.txt" }]] },
    { content: "It says eggs." },
  ]);
  const branch = await app(t, provider);
  const run = await branch.runtime.run({ prompt: "read list.txt", permissions: ["files.read"] });
  assert.equal(events(branch, run, "model.dropped_call").length, 1);
  const nudge = requests[1].messages.at(-1);
  assert.equal(nudge.role, "user");
  assert.match(nudge.content, /came back empty/);
  assert.match(nudge.content, /files\.read/);
  assert.equal(run.status, "completed");
});

test("a streamed empty reply that spent tokens is asked again once, end to end", async (t) => {
  const { requests, provider } = standIn([
    { content: "", spent: 60 },
    { calls: [["files.read", { path: "list.txt" }]] },
    { content: "It says eggs." },
  ]);
  const branch = await app(t, provider);
  const run = await branch.runtime.run({ prompt: "read list.txt", permissions: ["files.read"], onTextDelta: () => undefined });
  assert.equal(requests[0].stream, true, "the reply really was streamed");
  assert.equal(events(branch, run, "model.dropped_call").length, 1);
  assert.match(requests[1].messages.at(-1).content, /came back empty/);
  assert.equal(run.status, "completed");
});

test("an answer ends a streak of calls to tools that were not offered", async (t) => {
  const { provider } = standIn([
    { calls: [["shell.whatever", {}]] },
    { content: "hello" },
    { calls: [["shell.whatever", {}]] },
    { content: "Sorted: list.txt holds eggs." },
  ]);
  const branch = await app(t, provider);
  const run = await branch.runtime.run({ prompt: "read list.txt", permissions: ["files.read"], checks: { mustMention: ["sorted"], maxRetries: 2 } });
  assert.equal(run.status, "completed", run.output);
  assert.equal(events(branch, run, "tool.unoffered").length, 2);
});

test("home model servers get readable names; anything public, or not found, stays hashed", async () => {
  const lookup = (answers) => async (host) => { if (!(host in answers)) throw new Error("not found"); return answers[host]; };
  const names = lookup({ "box.home.example": ["192.168.1.20"], "nas.example": ["100.101.102.103"], "public.example": ["93.184.216.34"],
    "mixed.example": ["192.168.1.20", "93.184.216.34"] });
  for (const endpoint of ["http://127.0.0.1:1234/v1", "http://box.local:11434/v1", "http://tk-ug.tailebeed9.ts.net:11434/v1",
    "http://nas.lan/v1", "http://192.168.1.5:8080/v1", "http://100.64.1.1/v1", "http://box.home.example/v1", "http://nas.example/v1"])
    assert.equal(await wireRuleFor(endpoint, names), "local", endpoint);
  for (const endpoint of ["https://api.openai.com/v1", "https://public.example/v1", "https://mixed.example/v1", "https://gone.example/v1", "http://8.8.8.8/v1"])
    assert.equal(await wireRuleFor(endpoint, names), "cloud", endpoint);
});

test("a server that refuses dotted tool names gets the same request hashed, and hashed names from then on", async () => {
  const bodies = [];
  let refuse = true;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (refuse && body.tools?.some((tool) => tool.function.name.includes(".")))
      return new Response(JSON.stringify({ error: { message: "Invalid 'tools[0].function.name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.", type: "invalid_request_error", param: "tools[0].function.name", code: "invalid_value" } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: body.tools[0].function.name, arguments: "{}" } }] } }] }), { status: 200 });
  };
  const provider = new OpenAIProvider({ endpoint: "http://127.0.0.1:4011/v1", model: "proxied", apiKey: "k", fetchImpl });
  const request = { messages: [{ role: "user", content: "hi" }], tools: [{ name: "files.read", description: "d", parameters: {} }], maxTokens: 10, signal: AbortSignal.timeout(5000) };
  const first = await provider.complete(request);
  assert.equal(bodies[0].tools[0].function.name, "files.read", "readable first");
  assert.match(bodies[1].tools[0].function.name, /^branch_/, "then the same request with hashed names");
  assert.equal(first.toolCalls[0].name, "files.read", "the call still names the real tool");
  await provider.complete(request);
  assert.equal(bodies.length, 3, "remembered: the next request is hashed from the start");
  assert.match(bodies[2].tools[0].function.name, /^branch_/);
});

test("a refusal about anything else is not retried with other names", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify({ error: { message: "max_tokens is too large", type: "invalid_request_error" } }), { status: 400 }); };
  const provider = new OpenAIProvider({ endpoint: "http://127.0.0.1:4012/v1", model: "m", apiKey: "k", fetchImpl });
  await assert.rejects(provider.complete({ messages: [{ role: "user", content: "hi" }], tools: [{ name: "files.read", description: "d", parameters: {} }], maxTokens: 10, signal: AbortSignal.timeout(5000) }));
  assert.equal(calls, 1);
});

test("the core file tools always travel, but only to a task that may use them", async (t) => {
  const { requests, provider } = standIn([{ content: "Hello." }]);
  const branch = await app(t, provider);
  await branch.runtime.run({ prompt: "say hello" });
  for (const name of ["files.read", "files.list", "files.write", "files.edit", "files.move"]) assert.ok(offeredIn(requests[0]).includes(name), name);
  await branch.runtime.run({ prompt: "say hello again", permissions: ["files.read"] });
  assert.ok(offeredIn(requests[1]).includes("files.read"));
  assert.ok(!offeredIn(requests[1]).includes("files.write"), "a narrowed task is not handed a tool it may not use");
});

test("a pinned tool survives the budget, and a switched-off one is never pinned", () => {
  const tool = (name, words = 400) => ({ name, description: `${name} ${"word ".repeat(words)}`, parameters: { type: "object" } });
  const tools = [tool("files.read"), tool("files.write"), ...Array.from({ length: 30 }, (_, at) => tool(`files.extra_${at}`))];
  const groupOf = (name) => name.split(".")[0];
  const plain = new ToolLoader(tools, { groupOf, expanded: ["files"], budgetTokens: 900, signals: { prompt: "extra extra" } });
  plain.nextRound();
  assert.ok(!plain.descriptions().some((one) => one.name === "files.read"), "without pinning the budget moves it down");
  const pinned = new ToolLoader(tools, { groupOf, expanded: ["files"], budgetTokens: 900, pinned: ["files.read", "files.write"],
    hidden: ["files.write"], signals: { prompt: "extra extra" } });
  pinned.nextRound();
  const names = pinned.descriptions().map((one) => one.name);
  assert.ok(names.includes("files.read"));
  assert.ok(!names.includes("files.write"), "switched off: not pinned");
});

// ---------------------------------------------------------------- an honest "done" line (Q067)

test("a reply that promises its next step and stops is asked once, then ends failed, never done", async (t) => {
  const { provider } = standIn([{ content: "Let me start by reading the current contents of list.txt." }]);
  const branch = await app(t, provider);
  const run = await branch.runtime.run({ prompt: "add milk to list.txt", permissions: ["files.read"] });
  assert.equal(run.status, "failed");
  assert.equal(run.output, announcedEnding);
  assert.equal(events(branch, run, "model.announced_only").length, 2);
});

test("an answer to \"how would you…\" and a dry run may say what comes first", async (t) => {
  const { provider } = standIn([{ content: "I'll start by reading list.txt, then add the line." }]);
  const branch = await app(t, provider);
  const asked = await branch.runtime.run({ prompt: "How would you add milk to list.txt", permissions: ["files.read"] });
  assert.equal(asked.status, "completed");
  const dry = await branch.runtime.run({ prompt: "add milk to list.txt", permissions: ["files.read"], dryRun: true });
  assert.notEqual(dry.status, "failed", dry.output);
});

test("asked once, a model that then does the step finishes as done", async (t) => {
  const { provider } = standIn([
    { content: "I'll read the file now:" },
    { calls: [["files.read", { path: "list.txt" }]] },
    { content: "It says eggs. Let me know if you need anything else." },
  ]);
  const branch = await app(t, provider);
  const run = await branch.runtime.run({ prompt: "read list.txt", permissions: ["files.read"] });
  assert.equal(run.status, "completed");
});

// ---------------------------------------------------------------- a tool call written out as text (qa-fixes-4)

const textCall = '{"name": "memory.search", "arguments": {"query": "Roman Empire", "limit": 1}}';
test("a tool call written out as text is kept nowhere a person reads; asked once, the real call then works", async (t) => {
  // Mutation: drop the writesToolCallAsText check in the runtime → the JSON is the task's answer, red.
  const { requests, provider } = standIn([{ content: textCall }, { calls: [["files.read", { path: "list.txt" }]] }, { content: "It says eggs." }]);
  const branch = await app(t, provider);
  const run = await branch.runtime.run({ prompt: "read list.txt", permissions: ["files.read"] });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "It says eggs.");
  assert.ok(!branch.store.messages(run.sessionId).some((message) => String(message.content ?? "").includes('"arguments"')), "in no message");
  assert.match(requests[1].messages.at(-1).content, /tool call written out as text/);
  assert.match(requests[1].messages.at(-1).content, /files\.read/);
  assert.equal(events(branch, run, "model.text_call").length, 1);
});

test("a model that keeps writing tool calls out as text ends failed in plain words", async (t) => {
  // Mutation: let the second text call through (no textCallEnding) → the fenced JSON is the answer, red.
  const { provider } = standIn([{ content: "```json\n" + textCall + "\n```" }]);
  const branch = await app(t, provider);
  const run = await branch.runtime.run({ prompt: "find a fact about Rome", permissions: ["files.read"] });
  assert.equal(run.status, "failed");
  assert.equal(run.output, textCallEnding);
  assert.equal(events(branch, run, "model.text_call").length, 2);
});

test("a call written out as text never reaches a stream; an answer that begins with { still streams whole", async (t) => {
  // Codex P2 on #512: streamed words went out before the reply was read. Mutation: hand the model call `preview`, not
  // the gate → the JSON is in the stream, red.
  const { provider } = standIn([{ content: textCall }, { calls: [["files.read", { path: "list.txt" }]] }, { content: "It says eggs." },
    { content: '{"name": "Rome", "founded": -753}' }]);
  const branch = await app(t, provider);
  const streamed = [];
  const run = await branch.runtime.run({ prompt: "read list.txt", permissions: ["files.read"], onTextDelta: (text) => streamed.push(text) });
  assert.equal(run.output, "It says eggs.");
  assert.ok(!streamed.join("").includes('"arguments"'), streamed.join(""));
  assert.ok(streamed.join("").includes("It says eggs."));
  const answer = [];
  const json = await branch.runtime.run({ prompt: "give me Rome as JSON", permissions: ["files.read"], onTextDelta: (text) => answer.push(text) });
  assert.equal(answer.join(""), json.output, "held while it began like a call, then passed on whole");
});

test("a real call beside its own written-out copy runs; the copy is kept nowhere", async (t) => {
  // Codex P2 on #512. Mutation: check only replies with no real call → the JSON is in the conversation, red.
  const { provider } = standIn([{ content: '{"name": "files.read", "arguments": {"path": "list.txt"}}', calls: [["files.read", { path: "list.txt" }]] },
    { content: "It says eggs." }]);
  const branch = await app(t, provider);
  const run = await branch.runtime.run({ prompt: "read list.txt", permissions: ["files.read"] });
  assert.equal(run.output, "It says eggs.");
  assert.deepEqual(events(branch, run, "tool.completed").map((event) => event.name), ["files.read"]);
  assert.ok(!branch.store.messages(run.sessionId).some((message) => String(message.content ?? "").includes('"arguments"')));
});

test("an example call a person asked for is an answer: it names no tool Branch has", async (t) => {
  // Mutation: drop the registered-name check (isTool) in the runtime → the example fails the task, red.
  const example = '```json\n{"name": "get_weather", "arguments": {"city": "Atlanta"}}\n```';
  const { provider } = standIn([{ content: example }]);
  const branch = await app(t, provider);
  const run = await branch.runtime.run({ prompt: "Show me what a tool call looks like", permissions: ["files.read"] });
  assert.equal(run.status, "completed");
  assert.equal(run.output, example);
  assert.equal(events(branch, run, "model.text_call").length, 0);
});

test("a text call naming a tool by its hashed wire name is still one", async (t) => {
  const { provider } = standIn([{ content: JSON.stringify({ name: wireName("memory.search"), arguments: { query: "Rome" } }) }]);
  const branch = await app(t, provider);
  const run = await branch.runtime.run({ prompt: "find a fact about Rome", permissions: ["files.read"] });
  assert.equal(run.output, textCallEnding);
});

test("a call with a stray word in front and a closing tag is one too, and never reaches a stream or a message", async (t) => {
  // qfix3's real run: qwen2.5:7b wrote `portun {json} </tool_call>`, posted as a room reply. Mutation: drop the stray-word
  // strip in writesToolCallAsText → the JSON is the answer, red; hand the gate no wait for the second word → streamed, red.
  const { provider } = standIn([{ chunks: ["portun", " ", textCall, " </tool_call>"] }, { calls: [["files.read", { path: "list.txt" }]] }, { content: "It says eggs." }]);
  const branch = await app(t, provider);
  const streamed = [];
  const run = await branch.runtime.run({ prompt: "read list.txt", permissions: ["files.read"], onTextDelta: (text) => streamed.push(text) });
  assert.equal(run.output, "It says eggs.");
  assert.ok(!streamed.join("").includes('"arguments"') && !streamed.join("").includes("portun"), streamed.join(""));
  assert.ok(!branch.store.messages(run.sessionId).some((message) => /"arguments"|portun/.test(String(message.content ?? ""))), "in no message");
  assert.equal(events(branch, run, "model.text_call").length, 1);
});

test("an answer that ends with a call written out is asked to make it; showing a call someone asked about is an answer", async (t) => {
  // The real run: "Here's the command to move the remaining files:" and a fenced files.move, and the task was done with
  // two files still loose. Mutation: drop endsWithToolCallAsText from the round check → that is the answer, red.
  const ending = "Two files are left. Here is the command:\n```json\n" + JSON.stringify({ name: "files.read", arguments: { path: "list.txt" } }) + "\n```";
  const { requests, provider } = standIn([{ content: ending }, { calls: [["files.read", { path: "list.txt" }]] }, { content: "It says eggs." }]);
  const branch = await app(t, provider);
  const run = await branch.runtime.run({ prompt: "read list.txt", permissions: ["files.read"] });
  assert.equal(run.output, "It says eggs.");
  assert.match(requests[1].messages.at(-1).content, /tool call written out as text/);
  assert.ok(!branch.store.messages(run.sessionId).some((message) => String(message.content ?? "").includes("Here is the command")));
  const shown = standIn([{ content: ending }]);
  const asked = await app(t, shown.provider);
  const how = await asked.runtime.run({ prompt: "How would you read list.txt?", permissions: ["files.read"] });
  assert.equal(how.output, ending);
});

test("only an answer's last block is read as a call, and only one naming Branch's tool", () => {
  const call = '```json\n{"name":"files.read","arguments":{"path":"a"}}\n```';
  assert.ok(endsWithToolCallAsText(`Next:\n${call}`));
  assert.ok(endsWithToolCallAsText('Next: <tool_call>{"name":"files.read","arguments":{}}</tool_call>'));
  assert.ok(!endsWithToolCallAsText(`${call}\nThat is what I would run.`), "not the last part");
  assert.ok(!endsWithToolCallAsText('Here:\n```json\n{"name":"Rome","founded":-753}\n```'), "not a call");
  assert.ok(!endsWithToolCallAsText('Try:\n```json\n{"name":"get_weather","arguments":{}}\n```', (name) => name === "files.read"), "not Branch's tool");
  assert.ok(!endsWithToolCallAsText('```js\nconst a = 1;\n```\nand\n```json\n{"x":1}\n```'));
});

test("only a whole reply shaped like a call is one", () => {
  for (const text of [`portun ${textCall} </tool_call>`, `portun\n${textCall}`, `${textCall}</tool_call>`, `<tool_call>${textCall}`,
    "call```json\n" + textCall + "\n```"])
    assert.ok(writesToolCallAsText(text), text);
  for (const text of ["Here is the call: " + textCall, "Two words " + textCall, `Example: ${textCall}`, "averyveryveryverylongwordindeed " + textCall])
    assert.ok(!writesToolCallAsText(text), text);
  for (const text of [textCall, `[${textCall}]`, '<tool_call>{"name":"files.read","arguments":{}}</tool_call>',
    '{"tool_calls":[{"type":"function","function":{"name":"files.read","arguments":"{}"}}]}', '{"name":"files.read","parameters":{"path":"a"}}'])
    assert.ok(writesToolCallAsText(text), text);
  for (const text of ["Here is the call: " + textCall, '{"name":"Rome","founded":-753}', '{"name":"x"}', "[]", "{}", "The answer is 42.",
    '{"kind":"task","when":"a task","what":"x","name":"y","words":"z"}',
    // A shaped answer that happens to have a name and arguments. Mutation: drop the call-keys-only rule in isCallShape → red.
    '{"name":"Pasta","arguments":["cheap","fast"],"verdict":"yes"}'])
    assert.ok(!writesToolCallAsText(text), text);
  const isTool = (name) => name === "memory.search";
  assert.ok(writesToolCallAsText(textCall, isTool));
  assert.ok(!writesToolCallAsText('{"name":"get_weather","arguments":{}}', isTool), "not one of Branch's tools");
  assert.ok(!writesToolCallAsText(`[${textCall}, {"name":"get_weather","arguments":{}}]`, isTool), "every call must name one");
});

test("offers of help and plain answers are not promises", () => {
  // qa-fixes-5: qwen2.5:7b in a room: "Alright, I'll find a fact about the Roman Empire for you." and "I will find a fact
  // about the Roman Empire. @you" (a member's call for the owner last), and "I'm looking for a fact…". Mutations: drop
  // leadIn, the owner-call strip, or the "I'm looking…" line → red.
  for (const said of ["Let me start by reading list.txt.", "I'll read the file now:", "Now let me update the file.", "I’ll check the folder.",
    "Alright, I'll find a fact about the Roman Empire for you.", "Okay, let me check the folder.", "Sure, I'll read it now.",
    "Got it — I'll search for that.", "Okay. Sure, let me look it up.", "All right, I will open the file.", "**Alright**, I'll find a fact.",
    "I will find a fact about the Roman Empire. @you", "Alright, I'll find a fact about the Roman Empire for you, @you.",
    "I'm looking for a fact about the Roman Empire. @you", "I am now searching the web.", "Okay, I'm working on it."])
    assert.equal(announcesNextStep(said), true, said);
  for (const said of ["Done. Let me know if you need anything else.", "I'll remember that.", "Now I have updated the file.",
    "Should I read it?", "I'll wait for your answer.", "Hello, I am Trunk 1.", "I'm here if you need more.", "",
    "Sure, let me know if you need anything else.", "Okay, I'll remember that.", "Alright, should I find another one?", "Sorting is done.",
    "Should I read it, @you?", "Done. @you", "I'll ask @researcher.", "I'm looking forward to it.", "I'm happy to help.",
    "I'm Trunk 1, your helper."])
    assert.equal(announcesNextStep(said), false, said);
});

test("a list of changes after a promise to make them is a promise; a list of findings is an answer", () => {
  // QA (first task): qwen2.5:7b ended with "Let's start moving the files:" and a list, and moved nothing. Mutation: drop
  // promisesListedChanges from announcesNextStep → the first is not a promise, red.
  const moves = "- holiday.jpg to ~/Downloads/Pictures\n- notes.txt to ~/Downloads/Documents";
  for (const said of [`I found six files.\nLet's start moving the files:\n${moves}`, `Next, I will move them:\n\n1. a.pdf to Documents\n2. b.jpg to Pictures`,
    `Okay, I'll sort them like this:\n${moves}`,
    // The real run's last line, after five of six moves. Mutation: drop the "will be moved" line → red.
    "I've moved `setup-tool.zip` to the `Installers` subfolder. Now, the last file, `song.mp3`, will be moved to the `Music` subfolder."])
    assert.equal(announcesNextStep(said), true, said);
  for (const said of ["The files will be moved automatically by the sync.", "All six files have been moved.", "Nothing will be deleted."])
    assert.equal(announcesNextStep(said), false, said);
  for (const said of [`Let me list what I found:\n- a.pdf\n- b.jpg`, `I moved these files:\n${moves}`, `Here is the plan:\n${moves}`,
    `Let's start moving the files:\n${moves}\nAll done.`, `Let me show you the files:\n- a.pdf`])
    assert.equal(announcesNextStep(said), false, said);
});

// ---------------------------------------------------------------- memory asks, and a local model's room

test("asking to remember, forget or recall brings the tools that save, find and delete a fact", async (t) => {
  const { requests, provider } = standIn([{ content: "Noted." }]);
  const branch = await app(t, provider);
  for (const prompt of ["Remember that my sister is called Ada", "Forget that I like tea", "What do you recall about my sister?"]) {
    await branch.runtime.run({ prompt });
    for (const name of ["memory.put", "memory.search", "memory.delete"]) assert.ok(offeredIn(requests.at(-1)).includes(name), `${prompt}: ${name}`);
  }
  await branch.runtime.run({ prompt: "Tidy my Downloads folder" });
  assert.ok(!offeredIn(requests.at(-1)).some((name) => name.startsWith("memory.")), "a file task still gets none");
});

test("a local model's room comes from what it was made for, held to this computer's memory", () => {
  const show = { model_info: { "qwen2.context_length": 32768, "qwen2.block_count": 28, "qwen2.attention.head_count": 28,
    "qwen2.attention.head_count_kv": 4, "qwen2.embedding_length": 3584 }, parameters: "num_ctx                        8192\nstop \"<|im_end|>\"" };
  const facts = roomFacts(show);
  assert.deepEqual(facts, { contextLength: 32768, bakedNumCtx: 8192, bytesPerToken: 57344 });
  const gb = 1024 ** 3;
  assert.equal(contextRoom(facts, { free: 16 * gb, total: 32 * gb }), 8192, "a sized copy runs with its own room, never more");
  assert.equal(contextRoom({ ...facts, bakedNumCtx: null }, { free: 16 * gb, total: 32 * gb }), 32768, "room enough: what it was made for");
  assert.equal(contextRoom({ ...facts, bakedNumCtx: null }, { free: 0.5 * gb, total: 8 * gb }), 4096, "a busy computer: what a share of free memory holds");
  assert.equal(contextRoom(facts, { free: 0.5 * gb, total: 8 * gb }), 8192, "a sized copy keeps its own room on a busy computer too");
  assert.equal(contextRoom({ contextLength: 131072, bakedNumCtx: null, bytesPerToken: 1024 }, { free: 64 * gb, total: 128 * gb }), 65536, "never past 64k");
});

test("Ollama is told the room, and the task's budget stays inside it", async (t) => {
  const chats = [];
  const fetchImpl = async (url, init) => {
    // A sized fixture has a fixed room even while other lanes use this computer's memory.
    if (String(url).endsWith("/api/show")) return new Response(JSON.stringify({ model_info: { "llama.context_length": 9216 },
      parameters: "num_ctx 9216" }), { status: 200 });
    chats.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ message: { content: "Hello." }, done: true, prompt_eval_count: 10, eval_count: 3 }), { status: 200 });
  };
  const provider = new OllamaProvider({ endpoint: "http://127.0.0.1:11434/v1", model: "small", fetchImpl });
  const branch = await app(t, provider);
  const run = await branch.runtime.run({ prompt: "say hello" });
  assert.equal(chats[0].options.num_ctx, 9216);
  const [budget] = events(branch, run, "context.budget");
  assert.equal(budget.limit, 9216, "the budget is the model's own room, not the built-in 20000");
});

// ---------------------------------------------------------------- Branch's own model copies (Q071)

test("the copies Branch makes of a model are neither the person's models nor its name", async () => {
  assert.equal(madeByBranch("qwen2.5:7b-branch8k"), true);
  assert.equal(madeByBranch("branch-evals-qwen2-5-7b-8192:latest"), true);
  assert.equal(madeByBranch("qwen2.5:7b"), false);
  assert.equal(modelDisplayName("ollama", "qwen2.5:7b-branch8k"), "qwen2.5:7b");
  assert.equal(modelDisplayName("ollama", "qwen2.5:7b"), null);
  const tags = { models: ["qwen2.5:7b", "qwen2.5:7b-branch8k", "branch-evals-qwen2-5-7b-8192:latest"].map((name) => ({ name, size: 1 })) };
  const fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/version") return new Response(JSON.stringify({ version: "0.34.4" }), { status: 200 });
    if (path === "/api/tags") return new Response(JSON.stringify(tags), { status: 200 });
    return new Response("{}", { status: 404 });
  };
  const inventory = await new LocalRuntimes({ fetch }).inventory();
  assert.deepEqual(inventory.ollama.models.map((model) => model.name), ["qwen2.5:7b"]);
});

test("a made-up tool in one of Branch's families, written out as text, is not the answer either (QA retest pass 2)", async (t) => {
  // qwen2.5:7b answered a recall question with only {"name": "user.fact", "arguments": {}}: no such tool, but in the
  // family of user.ask. Mutation: drop inToolFamily from the runtime's check → the JSON is the task's answer, red.
  const { requests, provider } = standIn([{ content: '{"name": "user.fact", "arguments": {}}' }, { content: "Your favourite colour is teal." }]);
  const branch = await app(t, provider);
  const run = await branch.runtime.run({ prompt: "Tell me my favourite colour." });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "Your favourite colour is teal.");
  assert.ok(!branch.store.messages(run.sessionId).some((message) => String(message.content ?? "").includes("user.fact")), "in no message");
  assert.match(requests[1].messages.at(-1).content, /tool call written out as text/);
  assert.equal(events(branch, run, "model.text_call").length, 1);
});

test("a call-shaped answer naming a family Branch has none of is still an answer (QA retest pass 2)", async (t) => {
  const { provider } = standIn([{ content: '{"name": "weather.today", "arguments": {"city": "Atlanta"}}' }]);
  const branch = await app(t, provider);
  const run = await branch.runtime.run({ prompt: "Show me an example of a weather tool call as JSON." });
  assert.equal(run.status, "completed");
  assert.match(run.output, /weather\.today/);
});
