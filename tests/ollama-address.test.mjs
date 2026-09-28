// The native Ollama connection talks where Ollama really answers: the connection's own address, else BRANCH_OLLAMA_URL,
// else 127.0.0.1:11434, never a port written into the catalog (a forwarded port to a model server at home worked only
// as "OpenAI-compatible" before). The address is held to this computer and the owner's own network, as every model
// server the owner points at is (src/local-connection-policy.ts). Nothing here reaches a real Ollama: every request lands
// on a stand-in on 127.0.0.1.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

/** A stand-in Ollama: its model list, its own chat route, and no room to report. */
async function fakeOllama(t) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "stand-in" }] }));
    if (req.url === "/api/show") { res.statusCode = 404; return res.end("{}"); }
    res.end(JSON.stringify({ message: { role: "assistant", content: "hello back" }, done: true, prompt_eval_count: 1, eval_count: 1 }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return { origin: `http://127.0.0.1:${server.address().port}`, port: server.address().port, seen };
}

// BRANCH_OLLAMA_URL is read once, when Branch starts, so it is set before anything of Branch's is loaded.
const home = await new Promise((ok) => {
  const server = createServer((req, res) => {
    home.seen.push(req.url);
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "from-home" }, { id: "second" }] }));
    if (req.url === "/api/show") { res.statusCode = 404; return res.end("{}"); }
    res.end(JSON.stringify({ message: { role: "assistant", content: "from the moved Ollama" }, done: true }));
  });
  server.listen(0, "127.0.0.1", () => ok({ server, origin: `http://127.0.0.1:${server.address().port}`, seen: [] }));
});
process.env.BRANCH_OLLAMA_URL = home.origin;
const { buildConnection, ollamaBase } = await import("../dist/provider-factory.js");
const { connectFromPreset } = await import("../dist/connections-preset.js");
const { catalogEntry } = await import("../dist/provider-catalog.js");
const { ModelRouter } = await import("../dist/models.js");
const { NetworkPolicy } = await import("../dist/network-policy.js");
const { Store } = await import("../dist/store.js");
test.after(() => new Promise((r) => home.server.close(r)));

function deps() {
  const store = new Store(":memory:");
  const demo = { id: "demo", name: "Demo", model: "demo", provider: { name: "offline-demo-fixture", complete: async () => ({ content: "", toolCalls: [] }) } };
  return { models: new ModelRouter(store, [demo]), locker: { set: async () => undefined }, owner: "owner", policy: new NetworkPolicy({}), store };
}
const chat = { messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 8, signal: new AbortController().signal };

test("with no address given, the Ollama connection goes where BRANCH_OLLAMA_URL says, as native Ollama", async () => {
  // Mutation: build the ollama connection from the catalog's own address → nothing reaches the moved Ollama, red.
  const made = await connectFromPreset(deps(), { provider: "ollama", model: "from-home" });
  assert.equal(made.modelsFound, 2, "the model list came from the moved Ollama");
  const built = buildConnection({ provider: "ollama", key: "", model: "from-home", policy: new NetworkPolicy({}) });
  assert.equal(built.baseUrl, `${home.origin}/v1`);
  assert.equal((await built.provider.complete(chat)).content, "from the moved Ollama");
  assert.ok(home.seen.includes("/api/chat"), "Ollama's own chat route, not the OpenAI-shaped one");
});

test("an Ollama connection given its own address talks there, written with or without /v1", async (t) => {
  const own = await fakeOllama(t);
  for (const baseUrl of [own.origin, `http://localhost:${own.port}/`, `${own.origin}/v1`]) {
    const made = await connectFromPreset(deps(), { provider: "ollama", model: "stand-in", extras: { baseUrl } });
    assert.equal(made.modelsFound, 1, baseUrl);
    const built = buildConnection({ provider: "ollama", key: "", model: "stand-in", extras: { baseUrl }, policy: new NetworkPolicy({}) });
    assert.equal((await built.provider.complete(chat)).content, "hello back", baseUrl);
  }
  assert.ok(own.seen.includes("/api/chat"));
});

test("an Ollama on the owner's own network is allowed; anywhere else, or anything but an address, is refused", async () => {
  // Mutation: drop the own-network check in ollamaBase → a public address builds, red.
  const entry = catalogEntry("ollama");
  assert.equal(ollamaBase(entry, { baseUrl: "http://192.168.1.20:11434" }), "http://192.168.1.20:11434/v1");
  assert.equal(ollamaBase(entry, { baseUrl: "http://10.0.0.5:11434/v1/" }), "http://10.0.0.5:11434/v1");
  for (const [baseUrl, why] of [
    ["http://8.8.8.8:11434", /not this computer or an address on your own network/],
    ["https://ollama.example.com", /not this computer or an address on your own network/],
    ["http://nas.local:11434", /not this computer or an address on your own network/],
    ["http://169.254.1.1:11434", /not this computer or an address on your own network/],
    ["http://100.64.1.2:11434", /not this computer or an address on your own network/],
    ["http://user:pw@127.0.0.1:11434", /only its computer and port/],
    ["http://127.0.0.1:11434/api", /only its computer and port/],
    ["http://127.0.0.1:11434/?x=1", /only its computer and port/],
    ["file:///etc/passwd", /must start with http/],
    ["not an address", /is not an address/],
  ]) {
    assert.throws(() => ollamaBase(entry, { baseUrl }), why, baseUrl);
    await assert.rejects(connectFromPreset(deps(), { provider: "ollama", model: "x", extras: { baseUrl } }), why, baseUrl);
  }
});

test("a connection on the owner's network reaches its own address only", async () => {
  // The allowance is the one address: anything else the connection is asked to fetch goes through the web rules.
  const sent = [];
  const fetchImpl = async (url) => { sent.push(String(url)); return new Response("{}", { status: 404 }); };
  const built = buildConnection({ provider: "ollama", key: "", model: "m", extras: { baseUrl: "http://192.168.1.20:11434" },
    policy: new NetworkPolicy({}), fetchImpl });
  assert.equal(built.baseUrl, "http://192.168.1.20:11434/v1");
  await built.provider.complete(chat).catch(() => undefined);
  assert.ok(sent.length && sent.every((url) => url.startsWith("http://192.168.1.20:11434/")), sent.join(" "));
});

test("the Ollama adapter itself allows plain http only on this computer or the owner's network, and says so", async () => {
  const { OllamaProvider } = await import("../dist/providers/ollama.js");
  for (const endpoint of ["http://127.0.0.1:11434/v1", "http://192.168.1.20:11434/v1"])
    assert.doesNotThrow(() => new OllamaProvider({ endpoint, model: "m" }), endpoint);
  assert.throws(() => new OllamaProvider({ endpoint: "http://ollama.example.com:11434/v1", model: "m" }),
    /plain HTTP is allowed only on this computer or your own network/);
});
