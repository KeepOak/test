/**
 * Live steps: GET /api/runs/:id/live streams one task's step lines while it works — the reasoning summaries its model
 * streamed (held in memory only), each tool call from the moment it starts to what it came to, the question waiting on
 * the owner, and each helper's lines under it — scrubbed, and only to whoever's task it is. A scripted model streams
 * its thinking through the provider's own onReasoningDelta; nothing reaches a provider.
 *
 * Mutation notes (each turns this file red):
 * - src/runtime.ts thinkingShown: drop `thought.text = …` and the thought lines are missing ("before the answer").
 * - src/server.ts POST /api/run: drop `onTextDelta: () => undefined` and the model is never asked to stream, so no
 *   thought reaches the list ("before the answer").
 * - src/streams.ts streamLiveSteps: end on the first list (drop the `status !== "running"` test's place after the write
 *   loop, i.e. always break) and the held task's later lines never arrive; drop the `end` write and "folds" fails.
 * - src/server.ts /live: drop `app.runtime.hideSecrets(...)` and "secrets" fails (the tool's input carries it).
 * - src/runtime.ts thoughtsOf: drop `this.hideSecrets(...)` — still hidden by the route's scrub; drop both and it fails.
 * - src/server.ts /live: drop the `run.owner !== app.store.profiles.scope()` check and "household" fails.
 * - src/live-steps.ts linesOf: drop the helpers and the nested helper line is missing.
 * - src/run-steps.ts runSteps: drop the `icon` and /steps has no emoji.
 * - src/providers/cli-agent.ts complete: drop `onLine` from the spawn call and no Claude Code step arrives live; in
 *   src/live-steps.ts drop the program.step.started branch and its lines are missing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { STEP_ICONS, stepIcon, resultWords } from "../dist/live-steps.js";

/** A model stand-in: `script(request, n, model)` answers each request; `hold(signal)` waits until `open()`. */
function scripted(script) {
  const model = { name: "scripted", requests: [], gates: [] };
  model.complete = async (request) => { model.requests.push(request); return script(request, model.requests.length, model); };
  model.hold = (signal) => new Promise((resolve, reject) => {
    model.gates.push(resolve);
    signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  model.open = () => { for (const resolve of model.gates.splice(0)) resolve(); };
  return model;
}

async function fixture(t, script) {
  const root = await mkdtemp(join(tmpdir(), "branch-live-steps-"));
  const model = scripted(script);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider: model });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { model.open(); await server.close(); await app.close(); await discardTemp(root); });
  const call = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, { method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  /** Opens the live stream and keeps every event: `lists` (each steps event) and `ended` (the end event, once). */
  const watch = async (runId) => {
    const response = await fetch(`${server.url}/api/runs/${runId}/live`, { headers: { authorization: `Bearer ${server.token}` } });
    const seen = { status: response.status, lists: [], ended: null, raw: "", done: null };
    if (!response.ok) return seen;
    seen.done = (async () => {
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        seen.raw += text;
        buffer += text;
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop();
        for (const block of blocks) {
          const kind = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
          if (kind === "steps") seen.lists.push(JSON.parse(data));
          if (kind === "end") seen.ended = JSON.parse(data);
        }
      }
    })();
    return seen;
  };
  return { app, model, call, watch, server };
}
async function until(check, label, tries = 400) {
  for (let i = 0; i < tries; i++) { const value = await check(); if (value) return value; await new Promise((r) => setTimeout(r, 15)); }
  assert.fail(`Timed out: ${label}`);
}
const running = (app) => app.store.runs(app.runtime.owner).find((r) => r.status === "running");

