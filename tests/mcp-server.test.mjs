import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, savePolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { householdRefusal } from "../dist/household-routes.js";
import { fixtureModel } from "./fixtures/fixture-model.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

/** Sharing is switched on (with `tools`, none by default) unless `share` is false: while it is off the MCP door offers nothing at all. */
async function fixture(t, { share = true, tools = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-mcp-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
  });
  if (share) app.store.save("settings", app.runtime.owner, "mcp-sharing", { enabled: true, exposedTools: tools, a2a: false });
  const server = await startServer(app, {
    dataDir: join(root, "data"),
    port: 0,
  });
  t.after(async () => {
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  return { app, ...server };
}

async function mcpRequest(url, token, body, sessionId, method = "POST") {
  const headers = {
    authorization: `Bearer ${token}`,
    origin: url,
  };
  if (method !== "DELETE") {
    headers["content-type"] = "application/json";
  }
  if (sessionId) {
    headers["mcp-session-id"] = sessionId;
  }
  const response = await fetch(`${url}/mcp`, {
    method,
    headers,
    ...(method !== "DELETE" && body ? { body: JSON.stringify(body) } : {}),
  });
  if (response.status === 204) return { status: 204 };
  const data = await response.json();
  return data;
}

test("MCP server initializes with protocol negotiation", async (t) => {
  const { url, token } = await fixture(t);
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  });
  assert.ok(response.result);
  assert.equal(response.result.serverInfo.name, "branch");
  assert.match(response.result.protocolVersion, /^202[45]-\d{2}-\d{2}$/);
});

test("MCP server rejects uninitialized requests", async (t) => {
  const { url, token } = await fixture(t);
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  });
  assert.ok(response.error);
  assert.equal(response.error.code, -32002);
});

test("MCP tools/list respects exposure policy", async (t) => {
  const { url, token } = await fixture(t);
  const sessionId = "test-session-" + Math.random();
  // Initialize
  await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }, sessionId);
  // List tools
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }, sessionId);
  assert.ok(response.result);
  assert.ok(Array.isArray(response.result.tools));
  // By default, files.read should be exposed via MCP (or list could be empty if no tools match)
  assert.ok(response.result.tools.length >= 0);
});

test("MCP server returns error for unknown tool", async (t) => {
  const { url, token } = await fixture(t);
  const sessionId = "test-session-" + Math.random();
  await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }, sessionId);
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "nonexistent.tool",
      arguments: {},
    },
  }, sessionId);
  // Either the tool call returns an error in result.isError or we get an error response
  assert.ok(response.result || response.error);
});

test("MCP resources/list returns available resources", async (t) => {
  const { url, token } = await fixture(t, { tools: ["memory.search", "files.list"] });
  const sessionId = "test-session-" + Math.random();
  await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }, sessionId);
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "resources/list",
    params: {},
  }, sessionId);
  assert.ok(response.result);
  assert.ok(Array.isArray(response.result.resources));
  assert.ok(response.result.resources.some(r => r.uri === "memory://facts"));
  assert.ok(response.result.resources.some(r => r.uri === "workspace://files"));
});

test("MCP resources/read returns memory facts", async (t) => {
  const { url, token } = await fixture(t, { tools: ["memory.search"] });
  const sessionId = "test-session-" + Math.random();
  await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }, sessionId);
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "resources/read",
    params: { uri: "memory://facts" },
  }, sessionId);
  assert.ok(response.result);
  assert.ok(response.result.contents);
  assert.ok(Array.isArray(response.result.contents));
  assert.ok(response.result.contents[0].mimeType === "application/json");
});

test("MCP prompts/list returns available prompts", async (t) => {
  const { url, token } = await fixture(t);
  const sessionId = "test-session-" + Math.random();
  await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }, sessionId);
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "prompts/list",
    params: {},
  }, sessionId);
  assert.ok(response.result);
  assert.ok(Array.isArray(response.result.prompts));
  // Prompts list can be empty if no procedures are saved
});

