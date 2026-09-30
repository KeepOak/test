/**
 * DOTS-007 (part): the stateless MCP HTTP preview. Each request carries its own protocol metadata, the
 * routing headers must agree with the body, no session is ever used, and names that are not plain ASCII
 * travel base64-encoded in headers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decodeHeader, headerValue, statelessHeaders, validateStateless } from "../dist/mcp-stateless.js";

const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
const body = { jsonrpc: "2.0", id: 1, method: "prompts/get", params: { name: "résumé", _meta: meta } };
const headers = (extra = {}) => ({ "content-type": "application/json", accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2026-07-28", "mcp-method": "prompts/get", "mcp-name": headerValue("résumé"), ...extra });

test("DOTS-007: a request whose headers agree with its body is accepted; any mismatch or a session is refused", () => {
  assert.equal(validateStateless(body, headers()).method, "prompts/get");
  assert.deepEqual(statelessHeaders(body), { "mcp-protocol-version": "2026-07-28", "mcp-method": "prompts/get", "mcp-name": headerValue("résumé") });
  assert.throws(() => validateStateless(body, headers({ "mcp-method": "tools/call" })), /does not match/);
  assert.throws(() => validateStateless(body, headers({ "mcp-name": "resume" })), /does not match/);
  assert.throws(() => validateStateless(body, headers({ "mcp-session-id": "abc" })), /sessions/);
  assert.throws(() => validateStateless({ ...body, params: { name: "résumé" } }, headers()), /metadata/);
});

test("DOTS-007: header values round-trip, with non-ASCII names base64-encoded", () => {
  assert.equal(headerValue("plain-name"), "plain-name");
  assert.match(headerValue("résumé"), /^=\?base64\?.*\?=$/);
  assert.equal(decodeHeader(headerValue("résumé")), "résumé");
  assert.equal(decodeHeader("=?base64?not base64!?="), undefined);
});
