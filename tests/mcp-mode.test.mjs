import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { discardTemp } from "./temp-dir.mjs";
import { z } from "zod";
import { createBranch, McpConnections, savePolicy, sanitiseApp, appContentSecurityPolicy } from "../dist/index.js";
import { startServer } from "../dist/server.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "branch-mcpmode-"));
  const app = await createBranch({
    workspace: join(root, "workspace"),
    dataDir: join(root, "data"),
    // The fake servers these tests talk to run on this computer's own loopback address.
    web: { allowPrivateAddresses: true },
  });
  // The MCP door offers nothing while sharing is off, so these tests share (no tools) first.
  app.store.save("settings", app.runtime.owner, "mcp-sharing", { enabled: true, exposedTools: [], a2a: false });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => {
    await server.close();
    await app.close();
    await discardTemp(root);
  });
  return { app, ...server };
}

const headers = (url, token, extra = {}) => ({ authorization: `Bearer ${token}`, origin: url, ...extra });

async function rpc(url, token, body, sessionId) {
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: headers(url, token, { "content-type": "application/json", ...(sessionId ? { "mcp-session-id": sessionId } : {}) }),
    body: JSON.stringify(body),
  });
  return { response, data: await response.json() };
}

async function initialized(t) {
  const started = await fixture(t);
  const { response, data } = await rpc(started.url, started.token, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", clientInfo: { name: "probe", version: "1.0.0" } },
  });
  const sessionId = response.headers.get("mcp-session-id");
  return { ...started, sessionId, initialize: data, response };
}

const api = (url, token, path, body) =>
  fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: headers(url, token, body === undefined ? {} : { "content-type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (response) => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "request failed");
    return data;
  });

const share = (url, token, tools) => api(url, token, "/api/mcp/settings", { enabled: true, exposedTools: tools });

