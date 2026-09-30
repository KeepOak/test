/**
 * DOTS-007 (part): the stateless MCP preview, now served by the official SDK. It answers only while the owner has
 * switched the preview on; a request whose routing headers disagree with its body, or that names a session, is
 * refused; an agreeing one is answered with no session opened.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { headerValue } from "../dist/mcp-stateless.js";

const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
async function world(t, preview) {
  const root = await mkdtemp(join(tmpdir(), "branch-mcp-stateless-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  app.store.save("settings", app.runtime.owner, "mcp-sharing", { enabled: true, exposedTools: [], a2a: false, statelessPreview: preview });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  return (method, extra = {}, params = {}) => fetch(`${server.url}/mcp`, { method: "POST",
    headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json",
      accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": method, ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }) });
}
const read = async (response) => { const text = await response.text(); try { return JSON.parse(text); } catch { return { raw: text }; } };

test("DOTS-007: agreeing headers are answered with no session; a mismatch is refused, and a session id opens nothing", async (t) => {
  const call = await world(t, true);
  const listed = await call("tools/list");
  const ok = await read(listed);
  assert.ok(ok.result && Array.isArray(ok.result.tools), JSON.stringify(ok));
  assert.equal(listed.headers.get("mcp-session-id"), null, "no session is opened");
  const mismatch = await read(await call("tools/list", { "mcp-method": "prompts/list" }));
  assert.ok(mismatch.error, JSON.stringify(mismatch));
  const session = await call("tools/list", { "mcp-session-id": "abc" });
  assert.equal(session.headers.get("mcp-session-id"), null, "a sent session id opens no session");
  assert.match(headerValue("résumé"), /^=\?base64\?.*\?=$/, "non-ASCII names travel base64-encoded");
});

test("DOTS-007: with the preview off the 2026 request is refused", async (t) => {
  const call = await world(t, false);
  const off = await read(await call("tools/list"));
  assert.ok(off.error, JSON.stringify(off));
});
