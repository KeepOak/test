// mac5/providers: every provider reached only through a route its terms allow (issue #108).
// Nothing here reaches a real service: every request lands on a fake on 127.0.0.1.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { catalogEntries, catalogEntry, resolveBaseUrl, useCatalog, providerCatalog } from "../dist/provider-catalog.js";
import { buildConnection, testRouteFor } from "../dist/provider-factory.js";
import { perplexityBody, agentModelFor } from "../dist/providers/perplexity-agent.js";
import { vertexFetch } from "../dist/providers/anthropic-vertex.js";
import { migrateRecords } from "../dist/provider-migrations.js";
import { connectFromPreset, migrateSavedConnections, restoreConnections, savedConnections, connectionsSetting } from "../dist/connections-preset.js";
import { probeProvider } from "../dist/provider-probe.js";
import { ModelRouter } from "../dist/models.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { Store } from "../dist/store.js";
import { allPresets } from "../dist/providers/presets.js";

const request = (extra = {}) => ({
  messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hello" },
    { role: "assistant", content: "earlier" }, { role: "user", content: "again" }],
  tools: [], signal: new AbortController().signal, maxTokens: 32, ...extra,
});

async function fake(t, handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    handler(req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen };
}
const json = (res, value) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };

function routerFor(store) {
  const demo = { id: "demo", name: "Demo", model: "demo", provider: { name: "offline-demo-fixture", complete: async () => ({ content: "", toolCalls: [] }) } };
  return new ModelRouter(store, [demo]);
}

/** Builds a catalog connection with its address pointed at a fake. */
function against(id, origin, input = {}) {
  const original = providerCatalog();
  useCatalog({ ...original, services: original.services.map((s) => (s.id === id ? { ...s, baseUrl: `${origin}/v1`, extras: [] } : s)) });
  try { return buildConnection({ provider: id, key: "test-key", ...input }); } finally { useCatalog(original); }
}

// ------------------------------------------------------------------ 1. Perplexity

test("Perplexity uses the Agent API route and sends a preset, not a Sonar model", async (t) => {
  const { origin, seen } = await fake(t, (req, res) =>
    json(res, { output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 2, output_tokens: 1 } }));
  const { provider } = against("perplexity", origin, { model: "sonar-pro" });
  const done = await provider.complete(request());
  assert.equal(done.content, "ok");
  assert.equal(seen[0].url, "/v1/agent");
  assert.equal(seen[0].body.preset, "low");
  assert.equal(seen[0].body.model, undefined);
  assert.equal(seen[0].headers.authorization, "Bearer test-key");
  const earlier = seen[0].body.input.find((item) => item.role === "assistant");
  assert.equal(earlier.content, "earlier", "an earlier reply goes as plain words, since the Agent API takes input parts only");
});

test("a provider/model name goes in model, a preset in preset", () => {
  assert.deepEqual(perplexityBody({ model: "openai/gpt-5", input: [] }).model, "openai/gpt-5");
  assert.equal(perplexityBody({ model: "fast", input: [] }).preset, "fast");
  assert.equal(agentModelFor("sonar"), "fast");
  assert.equal(agentModelFor("sonar-deep-research"), "high");
  assert.equal(agentModelFor("medium"), "medium");
});

test("the catalog line for Perplexity names the Agent API and no longer the Sonar chat route", () => {
  const entry = catalogEntry("perplexity");
  assert.equal(entry.shape, "perplexity-agent");
  assert.equal(entry.baseUrl, "https://api.perplexity.ai/v1");
  assert.equal(entry.defaultModel, "fast");
});

