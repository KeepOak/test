/**
 * SELF-213: the agent comparison job ships off, and before any source is fetched or any token spent it
 * needs an explicit model preset and a pinned source for each of Branch, Hermes and OpenClaw.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { CliAgentProvider } from "../dist/providers/cli-agent.js";

test("SELF-213: off by default, and a comparison needs a real preset and all three agents' sources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-agent-compare-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, path, body) => fetch(server.url + path, { method, headers: { authorization: `Bearer ${server.token}`,
    "content-type": "application/json", origin: server.url }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  assert.equal((await call("GET", "/api/agent-comparison")).body.enabled, false);
  const source = (agent) => ({ agent, commit: "a".repeat(40), path: "src/run.ts", fromLine: 1, toLine: 20 });
  const request = { preset: "no-such-preset", maxTokens: 4000, maxSteps: 2, timeoutMs: 60000, network: "pinned-primary-sources",
    sources: [source("Branch"), source("Hermes"), source("OpenClaw")], steps: ["How a task stops"] };
  assert.equal((await call("POST", "/api/agent-comparison/start", request)).status, 409, "off: nothing starts");
  await call("POST", "/api/agent-comparison/settings", { enabled: true });
  assert.equal((await call("POST", "/api/agent-comparison/start", request)).status, 400, "an unknown preset is refused");
  await assert.rejects(app.runtime.run({ prompt: "x", model: "no-such-preset", fixedModel: true }), /isolation/);
  assert.equal(app.store.list("governance", app.runtime.owner).filter((row) => row.id.startsWith("agent-comparison:")).length, 0, "no job was recorded");
});

test("SELF-213: an installed coding assistant, which keeps its own tools, is refused for the isolated comparison", async (t) => {
  let spawned = 0, fetched = 0;
  const provider = new CliAgentProvider({ id: "claude-code", name: "probe", command: "fake", args: [], jsonField: "", note: "test" },
    {}, async () => { spawned++; return { code: 0, stdout: "{}", stderr: "" }; });
  const root = await mkdtemp(join(tmpdir(), "branch-agent-compare-cli-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => String(url).startsWith("https://raw.githubusercontent.com/") ? (fetched++, Promise.resolve(new Response("x", { status: 404 }))) : realFetch(url, init);
  t.after(async () => { globalThis.fetch = realFetch; await server.close(); await app.close(); await discardTemp(root); });
  const preset = [...app.runtime.models.presets.values()].find((row) => row.provider === provider || row.provider.name === provider.name)?.id;
  assert.ok(preset, "the CLI connection is a preset");
  const run = await app.runtime.run({ prompt: "compare", model: preset, fixedModel: true, isolated: true, permissions: [], plan: false,
    verify: false, unattended: true, source: "owner" });
  assert.equal(run.status, "failed");
  assert.match(run.output, /isolated comparison cannot use an installed coding assistant/);
  assert.equal(spawned, 0, "the program never started");
  const call = (method, path, body) => realFetch(server.url + path, { method, headers: { authorization: `Bearer ${server.token}`,
    "content-type": "application/json", origin: server.url }, ...(body ? { body: JSON.stringify(body) } : {}) }).then((r) => r.status);
  await call("POST", "/api/agent-comparison/settings", { enabled: true });
  const source = (agent) => ({ agent, commit: "a".repeat(40), path: "src/run.ts", fromLine: 1, toLine: 20 });
  assert.equal(await call("POST", "/api/agent-comparison/start", { preset, maxTokens: 4000, maxSteps: 2, timeoutMs: 60000,
    network: "pinned-primary-sources", sources: [source("Branch"), source("Hermes"), source("OpenClaw")], steps: ["How a task stops"] }), 400);
  assert.equal(fetched, 0, "no source is fetched for a refused connection");
  assert.equal(spawned, 0);
});
