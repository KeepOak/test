/**
 * UP-RESEARCH-009: an older MCP server that only speaks the SSE transport is reached after the Streamable HTTP
 * attempt fails, and a server that answers 401 asks for sign-in instead of trying another transport.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ToolRegistry } from "../dist/index.js";
import { connectMcp } from "../dist/integrations/mcp.js";

async function legacyHost(t, { unauthorized = false } = {}) {
  const sessions = new Map(), seen = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    seen.push(`${request.method} ${url.pathname}`);
    if (unauthorized) { response.writeHead(401); response.end(); return; }
    if (request.method === "GET" && url.pathname === "/mcp") {
      const transport = new SSEServerTransport("/messages", response);
      sessions.set(transport.sessionId, transport);
      const mcp = new McpServer({ name: "legacy", version: "1.0.0" });
      mcp.tool("echo", "Echo test", { text: z.string() }, async ({ text }) => ({ content: [{ type: "text", text }] }));
      await mcp.connect(transport);
      return;
    }
    if (request.method === "POST" && url.pathname === "/messages") {
      await sessions.get(url.searchParams.get("sessionId"))?.handlePostMessage(request, response);
      return;
    }
    response.writeHead(405); response.end(); // no Streamable HTTP here
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { seen, config: { id: "legacy", transport: "http", url: `http://127.0.0.1:${server.address().port}/mcp`, tools: ["echo"], expectedVersion: "1.0.0" } };
}

test("UP-RESEARCH-009: a legacy SSE-only MCP server is reached after Streamable HTTP fails", async (t) => {
  const host = await legacyHost(t);
  const connection = await connectMcp(new ToolRegistry(), host.config, {});
  t.after(() => connection.close());
  assert.equal(connection.tools.length, 1);
  assert.ok(host.seen.includes("POST /mcp"), "Streamable HTTP was tried first");
  assert.ok(host.seen.includes("GET /mcp"), "then the SSE stream");
});

test("UP-RESEARCH-009: a 401 asks for sign-in and never falls back to SSE", async (t) => {
  const host = await legacyHost(t, { unauthorized: true });
  await assert.rejects(connectMcp(new ToolRegistry(), host.config, {}), /requires sign-in/);
  assert.deepEqual(host.seen.filter((line) => line.startsWith("GET")), [], "no SSE attempt after a 401");
});
