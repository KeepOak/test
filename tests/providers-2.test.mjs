import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { CatalogSchema, catalogEntries, catalogEntry, catalogPrices, providerCatalog, resolveBaseUrl, missingExtras, modelsAddress } from "../dist/provider-catalog.js";
import { buildConnection, capabilityRefusal } from "../dist/provider-factory.js";
import { signRequest, signingKey, uriEncode } from "../dist/providers/sigv4.js";
import { AwsEventFraming, crc32, encodeEvent } from "../dist/providers/aws-event-stream.js";
import { azureUrl } from "../dist/providers/azure-openai.js";
import { ProviderHealth, readRateLimit, fallbackReason } from "../dist/provider-health.js";
import { connectFromPreset, forgetConnection, restoreConnections, secretNameFor, modelNames, connectionProject } from "../dist/connections-preset.js";
import { probeProvider } from "../dist/provider-probe.js";
import * as profiles from "../dist/model-profiles.js";
import { ModelRouter } from "../dist/models.js";
import { unofferedMark, wireName } from "../dist/providers.js";
import { ProviderHttpError } from "../dist/provider-retry.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { providerEmbeddings } from "../dist/providers.js";
import { openRouterBodyPart } from "../dist/model-savings/openrouter.js";
import { EmbeddingClient } from "../dist/document-embeddings.js";
import { embeddingConnection, embeddingsFor } from "../dist/embeddings.js";
import { tablePrice, estimateCost } from "../dist/pricing.js";
import { allPresets } from "../dist/providers/presets.js";

test("LAN Ollama embeddings retain their connection's exact origin and network stop", async () => {
  const policy = new NetworkPolicy({}), sent = [];
  const { provider } = buildConnection({ provider: "ollama", key: "", model: "qwen3:14b",
    extras: { baseUrl: "http://192.168.1.20:11434" }, policy,
    fetchImpl: async (url) => { sent.push(String(url)); return Response.json({ data: [{ index: 0, embedding: [1, 2] }] }); } });
  const route = providerEmbeddings(provider);
  assert.equal(typeof route.fetchImpl, "function");
  const client = new EmbeddingClient(route.endpoint, route.apiKey, "reader", route.fetchImpl);
  assert.deepEqual(Array.from((await client.embed(["passage"], AbortSignal.timeout(1000)))[0]), [1, 2]);
  const connection = embeddingConnection({ plan: () => ({ candidates: [{ provider }] }) }, "local", "reader");
  const reader = embeddingsFor(connection, async () => { throw new Error("ordinary network policy refuses LAN"); });
  assert.deepEqual(Array.from((await reader.embed(["passage"], AbortSignal.timeout(1000)))[0]), [1, 2]);
  assert.equal(sent.length, 2);
  await assert.rejects(() => route.fetchImpl("http://192.168.1.21:11434/v1/embeddings"), /not the address/);
  const blocked = buildConnection({ provider: "ollama", key: "", extras: { baseUrl: "http://192.168.1.20:11434" },
    policy: new NetworkPolicy({ blockedHosts: ["192.168.1.20"] }), fetchImpl: async () => { throw new Error("must not reach server"); } });
  await assert.rejects(() => providerEmbeddings(blocked.provider).fetchImpl("http://192.168.1.20:11434/v1/embeddings"), /blocked/);
});
import { Store } from "../dist/store.js";

const request = {
  messages: [
    { role: "system", content: "be brief" },
    { role: "user", content: "hello" },
  ],
  tools: [{ name: "files.read", description: "read a file", parameters: { type: "object", properties: {}, additionalProperties: false } }],
  signal: new AbortController().signal,
  maxTokens: 64,
};

/** A fake service. Nothing in this file ever reaches a real address. */
async function fake(t, handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    seen.push({ url: req.url, method: req.method, headers: req.headers, body: body ? JSON.parse(body) : null });
    handler(req, res, body ? JSON.parse(body) : null, seen.length);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}
const json = (res, value) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
const sse = (res, frames, done = true) => {
  res.setHeader("content-type", "text/event-stream");
  res.end(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""));
};
/** A policy that allows this computer, because every fake in this file listens on 127.0.0.1. */
const localPolicy = () => new NetworkPolicy({ allowPrivateAddresses: true });

// ---------------------------------------------------------------- P1: the catalog

test("the catalog validates against its schema and covers at least 25 services", () => {
  const catalog = CatalogSchema.parse(JSON.parse(readFileSync(new URL("../data/providers.json", import.meta.url), "utf8")));
  assert.ok(catalog.services.length >= 25, `only ${catalog.services.length} services`);
  assert.equal(new Set(catalog.services.map((s) => s.id)).size, catalog.services.length, "ids are unique");
  for (const entry of catalog.services) {
    assert.ok(entry.note.length > 5, `${entry.id} has no plain-language note`);
    if (entry.kind === "cloud" && entry.id !== "custom") assert.ok(entry.signUp.startsWith("https://"), `${entry.id} has no sign-up address`);
    for (const placeholder of entry.baseUrl.matchAll(/\{([a-zA-Z]+)\}/g))
      assert.ok((entry.extras ?? []).some((e) => e.key === placeholder[1]), `${entry.id} does not say how to fill in {${placeholder[1]}}`);
  }
});

test("the shipped catalog names every service the brief asked for", () => {
  const ids = new Set(catalogEntries().map((e) => e.id));
  for (const wanted of ["openai", "azure-openai", "anthropic", "gemini", "vertex-ai", "mistral", "groq", "openrouter",
    "together", "fireworks", "deepseek", "xai", "perplexity", "cohere", "cerebras", "sambanova", "huggingface",
    "github-models", "cloudflare", "bedrock", "ollama", "lm-studio", "vllm", "llama-cpp", "localai", "jan",
    "moonshot", "zhipu", "dashscope"])
    assert.ok(ids.has(wanted), `catalog is missing ${wanted}`);
});

