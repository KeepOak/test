/**
 * UP-RESEARCH-008: the owner sets how long a tool server's call may go without progress (1 s to 1 hour, 30 s when
 * unset). It changes only while the server is off, so a call already running keeps the deadline it started with.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

const notesServer = resolve("dist/examples/mcp-notes-server.js");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-mcp-timeout-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (path, body) => {
    const response = await fetch(`${server.url}${path}`, { method: "POST",
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { app, api };
}

test("a tool server's call timeout is 30 s by default, set by the owner within 1 s to 1 hour, and kept", async (t) => {
  const { app, api } = await fixture(t);
  const added = await api("/api/mcp/servers", { name: "Notes", server: { transport: "stdio", command: process.execPath, args: [notesServer] } });
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const id = added.body.server.id;
  assert.equal(added.body.server.callTimeoutSeconds, 30, "unset means 30 seconds");
  const set = await api(`/api/mcp/servers/${id}/timeout`, { seconds: 120 });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.server.callTimeoutSeconds, 120);
  assert.equal(app.ownMcp.saved().find((entry) => entry.id === id).callTimeoutSeconds, 120, "saved with the server");
  for (const seconds of [0, 3601, 1.5, "60"])
    assert.notEqual((await api(`/api/mcp/servers/${id}/timeout`, { seconds })).status, 200, `refused: ${JSON.stringify(seconds)}`);
  assert.notEqual((await api(`/api/mcp/servers/${id}/timeout`, { seconds: 60, extra: true })).status, 200, "no other fields");
});

test("the timeout cannot change while the server is on, so a running call keeps its deadline", async (t) => {
  const { app, api } = await fixture(t);
  const added = await api("/api/mcp/servers", { name: "Notes", server: { transport: "stdio", command: process.execPath, args: [notesServer] } });
  const id = added.body.server.id;
  const saved = app.ownMcp.saved().map((entry) => (entry.id === id ? { ...entry, on: true } : entry));
  app.store.save("settings", app.runtime.owner, "mcp-own-servers", { servers: saved });
  const refused = await api(`/api/mcp/servers/${id}/timeout`, { seconds: 90 });
  assert.notEqual(refused.status, 200);
  assert.match(JSON.stringify(refused.body), /Switch this server off/);
});