/** Opens the event stream and collects notifications until `want` of them have arrived. */
async function stream(url, token, sessionId, want, act) {
  const controller = new AbortController();
  const response = await fetch(`${url}/mcp`, {
    headers: headers(url, token, { accept: "text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}) }),
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /^: connected/);
  const got = [];
  const collect = (async () => {
    let buffer = "";
    while (got.length < want) {
      const part = await reader.read();
      if (part.done) break;
      buffer += new TextDecoder().decode(part.value);
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        got.push(JSON.parse(line.slice(6)));
      }
      buffer = "";
    }
  })();
  await act();
  await Promise.race([collect, new Promise((resolve) => setTimeout(resolve, 4000))]);
  controller.abort();
  return { got, sessionId: response.headers.get("mcp-session-id") };
}

test("C1: the modern transport gives a session, an event stream, and its newest version to a client asking for one it does not speak", async (t) => {
  const { url, token, sessionId, initialize } = await initialized(t);
  assert.ok(sessionId, "Branch names the conversation in the reply to the first message");
  assert.deepEqual(initialize.result.capabilities, {
    tools: { listChanged: true },
    resources: { subscribe: true, listChanged: true },
    prompts: { listChanged: true },
    logging: {},
  });

  const opened = await stream(url, token, sessionId, 0, async () => undefined);
  assert.ok(opened.sessionId, "the stream names its conversation too");

  const level = await rpc(url, token, { jsonrpc: "2.0", id: 2, method: "logging/setLevel", params: { level: "debug" } }, sessionId);
  assert.deepEqual(level.data.result, {});

  const old = await rpc(url, token, {
    jsonrpc: "2.0", id: 3, method: "initialize",
    params: { protocolVersion: "1999-01-01", clientInfo: { name: "probe", version: "1.0.0" } },
  });
  // A version Branch does not speak is answered with its newest, not refused: the client decides.
  assert.equal(old.data.error, undefined, JSON.stringify(old.data));
  assert.equal(old.data.result.protocolVersion, "2025-11-25");
  assert.equal(old.response.headers.get("mcp-protocol-version"), "2025-11-25");

  const current = await rpc(url, token, {
    jsonrpc: "2.0", id: 4, method: "initialize",
    params: { protocolVersion: "2025-11-25", clientInfo: { name: "probe", version: "1.0.0" } },
  });
  assert.equal(current.data.result.protocolVersion, "2025-11-25", "the version the shipped MCP SDK sends is accepted");

  const notified = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: headers(url, token, { "content-type": "application/json", "mcp-session-id": sessionId }),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  assert.equal(notified.status, 202, "a notification is accepted with no reply");

  const plain = await fetch(`${url}/mcp`, { headers: headers(url, token) });
  assert.equal(plain.status, 405, "a GET that does not ask for a stream is still refused");

  // The name of a conversation has to be one Branch handed out. It is long enough not to be
  // guessed, and a name nobody was given opens nothing and reads nobody else's stream.
  assert.ok(sessionId.length >= 32, `a conversation's name is not guessable: ${sessionId.length} characters`);
  const invented = "0".repeat(48);
  const strayStream = await fetch(`${url}/mcp`, {
    headers: headers(url, token, { accept: "text/event-stream", "mcp-session-id": invented }),
  });
  assert.equal(strayStream.status, 404, "a made-up name cannot open a stream");
  const strayCall = await rpc(url, token, { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }, invented);
  assert.equal(strayCall.response.status, 404, "nor make a call");
});

test("C1: a new skill's tools make Branch tell every connected client the list has changed", async (t) => {
  const { app, url, token, sessionId } = await initialized(t);
  const { got } = await stream(url, token, sessionId, 1, async () => {
    app.registry.register({
      name: "demo.extra", description: "A tool that arrived later", permission: "demo.read",
      parameters: z.object({}).strict(), execute: async () => ({ ok: true }),
    });
  });
  assert.ok(got.some((message) => message.method === "notifications/tools/list_changed"), JSON.stringify(got));
});

test("C2: a finished task reaches whoever subscribed to it", async (t) => {
  const { url, token, sessionId } = await initialized(t);
  await share(url, token, ["history.search"]);
  await rpc(url, token, { jsonrpc: "2.0", id: 2, method: "resources/subscribe", params: { uri: "runs://recent" } }, sessionId);
  const { got } = await stream(url, token, sessionId, 1, async () => {
    await rpc(url, token, {
      jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "branch.ask", arguments: { prompt: "Say hello." } },
    }, sessionId);
  });
  const updated = got.find((message) => message.method === "notifications/resources/updated");
  assert.ok(updated, JSON.stringify(got));
  assert.equal(updated.params.uri, "runs://recent");
});

test("C2: a finished task is not announced to a connection the owner does not share task history with", async (t) => {
  const { url, token, sessionId } = await initialized(t);
  await share(url, token, ["files.read"]);
  await rpc(url, token, { jsonrpc: "2.0", id: 2, method: "resources/subscribe", params: { uri: "runs://recent" } }, sessionId);
  const { got } = await stream(url, token, sessionId, 1, async () => {
    await rpc(url, token, {
      jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "branch.ask", arguments: { prompt: "Say hello." } },
    }, sessionId);
  });
  assert.ok(!got.some((message) => message.method === "notifications/resources/updated"), JSON.stringify(got));
});

