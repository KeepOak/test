/* MODEL-087: the NAS model through the owner's own SSH forward. Branch only ever talks to http://127.0.0.1:<port>/v1,
   never starts SSH, and never counts the connection as a model on this computer even though it listens here. */
import test from "node:test";
import assert from "node:assert/strict";
import { catalogEntry, resolveBaseUrl } from "../dist/provider-catalog.js";
import { presetRunsLocally } from "../dist/models.js";
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
