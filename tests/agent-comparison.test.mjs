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