test("an address with a gap in it refuses to be used until the gap is filled", () => {
  const azure = catalogEntry("azure-openai");
  assert.deepEqual(missingExtras(azure, {}), ["Your Azure resource name", "The name you gave the deployment"]);
  assert.throws(() => resolveBaseUrl(azure, { resource: "mine" }), /name you gave the deployment/);
  assert.throws(() => resolveBaseUrl(azure, { resource: "a/b", deployment: "d" }), /may only contain/);
  assert.equal(resolveBaseUrl(azure, { resource: "mine", deployment: "gpt4o" }),
    "https://mine.openai.azure.com/openai/deployments/gpt4o");
});

test("the Settings provider list is the catalog, not a second copy of it", () => {
  assert.equal(allPresets().length, catalogEntries().length);
  assert.equal(allPresets().find((p) => p.id === "bedrock").baseUrl, "https://bedrock-runtime.<region>.amazonaws.com");
});

// ---------------- every entry completes a chat against a fake of its own shape (table driven)

/** How each shape's fake answers, and where it expects the request to land. */
const shapeFakes = {
  "openai-chat": {
    path: "/chat/completions",
    reply: () => ({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    stream: [{ choices: [{ index: 0, delta: { content: "hi" } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }],
  },
  "openai-responses": {
    path: "/responses",
    reply: () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }], usage: { input_tokens: 3, output_tokens: 1 } }),
    stream: [{ type: "response.output_text.delta", delta: "hi" }, { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 1 } } }],
  },
  "anthropic-messages": {
    path: "/messages",
    reply: () => ({ content: [{ type: "text", text: "hi" }], usage: { input_tokens: 3, output_tokens: 1 } }),
    stream: [
      { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ],
  },
  gemini: {
    path: ":generateContent",
    reply: () => ({ candidates: [{ content: { parts: [{ text: "hi" }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } }),
    stream: [
      { candidates: [{ content: { parts: [{ text: "hi" }] } }] },
      { candidates: [{ content: { parts: [] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1 } },
    ],
  },
  "azure-openai": {
    path: "/chat/completions",
    reply: () => ({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    stream: [{ choices: [{ index: 0, delta: { content: "hi" } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }],
  },
  "cohere-chat-v2": {
    path: "/chat",
    reply: () => ({ message: { content: [{ type: "text", text: "hi" }] }, usage: { tokens: { input_tokens: 3, output_tokens: 1 } } }),
    stream: [
      { type: "content-delta", delta: { message: { content: { text: "hi" } } } },
      { type: "message-end", delta: { usage: { tokens: { input_tokens: 3, output_tokens: 1 } } } },
    ],
  },
  ollama: {
    path: "/api/chat",
    reply: () => ({ message: { content: "hi" }, prompt_eval_count: 3, eval_count: 1, done: true }),
    stream: "ndjson",
  },
  "bedrock-converse": { path: "/converse", reply: () => ({}), stream: "aws" },
  "perplexity-agent": {
    path: "/agent",
    reply: () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }], usage: { input_tokens: 3, output_tokens: 1 } }),
    stream: [{ type: "response.output_text.delta", delta: "hi" }, { type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 1 } } }],
  },
  "anthropic-vertex": {
    path: ":rawPredict",
    reply: () => ({ content: [{ type: "text", text: "hi" }], usage: { input_tokens: 3, output_tokens: 1 } }),
    stream: [
      { type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ],
  },
};

/** The answers a service needs, with the address pointed at the fake instead of the real thing. */
function extrasFor(entry, origin) {
  const answers = {};
  for (const extra of entry.extras ?? []) answers[extra.key] = extra.key === "baseUrl" ? `${origin}/v1` : (extra.example ?? "x").replace(/\.\.\.$/, "");
  if (entry.id === "bedrock") { answers.region = "us-east-1"; answers.accessKeyId = "AKIDEXAMPLE"; }
  return answers;
}
/** Every catalog entry, rebuilt against a fake of its own shape rather than its real address. */
function localised(entry, origin) {
  const local = { ...entry, baseUrl: entry.shape === "ollama" ? `${origin}/v1` : entry.shape === "azure-openai" ? `${origin}/openai/deployments/d` : entry.shape === "bedrock-converse" ? origin : entry.shape === "gemini" ? origin : `${origin}/v1` };
  return local;
}

for (const entry of catalogEntries()) {
  if (!entry.capabilities.includes("chat")) continue;
  test(`${entry.id}: a fake of its shape completes a chat`, async (t) => {
    const shape = shapeFakes[entry.shape];
    const { origin, seen } = await fake(t, (req, res) => {
      if (entry.shape === "bedrock-converse")
        return json(res, { output: { message: { content: [{ text: "hi" }] } }, usage: { inputTokens: 3, outputTokens: 1 } });
      json(res, shape.reply());
    });
    const local = localised(entry, origin);
    const { provider } = buildConnectionAgainst(local, extrasFor(entry, origin));
    const completion = await provider.complete(request);
    assert.equal(completion.content, "hi");
    // Ollama first asks /api/show how much room the model has; the chat is the request after it.
    const chat = seen.at(-1);
    assert.ok(chat.url.includes(shape.path.replace(":generateContent", "")), `${entry.id} asked for ${chat.url}`);
    if (entry.shape === "perplexity-agent") assert.equal(chat.body.preset, entry.defaultModel);
    assert.equal(completion.usage.input, 3);
    assert.equal(completion.usage.output, 1);
  });
}

/** Builds a connection from a catalog line whose address has been pointed at a fake. */
function buildConnectionAgainst(entry, extras, policy) {
  const { useCatalog, providerCatalog: real } = catalogModule;
  const original = real();
  useCatalog({ ...original, services: original.services.map((s) => (s.id === entry.id ? entry : s)) });
  try {
    return buildConnection({
      provider: entry.id, key: "test-key", extras, model: entry.defaultModel,
      ...(policy ? { policy } : {}),
    });
  } finally {
    useCatalog(original);
  }
}
const catalogModule = await import("../dist/provider-catalog.js");

test("every entry that says it streams can stream, against a fake of its shape", async (t) => {
  const streamable = catalogEntries().filter((e) => e.capabilities.includes("streaming") && e.capabilities.includes("chat"));
  assert.ok(streamable.length > 25);
  const byShape = new Map();
  for (const entry of streamable) if (!byShape.has(entry.shape)) byShape.set(entry.shape, entry);
  for (const [shapeName, entry] of byShape) {
    const shape = shapeFakes[shapeName];
    const { origin } = await fake(t, (req, res) => {
      if (shape.stream === "ndjson") {
        res.setHeader("content-type", "application/x-ndjson");
        return res.end(JSON.stringify({ message: { content: "hi" }, done: false }) + "\n" + JSON.stringify({ message: { content: "" }, prompt_eval_count: 3, eval_count: 1, done: true }) + "\n");
      }
      if (shape.stream === "aws") {
        res.setHeader("content-type", "application/vnd.amazon.eventstream");
        return res.end(Buffer.concat([
          encodeEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "hi" } }),
          encodeEvent("metadata", { usage: { inputTokens: 3, outputTokens: 1 } }),
        ]));
      }
      if (shape.stream === null) return json(res, shape.reply());
      sse(res, shape.stream, !["anthropic-messages", "anthropic-vertex", "gemini"].includes(shapeName));
    });
    const local = localised(entry, origin);
    const { provider } = buildConnectionAgainst(local, extrasFor(entry, origin));
    let text = "";
    const completion = await provider.complete({ ...request, onTextDelta: (part) => { text += part; } });
    assert.equal(completion.content, "hi", `${shapeName} streamed "${completion.content}"`);
    if (shape.stream !== null) assert.equal(text, "hi", `${shapeName} emitted "${text}" as it went`);
  }
});

test("every entry that publishes a list of models has a reachable list address", async (t) => {
  const listing = catalogEntries().filter((e) => e.modelsPath !== null);
  assert.ok(listing.length >= 20, `only ${listing.length} entries list models`);
  const { origin } = await fake(t, (req, res) => json(res, { data: [{ id: "one" }, { id: "two" }] }));
  for (const entry of listing) {
    const address = modelsAddress(entry, `${origin}/v1`);
    assert.ok(address.startsWith(origin), `${entry.id}: ${address}`);
    const response = await fetch(address);
    assert.deepEqual(modelNames(await response.json()), ["one", "two"]);
  }
});

// ---------------------------------------------------------------- P2: Azure

test("the Azure address puts the deployment in the path and the version on the end", () => {
  const url = azureUrl("https://mine.openai.azure.com/openai/deployments/gpt4o", "/chat/completions", "2024-10-01-preview");
  assert.equal(url, "https://mine.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-10-01-preview");
  assert.throws(() => azureUrl("http://elsewhere.example.com/openai", "/chat/completions", "2024-10-01-preview"), /HTTPS/);
});

test("Azure sends the key in its own header and never as a bearer token", async (t) => {
  const { origin, seen } = await fake(t, (req, res) => json(res, { choices: [{ message: { content: "ok" } }] }));
  const { provider } = buildConnection({
    provider: "azure-openai", key: "azure-secret", model: "gpt-4o",
    extras: { resource: "mine", deployment: "d" },
  });
  // The real entry points at Azure; rebuild against the fake to check the headers without leaving here.
  const local = buildConnectionAgainst({ ...catalogEntry("azure-openai"), baseUrl: `${origin}/openai/deployments/d` },
    { resource: "mine", deployment: "d", apiVersion: "2024-10-01-preview" });
  assert.equal(provider.name, "azure-openai");
  await local.provider.complete(request);
  assert.equal(seen[0].headers["api-key"], "test-key");
  assert.equal(seen[0].headers.authorization, undefined);
  assert.ok(seen[0].url.includes("api-version=2024-10-01-preview"));
  assert.ok(seen[0].url.startsWith("/openai/deployments/d/chat/completions"));
});

// ---------------------------------------------------------------- P2: Bedrock SigV4

// Amazon's published signing test suite, "get-vanilla" and "post-x-www-form-urlencoded".
// Source: aws/aws-sdk-ruby, gems/aws-sigv4/spec/suite — credentials, region and service from suite_spec.rb.
const awsCredentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" };
const awsWhen = new Date("2015-08-30T12:36:00Z");

test("the signer reproduces Amazon's published get-vanilla test vector, step by step", () => {
  const signed = signRequest({
    method: "GET", url: new URL("https://example.amazonaws.com/"), headers: {}, body: "",
    region: "us-east-1", service: "service", ...awsCredentials, now: awsWhen,
  });
  assert.equal(signed.canonicalRequest,
    "GET\n/\n\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\nhost;x-amz-date\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(signed.stringToSign,
    "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/service/aws4_request\nbb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63");
  assert.equal(signed.signature, "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  assert.equal(signed.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
});

test("the signer reproduces Amazon's post-x-www-form-urlencoded vector, which has a body", () => {
  const signed = signRequest({
    method: "POST", url: new URL("https://example.amazonaws.com/"),
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "Param1=value1",
    region: "us-east-1", service: "service", ...awsCredentials, now: awsWhen,
  });
  assert.equal(signed.canonicalRequest,
    "POST\n/\n\ncontent-type:application/x-www-form-urlencoded\nhost:example.amazonaws.com\nx-amz-date:20150830T123600Z\n\ncontent-type;host;x-amz-date\n9095672bbd1f56dfc5b65f3e153adc8731a4a654192329106275f4c7b24d0b6e");
  assert.equal(signed.stringToSign.split("\n")[3], "42a5e5bb34198acb3e84da4f085bb7927f2bc277ca766e6d19c73c2154021281");
  assert.equal(signed.signature, "ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a");
});

test("the derived signing key is the documented chain of four keyed hashes", () => {
  const key = signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", "service");
  assert.equal(key.length, 32);
  // A different date, region or service must derive a different key; that is the point of the chain.
  assert.notEqual(key.toString("hex"), signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150831", "us-east-1", "service").toString("hex"));
  assert.notEqual(key.toString("hex"), signingKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-west-2", "service").toString("hex"));
});

test("Amazon's own URI encoding leaves the unreserved characters alone and upper-cases the rest", () => {
  assert.equal(uriEncode("aA1-._~"), "aA1-._~");
  assert.equal(uriEncode("a b/c:d"), "a%20b%2Fc%3Ad");
});

test("a Bedrock request is signed, and the secret key itself is never sent", async (t) => {
  const { origin, seen } = await fake(t, (req, res) =>
    json(res, { output: { message: { content: [{ text: "hi" }] } }, usage: { inputTokens: 3, outputTokens: 1 } }));
  const { provider } = buildConnectionAgainst({ ...catalogEntry("bedrock"), baseUrl: origin },
    { region: "us-east-1", accessKeyId: "AKIDEXAMPLE" });
  const completion = await provider.complete(request);
  assert.equal(completion.content, "hi");
  const sent = seen[0];
  assert.ok(sent.url.startsWith("/model/"), sent.url);
  assert.ok(sent.url.endsWith("/converse"));
  assert.match(sent.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/bedrock\/aws4_request/);
  const whole = JSON.stringify(sent);
  assert.ok(!whole.includes("test-key"), "the secret key must not be sent");
  assert.ok(Array.isArray(sent.body.messages), "the conversation goes in Bedrock's own shape");
  assert.ok(sent.body.toolConfig.tools[0].toolSpec.name.startsWith("branch_"));
});

// ---------------------------------------------------------------- P2: Bedrock event frames

test("CRC-32 matches the standard known answer", () => {
  assert.equal(crc32(Buffer.from("123456789", "utf8")), 0xcbf43926);
});

test("Amazon's binary frames decode, including one split across two reads", () => {
  const bytes = Buffer.concat([
    encodeEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "he" } }),
    encodeEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "llo" } }),
    encodeEvent("metadata", { usage: { inputTokens: 7, outputTokens: 2 } }),
  ]);
  const framing = new AwsEventFraming();
  const first = framing.push(bytes.subarray(0, 30));
  const rest = framing.push(bytes.subarray(30));
  const events = [...first, ...rest];
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.type), ["contentBlockDelta", "contentBlockDelta", "metadata"]);
  assert.equal(events[1].payload.delta.text, "llo");
  assert.equal(events[2].payload.usage.inputTokens, 7);
  assert.equal(framing.complete, true);
});