test("while a task works, its thoughts and tool calls show as lines before the answer, then the list ends and folds", async (t) => {
  const { app, model, call, watch } = await fixture(t, async (request, n, self) => {
    if (n === 1) {
      request.onReasoningDelta?.("I should look at what is in the folder ");
      request.onReasoningDelta?.("before I answer.");
      return { content: "", toolCalls: [{ id: "c1", name: "files.list", arguments: JSON.stringify({ path: "." }) }] };
    }
    request.onReasoningDelta?.("Now I know what is there.");
    await self.hold(request.signal);
    return { content: "The folder is empty.", toolCalls: [] };
  });
  const answer = call("run", { prompt: "what is in my folder?" });
  const run = await until(() => running(app), "the task started");
  const seen = await watch(run.id);
  assert.equal(seen.status, 200);
  // The model is held on its second call: everything below arrives before the answer exists.
  const list = await until(() => seen.lists.find((l) => l.steps.some((s) => s.kind === "think" && s.state === "running")), "the second thought, live");
  assert.equal(list.status, "running", "the task is still working");
  const kinds = list.steps.map((s) => `${s.kind}:${s.state}`);
  assert.deepEqual(kinds, ["think:done", "tool:done", "think:running"], JSON.stringify(list.steps));
  const [first, tool, second] = list.steps;
  assert.equal(first.label, "I should look at what is in the folder before I answer.");
  assert.equal(first.icon, STEP_ICONS.thinking);
  assert.equal(second.label, "Now I know what is there.");
  assert.equal(tool.label, "Looking through .");
  assert.equal(tool.icon, STEP_ICONS.files);
  assert.equal(tool.result, "0 items", "what it came to, from the tool's own answer");
  assert.equal(typeof tool.seconds, "number");
  assert.match(tool.input, /"path"/, "the call's input, for the tap to expand");
  assert.equal(seen.ended, null, "not ended while the task works");
  assert.equal(app.store.messages(run.sessionId).some((m) => m.role === "assistant" && /empty/.test(m.content ?? "")), false, "no answer yet");

  model.open();
  const done = (await answer).body;
  assert.equal(done.status, "completed");
  await seen.done;
  assert.deepEqual(seen.ended, { status: "completed" }, "the list ends when the task does, so the window folds it");
  assert.equal(seen.lists.at(-1).status, "completed");
  // Thoughts are never written down: the record and the conversation hold none of them.
  const record = JSON.stringify(app.store.events(run.id)) + JSON.stringify(app.store.messages(run.sessionId));
  assert.doesNotMatch(record, /I should look at what is in the folder/);
  // The folded steps read the record, each with the same emoji as live.
  const steps = (await call(`runs/${run.id}/steps`)).body.steps;
  assert.equal(steps.find((s) => s.kind === "tool").icon, STEP_ICONS.files);
  assert.equal(steps.find((s) => s.kind === "model").icon, STEP_ICONS.thinking);
});

test("secrets never leave in a line, its input or a thought, and a question waits inline", async (t) => {
  const { app, call, watch } = await fixture(t, async (request, n) => {
    if (n === 1) {
      request.onReasoningDelta?.("The password is hunter2, so I will save it.");
      return { content: "", toolCalls: [{ id: "w1", name: "files.write", arguments: JSON.stringify({ path: "notes.txt", content: "hunter2" }) }] };
    }
    return { content: "Saved.", toolCalls: [] };
  });
  app.runtime.hideSecrets = (value) => JSON.parse(JSON.stringify(value).replaceAll("hunter2", "[hidden]"));
  savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [{ tool: "files.write", decision: "ask" }] });
  const answer = call("run", { prompt: "save my note" });
  const run = await until(() => app.store.runs(app.runtime.owner)[0], "the task started");
  const seen = await watch(run.id);
  assert.equal((await answer).body.status, "needs_input", "control: it stopped to ask");
  await seen.done;
  assert.ok(seen.lists.length, "at least one list arrived");
  assert.doesNotMatch(seen.raw, /hunter2/, "nothing in the stream carries the secret");
  const last = seen.lists.at(-1);
  const ask = last.steps.find((s) => s.kind === "ask");
  assert.ok(ask, JSON.stringify(last.steps));
  assert.equal(ask.state, "waiting");
  assert.equal(ask.icon, STEP_ICONS.approval);
  assert.ok(last.steps.some((s) => s.kind === "think" && /\[hidden\]/.test(s.label)), "the thought is shown with the secret taken out");
});

test("household: a person at the window never opens the owner's live steps", async (t) => {
  const { app, model, call } = await fixture(t, async (request, _n, self) => { await self.hold(request.signal); return { content: "ok", toolCalls: [] }; });
  const answer = call("run", { prompt: "OWNER PRIVATE: plan the surprise" });
  const run = await until(() => running(app), "the task started");
  await until(() => model.gates.length, "the model is held");
  const person = (await call("profiles", { name: "Sam", pin: "2468" })).body;
  assert.equal((await call("profiles/switch", { profileId: person.id, pin: "2468" })).status, 200);
  const refused = await call(`runs/${run.id}/live`);
  assert.equal(refused.status, 404, "the owner's task reads as not found");
  model.open();
  await answer;
});