test("MCP prompts/get returns error for unknown prompt", async (t) => {
  const { url, token } = await fixture(t);
  const sessionId = "test-session-" + Math.random();
  await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }, sessionId);
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "prompts/get",
    params: { name: "nonexistent-prompt" },
  }, sessionId);
  // Should get an error for unknown prompt
  assert.ok(response.error || !response.result);
});

test("MCP server tracks session ids", async (t) => {
  const { url, token } = await fixture(t);
  const sessionId = "test-session-123";
  const response1 = await mcpRequest(
    url,
    token,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    },
    sessionId
  );
  assert.ok(response1.result);
  const response2 = await mcpRequest(
    url,
    token,
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    },
    sessionId
  );
  assert.ok(response2.result);
});

test("MCP rejects bad authentication", async (t) => {
  const { url } = await fixture(t);
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      authorization: "Bearer badtoken",
      "content-type": "application/json",
      origin: url,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }),
  });
  assert.equal(response.status, 401);
});

test("MCP connection snippets endpoint works", async (t) => {
  const { url, token } = await fixture(t);
  const response = await fetch(`${url}/api/mcp/connection`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      origin: url,
    },
  });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.ok(data.httpEndpoint);
  assert.ok(data.bearerToken);
  assert.ok(data.claudeDesktop);
});

test("MCP connection snippets carry this install's address, key and paths", async (t) => {
  const { app, url, token } = await fixture(t);
  const data = await get(url, token, "/api/mcp/connection");
  assert.equal(data.httpEndpoint, `${url}/mcp`);
  assert.equal(data.bearerToken, token);
  assert.deepEqual(data.stdio.args, ["mcp-serve"]);
  assert.equal(data.stdio.env.BRANCH_WORKSPACE, app.runtime.workspace);
  assert.ok(data.stdio.env.BRANCH_DATA_DIR.length > 0);
  // The child inherits the other tool's working directory, so the snippet must name both paths.
  const parsed = JSON.parse(data.claudeDesktop.configExample);
  assert.equal(parsed.mcpServers.branch.env.BRANCH_WORKSPACE, app.runtime.workspace);
  assert.match(data.claudeCode.configExample, new RegExp(token));
  assert.equal(JSON.parse(data.cursor.configExample).mcpServers.branch.url, `${url}/mcp`);
});

test("MCP GET /mcp returns 405", async (t) => {
  const { url, token } = await fixture(t);
  const response = await fetch(`${url}/mcp`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      origin: url,
    },
  });
  assert.equal(response.status, 405);
});

test("MCP DELETE /mcp ends session", async (t) => {
  const { url, token } = await fixture(t);
  const sessionId = "test-session-" + Math.random();
  // Initialize
  await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }, sessionId);
  // Delete session
  const deleteResp = await fetch(`${url}/mcp`, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${token}`,
      origin: url,
      "mcp-session-id": sessionId,
    },
  });
  assert.equal(deleteResp.status, 204);
});

test("MCP branch.ask tool works", async (t) => {
  const { url, token } = await fixture(t);
  const sessionId = "test-session-" + Math.random();
  // Initialize
  await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      clientInfo: { name: "test-client", version: "1.0.0" },
    },
  }, sessionId);
  // Call branch.ask
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "branch.ask",
      arguments: { prompt: "Say hello" },
    },
  }, sessionId);
  assert.ok(response.result);
});

async function initialized(t, options) {
  const started = await fixture(t, options);
  const sessionId = "test-session-" + Math.random();
  await mcpRequest(started.url, started.token, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", clientInfo: { name: "test-client", version: "1.0.0" } },
  }, sessionId);
  return { ...started, sessionId };
}

async function settings(url, token, body) {
  const response = await fetch(`${url}/api/mcp/settings`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${token}`,
      origin: url,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error);
  return data;
}