test("a damaged frame stops the stream instead of being guessed at", () => {
  const bytes = Buffer.from(encodeEvent("contentBlockDelta", { delta: { text: "hi" } }));
  bytes[bytes.length - 2] ^= 0xff;
  assert.throws(() => new AwsEventFraming().push(bytes), /damaged/);
});

test("a streamed Bedrock reply is put back together from its frames", async (t) => {
  const { origin } = await fake(t, (req, res) => {
    res.setHeader("content-type", "application/vnd.amazon.eventstream");
    res.end(Buffer.concat([
      encodeEvent("contentBlockStart", { contentBlockIndex: 1, start: { toolUse: { toolUseId: "t1", name: wireName("files.read") } } }),
      encodeEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "he" } }),
      encodeEvent("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "llo" } }),
      encodeEvent("contentBlockDelta", { contentBlockIndex: 1, delta: { toolUse: { input: '{"a":1}' } } }),
      encodeEvent("contentBlockStop", { contentBlockIndex: 1 }),
      encodeEvent("metadata", { usage: { inputTokens: 7, outputTokens: 2 } }),
    ]));
  });
  const { provider } = buildConnectionAgainst({ ...catalogEntry("bedrock"), baseUrl: origin },
    { region: "us-east-1", accessKeyId: "AKIDEXAMPLE" });
  let text = "";
  const tools = [{ name: "files.read", description: "d", parameters: { type: "object" } }];
  const completion = await provider.complete({ ...request, tools, onTextDelta: (part) => { text += part; } });
  assert.equal(text, "hello");
  assert.equal(completion.content, "hello");
  assert.deepEqual(completion.usage, { input: 7, output: 2 });
});