test("C2: prompts carry their blanks, and a resource the settings refuse is invisible", async (t) => {
  const { app, url, token, sessionId } = await initialized(t);
  app.store.save("procedures", app.runtime.owner, "11111111-1111-4111-8111-111111111111", {
    version: 1, status: "verified", history: [],
    definition: {
      name: "Weekly tidy", steps: [{ tool: "files.read", arguments: {}, expected: null }],
      parameters: { folder: { type: "string", required: true }, depth: { type: "number", required: false } },
    },
  });
  const prompts = await rpc(url, token, { jsonrpc: "2.0", id: 2, method: "prompts/list", params: {} }, sessionId);
  const tidy = prompts.data.result.prompts.find((prompt) => prompt.description === "Weekly tidy");
  assert.ok(tidy);
  assert.deepEqual(tidy.arguments.map((a) => [a.name, a.required]), [["folder", true], ["depth", false]]);

  const missing = await rpc(url, token, { jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: tidy.name } }, sessionId);
  assert.match(missing.data.error.data.details, /needs: folder/);
  const filled = await rpc(url, token, {
    jsonrpc: "2.0", id: 4, method: "prompts/get", params: { name: tidy.name, arguments: { folder: "Invoices" } },
  }, sessionId);
  assert.match(filled.data.result.messages[0].content.text, /Invoices/);

  await share(url, token, ["memory.search"]);
  const before = await rpc(url, token, { jsonrpc: "2.0", id: 5, method: "resources/list", params: {} }, sessionId);
  assert.ok(before.data.result.resources.some((r) => r.uri === "memory://facts"));

  savePolicy(app.store, app.runtime.owner, { rules: [{ tool: "memory.*", match: "*", decision: "deny" }] });
  const after = await rpc(url, token, { jsonrpc: "2.0", id: 6, method: "resources/list", params: {} }, sessionId);
  assert.ok(!after.data.result.resources.some((r) => r.uri === "memory://facts"), "what the settings refuse is not offered");
  const read = await rpc(url, token, { jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "memory://facts" } }, sessionId);
  assert.match(read.data.error.data.details, /Unknown resource/);
});

test("C2: the exact list a client was shown is written down and can be checked afterwards", async (t) => {
  const { app, url, token, sessionId } = await initialized(t);
  await share(url, token, ["files.read"]);
  const recorded = await rpc(url, token, {
    jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mcp.snapshot", arguments: { action: "record" } },
  }, sessionId);
  const id = recorded.data.result.structuredContent.id;
  assert.ok(id);
  assert.equal(recorded.data.result.structuredContent.digest.length, 64);

  const same = await rpc(url, token, {
    jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mcp.snapshot", arguments: { action: "compare", id } },
  }, sessionId);
  assert.equal(same.data.result.structuredContent.same, true);

  await share(url, token, ["files.read", "files.write"]);
  const changed = await rpc(url, token, {
    jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "mcp.snapshot", arguments: { action: "compare", id } },
  }, sessionId);
  assert.equal(changed.data.result.structuredContent.same, false);
  assert.deepEqual(changed.data.result.structuredContent.added, ["files.write"]);

  const listed = await api(url, token, "/api/mcp/snapshots");
  assert.equal(listed.snapshots[0].id, id);
  assert.equal(typeof listed.snapshots[0].tools, "number");

  // Branch's own helpers are registered tools too, so ticking one must not list it twice.
  await share(url, token, ["mcp.dry_run", "mcp.servers", "files.read"]);
  const both = await rpc(url, token, { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }, sessionId);
  const names = both.data.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, [...new Set(names)], "no tool is offered twice");
  assert.ok(names.includes("mcp.dry_run") && names.includes("mcp.servers"));
});

test("C3+C6: a refused tool is never offered, an asked-about one waits, and the note says which is which", async (t) => {
  const { app, url, token, sessionId } = await initialized(t);
  app.registry.register({
    name: "browser.click", description: "Click something on a web page", permission: "browser.interact",
    parameters: z.object({ selector: z.string() }).strict(), execute: async () => ({ clicked: true }),
  });
  await share(url, token, ["browser.click", "files.write", "files.read"]);
  savePolicy(app.store, app.runtime.owner, {
    rules: [
      { tool: "files.write", match: "*", decision: "deny" },
      { tool: "browser.click", match: "*", decision: "ask" },
    ],
  });
  // A call that needs a yes now waits for the owner to give one. This test is about what is
  // offered and what is refused, not about the waiting, so it waits for no time at all.
  app.store.save("settings", app.runtime.owner, "mcp-serving", { idleMinutes: 30, askWaitSeconds: 0 });

  const listed = await rpc(url, token, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId);
  const names = listed.data.result.tools.map((tool) => tool.name);
  assert.ok(!names.includes("files.write"), "a flatly refused tool is not on offer at all");
  assert.ok(names.includes("browser.click"), "a tool that needs a yes stays on offer");

  const note = await rpc(url, token, {
    jsonrpc: "2.0", id: 3, method: "resources/read", params: { uri: "policy://hidden-tools" },
  }, sessionId);
  assert.match(note.data.result.contents[0].text, /Held back: files\.write/);
  assert.match(note.data.result.contents[0].text, /files\.write: Your approval settings do not allow/);

  const clicked = await rpc(url, token, {
    jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "browser.click", arguments: { selector: "#go" } },
  }, sessionId);
  assert.equal(clicked.data.result.isError, true);
  assert.match(clicked.data.result.content[0].text, /waiting for your yes in Branch/);

  const preflight = await api(url, token, "/api/mcp/preflight");
  assert.deepEqual(preflight.hidden.map((entry) => entry.name), ["files.write"]);
  assert.match(preflight.explanation, /Only a flat refusal hides a tool/);
});

