import { createServer } from "node:http";
import { DemoProvider } from "../../dist/demo.js";

let service;

/** A controlled OpenAI-shaped service, with the scripted provider explicitly injected outside the product. */
export async function fixtureProviderEnv() {
  service ??= startFixtureService(new DemoProvider());
  return (await service).env;
}

async function startFixtureService(provider) {
  const server = createServer((request, response) => {
    answer(provider, request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  // One stateless fixture per test process; it never holds a worker open after its tests finish.
  server.unref();
  server.on("connection", (socket) => socket.unref());
  return { env: { BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1`,
    BRANCH_MODEL: "demo", BRANCH_API_KEY: "controlled-test-fixture", BRANCH_MODEL_PRESETS: undefined } };
}

async function answer(provider, request, response) {
  if (request.url === "/v1/models") {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify({ data: [{ id: "demo" }] }));
  }
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404);
    return response.end();
  }
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 2 * 1024 * 1024) throw new Error("Fixture request is too large");
  }
  const body = JSON.parse(raw);
  let completion = await provider.complete({ messages: body.messages.map(messageFrom), tools: [],
    signal: AbortSignal.timeout(30_000) });
  // Through the product's real model path a call must name a tool the request offered (src/providers.ts originalName):
  // the scripted fixture's later steps (files.verify) are not offered to an ordinary task, so the task ends there,
  // with the steps it could take done, rather than asking for a tool it was never given.
  const offered = new Set((body.tools ?? []).map((tool) => tool.function?.name).filter(Boolean));
  if (completion.toolCalls.some((call) => !offered.has(call.name)))
    completion = { content: "Demo fixture completed: wrote and read branch-demo.txt.", toolCalls: [] };
  const message = { role: "assistant", content: completion.content,
    ...(completion.toolCalls.length ? { tool_calls: completion.toolCalls.map((call) => ({ id: call.id, type: "function",
      function: { name: call.name, arguments: call.arguments } })) } : {}) };
  if (!body.stream) {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify({ choices: [{ message }] }));
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {}) };
  response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: completion.toolCalls.length ? "tool_calls" : "stop" }] })}\n\n`
    + "data: [DONE]\n\n");
}

function messageFrom(message) {
  return { role: message.role, content: typeof message.content === "string" ? message.content
    : (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n"),
    ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}) };
}
