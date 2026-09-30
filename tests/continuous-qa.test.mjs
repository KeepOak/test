/**
 * SELF-210/211: continuous QA ships off, runs only against a prepared isolated Test copy, and model fix
 * drafts (which spend tokens) need an explicit model, file scope and daily budget.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

test("SELF-210/211: off by default; turning it on needs a Test copy; fix drafts need a model, scope and budget", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-continuous-qa-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = (method, body) => fetch(server.url + "/api/continuous-qa", { method, headers: { authorization: `Bearer ${server.token}`,
    "content-type": "application/json", origin: server.url }, ...(body ? { body: JSON.stringify(body) } : {}) })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const first = await call("GET");
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.settings.enabled, first.body.settings.modelFixes, first.body.running], [false, false, false]);
  const noCopy = await call("POST", { enabled: true });
  assert.notEqual(noCopy.status, 200);
  assert.match(JSON.stringify(noCopy.body), /Test copy/);
  const noBudget = await call("POST", { enabled: false, modelFixes: true });
  assert.match(JSON.stringify(noBudget.body), /explicit preset/);
  assert.equal((await call("GET")).body.settings.enabled, false);
});