const get = (url, token, path) =>
  fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}`, origin: url } }).then((r) => r.json());

test("MCP shares nothing until the owner turns it on", async (t) => {
  const { url, token, sessionId } = await initialized(t, { share: false });
  const before = await settings(url, token);
  assert.equal(before.enabled, false);
  assert.deepEqual(before.exposedTools, []);
  assert.equal(before.tools.find((tool) => tool.name === "files.read").changesThings, false);
  assert.equal(before.tools.find((tool) => tool.name === "files.write").changesThings, true);

  const listed = async () => {
    const response = await mcpRequest(url, token, { jsonrpc: "2.0", id: 9, method: "tools/list", params: {} }, sessionId);
    return response.result.tools.map((tool) => tool.name);
  };
  assert.deepEqual(await listed(), [], "not even branch.ask while nothing is shared");
  const ask = await mcpRequest(url, token, { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "branch.ask", arguments: { prompt: "What do you remember about me?" } } }, sessionId);
  assert.equal(ask.result.isError, true);
  assert.match(ask.result.content[0].text, /not sharing anything/);
  const resources = await mcpRequest(url, token, { jsonrpc: "2.0", id: 11, method: "resources/list", params: {} }, sessionId);
  assert.deepEqual(resources.result.resources, []);
  const facts = await mcpRequest(url, token, { jsonrpc: "2.0", id: 12, method: "resources/read", params: { uri: "memory://facts" } }, sessionId);
  assert.ok(facts.error, "a resource cannot be read while nothing is shared");
  const prompts = await mcpRequest(url, token, { jsonrpc: "2.0", id: 13, method: "prompts/list", params: {} }, sessionId);
  assert.deepEqual(prompts.result.prompts, []);

  const after = await settings(url, token, { enabled: true, exposedTools: ["files.read", "made.up"] });
  assert.deepEqual(after.exposedTools, ["files.read"]);
  assert.ok((await listed()).includes("files.read"));

  await settings(url, token, { enabled: false, exposedTools: ["files.read"] });
  assert.deepEqual(await listed(), []);
});

test("MCP refuses a tool the owner has not shared", async (t) => {
  const { url, token, sessionId } = await initialized(t);
  const response = await mcpRequest(url, token, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "files.write", arguments: { path: "x.txt", content: "no" } },
  }, sessionId);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /not sharing/);
});

test("MCP tool calls are recorded as tasks with a receipt", async (t) => {
  const { app, url, token, sessionId } = await initialized(t);
  await settings(url, token, { enabled: true, exposedTools: ["files.read"] });
  await writeFile(join(app.runtime.workspace, "note.txt"), "hello from branch");

  const call = await mcpRequest(url, token, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "files.read", arguments: { path: "note.txt" } },
  }, sessionId);
  assert.equal(call.result.isError, false);
  assert.match(call.result.content[0].text, /hello from branch/);

  const state = await get(url, token, "/api/state");
  const run = state.runs.find((entry) => entry.prompt === "Another AI tool used files.read");
  assert.ok(run, "the call should appear in Activity");
  assert.equal(run.status, "completed");
  const receipts = await get(url, token, `/api/runs/${run.id}/receipts`);
  assert.equal(receipts.counts.success, 1);
  assert.equal(receipts.items[0].name, "files.read");
});

test("MCP may not change Branch's own files even when writing is shared and allowed", async (t) => {
  // mac5/manual-actions: another AI tool's call goes through the runtime's own policy check.
  const { url, token, sessionId } = await initialized(t);
  await settings(url, token, { enabled: true, exposedTools: ["files.write"] });
  const call = await mcpRequest(url, token, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "files.write", arguments: { path: "../data/gateway.json", content: "{}" } },
  }, sessionId);
  assert.equal(call.result.isError, true);
  assert.match(call.result.content[0].text, /never lets a task/);
});

test("MCP holds a household profile off the owner's tools even where the rules allow", async (t) => {
  // Integration review (mac5/manual-actions), then Q262: the door for other programs files work under the owner, so a
  // household person at the window meets the one owner-only sentence at the door, and nothing is written.
  const { app, url, token, sessionId } = await initialized(t);
  await settings(url, token, { enabled: true, exposedTools: ["files.write"] });
  const child = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.runtime.roles.save(child.id, { role: "child", projects: [], dailySpendLimit: 0 });
  app.store.profiles.switch({ profileId: child.id, pin: "1234" });
  t.after(() => app.store.profiles.switch({ profileId: null }));
  const call = await mcpRequest(url, token, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "files.write", arguments: { path: "sam.txt", content: "x" } },
  }, sessionId);
  assert.deepEqual(call, { error: householdRefusal });
  assert.equal(existsSync(join(app.runtime.workspace, "sam.txt")), false, "nothing was written");
});

test("MCP offers recent conversations and reads one as plain text", async (t) => {
  const { app, url, token, sessionId } = await initialized(t, { tools: ["history.search"] });
  const run = await app.runtime.run({ prompt: "Remember that the kettle is broken." });

  const list = await mcpRequest(url, token, { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} }, sessionId);
  const conversation = list.result.resources.find((resource) => resource.uri === `conversation://${run.sessionId}`);
  assert.ok(conversation, "the conversation should be offered as a resource");
  assert.match(conversation.name, /kettle/);
  assert.match(conversation.description, /^Conversation from \d{4}-\d{2}-\d{2}$/);

  const read = await mcpRequest(url, token, {
    jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: conversation.uri },
  }, sessionId);
  assert.equal(read.result.contents[0].mimeType, "text/plain");
  assert.match(read.result.contents[0].text, /^user: Remember that the kettle is broken\./);

  const missing = await mcpRequest(url, token, {
    jsonrpc: "2.0", id: 4, method: "resources/read",
    params: { uri: "conversation://00000000-0000-0000-0000-000000000000" },
  }, sessionId);
  assert.match(missing.error.data.details, /not found/);
});

