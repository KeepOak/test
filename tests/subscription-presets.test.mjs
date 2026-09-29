import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { accountsServiceFor } from "../dist/accounts/service.js";
import { discardTemp } from "./temp-dir.mjs";

const pool = "cli-claude-code";
const choices = [[pool, "claude-opus-5-5"], [`${pool}-sonnet`, "sonnet"], [`${pool}-opus`, "opus"], [`${pool}-haiku`, "haiku"],
  [`${pool}-sonnet-5`, "claude-sonnet-5"], [`${pool}-haiku-4-5`, "claude-haiku-4-5"]];
const registered = (app) => choices.filter(([id]) => app.runtime.models.presets.has(id)).map(([id]) => id);
async function rootFor(t) {
  const parent = join(tmpdir(), "Codex-session-files"); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "subscription-presets-"));
  const closers = [];
  t.after(async () => { for (const close of closers) await close(); await discardTemp(root); });
  return { root, closers };
}
async function open({ root, closers }) {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude-home");
  let app;
  try { app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") }); }
  finally { if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved; }
  accountsServiceFor(app.runtime.models).deps.statusRun = async () => ({ code: 1, missing: false });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await server.close(); await app.close(); };
  closers.push(close);
  const post = async (path, body) => {
    const response = await fetch(server.url + path, { method: "POST", headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { app, post, close };
}

test("Claude model choices and an explicit fixed model return after restart; forgetting either connection or variant removes the family", async (t) => {
  for (const forgotten of [pool, `${pool}-sonnet-5`]) {
    const root = await rootFor(t);
    let engine = await open(root);
    assert.equal((await engine.post("/api/providers/cli-agents", { id: "claude-code" })).status, 200);
    assert.deepEqual(registered(engine.app), choices.map(([id]) => id));
    assert.equal(engine.app.runtime.models.presets.get(pool).name, "Claude Code (installed on this computer)");
    assert.equal((await engine.post("/api/models", { activePreset: `${pool}-sonnet-5` })).status, 200);
    await engine.close();
    engine = await open(root);
    for (const [id, model] of choices) assert.equal(engine.app.runtime.models.presets.get(id)?.model, model);
    assert.equal(engine.app.runtime.models.settings(engine.app.runtime.owner).activePreset, `${pool}-sonnet-5`);
    const provider = { name: "scripted", async complete() { return { content: "local", toolCalls: [] }; } };
    engine.app.runtime.models.register({ id: `${pool}-custom`, name: "Independent", model: "custom", provider });
    assert.equal((await engine.post("/api/connections/forget", { id: forgotten })).status, 200);
    assert.deepEqual(registered(engine.app), []);
    assert.ok(engine.app.runtime.models.presets.has(`${pool}-custom`), "prefix-sharing connections are independent");
    await engine.close();
    engine = await open(root);
    assert.deepEqual(registered(engine.app), [], "forgotten aliases cannot reappear from the saved program choice");
    await engine.close();
  }
});

test("switching a Claude runtime off or removing it removes every known model choice and preserves other runtimes", async (t) => {
  const engine = await open(await rootFor(t));
  engine.app.asks.setMode("runtimes", { mode: "on" });
  engine.app.asks.runtimes.add("claude-code");
  engine.app.asks.runtimes.add("codex");
  assert.equal(registered(engine.app).length, 6);
  engine.app.asks.setMode("runtimes", { mode: "off" });
  assert.deepEqual(registered(engine.app), []);
  engine.app.asks.setMode("runtimes", { mode: "on" });
  assert.equal(registered(engine.app).length, 6);
  assert.deepEqual(engine.app.asks.runtimes.remove("claude-code"), { removed: true });
  assert.deepEqual(registered(engine.app), []);
  assert.ok(engine.app.runtime.models.presets.has("cli-codex"));
});

test("forgetting a Claude model also forgets a saved runtime so the family cannot reappear at restart", async (t) => {
  const root = await rootFor(t);
  let engine = await open(root);
  engine.app.asks.setMode("runtimes", { mode: "on" });
  engine.app.asks.runtimes.add("claude-code");
  assert.equal((await engine.post("/api/connections/forget", { id: `${pool}-haiku-4-5` })).status, 200);
  await engine.close();
  engine = await open(root);
  assert.deepEqual(registered(engine.app), []);
});