test("saved Perplexity and regional connections are moved in place, once, with their ids kept", () => {
  const records = [
    { id: "perplexity", name: "P", catalogId: "perplexity", model: "sonar", extras: {} },
    { id: "perplexity-2", name: "P2", catalogId: "perplexity", model: "medium", extras: {} },
    { id: "moonshot", name: "M", catalogId: "moonshot", model: "moonshot-v1-8k", extras: {} },
    { id: "dashscope", name: "Q", catalogId: "dashscope", model: "qwen-plus", extras: {} },
    { id: "minimax", name: "X", catalogId: "minimax", model: "abab6.5s-chat", extras: {} },
    { id: "minimax-2", name: "X2", catalogId: "minimax", model: "MiniMax-M3", extras: { host: "api.minimax.io" } },
  ];
  const first = migrateRecords(records);
  assert.deepEqual(first.changed, ["perplexity", "moonshot", "dashscope", "minimax"]);
  assert.equal(first.records[0].model, "fast");
  assert.equal(first.records[0].id, "perplexity");
  assert.equal(first.records[2].extras.host, "api.moonshot.cn", "an old connection keeps the address it was using");
  assert.equal(first.records[3].extras.host, "dashscope.aliyuncs.com");
  assert.equal(first.records[4].extras.host, "api.minimax.cn");
  assert.equal(first.records[5].extras.host, "api.minimax.io");
  assert.deepEqual(migrateRecords(first.records).changed, [], "running it again changes nothing");
});

test("restoring connections writes the move back and rebuilds on the new route", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close?.());
  store.save("settings", "owner", connectionsSetting, { connections: [
    { id: "perplexity", name: "Perplexity", catalogId: "perplexity", model: "sonar", extras: {} },
    { id: "github-models", name: "GitHub Models", catalogId: "github-models", model: "openai/gpt-4o", extras: {} },
  ] });
  const models = routerFor(store);
  const locker = { exists: () => true, resolve: async (_o, _p, names) => Object.fromEntries(names.map((n) => [n, "k"])) };
  const back = await restoreConnections({ models, locker, owner: "owner", policy: new NetworkPolicy({}), store });
  assert.deepEqual(back, ["perplexity", "github-models"], "a retired connection is kept, not silently dropped");
  assert.equal(savedConnections(store, "owner")[0].model, "fast");
  assert.equal(models.presets.get("perplexity").provider.name, "perplexity-agent");
  assert.deepEqual(migrateSavedConnections(store, "owner"), []);
});

// ------------------------------------------------------------------ 2. GitHub Models

test("GitHub Models builds without throwing, and every use answers with the plain retired note", async () => {
  const built = buildConnection({ provider: "github-models", key: "", model: "openai/gpt-4o" });
  assert.equal(built.provider.retired, true);
  await assert.rejects(built.provider.complete(request()), /retired GitHub Models on 30 July 2026.*Microsoft Foundry.*Copilot/s);
  assert.equal(catalogEntry("github-models").terms.standing, "retired");
});

test("a retired connection's check says so plainly and reaches nothing", async (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close?.());
  const models = routerFor(store);
  const built = buildConnection({ provider: "github-models", key: "x" });
  models.register({ id: "gh", name: "GitHub Models", provider: built.provider, model: built.model, catalogId: "github-models" });
  const probe = await probeProvider(models, "gh", new NetworkPolicy({}), () => { throw new Error("must not be called"); });
  assert.equal(probe.retired, true);
  assert.match(probe.summary, /retired/);
  assert.equal(probe.terms.standing, "retired");
});

test("a new connection to a retired or not-offered service is refused before anything is sent", async () => {
  const deps = { models: { presets: new Map() }, locker: {}, owner: "o", policy: new NetworkPolicy({}),
    fetchImpl: () => { throw new Error("must not be called"); } };
  await assert.rejects(connectFromPreset(deps, { provider: "github-models", key: "x" }), /retired/);
  await assert.rejects(connectFromPreset(deps, { provider: "github-copilot", key: "x" }), /OpenCode/);
  const tested = testRouteFor("github-models", "https://models.github.ai/inference", "m", "k");
  await assert.rejects(tested.complete(request()), /retired/);
});