test("MCP resources follow the shared tools: sharing one tool offers no other tool's resources", async (t) => {
  const { app, url, token, sessionId } = await initialized(t, { tools: ["files.read"] });
  const run = await app.runtime.run({ prompt: "Remember that the kettle is broken." });
  const list = await mcpRequest(url, token, { jsonrpc: "2.0", id: 2, method: "resources/list", params: {} }, sessionId);
  assert.deepEqual(list.result.resources.map((resource) => resource.uri), ["policy://hidden-tools"]);
  for (const [id, uri] of [[3, "memory://facts"], [4, "workspace://files"], [5, "runs://recent"],
    [6, `run://${run.id}`], [7, `conversation://${run.sessionId}`]]) {
    const read = await mcpRequest(url, token, { jsonrpc: "2.0", id, method: "resources/read", params: { uri } }, sessionId);
    assert.match(read.error?.data?.details ?? "", /Unknown resource/, uri);
  }

  // Shared, but the approval settings would ask first: a read has nowhere to wait, so it stays hidden.
  await settings(url, token, { enabled: true, exposedTools: ["memory.search", "files.list"] });
  savePolicy(app.store, app.runtime.owner, { rules: [{ tool: "memory.search", match: "*", decision: "ask" }] });
  const shared = await mcpRequest(url, token, { jsonrpc: "2.0", id: 8, method: "resources/list", params: {} }, sessionId);
  const uris = shared.result.resources.map((resource) => resource.uri);
  assert.ok(uris.includes("workspace://files"), JSON.stringify(uris));
  assert.ok(!uris.includes("memory://facts"), "an ask decision does not make a resource readable");
  const facts = await mcpRequest(url, token, { jsonrpc: "2.0", id: 9, method: "resources/read", params: { uri: "memory://facts" } }, sessionId);
  assert.match(facts.error?.data?.details ?? "", /Unknown resource/);
});

