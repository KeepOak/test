import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { AnthropicStream } from "../dist/provider-stream.js";
import { AnthropicProvider, anthropicBody } from "../dist/providers.js";

/**
 * integrate/empty-completion: with the owner's reasoning setting on, Anthropic sends extended
 * thinking as content blocks of their own (`thinking`, `redacted_thinking`) with their own deltas
 * (`thinking_delta`, `signature_delta`). The parsers accepted only text and tool use, so every such
 * reply failed. Thinking is now heard the way the OpenAI-shaped and Ollama adapters hear it: it
 * resets the watchdog and is counted, and never reaches the page or the answer.
 */

const secret = "ANTHROPIC-PRIVATE-THOUGHT-51c2";
const events = (stop = "end_turn") => [
  { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: `${secret} first. ` } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: `${secret} second.` } },
  { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
  { type: "content_block_stop", index: 0 },
  { type: "content_block_start", index: 1, content_block: { type: "redacted_thinking", data: "opaque" } },
  { type: "content_block_stop", index: 1 },
  ...(stop === "max_tokens" ? [] : [
    { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "The answer." } },
    { type: "content_block_stop", index: 2 },
  ]),
  { type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 40 } },
  { type: "message_stop" },
];
const thinkingChars = `${secret} first. `.length + `${secret} second.`.length;

async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("an Anthropic stream with thinking blocks is read, the thinking heard and never shown", () => {
  const page = [], heard = [];
  const stream = new AnthropicStream((text) => page.push(text), (text) => heard.push(text));
  for (const event of events()) stream.consume(JSON.stringify(event));
  const completion = stream.result();
  assert.equal(completion.content, "The answer.");
  assert.deepEqual(completion.toolCalls, []);
  assert.equal(completion.reasoningChars, thinkingChars);
  assert.equal(page.join(""), "The answer.", "thinking never reaches the page, and adds no blank line");
  assert.equal(heard.length, 2, "each piece of thinking is heard, so the watchdog knows the model is working");
  assert.ok(!JSON.stringify(completion).includes(secret), "the answer carries a count, never the thinking");
});

test("the Anthropic adapter streams thinking to the listener, not to the page", async (t) => {
  const base = await serve(t, async (req, res) => {
    for await (const _ of req);
    res.setHeader("Content-Type", "text/event-stream");
    for (const event of events()) { res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`); await delay(1); }
    res.end();
  });
  const page = [], heard = [];
  const completion = await new AnthropicProvider({ endpoint: base, model: "claude-x", apiKey: "k" }).complete({
    messages: [{ role: "user", content: "q" }], tools: [], maxTokens: 4096, reasoning: "medium",
    signal: new AbortController().signal, onTextDelta: (text) => page.push(text), onReasoningDelta: (text) => heard.push(text),
  });
  assert.equal(completion.content, "The answer.");
  assert.equal(page.join(""), "The answer.");
  assert.equal(heard.join("").length, thinkingChars);
});

test("a non-streamed Anthropic reply with thinking — side questions, the judge — keeps only the answer", async (t) => {
  const base = await serve(t, async (req, res) => {
    for await (const _ of req);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ content: [
      { type: "thinking", thinking: secret, signature: "sig" },
      { type: "redacted_thinking", data: "opaque" },
      { type: "text", text: "Yes." },
    ], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 9 } }));
  });
  const completion = await new AnthropicProvider({ endpoint: base, model: "claude-x", apiKey: "k" }).complete({
    messages: [{ role: "user", content: "q" }], tools: [], maxTokens: 4096, reasoning: "medium", signal: new AbortController().signal,
  });
  assert.equal(completion.content, "Yes.");
  assert.equal(completion.reasoningChars, secret.length);
  assert.ok(!JSON.stringify(completion).includes(secret));
});

test("an Anthropic reply cut off while still thinking says so, and is charged for it", () => {
  const stream = new AnthropicStream(() => undefined, () => undefined);
  for (const event of events("max_tokens")) stream.consume(JSON.stringify(event));
  assert.throws(() => stream.result(), /thinking/i);
  assert.ok(stream.failure(new Error("x")).estimatedOutput > 0);
});

test("thinking is not asked for part way through a tool loop, where Anthropic would need the thinking sent back", () => {
  // Anthropic refuses a request with thinking on whose last assistant turn used a tool without its
  // signed thinking block before it. Branch never keeps the thinking, so it cannot send it back;
  // it asks for thinking on the rounds that open a turn and not on those that continue one.
  const opening = anthropicBody({ messages: [{ role: "user", content: "q" }], tools: [], maxTokens: 2048, reasoning: "high" }, "claude-x");
  assert.deepEqual(opening.thinking, { type: "enabled", budget_tokens: 1792 });
  const continuing = anthropicBody({ messages: [
    { role: "user", content: "q" },
    { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "files.list", arguments: "{}" }] },
    { role: "tool", toolCallId: "t1", content: "[]" },
  ], tools: [], maxTokens: 2048, reasoning: "high" }, "claude-x");
  assert.equal(continuing.thinking, undefined);
  const later = anthropicBody({ messages: [
    { role: "user", content: "q" },
    { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "files.list", arguments: "{}" }] },
    { role: "tool", toolCallId: "t1", content: "[]" },
    { role: "assistant", content: "Done." },
    { role: "user", content: "next" },
  ], tools: [], maxTokens: 2048, reasoning: "high" }, "claude-x");
  assert.deepEqual(later.thinking, { type: "enabled", budget_tokens: 1792 }, "a new turn thinks again");
});

test("selfdev: a tool call cut off at the reply ceiling is out of room, so the task asks again with more", async () => {
  const { isOutOfRoomThinking } = await import("../dist/provider-stream.js");
  const stream = new AnthropicStream(() => {}, () => {});
  for (const event of [
    { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t1", name: "files_edit", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"docs/a.md\",\"replace\":\"a very long" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 2048 } },
    { type: "message_stop" },
  ]) stream.consume(JSON.stringify(event));
  assert.throws(() => stream.result(), (error) => isOutOfRoomThinking(error) && /cut off/.test(error.message));
  assert.equal(isOutOfRoomThinking(new Error("Provider stream ended without a complete response")), false);
});
