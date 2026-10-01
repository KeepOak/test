/* MODEL-087: the NAS model through the owner's own SSH forward. Branch only ever talks to http://127.0.0.1:<port>/v1,
   never starts SSH, and never counts the connection as a model on this computer even though it listens here. */
import test from "node:test";
import assert from "node:assert/strict";
import { catalogEntry, resolveBaseUrl } from "../dist/provider-catalog.js";
import { presetRunsLocally } from "../dist/models.js";
import { embeddingConnection, embeddingsFor } from "../dist/embeddings.js";
import { buildConnection } from "../dist/provider-factory.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { ownModelOrigin } from "../dist/local-connection-policy.js";

const nas = () => catalogEntry("nas-ssh");
const sharing = (endpoint) => ({ name: "fake", complete: async () => ({ content: "", toolCalls: [] }), embeddings: () => ({ endpoint }) });

test("MODEL-087: the forward's address is this computer's loopback on the chosen port, and nothing else", () => {
  assert.ok(nas(), "the catalogue has the NAS entry");
  assert.equal(resolveBaseUrl(nas(), { port: "18080" }), "http://127.0.0.1:18080/v1");
  for (const port of ["0", "65536", "80@evil.example", "1/../../x", "18080/v2", "18080?x=1"])
    assert.throws(() => resolveBaseUrl(nas(), { port }), /./, `port ${port} is refused`);
});

test("MODEL-087: a forwarded NAS model is never a local-only model, though an ordinary loopback one still is", () => {
  const endpoint = "http://127.0.0.1:18080/v1";
  assert.equal(presetRunsLocally({ id: "nas", name: "NAS", model: "qwen", catalogId: "nas-ssh", provider: sharing(endpoint) }), false);
  assert.equal(presetRunsLocally({ id: "mine", name: "Mine", model: "qwen", provider: sharing(endpoint) }), true);
});

test("MODEL-087: only the forward's own 127.0.0.1 origin gets the model-server allowance", () => {
  assert.deepEqual(ownModelOrigin(nas(), "http://127.0.0.1:18080/v1"), { origin: "http://127.0.0.1:18080", here: true });
  assert.equal(ownModelOrigin(nas(), "http://localhost:18080/v1"), null);
  assert.equal(ownModelOrigin(nas(), "http://192.168.1.20:18080/v1"), null);
  assert.equal(ownModelOrigin(nas(), "https://127.0.0.1:18080/v1"), null);
});

for (const endpoint of ["http://127.0.0.1:18080/v1", "http://127.0.0.1:11434/v1"]) {
  test(`MODEL-087: NAS embedding privacy retains the remote preset at ${endpoint}`, () => {
    const provider = { ...sharing(endpoint), embeddings: () => ({ endpoint, apiKey: "fixture-only" }) };
    const preset = { id: "nas", name: "NAS", model: "qwen", catalogId: "nas-ssh", provider };
    const models = { plan: () => ({ candidates: [preset] }) };
    const connection = embeddingConnection(models, "owner");
    assert.ok(connection);
    assert.equal(connection.local, false, "a loopback forward cannot claim that passages stay on this computer");
    assert.equal(connection.shape, "openai", "a NAS port matching Ollama does not change the remote protocol");
    assert.equal(connection.model, "text-embedding-3-small");
    assert.equal(embeddingsFor(connection, () => { throw new Error("fixture must not contact a model"); }).local, false);
    const ordinary = embeddingConnection({ plan: () => ({ candidates: [{ ...preset, catalogId: undefined }] }) }, "owner");
    assert.equal(ordinary.local, true, "ordinary local embedding routing remains available");
    assert.equal(ordinary.shape, endpoint.includes(":11434/") ? "ollama" : "openai");
    assert.equal(embeddingConnection({ plan: () => ({ candidates: [] }) }, "owner"), null);
  });
}
const embeddingReply = () => Response.json({ data: [{ index: 0, embedding: [1, 2] }] });
const nasReader = (policy, call) => {
  const built = buildConnection({ provider: "nas-ssh", key: "fixture-only", extras: { port: "18080" }, model: "qwen", policy, fetchImpl: call });
  const preset = { id: "nas", name: "NAS", model: built.model, catalogId: "nas-ssh", provider: built.provider };
  const connection = embeddingConnection({ plan: () => ({ candidates: [preset] }) }, "owner");
  assert.ok(connection.fetchImpl, "the real factory's guarded transport survives the provider accessor");
  assert.equal(connection.local, false);
  return { connection, reader: embeddingsFor(connection, async () => { throw new Error("factory transport was lost"); }) };
};

