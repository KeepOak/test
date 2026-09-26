/**
 * Overview: recent activity is what a person asked for. GET /api/state marks `aside` the tasks setup started (#386,
 * src/setup-origin.ts) and the engine's own asks in a Trunk's conversation (the task that opens it and the ask that has
 * the Trunk introduce itself, src/trunks/engine-asks.ts); a task asked from the window is not marked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-overview-aside-"));
  const provider = { name: "scripted", async complete() { return { content: "Hello, I am here.", toolCalls: [] }; } };
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0, host: "127.0.0.1" });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const call = async (method, path, body, setup = false) => {
    const response = await fetch(new URL(path, server.url), {
      method, headers: { authorization: `Bearer ${server.token}`, "x-branch-origin": setup ? "setup" : "window",
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json().catch(() => ({}));
    assert.ok(response.status < 400, `${method} ${path}: ${response.status} ${data.error ?? ""}`);
    return data;
  };
  return { app, call };
}

test("GET /api/state marks setup's tasks and the engine's own asks aside, and nothing the window asked", async (t) => {
  const { app, call } = await fixture(t);
  await call("POST", "/api/trunks/switch", { part: "trunks", mode: "on" }, true);
  await call("POST", "/api/trunks", { name: "Made in setup" }, true);
  await call("POST", "/api/trunks", { name: "Made later" });
  await app.trunks.introduced();
  await call("POST", "/api/run", { prompt: "Hello from setup" }, true);
  await call("POST", "/api/run", { prompt: "Summarise my week" });
  const runs = (await call("GET", "/api/state")).runs;
  const byPrompt = (words) => runs.filter((r) => r.prompt === words);
  assert.equal(byPrompt("Hello from setup")[0]?.aside, true, "a task asked from setup");
  assert.equal(byPrompt("Summarise my week")[0]?.aside, undefined, "a task asked from the window");
  for (const name of ["Made in setup", "Made later"]) assert.equal(byPrompt(`Trunk: ${name}`)[0]?.aside, true, `the task that opens ${name}'s conversation`);
  const intros = runs.filter((r) => r.prompt.startsWith("Introduce yourself to the owner"));
  assert.equal(intros.length, 2);
  assert.ok(intros.every((r) => r.aside === true), "each Trunk's introduction, from setup or not");
});
