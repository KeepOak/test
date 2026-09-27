import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { OpenAIProvider } from "../dist/providers.js";
import { OllamaProvider } from "../dist/providers/ollama.js";
import { produced, producedNothing } from "../dist/empty-answer.js";

/**
 * mac7/empty-completion. The first real measurement against a local 4B model
 * (experiments/scoreboard/results.jsonl) recorded three runs that ended `completed`, with no error
 * and an empty answer — Branch reporting success having produced nothing. These hold the two
 * halves of that: the stream parser that dropped a reasoning model's thinking, and the guard that
 * refuses to call an empty result a success whatever the cause.
 */

async function fixture(t, provider) {
  const root = await mkdtemp(join(tmpdir(), "branch-empty-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "private"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, workspace: join(root, "workspace") };
}
const calls = (...responses) => ({
  name: "fixture",
  async complete() { return responses.shift() ?? { content: "done", toolCalls: [] }; },
});
const sse = (data) => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\r\n\r\n`;
const chunk = (delta, finish = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });

async function sseFixture(t, frames) {
  const server = createServer(async (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    for (const frame of frames) { res.write(frame); await delay(1); }
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}/v1`;
}

test("a round that produces nothing ends as a failure with a sentence, not completed", async (t) => {
  // mac7/coding-gap: only a reply that thought is nudged; one with no thinking is judged at once, as before.
  const { app } = await fixture(t, calls({ content: "", toolCalls: [] }));
  const run = await app.runtime.run({ prompt: "fix the failing test" });
  assert.notEqual(run.status, "completed");
  assert.equal(run.status, "failed");
  assert.match(run.output, /empty reply|nothing was done/i);
  assert.ok(run.output.trim().length > 40, "the failure says what happened in a sentence");
  assert.ok(app.store.events(run.id).some((e) => e.kind === "run.produced_nothing"));
});

test("a model that spends its whole reply thinking says so rather than reporting success", async (t) => {
  // mac7/coding-gap: an empty reply is nudged twice before the task is judged, so the model stays empty three times here.
  const thought = () => ({ content: "", toolCalls: [], reasoningChars: 6200 });
  const { app } = await fixture(t, calls(thought(), thought(), thought()));
  const run = await app.runtime.run({ prompt: "write summary.md" });
  assert.equal(run.status, "failed");
  assert.match(run.output, /thinking/i);
  assert.match(run.output, /18,600/, "three replies of 6,200 characters each, all counted");
  assert.match(run.output, /larger model/i);
});

test("a task whose tools all failed and then said nothing is still a failure", async (t) => {
  // integrate/empty-completion: a tool that *worked* is work done (tests/empty-completion-adversarial.test.mjs);
  // only a task whose every tool failed and that said nothing is empty.
  const { app } = await fixture(t, calls(
    { content: "", toolCalls: [{ id: "one", name: "files.write", arguments: "{\"path\": \"a.txt\", cont" }] },
    { content: "", toolCalls: [] },
    // Dogfood A7 asks an empty reply after a tool twice more for its answer; this model stays silent through both.
    { content: "", toolCalls: [] },
    { content: "", toolCalls: [] },
  ));
  const run = await app.runtime.run({ prompt: "write a.txt" });
  assert.equal(run.status, "failed");
  assert.match(run.output, /stopped without writing an answer/i);
});

test("a refused tool call surfaces to the model and in the record", async (t) => {
  const { app } = await fixture(t, calls(
    { content: "", toolCalls: [{ id: "one", name: "no.such.tool", arguments: "{}" }] },
    { content: "I could not run that.", toolCalls: [] },
  ));
  const run = await app.runtime.run({ prompt: "run the tests" });
  const failed = app.store.events(run.id).filter((e) => e.kind === "tool.failed");
  assert.equal(failed.length, 1);
  assert.match(String(failed[0].data.error), /no.such.tool|unknown|not/i);
  const handed = app.store.messages(run.sessionId).filter((m) => m.role === "tool");
  assert.equal(handed.length, 1);
  assert.match(handed[0].content, /"ok":false/);
  assert.equal(run.status, "completed");
});

test("a malformed tool call from a weak model surfaces instead of ending the round quietly", async (t) => {
  const { app } = await fixture(t, calls(
    { content: "", toolCalls: [{ id: "one", name: "files.write", arguments: "{\"path\": \"a.txt\", cont" }] },
    { content: "That did not parse.", toolCalls: [] },
  ));
  const run = await app.runtime.run({ prompt: "write a.txt" });
  assert.ok(app.store.events(run.id).some((e) => e.kind === "tool.failed" && /JSON/i.test(String(e.data.error))));
  assert.match(app.store.messages(run.sessionId).find((m) => m.role === "tool").content, /"ok":false/);
  assert.equal(run.status, "completed");
});

test("the file-changing path still works: a written file is a finished task", async (t) => {
  const { app, workspace } = await fixture(t, calls(
    { content: "", toolCalls: [{ id: "one", name: "files.write", arguments: JSON.stringify({ path: "report.mjs", content: "console.log(1)\n" }) }] },
    { content: "Wrote report.mjs.", toolCalls: [] },
  ));
  const run = await app.runtime.run({ prompt: "write report.mjs" });
  assert.equal(run.status, "completed");
  assert.equal(await readFile(join(workspace, "report.mjs"), "utf8"), "console.log(1)\n");
});

test("the OpenAI-shaped stream keeps a reasoning model's thinking instead of dropping it", async (t) => {
  const endpoint = await sseFixture(t, [
    sse(chunk({ reasoning_content: "Let me look at the test. " })),
    sse(chunk({ reasoning: "It sums the wrong column." })),
    sse(chunk({ content: "The bug is on line 4." }, "stop")),
    sse("[DONE]"),
  ]);
  const seen = [], thought = [];
  const completion = await new OpenAIProvider({ endpoint, model: "fixture", apiKey: "k" }).complete({
    messages: [{ role: "user", content: "fix it" }], tools: [], maxTokens: 100,
    signal: new AbortController().signal,
    onTextDelta: (text) => seen.push(text),
    onReasoningDelta: (text) => thought.push(text),
  });
  assert.equal(completion.content, "The bug is on line 4.");
  assert.equal(completion.reasoningChars, 50);
  assert.deepEqual(seen, ["The bug is on line 4."], "thinking never reaches the page");
  assert.equal(thought.length, 2, "thinking reaches whatever listens for it");
});

test("a reply that is all thinking comes back as thinking, not as silence", async (t) => {
  const endpoint = await sseFixture(t, [
    sse(chunk({ reasoning_content: "x".repeat(300) })),
    sse(chunk({ content: "" }, "stop")),
    sse("[DONE]"),
  ]);
  const completion = await new OpenAIProvider({ endpoint, model: "fixture", apiKey: "k" }).complete({
    messages: [{ role: "user", content: "fix it" }], tools: [], maxTokens: 100,
    signal: new AbortController().signal, onTextDelta: () => undefined,
  });
  assert.equal(completion.content, "");
  assert.equal(completion.reasoningChars, 300);
});

test("Ollama's own thinking field is read too", async (t) => {
  const server = createServer(async (_req, res) => {
    res.setHeader("Content-Type", "application/x-ndjson");
    res.write(JSON.stringify({ message: { content: "", thinking: "hmm" } }) + "\n");
    res.write(JSON.stringify({ message: { content: "ok" }, done: true, eval_count: 3 }) + "\n");
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const thought = [];
  const completion = await new OllamaProvider({ endpoint: `http://127.0.0.1:${server.address().port}`, model: "qwen3" }).complete({
    messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 50,
    signal: new AbortController().signal,
    onTextDelta: () => undefined, onReasoningDelta: (text) => thought.push(text),
  });
  assert.equal(completion.content, "ok");
  assert.equal(completion.reasoningChars, 3);
  assert.deepEqual(thought, ["hmm"]);
});

test("thinking resets the silence clock, so a model that is visibly working is not called stalled", async (t) => {
  let stalls = 0;
  const thinker = {
    name: "thinker",
    async complete(request) {
      // Silent in words for far longer than the 40 ms watchdog, but thinking the whole time. The
      // repeating provider pulse is already scheduled when each rearmed watchdog starts. This tests
      // the wiring, not whether a loaded build machine can resolve two sequential timers on time.
      await new Promise((resolve, reject) => {
        let beats = 0;
        const done = () => { clearInterval(pulse); request.signal.removeEventListener("abort", aborted); };
        const aborted = () => { done(); reject(request.signal.reason); };
        const pulse = setInterval(() => {
          request.onReasoningDelta?.(".");
          if (++beats < 8) return;
          done();
          resolve();
        }, 15);
        request.signal.addEventListener("abort", aborted, { once: true });
      });
      return { content: "done thinking", toolCalls: [], reasoningChars: 8 };
    },
  };
  const root = await mkdtemp(join(tmpdir(), "branch-empty-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "private"),
    provider: thinker, reliability: { modelStallMs: 5000 } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.runtime.reliability.modelStallMs = 40;
  const run = await app.runtime.run({ prompt: "think hard", onTextDelta: () => undefined });
  app.store.events(run.id).forEach((e) => { if (e.kind === "model.stalled") stalls++; });
  assert.equal(stalls, 0, "a thinking model is not a stalled one");
  assert.equal(run.status, "completed");
  assert.equal(run.output, "done thinking");
});

test("the guard reads only what the task recorded", () => {
  const events = (...rows) => rows.map((row, id) => ({ id, runId: "r", createdAt: "", ...row }));
  assert.deepEqual(
    produced(events({ kind: "tool.started", data: {} }, { kind: "model.completed", data: { reasoningChars: 12, model: "qwen3:4b" } })),
    { toolCalls: 0, toolResults: 0, filesChanged: 0, reasoningChars: 12, model: "qwen3:4b" },
  );
  assert.equal(producedNothing("completed", "an answer", { toolCalls: 0, reasoningChars: 0, model: null }), null);
  assert.equal(producedNothing("failed", "", { toolCalls: 0, reasoningChars: 0, model: null }), null,
    "a task that already said why it failed is left alone");
  assert.equal(producedNothing("needs_input", "", { toolCalls: 0, reasoningChars: 0, model: null }), null);
  assert.match(producedNothing("completed", "   ", { toolCalls: 0, reasoningChars: 0, model: "qwen3:4b" }), /qwen3:4b/);
  // qa-fixes-3 (Q062): the service reported output tokens, yet nothing arrived: said as the service keeping it back.
  // Mutation: drop the reportedOutput branch in producedNothing → "returned an empty reply", red.
  assert.match(producedNothing("completed", "", { toolCalls: 0, reasoningChars: 0, model: "qwen2.5:7b", reportedOutput: 53 }),
    /^The model \(qwen2\.5:7b\) wrote a reply, but the model service passed none of it on/);
  assert.equal(produced([{ kind: "model.completed", data: { reported: { input: 2997, output: 53 } } }]).reportedOutput, 53);
  // qa-fixes-4: "configured" is what a preset is called when no model was named for it, never a model's name.
  // Mutation: keep every name in produced → "The model (configured)", red.
  const unnamed = produced([{ kind: "model.completed", data: { model: "configured", reported: { output: 53 } } }]);
  assert.equal(unnamed.model, null);
  assert.match(producedNothing("completed", "", unnamed), /^The model wrote a reply, but the model service passed none of it on/);
});

test("a connection handed in without a preset is named by the model it asks for", async (t) => {
  // qa-fixes-4: the empty-reply sentence said "(configured)" for qwen2.5:7b. Mutation: drop `provider.model` in defaultPreset → red.
  const provider = new OpenAIProvider({ endpoint: "http://127.0.0.1:9/v1", model: "qwen2.5:7b", apiKey: "local" });
  const root = await mkdtemp(join(tmpdir(), "branch-named-model-"));
  const app = await createBranch({ workspace: join(root, "ws"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  assert.equal(app.runtime.models.default.model, "qwen2.5:7b");
  assert.equal(new OllamaProvider({ endpoint: "http://127.0.0.1:9", model: "llama3.2" }).model, "llama3.2");
});

test("a manual tool action that returns nothing is not read as an empty success", async (t) => {
  const { app, workspace } = await fixture(t, calls());
  await writeFile(join(workspace, "seen.txt"), "hello\n");
  const result = await app.runtime.executeTool("files.read", { path: "seen.txt" });
  assert.match(JSON.stringify(result), /hello/);
});
