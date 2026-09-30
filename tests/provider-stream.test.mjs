import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import { OpenAIProvider, AnthropicProvider } from "../dist/providers.js";
import { OpenAIStream } from "../dist/provider-stream.js";
import { createBranch } from "../dist/index.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function fixture(t, handler) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    const payload = JSON.parse(body);
    requests.push(payload);
    res.setHeader("Content-Type", "text/event-stream");
    await handler(payload, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { endpoint: `http://127.0.0.1:${server.address().port}/v1`, requests };
}
const options = (endpoint) => ({ endpoint, model: "fixture", apiKey: "fixture-secret" });
const request = {
  messages: [{ role: "user", content: "Read" }],
  tools: [{ name: "files.read", description: "Read", parameters: { type: "object" } }],
  signal: new AbortController().signal, maxTokens: 100,
};
const sse = (data) => `data: ${typeof data === "string" ? data : JSON.stringify(data)}\r\n\r\n`;
const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });

test("OpenAI accepts repeated empty terminal choice before DONE", async (t) => {
  const f = await fixture(t, async (_body, res) => res.end(
    sse(chunk({ content: "answer" })) + sse(chunk({}, "stop")) +
    sse(chunk({}, "stop")) + sse({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } }) +
    sse("[DONE]")));
  const deltas = [];
  const result = await new OpenAIProvider(options(f.endpoint)).complete({ ...request,
    onTextDelta: (text) => deltas.push(text) });
  assert.equal(result.content, "answer");
  assert.deepEqual(result.toolCalls, []);
  assert.deepEqual(result.usage, { input: 3, output: 2 });
  assert.deepEqual(deltas, ["answer"]);
});

test("OpenAI rejects content or tool fragments after finish even with repeated terminal reason", async (t) => {
  for (const delta of [
    { content: "late" },
    { reasoning_content: "late thinking" },
    { tool_calls: [{ index: 0, id: "late", function: { name: "files.read", arguments: "{}" } }] },
  ]) {
    const stream = new OpenAIStream(() => {});
    stream.consume(JSON.stringify(chunk({ content: "answer" })));
    stream.consume(JSON.stringify(chunk({}, "stop")));
    assert.throws(() => stream.consume(JSON.stringify(chunk(delta, "stop"))),
      /Provider sent choices after finish/);
  }
});

async function runtimeFixture(t, provider) {
  const scratch = join(tmpdir(), "Codex-session-files");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "branch-stream-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "private"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}

function accountedFrames(kind, limited) {
  if (kind === "openai") return [
    sse(chunk({ content: "uncommitted fragment" }, limited ? "length" : "stop")),
    sse({ choices: [], usage: { prompt_tokens: 33, completion_tokens: 17 } }),
  ];
  return [
    sse({ type: "message_start", message: { usage: { input_tokens: 33, output_tokens: 1 } } }),
    sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "uncommitted fragment" } }),
    sse({ type: "content_block_stop", index: 0 }),
    sse({ type: "message_delta", delta: { stop_reason: limited ? "max_tokens" : "end_turn" }, usage: { output_tokens: 17 } }),
  ];
}

test("OpenAI SSE delivers genuine text before completion and assembles fragmented tool calls/usage", async (t) => {
  const release = deferred(), received = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t, async (body, res) => {
    const frame = Buffer.from(sse(chunk({ content: "Live ☃" })));
    const split = frame.indexOf(Buffer.from("☃")) + 1;
    res.write(frame.subarray(0, split));
    res.write(frame.subarray(split, frame.length - 3));
    res.write(frame.subarray(frame.length - 3));
    await release.promise;
    res.write(sse(chunk({ tool_calls: [{ index: 0, id: "call1", function: { name: body.tools[0].function.name, arguments: '{"pa' } }] })));
    res.write(sse(chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"x"}' } }] }, "tool_calls")));
    res.write(sse({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } }));
    res.end(sse("[DONE]"));
  });
  let settled = false;
  const deltas = [];
  const pending = new OpenAIProvider(options(f.endpoint)).complete({ ...request,
    onTextDelta: (text) => { deltas.push(text); received.resolve(); } }).then((value) => { settled = true; return value; });
  await received.promise;
  assert.equal(settled, false);
  assert.deepEqual(deltas, ["Live ☃"]);
  release.resolve();
  const result = await pending;
  assert.equal(result.content, "Live ☃");
  assert.deepEqual(result.toolCalls, [{ id: "call1", name: "files.read", arguments: '{"path":"x"}' }]);
  assert.deepEqual(result.usage, { input: 12, output: 7 });
  assert.equal(f.requests[0].stream, true);
  assert.deepEqual(f.requests[0].stream_options, { include_usage: true });
});