test("C3: a dry run says what would happen and changes nothing", async (t) => {
  const { app, url, token, sessionId } = await initialized(t);
  await share(url, token, ["files.write", "files.read"]);
  const planned = await rpc(url, token, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "files.write", arguments: { path: "made-up.txt", content: "hello" }, _meta: { dryRun: true } },
  }, sessionId);
  const plan = planned.data.result.structuredContent;
  assert.equal(plan.dryRun, true);
  assert.equal(plan.tool, "files.write");
  assert.equal(plan.changesThings, true);
  assert.deepEqual(plan.files, ["made-up.txt"]);
  assert.match(plan.cost, /Nothing/);
  // 0.18.1 (deliberate update): this used to expect "straight away" — "No approvals" let an MCP caller's
  // write through. A caller is now held to "Ask before changes" under every setting, so the plan says so.
  assert.match(plan.wouldHappen, /would ask you first/);

  const files = await app.files.list();
  assert.ok(!JSON.stringify(files).includes("made-up.txt"), "the dry run wrote nothing");
  assert.ok(!app.store.runs(app.runtime.owner).some((run) => /files\.write/.test(run.prompt)), "and started no task");

  const viaTool = await rpc(url, token, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "mcp.dry_run", arguments: { name: "files.write", arguments: { path: "x.txt" } } },
  }, sessionId);
  assert.equal(viaTool.data.result.structuredContent.tool, "files.write");
});

// C4 (signing in to a server that needs it) is in tests/mcp-sign-in.test.mjs, through the MCP SDK the transport uses.

test("C5: an outside server opens when a task needs it, closes when the task ends, and never goes over the cap", async (t) => {
  const { app } = await fixture(t);
  const opened = [], closed = [];
  const connections = new McpConnections(app.store, () => app.store.profiles.scope());
  connections.warmMs = () => 0;
  connections.backoffMs = () => 1;
  const opener = (id) => async () => { opened.push(id); return { close: async () => void closed.push(id) }; };
  for (const id of ["one", "two", "three"]) connections.register(id, opener(id));

  await connections.acquire("run-a", "one");
  assert.deepEqual(opened, ["one"]);
  await connections.acquire("run-a", "one");
  assert.deepEqual(opened, ["one"], "a second use of the same server reuses the connection");
  assert.equal(connections.openCount(), 1);
  assert.equal(connections.health()[0].state, "ready");

  await connections.releaseRun("run-a");
  assert.deepEqual(closed, ["one"], "the task ended, so the connection closed");
  assert.equal(connections.openCount(), 0);

  app.store.save("settings", app.store.profiles.scope(), "mcp-connections", { maxConcurrentServers: 1, keepWarmMinutes: 0, reconnectAttempts: 0 });
  await connections.acquire("run-b", "one");
  await assert.rejects(connections.acquire("run-b", "two"), /already has 1 outside servers connected/);
  await connections.releaseRun("run-b");

  // A server that will not answer is tried again, then given up on with a plain reason.
  let tries = 0;
  connections.register("flaky", async () => { tries++; throw new Error("no answer"); });
  app.store.save("settings", app.store.profiles.scope(), "mcp-connections", { maxConcurrentServers: 4, keepWarmMinutes: 0, reconnectAttempts: 2 });
  await assert.rejects(connections.acquire("run-c", "flaky"), /could not reach the "flaky" server/);
  assert.equal(tries, 3, "the first try plus two more");
  await connections.closeAll();
});

