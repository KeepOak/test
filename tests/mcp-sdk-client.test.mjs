// The MCP door as a real client sees it: the MCP SDK Branch itself ships (1.30) connects over
// standard input/output (the `branch mcp-serve` plugin path) and over HTTP (`/mcp`), with no
// hand-written handshake. Raw-fetch tests cannot catch a refusal of the version the SDK sends.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { supportedProtocolVersions } from "../dist/mcp-server.js";
import { startServer } from "../dist/server.js";
import { fixtureModel } from "./fixtures/fixture-model.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("Branch speaks exactly the protocol versions of the MCP SDK it ships", () => {
  assert.deepEqual([...supportedProtocolVersions], [...SUPPORTED_PROTOCOL_VERSIONS]);
  assert.equal(supportedProtocolVersions[0], LATEST_PROTOCOL_VERSION);
});

test("the shipped SDK client connects to branch mcp-serve over standard input and output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-mcp-sdk-stdio-"));
  const setup = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  setup.store.save("settings", setup.runtime.owner, "mcp-sharing", { enabled: true, exposedTools: ["files.read"], a2a: false });
  await setup.close();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/cli.js", "mcp-serve"],
    cwd: projectRoot,
    env: { ...process.env, ...(await fixtureModel()).env, BRANCH_DATA_DIR: join(root, "data"), BRANCH_WORKSPACE: join(root, "workspace") },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += chunk; });
  const client = new Client({ name: "sdk-stdio-test", version: "1.0.0" });
  // One hook, in order: the child lets go of its data folder before the folder is removed.
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.name, "branch", stderr);
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "branch.ask"), stderr);
  assert.ok(tools.some((tool) => tool.name === "files.read"), "the shared tool is offered");
});

test("the shipped SDK client connects to /mcp over HTTP, with notifications answered 202", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-mcp-sdk-http-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  app.store.save("settings", app.runtime.owner, "mcp-sharing", { enabled: true, exposedTools: ["files.read"], a2a: false });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${server.token}` } },
  });
  const client = new Client({ name: "sdk-http-test", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  await client.connect(transport);
  assert.equal(transport.protocolVersion, LATEST_PROTOCOL_VERSION);
  assert.ok(transport.sessionId, "Branch names the conversation");
  assert.equal(client.getServerVersion()?.name, "branch");
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === "files.read"));
  await client.ping();

  const notification = await fetch(`${server.url}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json", "mcp-session-id": transport.sessionId },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");
});