test("Anthropic SSE streams text blocks and assembles tool input with final usage", async (t) => {
  const release = deferred(), received = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t, async (body, res) => {
    res.write(sse({ type: "message_start", message: { usage: { input_tokens: 15, output_tokens: 1 } } }));
    res.write(sse({ type: "ping" }));
    res.write(sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
    res.write(sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading now" } }));
    await release.promise;
    res.write(sse({ type: "content_block_stop", index: 0 }));
    res.write(sse({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tool1", name: body.tools[0].name, input: {} } }));
    for (const partial_json of ['{"path":', '"x"}'])
      res.write(sse({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json } }));
    res.write(sse({ type: "content_block_stop", index: 1 }));
    res.write(sse({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }));
    res.end(sse({ type: "message_stop" }));
  });
  let settled = false;
  const deltas = [];
  const pending = new AnthropicProvider(options(f.endpoint)).complete({ ...request,
    onTextDelta: (text) => { deltas.push(text); received.resolve(); } }).then((value) => { settled = true; return value; });
  await received.promise;
  assert.equal(settled, false);
  assert.deepEqual(deltas, ["Reading now"]);
  release.resolve();
  const result = await pending;
  assert.equal(result.content, "Reading now");
  assert.deepEqual(result.toolCalls, [{ id: "tool1", name: "files.read", arguments: '{"path":"x"}' }]);
  assert.deepEqual(result.usage, { input: 15, output: 9 });
  assert.equal(f.requests[0].stream, true);
});

for (const [kind, Provider] of [["openai", OpenAIProvider], ["anthropic", AnthropicProvider]]) {
  test(`${kind} accepts CR-only SSE delimiters with the final CR at EOF`, async (t) => {
    const f = await fixture(t, async (_body, res) => {
      const ending = sse(kind === "openai" ? "[DONE]" : { type: "message_stop" });
      res.end((accountedFrames(kind, false).join("") + ending).replaceAll("\r\n", "\r"));
    });
    const deltas = [];
    const result = await new Provider(options(f.endpoint)).complete({ ...request, onTextDelta: (text) => deltas.push(text) });
    assert.equal(result.content, "uncommitted fragment");
    assert.deepEqual(result.usage, { input: 33, output: 17 });
    assert.deepEqual(deltas, ["uncommitted fragment"]);
  });
}

test("OpenAI rejects truncated, malformed, oversized, and token-limited streams", async (t) => {
  for (const response of [
    sse(chunk({ content: "partial" })),
    sse(chunk({ content: "partial" }, "length")) + sse("[DONE]"),
    sse({ choices: "invalid" }),
    "data: " + "x".repeat(1048576),
  ]) {
    const f = await fixture(t, async (_body, res) => res.end(response));
    await assert.rejects(new OpenAIProvider(options(f.endpoint)).complete({ ...request, onTextDelta: () => {} }));
  }
});

test("Anthropic rejects incomplete blocks and in-band errors without exposing provider details", async (t) => {
  for (const response of [
    sse({ type: "error", error: { message: "fixture-secret" } }),
    sse({ type: "message_start", message: {} }) +
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "partial" } }) +
      sse({ type: "message_delta", delta: { stop_reason: "end_turn" } }) + sse({ type: "message_stop" }),
  ]) {
    const f = await fixture(t, async (_body, res) => res.end(response));
    await assert.rejects(new AnthropicProvider(options(f.endpoint)).complete({ ...request, onTextDelta: () => {} }),
      (error) => !error.message.includes("fixture-secret"));
  }
});

test("cancelling a real SSE response leaves partial text uncommitted and usage attempt incomplete", async (t) => {
  const received = deferred();
  const f = await fixture(t, async (_body, res) => res.write(sse(chunk({ content: "uncommitted fragment" }))));
  const app = await runtimeFixture(t, new OpenAIProvider(options(f.endpoint)));
  const controller = new AbortController();
  const pending = app.runtime.run({ prompt: "Stream", signal: controller.signal, onTextDelta: () => received.resolve() });
  await received.promise;
  controller.abort(new Error("Cancelled by user"));
  const run = await pending;
  assert.equal(run.status, "cancelled");
  assert.deepEqual(app.store.messages(run.sessionId), [{ role: "user", content: "Stream" }]);
  const usage = app.store.usage(run.id);
  assert.equal(usage.attempts, 1);
  assert.equal(usage.incompleteCalls, 1);
  assert.equal(usage.unreportedCalls, 1);
  assert.equal(usage.reports, 0);
  assert.ok(usage.estimatedOutput > 0);
  assert.match(app.store.events(run.id).map((event) => event.kind).join(" "), /model.cancelled/);
});

for (const [kind, Provider] of [["openai", OpenAIProvider], ["anthropic", AnthropicProvider]]) {
  for (const limited of [true, false]) {
    test(`${kind} preserves received usage and observed output after ${limited ? "token limit" : "cancellation before end marker"}`, async (t) => {
      const delivered = deferred();
      const f = await fixture(t, async (_body, res) => {
        res.write(accountedFrames(kind, limited).join(""));
        if (limited) res.end(sse(kind === "openai" ? "[DONE]" : { type: "message_stop" }));
      });
      const app = await runtimeFixture(t, new Provider(options(f.endpoint)));
      const controller = new AbortController();
      const pending = app.runtime.run({ prompt: "Stream", signal: controller.signal,
        onTextDelta: () => delivered.resolve() });
      await delivered.promise;
      if (!limited) {
        // All frames share one HTTP write; allow its read to consume the usage tail.
        await delay(30);
        controller.abort(new Error("Cancelled by user"));
      }
      const run = await pending;
      const usage = app.store.usage(run.id);
      assert.equal(run.status, limited ? "failed" : "cancelled");
      // A reply Claude cut off at its ceiling is asked again with more room (src/runtime.ts, model.ceiling_raised), up
      // to the most a reply may have; every one of those attempts is accounted for exactly as the first.
      const raised = app.store.events(run.id).filter((event) => event.kind === "model.ceiling_raised").length;
      if (kind === "anthropic" && limited) assert.ok(raised > 0, "a cut-off reply is asked again with more room");
      const attempts = 1 + raised;
      assert.equal(usage.attempts, attempts);
      assert.equal(usage.reports, attempts);
      assert.equal(usage.reportedInput, 33 * attempts);
      assert.equal(usage.reportedOutput, 17 * attempts);
      assert.equal(usage.incompleteCalls, attempts);
      assert.equal(usage.unreportedCalls, 0);
      assert.ok(usage.estimatedOutput > 0);
      assert.deepEqual(app.store.messages(run.sessionId), [{ role: "user", content: "Stream" }]);
      assert.doesNotMatch(run.output, /uncommitted fragment/);
    });
  }
}