test("C5: the connection settings are kept per person and shown with each server's health", async (t) => {
  const { url, token } = await fixture(t);
  const before = await api(url, token, "/api/mcp/connections");
  assert.equal(before.settings.keepWarmMinutes, 5);
  assert.deepEqual(before.servers, []);
  const after = await api(url, token, "/api/mcp/connections", { keepWarmMinutes: 0, maxConcurrentServers: 2 });
  assert.equal(after.settings.keepWarmMinutes, 0);
  assert.equal(after.settings.maxConcurrentServers, 2);
  assert.equal(after.settings.reconnectAttempts, 3, "what was not sent keeps its value");
});

test("C6: a page from an outside server is served in a frame that can do nothing", async (t) => {
  const { url, token } = await fixture(t);
  const stripped = sanitiseApp('<p>Hi</p><script>fetch("http://evil")</script><a href="javascript:alert(1)">x</a>');
  assert.ok(!stripped.html.includes("<script"));
  assert.ok(!stripped.html.includes("javascript:"));
  assert.ok(stripped.removed >= 2);

  const held = await api(url, token, "/api/mcp/app", {
    server: "fixture", uri: "ui://panel", html: '<p>Pick one</p><form action="http://evil"></form>',
  });
  assert.match(held.url, /^\/mcp-app\/[A-Za-z0-9_-]{32,48}$/);
  const page = await fetch(`${url}${held.url}`, { headers: { host: new URL(url).host } });
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("content-security-policy"), appContentSecurityPolicy);
  assert.match(page.headers.get("content-security-policy"), /^sandbox; default-src 'none'/);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'self'/);
  const body = await page.text();
  assert.ok(body.includes("Pick one"));
  assert.ok(!body.includes("<form"), "even the tags the frame would refuse are taken out");

  const gone = await fetch(`${url}/mcp-app/${"a".repeat(40)}`, { headers: { host: new URL(url).host } });
  assert.equal(gone.status, 404);
});

test("C7: trying a server lists its tools, calls one, and writes the try down", async (t) => {
  const { app, url, token } = await fixture(t);
  const remote = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405); response.end(); return; }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const message = JSON.parse(raw);
    if (message.id === undefined) { response.writeHead(202); response.end(); return; }
    let result;
    if (message.method === "initialize")
      result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "2.0.0" } };
    if (message.method === "tools/list")
      result = { tools: [{ name: "echo", description: "Say it back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] };
    if (message.method === "tools/call") result = { content: [{ type: "text", text: message.params.arguments.text }] };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  remote.listen(0, "127.0.0.1");
  await once(remote, "listening");
  t.after(() => new Promise((resolve) => remote.close(resolve)));
  const server = { transport: "http", url: `http://127.0.0.1:${remote.address().port}` };

  const listed = await api(url, token, "/api/mcp/try", { server });
  assert.equal(listed.serverName, "fixture");
  assert.equal(listed.serverVersion, "2.0.0");
  assert.deepEqual(listed.tools.map((tool) => tool.name), ["echo"]);
  assert.deepEqual(listed.tools[0].schema.required, ["text"], "the form's shape comes back with it");
  assert.equal(listed.called, null);

  const called = await api(url, token, "/api/mcp/try", { server, call: { name: "echo", arguments: { text: "it works" } } });
  assert.equal(called.called.result.content[0].text, "it works");

  const audit = app.store.audit.list(app.runtime.owner, { action: "mcp.tried" });
  assert.equal(audit.length, 2);
  assert.equal(audit[0].outcome, "ran");
  assert.match(audit[0].subject, /echo answered/);
  assert.equal(audit[1].outcome, "listed");

  await assert.rejects(
    api(url, token, "/api/mcp/try", { server: { transport: "http", url: "http://127.0.0.1:1/mcp" } }),
    /could not use that server/,
  );
});