test("a helper's lines sit under the helper; one emoji table serves every kind of step", async (t) => {
  const { app } = await fixture(t, async () => ({ content: "done", toolCalls: [] }));
  const { liveSteps } = await import("../dist/live-steps.js");
  const owner = app.runtime.owner, parent = app.store.createRun(owner, "compare the invoices");
  const child = app.store.createRun(owner, "read the August invoice");
  app.store.event(child.id, "run.started", { parentRunId: parent.id, agent: "mode:code" });
  app.store.event(child.id, "tool.started", { name: "web.fetch", id: "h1", label: "Reading example.com" });
  app.store.event(child.id, "tool.completed", { name: "web.fetch", id: "h1", result: { text: "one two three" } });
  const other = app.store.createRun(owner, "an unrelated task");
  app.store.event(other.id, "run.started", {});
  const deps = { thoughtsOf: () => [], waiting: [], helperName: () => "Scout" };
  const lines = liveSteps(app.store, parent.id, deps).steps;
  assert.deepEqual(lines.map((l) => [l.kind, l.depth, l.label]), [["helper", 0, "Scout"], ["tool", 1, "Reading example.com"]]);
  assert.equal(lines[0].icon, STEP_ICONS.helper);
  assert.equal(lines[1].icon, STEP_ICONS.page);
  assert.equal(lines[1].result, "Read 3 words");
  // The table: named tools by what they do, anything else the plain tool emoji.
  assert.equal(stepIcon("tool", "web.search"), STEP_ICONS.search);
  assert.equal(stepIcon("tool", "shell.execute"), STEP_ICONS.command);
  assert.equal(stepIcon("tool", "memory.save"), STEP_ICONS.memory);
  assert.equal(stepIcon("tool", "browser.click"), STEP_ICONS.browser);
  assert.equal(stepIcon("tool", "something.new"), STEP_ICONS.tool);
  assert.equal(stepIcon("ask"), STEP_ICONS.approval);
  // Result words only where the answer's shape is known; never a guess.
  assert.equal(resultWords("web.search", [{}, {}, {}])?.english, "Found 3 results");
  assert.equal(resultWords("something.new", { anything: 1 }), null);
});

test("Claude Code's stream-json thinking and tools become live lines, in Branch's words and emoji", async (t) => {
  const { streamJsonStep, CliAgentProvider, cliAgentCatalog } = await import("../dist/providers/cli-agent.js");
  const heard = { thought: "", steps: [] };
  const request = { onReasoningDelta: (text) => { heard.thought += text; }, onToolActivity: (step) => heard.steps.push(step) };
  const lines = [
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "Check the tests first." }, { type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok", is_error: false }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "tu2", name: "WebFetch", input: { url: "https://example.com/a" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: "refused", is_error: true }] } },
    { type: "result", subtype: "success", result: "All green." },
  ].map((line) => JSON.stringify(line));
  for (const line of [...lines, "not json"]) streamJsonStep(line, request);
  assert.equal(heard.thought, "Check the tests first.\n");
  assert.deepEqual(heard.steps.map((s) => [s.id, s.name, s.label, Boolean(s.done), s.error ?? null]), [
    ["tu1", "shell.execute", "Running npm test", false, null], ["tu1", "", "", true, null],
    ["tu2", "web.fetch", "Reading example.com", false, null], ["tu2", "", "", true, "refused"]]);
  // What came back rides with the finish, so a tapped line shows its output (Codex review P2).
  assert.equal(heard.steps[1].output, "ok");
  // The provider hands the program's lines over as they are printed, and still answers from the whole output.
  const row = cliAgentCatalog.find((r) => r.id === "claude-code");
  const spawn = async (_row, _prompt, _signal, _limits, _home, onLine) => { for (const line of lines) onLine?.(line); return { code: 0, stdout: lines.join("\n"), stderr: "" }; };
  const provider = new CliAgentProvider(row, {}, spawn);
  const seen = [];
  const done = await provider.complete({ messages: [{ role: "user", content: "run the tests" }], tools: [], maxTokens: 100, signal: new AbortController().signal,
    onReasoningDelta: () => {}, onToolActivity: (step) => seen.push(step) });
  assert.equal(done.content, "All green.");
  assert.equal(seen.length, 4, "each step arrived while the program ran");
  // Written down as program steps, they read as lines with the same emoji as Branch's own tools.
  const { app } = await fixture(t, async () => ({ content: "ok", toolCalls: [] }));
  const { liveSteps } = await import("../dist/live-steps.js");
  const run = app.store.createRun(app.runtime.owner, "run the tests");
  app.store.event(run.id, "program.step.started", { id: "tu1", name: "shell.execute", label: "Running npm test", input: "{\"command\":\"npm test\"}" });
  app.store.event(run.id, "program.step.finished", { id: "tu1", output: "ok" });
  app.store.event(run.id, "program.step.started", { id: "tu2", name: "web.fetch", label: "Reading example.com", input: "" });
  app.store.event(run.id, "program.step.finished", { id: "tu2", error: "refused" });
  const got = liveSteps(app.store, run.id, { thoughtsOf: () => [], waiting: [], helperName: () => null }).steps;
  assert.deepEqual(got.map((l) => [l.icon, l.label, l.state, l.result]), [
    [STEP_ICONS.command, "Running npm test", "done", null], [STEP_ICONS.page, "Reading example.com", "failed", "refused"]]);
  assert.equal(got[0].output, "ok", "the finished line carries what came back");
});