// ---------------------------------------------------------------- P2: Cohere v2

test("Cohere's own reply shape is mapped: block list to text, nested tally to usage", async (t) => {
  const { origin, seen } = await fake(t, (req, res) => json(res, {
    message: {
      content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
      tool_calls: [{ id: "c1", type: "function", function: { name: wireName("files.read"), arguments: '{"p":1}' } }],
    },
    usage: { tokens: { input_tokens: 11, output_tokens: 4 } },
  }));
  const tools = [{ name: "files.read", description: "d", parameters: { type: "object" } }];
  const { provider } = buildConnectionAgainst({ ...catalogEntry("cohere"), baseUrl: `${origin}/v2` }, {});
  const completion = await provider.complete({ ...request, tools });
  assert.equal(completion.content, "first\nsecond", "the block list became one piece of text");
  assert.deepEqual(completion.usage, { input: 11, output: 4 }, "the nested tally was read");
  assert.deepEqual(completion.toolCalls, [{ id: "c1", name: "files.read", arguments: '{"p":1}' }]);
  assert.equal(seen[0].url, "/v2/chat");
  assert.equal(seen[0].headers.authorization, "Bearer test-key");
  assert.equal(seen[0].body.tools[0].function.name, wireName("files.read"));
  assert.equal(seen[0].body.messages[0].role, "system", "instructions stay in the message list");
});

