// QA Q003: a model server the owner configures ("Something else that speaks OpenAI's shape", or a local program) is
// reachable on this computer and on the owner's own network, on its own address only; the web-tools policy that every
// tool and agent goes through is unchanged. Nothing here reaches a real service: every request lands on a fake on
// 127.0.0.1, or on a stand-in fetch that records what it was asked.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { catalogEntry } from "../dist/provider-catalog.js";
import { buildConnection } from "../dist/provider-factory.js";
import { connectFromPreset } from "../dist/connections-preset.js";
import { connectionCheck, connectionFetch, ownModelOrigin } from "../dist/local-connection-policy.js";
import { ModelRouter } from "../dist/models.js";
import { NetworkPolicy } from "../dist/network-policy.js";
import { Store } from "../dist/store.js";

async function fake(t) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url.endsWith("/models") ? { data: [{ id: "stand-in" }] }
      : { choices: [{ message: { role: "assistant", content: "hello back" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return { origin: `http://127.0.0.1:${server.address().port}`, port: server.address().port, seen };
}

function deps() {
  const store = new Store(":memory:");
  const demo = { id: "demo", name: "Demo", model: "demo", provider: { name: "offline-demo-fixture", complete: async () => ({ content: "", toolCalls: [] }) } };
  return { models: new ModelRouter(store, [demo]), locker: { set: async () => undefined }, owner: "owner", policy: new NetworkPolicy({}), store };
}

const chat = { messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 8, signal: new AbortController().signal };

test("an OpenAI-shaped server the owner adds on this computer works, by 127.0.0.1 and by localhost", async (t) => {
  const { origin, port, seen } = await fake(t);
  for (const base of [`${origin}/v1`, `http://localhost:${port}/v1`]) {
    const made = await connectFromPreset(deps(), { provider: "custom", key: "stand-in-key", extras: { baseUrl: base } });
    assert.equal(made.modelsFound, 1, `the default rules let the owner's own server at ${base} answer`);
    const built = buildConnection({ provider: "custom", key: "stand-in-key", extras: { baseUrl: base }, model: "stand-in", policy: new NetworkPolicy({}) });
    assert.equal((await built.provider.complete(chat)).content, "hello back");
  }
  assert.ok(seen.includes("/v1/chat/completions"));
});

test("the web-tools policy still refuses this computer: a tool fetching 127.0.0.1 is refused", async (t) => {
  const { origin, seen } = await fake(t);
  const policy = new NetworkPolicy({});
  await assert.rejects(policy.guard(globalThis.fetch)(`${origin}/v1/models`), /private or local/);
  await assert.rejects(policy.assertAllowed(new URL(`${origin}/`)), /private or local/);
  await assert.rejects(policy.assertAllowed(new URL("http://192.168.1.20:11434/")), /private or local/);
  await assert.rejects(policy.assertAllowed(new URL("http://localhost:11434/")), /this computer or a private network/);
  assert.deepEqual(seen, [], "nothing reached the server");
  // A service with a fixed address in the catalog gets no allowance, whatever address it is handed.
  await assert.rejects(connectionCheck(policy, catalogEntry("openai"), `${origin}/v1`)(new URL(`${origin}/v1/models`)), /private or local/);
});

test("the allowance is the connection's own address only: another port, a redirect or another host is refused", async (t) => {
  const { origin, port } = await fake(t);
  const policy = new NetworkPolicy({});
  const custom = catalogEntry("custom");
  const check = connectionCheck(policy, custom, `${origin}/v1`);
  await check(new URL(`${origin}/v1/models`));
  await assert.rejects(check(new URL(`http://127.0.0.1:${port + 1}/v1/models`)), /private or local/, "another port stays closed");
  await assert.rejects(check(new URL("http://10.0.0.5/v1/models")), /private or local/);
  const asked = [];
  const call = connectionFetch(policy, custom, `${origin}/v1`, async (input, init) => { asked.push(init.redirect); return new Response("{}"); });
  await call(`${origin}/v1/models`, { redirect: "follow" });
  assert.deepEqual(asked, ["error"], "a redirect is never followed by itself");
  await assert.rejects(call(`http://127.0.0.1:${port + 1}/v1/models`), /not the address of this model's program/);
  const blocked = connectionCheck(new NetworkPolicy({ blockedHosts: ["127.0.0.1"] }), custom, `${origin}/v1`);
  await assert.rejects(blocked(new URL(`${origin}/v1/models`)), /blocked/, "the owner's block still wins");
});

test("the emergency stop still holds a server the owner gave by address on this computer", async (t) => {
  const { origin, seen } = await fake(t);
  const stopped = new NetworkPolicy({});
  stopped.emergencyStop = () => { throw new Error("The emergency stop is on"); };
  const custom = catalogEntry("custom");
  await assert.rejects(connectionCheck(stopped, custom, `${origin}/v1`)(new URL(`${origin}/v1/models`)), /emergency stop/);
  await assert.rejects(connectionFetch(stopped, custom, `${origin}/v1`, globalThis.fetch)(`${origin}/v1/models`), /emergency stop/);
  const built = buildConnection({ provider: "custom", key: "k", extras: { baseUrl: `${origin}/v1` }, model: "stand-in", policy: stopped });
  await assert.rejects(built.provider.complete(chat), /emergency stop/);
  assert.deepEqual(seen, [], "nothing reached the server");
});

test("a server on the owner's own network is allowed; metadata, shared, testing and named addresses are not", async () => {
  const custom = catalogEntry("custom");
  for (const base of ["http://192.168.1.20:11434/v1", "http://10.0.0.7:1234/v1", "http://172.16.4.2:8080/v1", "http://[fd00::12]:8000/v1"])
    assert.ok(ownModelOrigin(custom, base), `${base} is the owner's own network`);
  for (const base of ["http://169.254.169.254/v1", "http://100.64.1.1/v1", "http://172.32.0.1/v1", "http://198.18.0.1/v1",
    "http://[::ffff:192.168.1.2]/v1", "http://[fe80::1]/v1", "http://[fd00:ec2::254]/v1", "http://0.0.0.0/v1", "http://mybox.lan/v1", "https://api.example.com/v1"])
    assert.equal(ownModelOrigin(custom, base), null, `${base} gets no allowance`);
  assert.equal(ownModelOrigin(catalogEntry("openai"), "http://192.168.1.20/v1"), null, "only an address the owner sets");
  // Built through the factory: plain http is fine on the owner's network, and the metadata address is refused.
  const policy = new NetworkPolicy({});
  const lan = connectionCheck(policy, custom, "http://192.168.1.20:11434/v1");
  await lan(new URL("http://192.168.1.20:11434/v1/models"));
  await assert.rejects(lan(new URL("http://192.168.1.21:11434/v1/models")), /private or local/);
  assert.throws(() => buildConnection({ provider: "custom", key: "k", extras: { baseUrl: "http://169.254.169.254/v1" }, policy }), /https/);
  const meta = buildConnection({ provider: "custom", key: "k", extras: { baseUrl: "https://169.254.169.254/v1" }, model: "m", policy });
  await assert.rejects(meta.provider.complete(chat), /private or local/);
  // The owner's rules and Lockdown still apply on the owner's network.
  const ruled = connectionCheck(new NetworkPolicy({ blockedHosts: ["192.168.1.20"] }), custom, "http://192.168.1.20:11434/v1");
  await assert.rejects(ruled(new URL("http://192.168.1.20:11434/v1/models")), /blocked/);
  const locked = new NetworkPolicy({});
  locked.emergencyStop = () => { throw new Error("Lockdown is on"); };
  const call = connectionFetch(locked, custom, "http://192.168.1.20:11434/v1", async () => new Response("{}"));
  await assert.rejects(call("http://192.168.1.20:11434/v1/models"), /Lockdown/);
});