// Mutations: in src/providers/cli-agent.ts complete, drop `codexJsonSteps(request)` and no Codex step arrives live; in
// codexJsonSteps drop the thread from the id and the second run's step takes the first run's id; in answerFrom drop the
// Codex branch and the answer is the raw event lines.
test("Codex's exec --json reasoning and items become live lines, each id held to its run, and its answer is its last message", async () => {
  const { codexJsonSteps, CliAgentProvider, cliAgentCatalog, answerFrom } = await import("../dist/providers/cli-agent.js");
  const heard = { thought: "", steps: [] };
  const request = { onReasoningDelta: (text) => { heard.thought += text; }, onToolActivity: (step) => heard.steps.push(step) };
  const lines = [
    { type: "thread.started", thread_id: "th-1" },
    { type: "turn.started" },
    { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "**Look at the tests**" } },
    { type: "item.started", item: { id: "item_1", type: "command_execution", command: "bash -lc 'npm test'", status: "in_progress" } },
    { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "bash -lc 'npm test'", aggregated_output: "1 failed", exit_code: 1, status: "failed" } },
    { type: "item.completed", item: { id: "item_2", type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }], status: "completed" } },
    { type: "item.started", item: { id: "item_3", type: "web_search", query: "node test runner" } },
    { type: "item.completed", item: { id: "item_3", type: "web_search", query: "node test runner" } },
    { type: "item.completed", item: { id: "item_4", type: "agent_message", text: "Fixed the failing test." } },
    { type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } },
  ].map((line) => JSON.stringify(line));
  const read = codexJsonSteps(request);
  for (const line of [...lines, "not json"]) read(line);
  assert.equal(heard.thought, "**Look at the tests**\n");
  assert.deepEqual(heard.steps.map((s) => [s.id, s.name, s.label, Boolean(s.done), s.error ?? null]), [
    ["th-1:item_1", "shell.execute", "Running bash -lc 'npm test'", false, null], ["th-1:item_1", "", "", true, "Stopped with exit code 1"],
    ["th-1:item_2", "files.edit", "Changing src/a.ts", false, null], ["th-1:item_2", "", "", true, null],
    ["th-1:item_3", "web.search", "Searching the web for “node test runner”", false, null], ["th-1:item_3", "", "", true, null]]);
  // A second run of the program starts its item ids again; its steps are its own lines, not the first run's.
  const again = [];
  const second = codexJsonSteps({ onToolActivity: (step) => again.push(step) });
  second(JSON.stringify({ type: "thread.started", thread_id: "th-2" }));
  second(JSON.stringify({ type: "item.started", item: { id: "item_1", type: "command_execution", command: "ls" } }));
  assert.equal(again[0].id, "th-2:item_1");
  // The provider reads the lines as they are printed and answers with the last agent_message, not the raw events.
  const row = cliAgentCatalog.find((r) => r.id === "codex");
  assert.equal(answerFrom(row, lines.join("\n")), "Fixed the failing test.");
  const spawn = async (_row, _prompt, _signal, _limits, _home, onLine) => { for (const line of lines) onLine?.(line); return { code: 0, stdout: lines.join("\n"), stderr: "" }; };
  const seen = [];
  const done = await new CliAgentProvider(row, {}, spawn).complete({ messages: [{ role: "user", content: "fix the test" }], tools: [], maxTokens: 100,
    signal: new AbortController().signal, onReasoningDelta: () => {}, onToolActivity: (step) => seen.push(step) });
  assert.equal(done.content, "Fixed the failing test.");
  assert.equal(seen.length, 6, "each step arrived while the program ran");
});