test("a tool name Cohere sends that Branch never asked for comes back marked, never as an offered tool", async (t) => {
  const { origin } = await fake(t, (req, res) => json(res, {
    message: { content: [], tool_calls: [{ id: "c1", type: "function", function: { name: "made_up", arguments: "{}" } }] },
  }));
  const { provider } = buildConnectionAgainst({ ...catalogEntry("cohere"), baseUrl: `${origin}/v2` }, {});
  const completion = await provider.complete({ ...request, tools: [{ name: "files.read", description: "d", parameters: {} }] });
  // The runtime answers a call like this and never runs it (tests/real-model-tools.test.mjs).
  assert.deepEqual(completion.toolCalls.map((call) => call.name), [unofferedMark + "made_up"]);
});

// ---------------------------------------------------------------- P3: capability-aware planning

test("a capability a connection lacks is refused by name, and an alternative is offered", () => {
  const refusal = capabilityRefusal("groq", "vision", [{ id: "a", providerId: "openai", name: "OpenAI" }]);
  assert.match(refusal, /Groq cannot be shown a picture/);
  assert.match(refusal, /OpenAI can/);
  assert.equal(capabilityRefusal("openai", "vision", []), null);
  assert.match(capabilityRefusal("groq", "vision", []), /no other connection/);
});

function router(t, presets) {
  const store = new Store(":memory:");
  t.after(() => store.close?.());
  return new ModelRouter(store, presets);
}
const stub = (id, catalogId) => ({
  id, name: id, model: "m", catalogId,
  provider: { name: id, complete: async () => ({ content: "", toolCalls: [] }) },
});

test("the plan refuses to send picture work to a model that cannot see, and names one that can", (t) => {
  const models = router(t, [stub("g", "groq"), stub("o", "openai")]);
  models.configure("local", { fallbackOrder: ["o"] });
  const plan = models.planFor("local", "", "vision");
  assert.equal(plan.choice.presetId, "o", "the one that can see answered");
  assert.equal(plan.refusal, null);
  assert.match(plan.choice.fallbackReason, /cannot do that/);
  const alone = router(t, [stub("g", "groq")]);
  const refused = alone.planFor("local", "", "vision");
  assert.match(refused.refusal, /no other connection/);
});

test("a connection Branch did not set up from the catalog is not assumed to be worse than it is", (t) => {
  const models = router(t, [stub("mine", undefined)]);
  assert.equal(models.planFor("local", "", "vision").refusal, null);
});

// ---------------------------------------------------------------- P4: adding a connection

async function withStore(t) {
  const store = new Store(":memory:");
  const key = { key: async () => Buffer.alloc(32, 7) };
  store.openLocker(key);
  t.after(() => store.close?.());
  return store;
}

test("from-preset probes the service before storing anything, and never logs the key", async (t) => {
  const { origin, seen } = await fake(t, (req, res) => json(res, { data: [{ id: "one" }, { id: "two" }] }));
  const store = await withStore(t);
  const models = router(t, [stub("demo", undefined)]);
  const original = providerCatalog();
  catalogModule.useCatalog({ ...original, services: original.services.map((s) => (s.id === "groq" ? { ...s, baseUrl: `${origin}/v1` } : s)) });
  t.after(() => catalogModule.useCatalog(original));
  const result = await connectFromPreset(
    { models, locker: store.locker, owner: "local", policy: localPolicy() },
    { provider: "groq", key: "sk-secret-value" },
  );
  assert.deepEqual(result.models, ["one", "two"]);
  assert.equal(result.modelsFound, 2);
  assert.ok(models.presets.has("groq"), "the connection is registered");
  assert.equal(models.presets.get("groq").catalogId, "groq");
  assert.equal(models.presets.get("groq").endpoint, `${origin}/v1`, "its address is kept, so a figure learned for it stays with it");
  assert.deepEqual(store.locker.names("local", connectionProject).map((row) => row.name), ["GROQ_KEY"]);
  assert.ok(!JSON.stringify(result).includes("sk-secret-value"), "the key is never handed back");
  assert.ok(JSON.stringify(seen).includes("sk-secret-value"), "the key does reach the service itself");
});

test("a service with no list of models is checked by asking it for one small reply", async (t) => {
  const { origin, seen } = await fake(t, (req, res) => json(res, { choices: [{ message: { content: "OK" } }] }));
  const store = await withStore(t);
  const models = router(t, [stub("demo", undefined)]);
  const original = providerCatalog();
  // Portkey publishes no list of models, so from-preset has to use the connection to check the key.
  catalogModule.useCatalog({ ...original, services: original.services.map((s) => (s.id === "portkey" ? { ...s, baseUrl: `${origin}/v1` } : s)) });
  t.after(() => catalogModule.useCatalog(original));
  const result = await connectFromPreset(
    { models, locker: store.locker, owner: "local", policy: localPolicy() },
    { provider: "portkey", key: "pk-secret" },
  );
  assert.equal(result.modelsFound, null);
  assert.match(result.message, /answered a small test request/);
  assert.equal(seen[0].url, "/v1/chat/completions", "the check was a real completion");
  assert.deepEqual(store.locker.names("local", connectionProject).map((row) => row.name), ["PORTKEY_KEY"]);
});

