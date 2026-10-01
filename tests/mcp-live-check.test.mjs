/**
 * RES-408: checking an MCP server pings a session that is already open. It never starts the server,
 * so a server nobody is using reports "not open" instead of being launched to answer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, McpConnections } from "../dist/index.js";

test("RES-408: a check pings an open session and never opens a closed one", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-mcp-check-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const opened = [], pinged = [];
  const connections = new McpConnections(app.store, () => app.store.profiles.scope());
  connections.warmMs = () => 60_000;
  connections.register("one", async () => { opened.push("one"); return { close: async () => {}, check: async () => void pinged.push("one") }; });

  await assert.rejects(connections.check("one"), /not open/);
  assert.deepEqual(opened, [], "checking started nothing");
  await connections.acquire("run-a", "one");
  await connections.check("one");
  assert.deepEqual([opened, pinged], [["one"], ["one"]]);
  await connections.closeAll();
});

test("on-demand health refuses an acknowledgement after that same client dies without reopening it", async t => {
  const root = await mkdtemp(join(tmpdir(), "branch-mcp-dead-ping-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const manager = new McpConnections(app.store, () => app.store.profiles.scope());
  t.after(async () => { await manager.closeAll(); await app.close(); await discardTemp(root); });
  const entered = Promise.withResolvers(), released = Promise.withResolvers();
  let opens = 0, living = true, checks = 0;
  const connection = { alive: () => living, close: async () => {}, check: async () => {
    checks++; entered.resolve(); await released.promise;
  } };
  manager.register("one", async () => { opens++; return connection; });
  assert.equal(await manager.acquire("original-run", "one"), connection);
  const pending = manager.check("one"), refused = assert.rejects(pending, /closed during the check/);
  await entered.promise; living = false; released.resolve(); await refused;
  assert.equal(opens, 1); assert.equal(checks, 1);
  await assert.rejects(manager.check("one"), /not open/);
  assert.equal(opens, 1, "neither health check starts or retries a client");
});