// Mutation: in src/runtime.ts programStep, shorten the label before hideSecrets and part of the secret is written down.
test("a program's step is scrubbed whole before it is shortened, so no part of a secret is written down", async (t) => {
  const { streamJsonStep } = await import("../dist/providers/cli-agent.js");
  const secret = "cutsecret-horse-battery-staple-9731-zebra"; // not-a-real-secret: a planted fixture, here to prove it gets blanked out
  const command = `echo ${"a".repeat(55)} ${secret} ${"b".repeat(760)} ${secret}`;
  const { app, call } = await fixture(t, async (request) => {
    streamJsonStep(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "cut1", name: "Bash", input: { command } }] } }), request);
    streamJsonStep(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "cut1", is_error: true, content: `${"c".repeat(150)} ${secret}` }] } }), request);
    return { content: "Done.", toolCalls: [] };
  });
  app.store.secrets.scrubber.remember("CUT_KEY", secret);
  const done = (await call("run", { prompt: "run it" })).body;
  assert.equal(done.status, "completed");
  const written = app.store.events(done.id).filter((e) => e.kind.startsWith("program.step."));
  assert.equal(written.length, 2, "control: both halves of the step were written down");
  assert.ok(written[0].data.label.length <= 121 && written[0].data.input.length <= 801, "and shortened");
  assert.doesNotMatch(JSON.stringify(written), /cutsecret/, "no piece of the secret is left where a cut fell");
});

// Mutation: in src/server.ts /live, drop `app.runtime.thoughtsChanged` from the list's mark and the thought never
// arrives on the open stream (nothing else changes to rebuild the list).
test("a thought reaches an open stream by itself, while nothing else happens", async (t) => {
  const { app, model, call, watch } = await fixture(t, async (request, _n, self) => {
    await self.hold(request.signal);
    request.onReasoningDelta?.("Thinking after the stream opened.");
    await self.hold(request.signal);
    return { content: "ok", toolCalls: [] };
  });
  const answer = call("run", { prompt: "think it over" });
  const run = await until(() => running(app), "the task started");
  await until(() => model.gates.length, "the model is held");
  const seen = await watch(run.id);
  await until(() => seen.lists.length, "the first list");
  model.open();
  await until(() => seen.lists.some((l) => l.steps.some((s) => s.kind === "think" && /after the stream opened/.test(s.label))), "the thought, live");
  await until(() => model.gates.length, "held again");
  model.open();
  await answer;
  await seen.done;
});

// Mutation: in src/runtime.ts drop `&& !preset.provider.keepsOwnTime` and the silence watchdog stops the quiet program.
test("a program on this computer that is quiet for longer than the silence limit still finishes, its steps heard", async (t) => {
  const { CliAgentProvider, cliAgentCatalog } = await import("../dist/providers/cli-agent.js");
  const lines = [
    { type: "thread.started", thread_id: "th-q" },
    { type: "item.started", item: { id: "item_1", type: "command_execution", command: "npm test" } },
    { type: "item.completed", item: { id: "item_1", type: "command_execution", command: "npm test", exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "All green." } },
  ].map((line) => JSON.stringify(line));
  const spawn = async (_row, _prompt, signal, _limits, _home, onLine) => {
    onLine?.(lines[0]); onLine?.(lines[1]);
    await new Promise((resolve) => setTimeout(resolve, 900)); // a long step: nothing printed meanwhile
    // Stopped from outside, the real program is killed and says nothing more (runCliAgent).
    if (signal.aborted) return { code: null, stdout: "", stderr: "" };
    onLine?.(lines[2]); onLine?.(lines[3]);
    return { code: 0, stdout: lines.join("\n"), stderr: "" };
  };
  const root = await mkdtemp(join(tmpdir(), "branch-live-steps-quiet-"));
  const provider = new CliAgentProvider(cliAgentCatalog.find((r) => r.id === "codex"), {}, spawn);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  app.runtime.reliability.modelStallMs = 200;
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const response = await fetch(`${server.url}/api/run`, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "run the tests" }) });
  const run = await response.json();
  assert.equal(run.status, "completed", JSON.stringify(run).slice(0, 400));
  assert.equal(run.output, "All green.");
  const steps = app.store.events(run.id).filter((e) => e.kind.startsWith("program.step."));
  assert.deepEqual(steps.map((e) => e.kind), ["program.step.started", "program.step.finished"], "its step was heard while it ran");
});
