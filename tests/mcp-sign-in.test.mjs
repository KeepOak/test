// Signing in to an outside MCP server, end to end through the owner's own route: the server answers 401 and publishes
// its sign-in (RFC 9728, then RFC 8414), Branch registers itself with the real callback port, the browser comes back
// with a code, the keys land in the locker, the server is connected with them, a key the server stops accepting is
// renewed without asking, and a connection that cannot renew says a sign-in is needed instead of opening a browser.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, signInFinished, needsSignIn } from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { mcpToolName } from "../dist/integrations/mcp.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-mcp-signin-"));
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
const until = async (check, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("timed out");
};
const form = async (request) => { let raw = ""; for await (const chunk of request) raw += chunk; return new URLSearchParams(raw); };
const json = (response, status, body, headers = {}) => { response.writeHead(status, { "content-type": "application/json", ...headers }); response.end(JSON.stringify(body)); };

/** An MCP server that is also its own sign-in service. */
async function signInServer(t) {
  const s = { base: "", valid: new Set(), registered: [], tokens: [], challenge: "", refreshWorks: true, seen: [] };
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, s.base).pathname;
    s.seen.push(`${request.method} ${path}`);
    if (path.startsWith("/.well-known/oauth-protected-resource"))
      return json(response, 200, { resource: `${s.base}/mcp`, authorization_servers: [s.base] });
    if (path === "/.well-known/oauth-authorization-server")
      return json(response, 200, { issuer: s.base, authorization_endpoint: `${s.base}/authorize`, token_endpoint: `${s.base}/token`,
        registration_endpoint: `${s.base}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"] });
    if (path === "/register") {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const asked = JSON.parse(raw);
      s.registered.push(asked.redirect_uris);
      return json(response, 201, { ...asked, client_id: `client-${s.registered.length}`, client_id_issued_at: 1 });
    }
    if (path === "/token") {
      const body = await form(request);
      s.tokens.push(Object.fromEntries(body));
      if (body.get("grant_type") === "authorization_code") {
        const verifier = body.get("code_verifier") ?? "";
        if (createHash("sha256").update(verifier).digest("base64url") !== s.challenge) return json(response, 400, { error: "invalid_grant" });
      } else if (!s.refreshWorks || body.get("refresh_token") !== "refresh-key") return json(response, 400, { error: "invalid_grant" });
      const access = `access-key-${s.tokens.length}`;
      s.valid.add(access);
      return json(response, 200, { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-key" });
    }
    if (path === "/mcp") {
      const key = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      if (!s.valid.has(key)) {
        response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${s.base}/.well-known/oauth-protected-resource/mcp"` });
        response.end();
        return;
      }
      if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
      let raw = ""; for await (const chunk of request) raw += chunk;
      const message = JSON.parse(raw);
      if (message.id === undefined) { response.writeHead(202); response.end(); return; }
      let result;
      if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" } };
      if (message.method === "tools/list") result = { tools: [{ name: "whoami", description: "Who is signed in", inputSchema: { type: "object", properties: {} } }] };
      if (message.method === "tools/call") result = { content: [{ type: "text", text: "signed in as the owner" }] };
      return json(response, 200, { jsonrpc: "2.0", id: message.id, result });
    }
    response.writeHead(404); response.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  s.base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((done) => server.close(done)));
  return s;
}