test("key-sweep review: the Perplexity test route sends through the checked fetch it is given", async () => {
  const seen = [];
  const fetchImpl = async (target) => { seen.push(String(target)); throw new Error("blocked by the network rules"); };
  const tested = testRouteFor("perplexity", "https://api.perplexity.ai", "sonar", "k", fetchImpl);
  await assert.rejects(tested.complete(request()), /blocked/);
  assert.equal(seen.length, 1, "the checked fetch saw the request");
});

// ------------------------------------------------------------------ 4. Claude on Vertex

test("Claude on Vertex moves the model into the address and the token into Authorization", async () => {
  const seen = [];
  const next = async (url, init) => { seen.push({ url, init }); return new Response("{}"); };
  const call = vertexFetch("claude-sonnet-5", "tok", next);
  await call("https://global-aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/anthropic/messages", {
    method: "POST", headers: { "x-api-key": "tok", "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-5", stream: true, messages: [] }),
  });
  assert.equal(seen[0].url, "https://aiplatform.googleapis.com/v1/projects/p/locations/global/publishers/anthropic/models/claude-sonnet-5:streamRawPredict");
  const headers = new Headers(seen[0].init.headers);
  assert.equal(headers.get("authorization"), "Bearer tok");
  assert.equal(headers.get("x-api-key"), null);
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.anthropic_version, "vertex-2023-10-16");
  assert.equal(body.model, undefined);
});

test("a regional Vertex address keeps its region host, and an odd model name is refused", async () => {
  const seen = [];
  const call = vertexFetch("claude-haiku-4-5@20251001", "tok", async (url) => { seen.push(url); return new Response("{}"); });
  await call("https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/publishers/anthropic/messages",
    { method: "POST", body: JSON.stringify({ model: "x" }) });
  assert.match(seen[0], /^https:\/\/us-east5-aiplatform\.googleapis\.com\/.*claude-haiku-4-5@20251001:rawPredict$/);
  const bad = vertexFetch("../evil", "tok", async () => new Response("{}"));
  await assert.rejects(bad("https://x.example/v1/messages", { method: "POST", body: "{}" }), /may only contain/);
});

// ------------------------------------------------------------------ 7. regions and addresses