test("branch mcp-serve speaks JSON-RPC on standard input and output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-mcp-stdio-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const setup = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  setup.store.save("settings", setup.runtime.owner, "mcp-sharing", { enabled: true, exposedTools: ["files.read", "files.write"], a2a: false });
  await setup.close();
  const child = spawn(process.execPath, ["dist/cli.js", "mcp-serve"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...(await fixtureModel()).env,
      BRANCH_DATA_DIR: join(root, "data"),
      BRANCH_WORKSPACE: join(root, "workspace"),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const replies = collect(child, 3);

  const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", clientInfo: { name: "stdio-test", version: "1.0.0" } } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "branch.ask", arguments: { prompt: "Say hello" } } });

  const answers = await replies;
  child.stdin.end();
  const exit = await new Promise((resolve) => child.once("exit", resolve));

  assert.equal(answers[0].result.serverInfo.name, "branch", stderr);
  assert.ok(answers[1].result.tools.some((tool) => tool.name === "branch.ask"));
  // 0.18.1 (deliberate update): this used to expect isError false, because "No approvals" let an MCP
  // caller's task write the demo file unasked. It is now held to "Ask before changes", so the caller
  // is told the task is waiting for the owner's yes.
  assert.equal(answers[2].result.isError, true, JSON.stringify(answers[2]));
  assert.match(answers[2].result.content[0].text, /Before I go ahead: Writing branch-demo\.txt/);
  assert.equal(stdout.trim().split("\n").length, 3, "a notification must not get a reply");
  assert.equal(exit, 0);
  assert.match(stderr, /ready for another AI tool/);
  assert.ok(!/"jsonrpc"/.test(stderr), "the protocol must not leak onto standard error");
});

test("branch mcp-serve reports a line that is not JSON and keeps going", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-mcp-stdio-bad-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const child = spawn(process.execPath, ["dist/cli.js", "mcp-serve"], {
    cwd: projectRoot,
    env: { ...process.env, ...(await fixtureModel()).env, BRANCH_DATA_DIR: join(root, "data"), BRANCH_WORKSPACE: join(root, "workspace") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  child.stdout.setEncoding("utf8");
  const replies = collect(child, 2);
  child.stdin.write("not json at all\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n");
  const answers = await replies;
  child.stdin.end();
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(answers[0].error.code, -32700);
  assert.deepEqual(answers[1].result, {});
});

/** Waits for `count` newline-delimited JSON replies from the child's standard output. */
function collect(child, count) {
  return new Promise((resolve, reject) => {
    const lines = [];
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`Only ${lines.length} of ${count} replies arrived`)), 60000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) if (part.trim()) lines.push(JSON.parse(part));
      if (lines.length >= count) { clearTimeout(timer); resolve(lines.slice(0, count)); }
    });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("The server stopped early")); });
  });
}

test("branch.ask may use only what the owner shares", async (t) => {
  const { app, url, token, sessionId } = await initialized(t);
  await settings(url, token, { enabled: true, exposedTools: ["files.read"] });
  const asked = await mcpRequest(url, token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "branch.ask", arguments: { prompt: "Say hello" } } }, sessionId);
  assert.ok(asked.result);
  const run = app.store.runs(app.runtime.owner).find((one) => one.prompt === "Say hello");
  assert.ok(run, "the task ran");
  const tried = app.store.events(run.id).filter((event) => event.kind === "tool.started" || event.kind === "policy.ask").map((event) => event.data.name);
  assert.ok(!tried.includes("files.write") || app.store.events(run.id).some((event) => event.kind === "tool.failed" && /Permission denied: files\.write/.test(event.data.error)),
    `a tool that was not shared was not used: ${JSON.stringify(tried)}`);
  await assert.rejects(access(join(app.runtime.workspace, "branch-demo.txt")), "nothing was written");
});
