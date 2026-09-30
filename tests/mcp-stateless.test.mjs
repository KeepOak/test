/**
 * DOTS-007 (part): the stateless MCP HTTP preview. Each request carries its own protocol metadata, the
 * routing headers must agree with the body, no session is ever used, and names that are not plain ASCII
 * travel base64-encoded in headers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { decodeHeader, headerValue, statelessHeaders, validateStateless } from "../dist/mcp-stateless.js";
import { createBranch } from "../dist/index.js";
import { savePolicy } from "../dist/policy.js";

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

/**
 * A stateless resource read is checked against the owner's approval settings when it starts and again just
 * before its answer is sent, so a setting changed to "never" while the read is still working is obeyed.
 */
async function statelessApp(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-mcp-stateless-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  app.store.save("settings", app.runtime.owner, "mcp-sharing", { enabled: true, statelessPreview: true, exposedTools: [], a2a: false });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return app;
}
const read = (app, uri) => app.mcpServer.handleStateless({ jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri, _meta: meta } });
const deny = (app, tool) => savePolicy(app.store, app.runtime.owner, { preset: "custom", rules: [{ tool, decision: "deny" }] });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
/** Holds the workspace listing open until the test lets it finish, and says when it has started. */
function holdListing(t, app) {
  const files = app.mcpServer.files, original = files.list, entered = deferred(), gate = deferred();
  files.list = async (...args) => { entered.resolve(); await gate.promise; return original.apply(files, args); };
  t.after(() => { files.list = original; });
  return { entered: entered.promise, release: gate.resolve };
}

test("DOTS-007: a workspace read whose permission is withdrawn while it lists is refused and discloses nothing", async (t) => {
  const app = await statelessApp(t);
  await writeFile(join(app.runtime.workspace, "stateless-marker-4417.txt"), "x");
  const held = holdListing(t, app);
  const pending = read(app, "workspace://files");
  await held.entered;
  deny(app, "files.list");
  held.release();
  const response = await pending;
  assert.equal(response.result, undefined);
  assert.equal(response.error.code, -32602);
  assert.doesNotMatch(JSON.stringify(response), /stateless-marker-4417/);
  const fresh = await read(app, "workspace://files");
  assert.ok(fresh.error && !fresh.result, "the saved refusal is in force for a new read too");
});

test("DOTS-007: with the permission left alone, the held workspace read still answers", async (t) => {
  const app = await statelessApp(t);
  await writeFile(join(app.runtime.workspace, "stateless-marker-5528.txt"), "x");
  const held = holdListing(t, app);
  const pending = read(app, "workspace://files");
  await held.entered;
  held.release();
  const response = await pending;
  assert.equal(response.error, undefined);
  assert.match(response.result.contents[0].text, /stateless-marker-5528/);
});

test("DOTS-007: documents and task history are checked again before their answer is sent", async (t) => {
  const app = await statelessApp(t);
  const documents = app.mcpServer.documents, runs = app.store.runs;
  t.after(() => { app.mcpServer.documents = documents; app.store.runs = runs; });
  app.mcpServer.documents = { list: () => { deny(app, "documents.search"); return [{ title: "doc-marker-6639" }]; } };
  const doc = await read(app, "documents://library");
  assert.ok(doc.error && doc.result === undefined);
  assert.doesNotMatch(JSON.stringify(doc), /doc-marker-6639/);
  app.store.runs = () => { deny(app, "history.search"); return [{ id: "run-marker-7740" }]; };
  const history = await read(app, "runs://recent");
  assert.ok(history.error && history.result === undefined);
  assert.doesNotMatch(JSON.stringify(history), /run-marker-7740/);
});

test("DOTS-007: refusing one kind of resource leaves the others readable", async (t) => {
  const app = await statelessApp(t);
  app.store.save("memory", app.runtime.owner, "fact-1", { text: "memory-marker-8851" });
  deny(app, "files.list");
  const facts = await read(app, "memory://facts");
  assert.equal(facts.error, undefined);
  assert.match(facts.result.contents[0].text, /memory-marker-8851/);
});