test("a second connection to the same service does not overwrite the first one's key", async (t) => {
  const { origin } = await fake(t, (req, res) => json(res, { data: [{ id: "one" }] }));
  const store = await withStore(t);
  const models = router(t, [stub("demo", undefined)]);
  const original = providerCatalog();
  catalogModule.useCatalog({ ...original, services: original.services.map((s) => (s.id === "groq" ? { ...s, baseUrl: `${origin}/v1` } : s)) });
  t.after(() => catalogModule.useCatalog(original));
  const deps = { models, locker: store.locker, owner: "local", policy: localPolicy() };
  const first = await connectFromPreset(deps, { provider: "groq", key: "one" });
  const second = await connectFromPreset(deps, { provider: "groq", key: "two" });
  assert.equal(first.id, "groq");
  assert.equal(second.id, "groq-2");
  assert.deepEqual(store.locker.names("local", connectionProject).map((row) => row.name), ["GROQ_2_KEY", "GROQ_KEY"]);
});

test("a service that only compares passages is refused as a connection, in plain words", async (t) => {
  const store = await withStore(t);
  const models = router(t, [stub("demo", undefined)]);
  await assert.rejects(
    connectFromPreset({ models, locker: store.locker, owner: "local", policy: localPolicy() }, { provider: "voyageai", key: "k" }),
    /does not hold conversations/);
});