test("a region choice defaults to the international address and accepts only the listed ones", () => {
  assert.equal(resolveBaseUrl(catalogEntry("moonshot")), "https://api.moonshot.ai/v1");
  assert.equal(resolveBaseUrl(catalogEntry("moonshot"), { host: "api.moonshot.cn" }), "https://api.moonshot.cn/v1");
  assert.equal(resolveBaseUrl(catalogEntry("minimax")), "https://api.minimax.io/v1");
  assert.equal(resolveBaseUrl(catalogEntry("dashscope")), "https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
  assert.throws(() => resolveBaseUrl(catalogEntry("minimax"), { host: "evil.example" }), /must be one of/);
  assert.equal(resolveBaseUrl(catalogEntry("zai")), "https://api.z.ai/api/paas/v4");
  assert.equal(resolveBaseUrl(catalogEntry("deepseek")), "https://api.deepseek.com");
  assert.equal(catalogEntry("deepseek").defaultModel, "deepseek-flash");
  assert.equal(resolveBaseUrl(catalogEntry("azure-openai-v1"), { resource: "mine" }), "https://mine.openai.azure.com/openai/v1");
});

// ------------------------------------------------------------------ 8. the Terms line

test("every provider carries a Terms line with an https link, and warnings where a route is not official", () => {
  for (const entry of catalogEntries()) {
    assert.ok(entry.terms.route.length > 3, `${entry.id} names its route`);
    assert.match(entry.terms.url, /^https:\/\//, `${entry.id} links its terms`);
    if (entry.terms.standing !== "official") assert.ok(entry.terms.warning, `${entry.id} says why it is ${entry.terms.standing}`);
  }
  assert.equal(allPresets().find((p) => p.id === "github-copilot").terms.standing, "not-offered");
  assert.ok(allPresets().every((p) => p.terms && p.terms.url));
});

test("no route in the catalog signs in to Claude.ai, Gemini CLI or Copilot on Branch's own account", () => {
  const text = JSON.stringify(providerCatalog());
  for (const forbidden of ["Iv1.b507a08c87ecfe98", "Ov23li8tweQw6odWQebz", "vscode-chat", "claude.ai/oauth", "681255809395"])
    assert.ok(!text.includes(forbidden), `the catalog mentions ${forbidden}`);
});

test("the provider picker says each service's standing under its terms, in both languages", async () => {
  // Redesign: the picker is the new window's Add account flow (public/app/flows/account.js). The prototype's picker has no
  // Terms line with a "read" link (the old #provider-terms and #chatgpt-terms); it names a retired or not-offered service by
  // the engine's standing, in its own group, so those words are what must be there in English and real French.
  const { readFile } = await import("node:fs/promises");
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const [script, en, fr] = await Promise.all([read("public/app/flows/account.js"), read("public/locales/en.json"), read("public/locales/fr.json")]);
  assert.match(script, /s\.terms\?\.standing === "not-offered" \? t\("terms\.standing\.not-offered"\) : t\("terms\.standing\.retired"\)/,
    "a service the engine marks not offered or retired says so");
  const english = JSON.parse(en), french = JSON.parse(fr);
  const used = [...new Set([...script.matchAll(/"(terms\.[a-z.-]+)"/g)].map((hit) => hit[1]))];
  assert.ok(used.length >= 2, `the picker names the standings through keys (${used.join(", ")})`);
  for (const key of used) {
    assert.ok(english[key], `${key} in English`);
    assert.ok(french[key] && french[key] !== english[key], `${key} has real French`);
  }
});

test("a retired connection is never picked as a fallback", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close?.());
  const models = routerFor(store);
  const retired = buildConnection({ provider: "github-models", key: "x" });
  models.register({ id: "gh", name: "GitHub Models", provider: retired.provider, model: retired.model, catalogId: "github-models" });
  models.configure("owner", { activePreset: "demo", fallbackOrder: ["gh"] });
  const plan = models.plan("owner", "s1");
  assert.deepEqual(plan.candidates.map((c) => c.id), ["demo"]);
});

// ------------------------------------------------------------------ integrator (mac5/providers)

test("a new region connection keeps the address it was made with after a restart", async (t) => {
  const { origin } = await fake(t, (_req, res) => json(res, { data: [{ id: "kimi-k2.6" }] }));
  const store = new Store(":memory:");
  t.after(() => store.close?.());
  const models = routerFor(store);
  const locker = { set: async () => undefined, exists: () => true,
    resolve: async (_o, _p, names) => Object.fromEntries(names.map((n) => [n, "k"])) };
  const deps = { models, locker, owner: "owner", policy: new NetworkPolicy({ allowPrivateAddresses: true }), store,
    fetchImpl: (url, init) => fetch(String(url).replace("https://api.moonshot.ai", origin), init) };
  await connectFromPreset(deps, { provider: "moonshot", key: "intl-key", extras: {} });
  assert.equal(savedConnections(store, "owner")[0].extras.host, "api.moonshot.ai", "the default the key was checked against is written down");
  assert.deepEqual(migrateSavedConnections(store, "owner"), [], "a connection made today is not moved to the mainland address");
  assert.equal(savedConnections(store, "owner")[0].extras.host, "api.moonshot.ai");
});

