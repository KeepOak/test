// An MCP server's credentials come from the environment first and then from the default project's locker, and the
// add form's values go into the locker only: never kept with the server, written down or sent back.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { mcpToolName } from "../dist/integrations/mcp.js";
import { McpConfigSchema, makeTransport, withLockerSecrets } from "../dist/integrations/mcp-config.js";

const key = "fixture-key-4f1c9e";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-mcp-locker-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), web: { allowPrivateAddresses: true } });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  return { app, ...server };
}
const api = (url, token, path, body) => fetch(`${url}${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { authorization: `Bearer ${token}`, origin: url, ...(body === undefined ? {} : { "content-type": "application/json" }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}).then(async (response) => {
  const text = await response.text();
  const data = JSON.parse(text);
  if (!response.ok) throw new Error(data.error ?? "request failed");
  return { data, text };
});

/** A web MCP server that answers only with the right key. */
async function remote(t) {
  const seen = [];
  const server = createServer(async (request, response) => {
    seen.push(request.headers.authorization ?? "");
    if (request.headers.authorization !== `Bearer ${key}`) { response.writeHead(401); response.end(); return; }
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { response.writeHead(202); response.end(); return; }
    let result;
    if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "2.0.0" } };
    if (message.method === "tools/list") result = { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } }] };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((done) => server.close(done)));
  return { address: `http://127.0.0.1:${server.address().port}`, seen };
}

test("a credential comes from the environment first, then the locker, and a missing one says where to put it", async () => {
  const lookups = [];
  const lookup = async (name) => { lookups.push(name); return name === "LOCKED" ? "from-locker" : undefined; };
  const stdio = { transport: "stdio", command: "x", args: [], envKeys: ["LOCKED", "IN_ENV", "lower_case"] };
  const env = await withLockerSecrets(stdio, { IN_ENV: "from-env" }, lookup);
  assert.equal(env.LOCKED, "from-locker");
  assert.equal(env.IN_ENV, "from-env");
  assert.deepEqual(lookups, ["LOCKED"], "the environment wins, and a name the locker cannot hold is not looked up");
  await assert.rejects(makeTransport({ transport: "http", url: "https://example.invalid/mcp", bearerEnv: "NOT_SET" }, {}),
    /Set NOT_SET as an environment variable, or save a secret called NOT_SET in the default project/);
  assert.equal(McpConfigSchema.safeParse({ id: "x", tools: ["a"], expectedVersion: "1", transport: "http",
    url: "https://example.invalid/mcp", bearerEnv: "OAUTH_MCP_X" }).success, false, "a saved sign-in is never sent as a key");
});

test("the add form's value goes to the locker, reaches the server, and is not kept or sent back", async (t) => {
  const { app, url, token } = await fixture(t);
  const web = await remote(t);
  const { data, text } = await api(url, token, "/api/mcp/servers", {
    name: "Keyed", server: { transport: "http", url: web.address, bearerEnv: "KEYED_MCP_KEY" }, values: { KEYED_MCP_KEY: key },
  });
  assert.equal(data.server.on, true, data.said);
  assert.deepEqual(app.registry.names().filter((name) => name.startsWith("mcp.keyed.")), [mcpToolName("keyed", "echo")]);
  assert.ok(web.seen.includes(`Bearer ${key}`), "the server was reached with the saved key");
  assert.ok(!text.includes(key), "the answer does not carry the value");
  const saved = JSON.stringify(app.store.get("settings", app.runtime.owner, "mcp-own-servers")?.data);
  assert.ok(!saved.includes(key), "the server's saved entry does not carry the value");
  assert.match(saved, /KEYED_MCP_KEY/);
  const events = JSON.stringify(app.store.runs(app.runtime.owner).flatMap((run) => app.store.events(run.id)));
  assert.ok(!events.includes(key), "nothing written down carries the value");
  const locker = await app.store.secrets.resolve(app.runtime.owner, "default", ["KEYED_MCP_KEY"], { purpose: "test" });
  assert.equal(locker.KEYED_MCP_KEY, key);

  await assert.rejects(api(url, token, "/api/mcp/servers", {
    name: "Stray", server: { transport: "http", url: web.address }, values: { OTHER_KEY: "x" },
  }), /OTHER_KEY is not one of the secrets this server is given/);
});

test("a server added with an empty value uses the one already in the locker", async (t) => {
  const { app, url, token } = await fixture(t);
  const web = await remote(t);
  await app.store.secrets.put(app.runtime.owner, "default", "SAVED_MCP_KEY", key);
  const { data } = await api(url, token, "/api/mcp/servers", {
    name: "Saved", server: { transport: "http", url: web.address, bearerEnv: "SAVED_MCP_KEY" }, values: { SAVED_MCP_KEY: "" },
  });
  assert.equal(data.server.on, true, data.said);
  const locker = await app.store.secrets.resolve(app.runtime.owner, "default", ["SAVED_MCP_KEY"], { purpose: "test" });
  assert.equal(locker.SAVED_MCP_KEY, key, "the empty value did not replace it");
});