test("a completion on the ordinary OpenAI shape goes through the network rules and is written down", async (t) => {
  const { origin } = await fake(t, (req, res) => json(res, { choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  // The owner's default rules refuse this computer's own addresses to a service at a fixed address; a completion must
  // obey them. QA Q003: a server the owner points "custom" at is theirs to reach, but a rule they wrote still wins.
  const strict = buildConnectionAgainst({ ...catalogEntry("openai"), baseUrl: `${origin}/v1` }, {}, new NetworkPolicy({}));
  await assert.rejects(strict.provider.complete(request), /private or local address|may not reach/);
  const ruled = buildConnection({ provider: "custom", key: "k", extras: { baseUrl: `${origin}/v1` }, policy: new NetworkPolicy({ blockedHosts: ["127.0.0.1"] }) });
  await assert.rejects(ruled.provider.complete(request), /blocked/);

  const health = new ProviderHealth();
  const watched = buildConnection({
    provider: "custom", key: "k", extras: { baseUrl: `${origin}/v1` },
    policy: localPolicy(), fetchImpl: health.watch("mine"),
  });
  assert.equal((await watched.provider.complete(request)).content, "hi");
  assert.notEqual(health.get("mine").latencyMs, null, "the completion itself was written down");
  assert.equal(health.get("mine").consecutiveFailures, 0);
});

test("Anthropic and Gemini connections obey the network rules too", async (t) => {
  const { origin } = await fake(t, (req, res) => json(res, { content: [{ type: "text", text: "hi" }] }));
  const strictAnthropic = buildConnectionAgainst({ ...catalogEntry("anthropic"), baseUrl: `${origin}/v1` }, {}, new NetworkPolicy({}));
  await assert.rejects(strictAnthropic.provider.complete(request), /private or local address|may not reach/);
  const strictGemini = buildConnectionAgainst({ ...catalogEntry("gemini"), baseUrl: origin }, {}, new NetworkPolicy({}));
  await assert.rejects(strictGemini.provider.complete(request), /private or local address|may not reach/);
});

test("a key the service refuses is not stored and the reason is in plain words", async (t) => {
  const { origin } = await fake(t, (req, res) => { res.statusCode = 401; json(res, { error: "nope" }); });
  const store = await withStore(t);
  const models = router(t, [stub("demo", undefined)]);
  const original = providerCatalog();
  catalogModule.useCatalog({ ...original, services: original.services.map((s) => (s.id === "groq" ? { ...s, baseUrl: `${origin}/v1` } : s)) });
  t.after(() => catalogModule.useCatalog(original));
  await assert.rejects(
    connectFromPreset({ models, locker: store.locker, owner: "local", policy: localPolicy() }, { provider: "groq", key: "bad" }),
    /key was refused/);
  assert.deepEqual(store.locker.names("local", connectionProject), [], "nothing was stored");
  assert.equal(models.presets.has("groq"), false);
});

test("a service that needs more than a key says so before anything is sent", async (t) => {
  const store = await withStore(t);
  const models = router(t, [stub("demo", undefined)]);
  await assert.rejects(
    connectFromPreset({ models, locker: store.locker, owner: "local", policy: localPolicy() }, { provider: "azure-openai", key: "k" }),
    /still needs: Your Azure resource name/);
});

test("the locker name for a service is an environment-style name the locker will accept", () => {
  assert.equal(secretNameFor("lm-studio"), "LM_STUDIO_KEY");
  assert.equal(secretNameFor("azure-openai"), "AZURE_OPENAI_KEY");
});

test("a custom OpenAI-compatible address must be https, or plain http on this computer or the owner's network", () => {
  assert.throws(() => buildConnection({ provider: "custom", key: "k", extras: { baseUrl: "http://example.com/v1" } }),
    /must start with https/);
  assert.throws(() => buildConnection({ provider: "custom", key: "k", extras: { baseUrl: "http://169.254.169.254/v1" } }),
    /must start with https/);
  assert.doesNotThrow(() => buildConnection({ provider: "custom", key: "k", extras: { baseUrl: "http://192.168.1.20:11434/v1" } }));
  assert.doesNotThrow(() => buildConnection({ provider: "custom", key: "k", extras: { baseUrl: "http://127.0.0.1:9/v1" } }));
  assert.doesNotThrow(() => buildConnection({ provider: "custom", key: "k", extras: { baseUrl: "https://api.example.com/v1" } }));
});

// ---------------------------------------------------------------- P5: health and fallback

test("health is recorded from real calls: latency, the last complaint, and the service's allowance", async (t) => {
  const health = new ProviderHealth();
  const { origin } = await fake(t, (req, res) => {
    res.setHeader("x-ratelimit-limit-requests", "100");
    res.setHeader("x-ratelimit-remaining-requests", "7");
    res.setHeader("x-ratelimit-reset-requests", "30s");
    if (req.url === "/bad") { res.statusCode = 429; return json(res, { error: "slow down" }); }
    json(res, { ok: true });
  });
  const watched = health.watch("one");
  await watched(`${origin}/good`);
  const good = health.get("one");
  assert.equal(good.consecutiveFailures, 0);
  assert.ok(good.latencyMs !== null && good.latencyMs >= 0);
  // mac7/usage-bar: the flat three are the requests window, kept; `windows` is the whole of it.
  assert.equal(good.rateLimit.limit, 100);
  assert.equal(good.rateLimit.remaining, 7);
  assert.equal(good.rateLimit.resetSeconds, 30);
  assert.deepEqual(good.rateLimit.windows.map((one) => one.id), ["requests"]);
  await watched(`${origin}/bad`);
  const bad = health.get("one");
  assert.equal(bad.consecutiveFailures, 1);
  assert.equal(bad.lastStatus, 429);
  assert.match(bad.summary, /failed once/);
});

test("a failing connection is skipped, and comes back once its rest is over", (t) => {
  let clock = 1_000_000;
  const store = new Store(":memory:");
  t.after(() => store.close?.());
  const models = new ModelRouter(store, [stub("first", "openai"), stub("second", "groq")], () => clock);
  models.configure("local", { activePreset: "first", fallbackOrder: ["second"], cooldownMs: 60_000 });
  assert.equal(models.plan("local", "").choice.presetId, "first");
  const until = models.markFailure("local", "first", new ProviderHttpError(503));
  assert.ok(until, "a 503 is worth resting for");
  const during = models.plan("local", "");
  assert.equal(during.choice.presetId, "second");
  assert.equal(during.choice.source, "cooldown");
  assert.match(during.choice.fallbackReason, /first .*was skipped, so second took it/);
  clock += 61_000;
  assert.equal(models.plan("local", "").choice.presetId, "first", "it comes back after the rest");
});

test("the why-this-model line says nothing extra when nothing was skipped", () => {
  assert.equal(fallbackReason(new ProviderHealth(), [], "a"), null);
});

test("rate-limit headers are read in whichever spelling the service uses", () => {
  const reading = readRateLimit(new Headers({ "ratelimit-remaining": "5" }));
  assert.equal(reading.limit, null);
  assert.equal(reading.remaining, 5);
  assert.equal(reading.resetSeconds, null);
  assert.equal(readRateLimit(new Headers({})), null);
});

// ---------------------------------------------------------------- prices

test("the catalog supplies prices for models pricing.ts does not list, and never invents a zero", () => {
  const prices = catalogPrices();
  assert.ok(Object.keys(prices).length > 0);
  assert.deepEqual(tablePrice("command-r-plus-08-2024"), { input: 2.5, output: 10 });
  // A cloud model with no price on file reports no price, not nothing-to-pay.
  const unknown = estimateCost("qwen-plus", { input: 1000, output: 1000 });
  assert.equal(unknown.amount, null);
  assert.equal(unknown.note, "no price on file");
  // A model on this computer genuinely costs nothing.
  assert.equal(estimateCost("local-model", { input: 1000, output: 1000 }).amount, 0);
  for (const entry of catalogEntries())
    for (const [model, price] of Object.entries(entry.prices ?? {})) {
      // MODEL-091: OpenRouter's free router is zero because every request caps the price at zero, so OpenRouter refuses
      // rather than charges; that cap is what makes the zero true, so it is checked here instead of taken on trust.
      if (price.input === 0 && price.output === 0 && model === "openrouter/free") {
        assert.deepEqual(openRouterBodyPart(entry.baseUrl, undefined, model).provider?.max_price, { prompt: 0, completion: 0, request: 0 });
        continue;
      }
      if (entry.kind === "cloud") assert.ok(price.input > 0 || price.output > 0, `${model} is priced at zero but is not local`);
    }
});

// ---------------------------------------------------------------- D: the docs table

test("the documentation table regenerates to exactly what is checked in", () => {
  const before = readFileSync(new URL("../docs/configuration.md", import.meta.url), "utf8");
  // fileURLToPath, not .pathname: a checkout whose folder name has a space must still be found.
  execFileSync(process.execPath, ["scripts/docs-providers.mjs"], { cwd: fileURLToPath(new URL("..", import.meta.url)) });
  const after = readFileSync(new URL("../docs/configuration.md", import.meta.url), "utf8");
  assert.equal(after, before, "run `npm run docs:providers` and commit the result");
  assert.ok(before.includes("tested against a fake of the"), "the honest line about fakes is in the docs");
  assert.ok(before.includes("| AWS Bedrock | in the cloud | Bedrock |"));
});

// ------------------------------------------- Batch 19 (wave 7, integration): the follow-up fixes

const withFakeCatalog = (t, origin, id = "groq") => {
  const original = providerCatalog();
  catalogModule.useCatalog({ ...original, services: original.services.map((s) => (s.id === id ? { ...s, baseUrl: `${origin}/v1` } : s)) });
  t.after(() => catalogModule.useCatalog(original));
};

test("a second connection to the same service keeps its own record of how it is behaving", async (t) => {
  let answers = 0;
  const { origin } = await fake(t, (req, res) => {
    answers++;
    if (answers > 2) { res.statusCode = 500; res.end("no"); return; }
    json(res, { data: [{ id: "one" }] });
  });
  const store = await withStore(t);
  const models = router(t, [stub("demo", undefined)]);
  withFakeCatalog(t, origin);
  const deps = { models, locker: store.locker, owner: "local", policy: localPolicy(), store };
  await connectFromPreset(deps, { provider: "groq", key: "one" });
  const second = await connectFromPreset(deps, { provider: "groq", key: "two" });
  assert.equal(second.id, "groq-2");
  // Only the second connection makes this call, so only its card may change.
  await models.presets.get("groq-2").provider.complete({ ...request, tools: [] }).catch(() => {});
  assert.equal(models.health.get("groq-2").consecutiveFailures, 1, "the failure landed on the connection that made it");
  assert.equal(models.health.get("groq").consecutiveFailures, 0, "the first connection was not blamed for it");
});

test("one failed call is written down once, not twice", async (t) => {
  const models = router(t, [stub("demo", undefined)]);
  const watched = models.health.watch("demo", async () => new Response("no", { status: 500 }));
  const response = await watched("http://127.0.0.1:1/x");
  assert.equal(response.status, 500);
  models.markFailure("local", "demo", new ProviderHttpError(500, undefined, undefined, true, true));
  assert.equal(models.health.get("demo").consecutiveFailures, 1);
});

test("a connection added from a preset is still here after Branch restarts", async (t) => {
  const { origin } = await fake(t, (req, res) => json(res, { data: [{ id: "one" }] }));
  const store = await withStore(t);
  withFakeCatalog(t, origin);
  const models = router(t, [stub("demo", undefined)]);
  const deps = { models, locker: store.locker, owner: "local", policy: localPolicy(), store };
  await connectFromPreset(deps, { provider: "groq", key: "sk-secret-value", name: "My Groq" });
  // A fresh router is what a restart looks like: nothing but the built-in presets.
  const afterRestart = new ModelRouter(store, [stub("demo", undefined)]);
  assert.equal(afterRestart.presets.has("groq"), false, "nothing is there until it is put back");
  assert.deepEqual(await restoreConnections({ ...deps, models: afterRestart }), ["groq"]);
  assert.equal(afterRestart.presets.get("groq").name, "My Groq");
  assert.equal(afterRestart.presets.get("groq").catalogId, "groq");
  // The key stayed in the locker and was never written into settings.
  const saved = JSON.stringify(store.get("settings", "local", "model-connections").data);
  assert.ok(!saved.includes("sk-secret-value"), "the key is not in the settings record");
  assert.ok(store.locker.exists("local", connectionProject, "GROQ_KEY"));
});

test("a connection whose key was taken out of the locker by hand is skipped, not fatal", async (t) => {
  const { origin } = await fake(t, (req, res) => json(res, { data: [{ id: "one" }] }));
  const store = await withStore(t);
  withFakeCatalog(t, origin);
  const models = router(t, [stub("demo", undefined)]);
  const deps = { models, locker: store.locker, owner: "local", policy: localPolicy(), store };
  await connectFromPreset(deps, { provider: "groq", key: "sk-secret-value" });
  store.locker.remove("local", connectionProject, "GROQ_KEY");
  const afterRestart = new ModelRouter(store, [stub("demo", undefined)]);
  assert.deepEqual(await restoreConnections({ ...deps, models: afterRestart }), [], "it is left out rather than half built");
  assert.equal(afterRestart.presets.has("groq"), false);
});

test("a routing profile does not send picture work to a connection that cannot see one", async (t) => {
  const store = await withStore(t);
  const models = new ModelRouter(store, [stub("g", "groq"), stub("o", "openai")]);
  profiles.saveProfileSettings(store, "local", models, {
    active: "mine",
    profiles: [{ id: "mine", name: "Mine", description: "", fallback: { preset: "g", fallbacks: ["o"] }, routes: {} }],
  });
  const forPictures = profiles.routeByProfile(store, models, "local", "vision");
  assert.equal(forPictures.preset, "o", "the one that can be shown a picture took it");
  assert.match(forPictures.reason, /asked for g first/);
  // Ordinary conversation is unchanged: Groq can hold one, so it still goes first.
  assert.equal(profiles.routeByProfile(store, models, "local", "chat").preset, "g");
});

test("a connection can be taken away for good: the list, the record and the key", async (t) => {
  const { origin } = await fake(t, (req, res) => json(res, { data: [{ id: "one" }] }));
  const store = await withStore(t);
  withFakeCatalog(t, origin);
  const models = router(t, [stub("demo", undefined)]);
  const deps = { models, locker: store.locker, owner: "local", policy: localPolicy(), store };
  await connectFromPreset(deps, { provider: "groq", key: "one" });
  await connectFromPreset(deps, { provider: "groq", key: "two" });
  assert.deepEqual(await forgetConnection(deps, "groq"), { id: "groq", removed: true });
  assert.equal(models.presets.has("groq"), false);
  assert.equal(models.presets.has("groq-2"), true, "a name that merely starts the same is left alone");
  assert.equal(store.locker.exists("local", connectionProject, "GROQ_KEY"), false);
  assert.equal(store.locker.exists("local", connectionProject, "GROQ_2_KEY"), true);
  // It stays gone: a restart does not bring it back.
  const afterRestart = new ModelRouter(store, [stub("demo", undefined)]);
  assert.deepEqual(await restoreConnections({ ...deps, models: afterRestart }), ["groq-2"]);
  await assert.rejects(forgetConnection(deps, "groq"), /no connection called/);
});

test("a refusal never promises that a connection Branch knows nothing about can do the work", (t) => {
  const models = router(t, [stub("g", "groq"), stub("mine", undefined)]);
  const refused = models.planFor("local", "", "vision");
  assert.match(refused.refusal, /nothing on file about mine/);
  assert.ok(!/mine can\b/.test(refused.refusal), refused.refusal);
});

test("the connection card says in plain words what a connection can and cannot do", async (t) => {
  const models = router(t, [stub("g", "groq")]);
  const probe = await probeProvider(models, "g", localPolicy(), async () => { throw new Error("no network in this test"); });
  assert.ok(probe.canSaid.some((line) => line.includes("hold a conversation")), probe.canSaid.join(" "));
  assert.ok(probe.canSaid.some((line) => line.startsWith("It cannot") && line.includes("be shown a picture")), probe.canSaid.join(" "));
  assert.equal(probe.can.vision, false);
  assert.equal(probe.can.chat, true);
});