test("moving a saved connection keeps a copy of what it was and records old and new, never a key", (t) => {
  const store = new Store(":memory:");
  t.after(() => store.close?.());
  const before = [{ id: "perplexity", name: "P", catalogId: "perplexity", model: "sonar-pro", extras: {} },
    { id: "minimax", name: "M", catalogId: "minimax", model: "abab6.5s-chat", extras: {} }];
  store.save("settings", "owner", connectionsSetting, { connections: before });
  assert.deepEqual(migrateSavedConnections(store, "owner"), ["perplexity", "minimax"]);
  const copy = store.get("settings", "owner", "model-connections-before-move")?.data;
  assert.deepEqual(copy.connections, before, "the records as they were are kept beside the new ones");
  const entry = store.audit.list("owner").find((row) => row.action === "connection.changed");
  assert.match(entry.reason, /sonar-pro → low/);
  assert.match(entry.reason, /api\.minimax\.cn/);
  assert.doesNotMatch(JSON.stringify(entry), /KEY|secret/i);
  // Running again neither moves nor overwrites the first copy.
  assert.deepEqual(migrateSavedConnections(store, "owner"), []);
  assert.deepEqual(store.get("settings", "owner", "model-connections-before-move").data.connections, before);
});

test("a Sonar name Perplexity gave no replacement for is refused in plain words, not sent", () => {
  assert.equal(agentModelFor("sonar-reasoning"), "sonar-reasoning", "no replacement is invented");
  assert.throws(() => perplexityBody({ model: "sonar-reasoning", input: "hi" }), /sonar-reasoning.*fast, low, medium, high, xhigh/s);
  assert.deepEqual(perplexityBody({ model: "openai/gpt-5.6-sol", input: "hi" }).model, "openai/gpt-5.6-sol");
});

test("a local program from the catalog is reachable on its own port only, with the owner's rules kept", async (t) => {
  const { origin, seen } = await fake(t, (_req, res) => json(res, { data: [{ id: "llama3" }] }));
  const original = providerCatalog();
  useCatalog({ ...original, services: original.services.map((s) => (s.id === "ollama" ? { ...s, baseUrl: `${origin}/v1` } : s)) });
  t.after(() => useCatalog(original));
  const store = new Store(":memory:");
  t.after(() => store.close?.());
  const models = routerFor(store);
  const locker = { set: async () => undefined };
  const deps = { models, locker, owner: "owner", policy: new NetworkPolicy({}), store };
  const made = await connectFromPreset(deps, { provider: "ollama", key: "" });
  assert.equal(made.modelsFound, 1, "the default rules do not refuse the program's own address");
  assert.ok(seen.length >= 1);
  const { connectionCheck } = await import("../dist/local-connection-policy.js");
  const check = connectionCheck(new NetworkPolicy({}), catalogEntry("ollama"), `${origin}/v1`);
  await check(new URL(`${origin}/v1/chat/completions`));
  await assert.rejects(check(new URL("http://127.0.0.1:1/v1/models")), /private or local/, "another port stays closed");
  await assert.rejects(check(new URL("http://10.0.0.5/v1/models")), /private or local/);
  const blocked = connectionCheck(new NetworkPolicy({ blockedHosts: ["127.0.0.1"] }), catalogEntry("ollama"), `${origin}/v1`);
  await assert.rejects(blocked(new URL(`${origin}/v1/models`)), /blocked/, "the owner's block still wins");
  // A cloud entry pointed at this computer gets no such allowance.
  const cloud = connectionCheck(new NetworkPolicy({}), catalogEntry("openai"), `${origin}/v1`);
  await assert.rejects(cloud(new URL(`${origin}/v1/models`)), /private or local/);
});

test("the Vertex token goes to no route but the conversation one, and no coding assistant gets the prompt as an argument", async () => {
  const call = vertexFetch("claude-sonnet-5", "tok", () => { throw new Error("must not be called"); });
  await assert.rejects(call("https://us-east5-aiplatform.googleapis.com/v1/projects/p/locations/us-east5/publishers/anthropic/models", {}), /only hold conversations/);
  const { cliAgentCatalog } = await import("../dist/providers/cli-agent.js");
  assert.deepEqual(cliAgentCatalog.find((row) => row.id === "copilot").args, [], "the question is piped in, never put after -p");
  assert.ok(cliAgentCatalog.every((row) => !row.args.includes("-p") || row.id === "claude-code"), "claude -p reads the question from standard input");
});