test("signing in to a web MCP server: registered with the real port, keys in the locker, connected, renewed", async (t) => {
  const { app, url, token } = await fixture(t);
  const remote = await signInServer(t);
  const address = `${remote.base}/mcp`;
  const added = await api(url, token, "/api/mcp/servers", { name: "Signed", server: { transport: "http", url: address } });
  assert.equal(added.data.server.on, false, "without a sign-in the server does not connect");

  const started = await api(url, token, "/api/mcp/signin", { id: "signed", url: address });
  const authorize = new URL(started.data.url);
  const callback = authorize.searchParams.get("redirect_uri");
  assert.match(callback, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
  assert.deepEqual(remote.registered, [[callback]], "the identity is registered with the callback's own port");
  assert.equal(authorize.searchParams.get("client_id"), "client-1");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorize.searchParams.get("resource"), address, "the server is named as the resource");
  remote.challenge = authorize.searchParams.get("code_challenge");

  const wrongState = await fetch(`${callback}?code=c&state=not-it`);
  assert.equal(wrongState.status, 400, "an answer for another sign-in is refused");
  const again = await api(url, token, "/api/mcp/signin", { id: "signed", url: address });
  const retry = new URL(again.data.url);
  remote.challenge = retry.searchParams.get("code_challenge");
  const finished = signInFinished(app.store, "signed");
  const back = await fetch(`${retry.searchParams.get("redirect_uri")}?code=code-1&state=${encodeURIComponent(retry.searchParams.get("state"))}`);
  assert.equal(back.status, 200);
  await finished;

  const tool = mcpToolName("signed", "whoami");
  await until(() => app.registry.names().includes(tool));
  const context = app.runtime.context({ runId: app.store.createRun(app.runtime.owner, "call it").id });
  const said = await app.registry.execute(tool, {}, { ...context, permissions: new Set([tool]) });
  assert.match(JSON.stringify(said), /signed in as the owner/);

  // The server stops accepting the key: the saved refresh key renews it and the call goes through, with no browser.
  remote.valid.clear();
  const renewed = await app.registry.execute(tool, {}, { ...context, permissions: new Set([tool]) });
  assert.match(JSON.stringify(renewed), /signed in as the owner/);
  assert.equal(remote.tokens.at(-1).grant_type, "refresh_token");
  assert.equal(needsSignIn(app.store, app.runtime.owner, "signed"), false);

  const keys = [...remote.valid, "refresh-key"];
  const everything = JSON.stringify([started.text, again.text,
    app.store.runs(app.runtime.owner).flatMap((run) => app.store.events(run.id)),
    app.store.audit.list(app.runtime.owner),
    app.store.get("settings", app.runtime.owner, "mcp-oauth:signed"),
    app.store.get("settings", app.runtime.owner, "mcp-own-servers")]);
  for (const key of keys) assert.ok(!everything.includes(key), `no record holds ${key}`);

  // Renewal refused too: the connection says a sign-in is needed, and no sign-in page is opened for it.
  remote.valid.clear();
  remote.refreshWorks = false;
  const before = remote.seen.filter((line) => line === "POST /register").length;
  await assert.rejects(app.registry.execute(tool, {}, { ...context, permissions: new Set([tool]) }));
  assert.equal(needsSignIn(app.store, app.runtime.owner, "signed"), true);
  assert.equal(remote.seen.filter((line) => line === "POST /register").length, before, "nothing new was registered");
});

test("a sign-in is only for one of your own web servers, at its saved address, and needs a published sign-in", async (t) => {
  const { url, token } = await fixture(t);
  await assert.rejects(api(url, token, "/api/mcp/signin", { id: "nowhere", url: "http://127.0.0.1:1/mcp" }), /no server of yours/);
  await api(url, token, "/api/mcp/servers", { name: "Nowhere", server: { transport: "http", url: "http://127.0.0.1:1/mcp" } });
  await assert.rejects(api(url, token, "/api/mcp/signin", { id: "nowhere", url: "http://127.0.0.1:2/mcp" }), /not the address saved/);
  await assert.rejects(api(url, token, "/api/mcp/signin", { id: "nowhere", url: "http://127.0.0.1:1/mcp" }), /could not be started/);
});

test("a removed server's sign-in is forgotten: a new server under the same name never gets its keys", async (t) => {
  const { app, url, token } = await fixture(t);
  const remote = await signInServer(t);
  const address = `${remote.base}/mcp`;
  await api(url, token, "/api/mcp/servers", { name: "Signed", server: { transport: "http", url: address } });
  const started = await api(url, token, "/api/mcp/signin", { id: "signed", url: address });
  const authorize = new URL(started.data.url);
  remote.challenge = authorize.searchParams.get("code_challenge");
  const finished = signInFinished(app.store, "signed");
  await fetch(`${authorize.searchParams.get("redirect_uri")}?code=c&state=${encodeURIComponent(authorize.searchParams.get("state"))}`);
  await finished;
  await until(() => app.registry.names().includes(mcpToolName("signed", "whoami")));
  await api(url, token, "/api/mcp/servers/signed/remove", {});
  assert.ok(!app.store.secrets.list(app.runtime.owner, "default").some((entry) => entry.name.startsWith("MCP_SIGNIN_SIGNED")),
    "the identity and keys left the locker");

  const headers = [];
  const other = createServer((request, response) => { headers.push(request.headers.authorization ?? null); response.writeHead(401); response.end(); });
  other.listen(0, "127.0.0.1");
  await once(other, "listening");
  t.after(() => new Promise((done) => other.close(done)));
  await api(url, token, "/api/mcp/servers", { name: "Signed", server: { transport: "http", url: `http://127.0.0.1:${other.address().port}/mcp` } });
  assert.ok(headers.length > 0, "the new server was reached");
  assert.deepEqual(headers.filter(Boolean), [], "it never saw a key");
});