for (const [name, rules] of [
  ["blocked host", { blockedHosts: ["127.0.0.1"] }],
  ["blocked path", { blockedPaths: ["127.0.0.1/v1/embeddings"] }],
  ["unallowed host", { allowedHosts: ["api.openai.com"] }],
  ["unallowed path", { allowedPaths: ["127.0.0.1/v1/chat/"] }],
]) {
  test(`MODEL-087: factory NAS embedding transport enforces ${name} before dispatch`, async () => {
    let dispatched = 0;
    const { reader } = nasReader(new NetworkPolicy(rules), async () => { dispatched++; return embeddingReply(); });
    await assert.rejects(reader.embed(["private passage"], new AbortController().signal), /blocked list|allowed list/);
    assert.equal(dispatched, 0);
  });
}

test("MODEL-087: NAS embeddings retain emergency stop, chosen origin, redirect refusal and cancellation", async () => {
  const policy = new NetworkPolicy({});
  let stopped = false;
  policy.emergencyStop = () => { if (stopped) throw new Error("fixture emergency stop"); };
  const requests = [];
  const { connection, reader } = nasReader(policy, async (url, init) => {
    init?.signal?.throwIfAborted();
    requests.push({ url, init });
    return embeddingReply();
  });
  const signal = new AbortController().signal;
  assert.deepEqual(Array.from((await reader.embed(["passage"], signal))[0]), [1, 2]);
  assert.equal(requests[0].url, "http://127.0.0.1:18080/v1/embeddings");
  assert.equal(requests[0].init.redirect, "error");
  assert.equal(requests[0].init.signal, signal);
  await assert.rejects(connection.fetchImpl("http://127.0.0.1:18081/v1/embeddings"), /not the address/);
  const cancelled = new AbortController();
  cancelled.abort(new Error("fixture cancelled"));
  await assert.rejects(reader.embed(["passage"], cancelled.signal), /fixture cancelled/);
  stopped = true;
  await assert.rejects(reader.embed(["passage"], signal), /fixture emergency stop/);
  assert.equal(requests.length, 1, "neither a different origin nor a stopped request reaches transport");
});

test("MODEL-087: a remote loopback embedding without a provider transport uses the supplied guarded fetch", async () => {
  const endpoint = "http://127.0.0.1:18080/v1";
  const globalFetch = globalThis.fetch;
  let globalCalls = 0, guardedCalls = 0;
  globalThis.fetch = async () => { globalCalls++; throw new Error("unguarded global fetch"); };
  try {
    const reader = embeddingsFor({ shape: "openai", endpoint, apiKey: "fixture-only", model: "qwen", local: false }, async () => {
      guardedCalls++;
      return embeddingReply();
    });
    await reader.embed(["passage"], new AbortController().signal);
    assert.equal(guardedCalls, 1);
    assert.equal(globalCalls, 0);
    globalThis.fetch = async () => { globalCalls++; return embeddingReply(); };
    // The local adapter captures its transport at construction.
    const localReader = embeddingsFor({ shape: "openai", endpoint, apiKey: "fixture-only", model: "qwen", local: true });
    await localReader.embed(["passage"], new AbortController().signal);
    assert.equal(localReader.local, true);
    assert.equal(globalCalls, 1);
  } finally { globalThis.fetch = globalFetch; }
});
