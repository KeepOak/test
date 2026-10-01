import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFile, readdir, mkdtemp, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ClaudeSubscriptionProvider } from "../dist/providers/claude-subscription.js";
import { connectNative } from "../dist/providers/claude-subscription-admission.js";
import { withAccountCall } from "../dist/accounts/context.js";
import { nativeToolName, nativeToolPrefix } from "../dist/providers/claude-subscription-history.js";
import { closeNativeSubscriptions } from "../dist/providers/claude-subscription-continuation.js";
import { discardTemp } from "./temp-dir.mjs";

// A finished turn keeps its native transport for the next one; each test closes what it kept.
test.afterEach(() => closeNativeSubscriptions());

const tool = { name: "files.read", description: "Read a Branch file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
const account = { owner: "local", sessionId: "fixture", runId: "fixture" };
const scope = (work, value = account) => withAccountCall(value, work);
const request = (messages = [{ role: "user", content: "Read the file" }], signal = new AbortController().signal) =>
  ({ messages, tools: [tool], signal, maxTokens: 1024 });
function events(name = nativeToolPrefix + nativeToolName(tool.name), malformed = false) {
  return [
    { type: "message_start", message: { id: "fixture", type: "message", role: "assistant", content: [], usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 10, cache_creation_input_tokens: 3 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "Ready☘" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "call-fixture", name, input: {} } },
    { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: malformed ? '{"path":' : '{"path":"note.txt"}' } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ];
}
/* `mode` may name one native fixture mode per launch (the last repeats). `holdClose(n)` may return a promise that the n-th
   launch's "close" event waits for, so the test decides when the provider learns that process has closed. */
async function fixture(t, { mode = "normal", reply = events(), hold = false, status = 200, options = {}, holdClose = () => null } = {}) {
  const parent = join(tmpdir(), "Codex-session-files"); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "subscription-fixture-"));
  const seen = [], launches = [];
  let disconnected = false;
  const server = createServer(async (incoming, response) => {
    let bytes = ""; for await (const chunk of incoming) bytes += chunk;
    seen.push({ body: JSON.parse(bytes), headers: incoming.headers });
    response.on("close", () => { disconnected = true; });
    response.writeHead(status, { "content-type": "text/event-stream", ...(status === 429 ? { "anthropic-ratelimit-unified-reset": "1790672400" } : {}) });
    const body = Buffer.from(reply.map((event) => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""));
    for (let i = 0; i < body.length; i += 3) response.write(body.subarray(i, i + 3));
    if (!hold) response.end();
  });
  await new Promise((go) => server.listen(0, "127.0.0.1", go));
  t.after(async () => { server.closeAllConnections(); await new Promise((go) => server.close(go)); await discardTemp(root); });
  const connect = (headers, payload, query, signal) => fetch(`http://127.0.0.1:${server.address().port}/v1/messages${query}`, { method: "POST", headers, body: payload, signal });
  const start = (_command, args, invocation) => {
    const modes = [mode].flat(), launchMode = modes[Math.min(launches.length, modes.length - 1)], gate = holdClose(launches.length);
    const child = spawn(process.execPath, [resolve("tests/fixtures/claude-subscription-native.mjs"), ...args], { ...invocation,
      env: { ...invocation.env, BRANCH_NATIVE_FIXTURE_MODE: launchMode, BRANCH_NATIVE_FIXTURE_PIDS: join(root, "pids.json"), BRANCH_NATIVE_FIXTURE_INERT: join(root, "inert.json") } });
    if (gate) { const once = child.once.bind(child); child.once = (event, listener) => once(event, event === "close" ? (...args) => { void gate.then(() => listener(...args)); } : listener); }
    launches.push({ args, env: invocation.env, cwd: invocation.cwd, child });
    return child;
  };
  const provider = new ClaudeSubscriptionProvider({ owner: "local", timeoutMs: 5000, ...options }, { spawn: start, connect });
  return { provider, seen, launches, root, disconnected: () => disconnected };
}
async function until(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise((go) => setTimeout(go, 10)); }
  assert.fail("fixture did not reach its expected boundary");
}

test("native protocol preserves full canonical history, tool results, schemas and actual cache usage", async (t) => {
  const f = await fixture(t), text = "x".repeat(150000), history = [
    { role: "system", content: "Owner's instructions" }, { role: "user", content: text },
    { role: "assistant", content: "Earlier", toolCalls: [{ id: "older", name: "files.read", arguments: '{"path":"older.txt"}' }] },
    { role: "tool", toolCallId: "older", content: "Owner denied that call; it was not run" }, { role: "user", content: "Now read note.txt" },
  ];
  const chunks = []; let rates = ""; f.provider.onOutput = (value) => { rates = value; };
  const answer = await scope(() => f.provider.complete({ ...request(history), onTextDelta: (text) => chunks.push(text) }));
  assert.deepEqual(answer.toolCalls, [{ id: "call-fixture", name: "files.read", arguments: '{"path":"note.txt"}' }]);
  assert.deepEqual(answer.usage, { input: 18, output: 7, cachedInput: 10 });
  assert.equal(answer.content, "Ready☘"); assert.equal(chunks.join(""), answer.content);
  assert.equal(f.seen.length, 1); assert.equal(f.seen[0].body.messages[0].content[0].text, text);
  assert.equal(f.seen[0].body.messages[1].content[1].name, nativeToolPrefix + nativeToolName("files.read"));
  assert.equal(f.seen[0].body.messages[2].content[0].content, history[3].content);
  assert.equal(f.seen[0].body.messages[2].content[1].text, history[4].content);
  assert.deepEqual(f.seen[0].body.tools[0].input_schema, tool.parameters);
  assert.equal(f.launches[0].args[f.launches[0].args.indexOf("--tools") + 1], "");
  assert.ok(f.launches[0].args.includes("dontAsk") && f.launches[0].args.includes("--strict-mcp-config"));
  assert.ok(rates.includes("rate_limit_event") && !rates.includes("Ready"));
  // The finished transport is kept for the conversation's next turn; closing it erases its private files.
  await stat(f.launches[0].cwd);
  closeNativeSubscriptions();
  await until(() => stat(f.launches[0].cwd).then(() => false, () => true));
});

test("one upstream admission survives denied native retry without permitting a second generation", async (t) => {
  const f = await fixture(t, { mode: "retry" });
  const answer = await scope(() => f.provider.complete(request()));
  assert.equal(f.seen.length, 1); assert.equal(answer.toolCalls.length, 1);
});

test("truncated streams, malformed tool arguments and native-only tools never become committed tool batches", async (t) => {
  for (const reply of [events().slice(0, -1), events(undefined, true), events("Bash")]) {
    const f = await fixture(t, { reply });
    await assert.rejects(scope(() => f.provider.complete(request())), /complete|unknown|response|arguments/i);
    await assert.rejects(stat(f.launches[0].cwd), /ENOENT/);
  }
});

test("owner and Trunk sign-in checks refuse before any process, listener or upstream request", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.provider.complete(request()), /owner.*context/i);
  await assert.rejects(scope(() => f.provider.complete(request()), { ...account, owner: "profile:someone" }), /owner.*context/i);
  await assert.rejects(scope(() => f.provider.complete(request()), { ...account, trunk: { keys: { copyFromOwner: false, accounts: {} }, signIns: false } }), /sign-in accounts/i);
  assert.equal(f.launches.length, 0); assert.equal(f.seen.length, 0);
  assert.equal((await scope(() => f.provider.complete(request()), { ...account, trunk: { keys: { copyFromOwner: false, accounts: {} }, signIns: true } })).toolCalls.length, 1);
});

test("account home is immutable; inherited endpoint, API-key and native settings overrides do not reach the CLI", async (t) => {
  const home = { name: "CLAUDE_CONFIG_DIR", path: resolve("tests/fixtures/account-home") };
  const f = await fixture(t, { options: { accountHome: home } }); home.path = resolve("tests/fixtures/changed-home");
  await scope(() => f.provider.complete(request()));
  assert.equal(f.launches[0].env.CLAUDE_CONFIG_DIR, resolve("tests/fixtures/account-home"));
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_EXTRA_BODY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"])
    assert.equal(f.launches[0].env[name], undefined);
  assert.match(f.launches[0].env.ANTHROPIC_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+\/admit\/[a-f0-9]+$/);
});

test("bad replay acknowledgments and explicit request limits fail without silent history cuts", async (t) => {
  const f = await fixture(t, { mode: "bad-ack" });
  await assert.rejects(scope(() => f.provider.complete(request([{ role: "user", content: "Old" }, { role: "assistant", content: "Then" }, { role: "user", content: "Now" }]))), /zero-turn/);
  assert.equal(f.seen.length, 0);
  const limited = await fixture(t);
  await assert.rejects(scope(() => limited.provider.complete(request([{ role: "user", content: "x".repeat(8 * 1024 * 1024) }]))), /8 MiB/);
  assert.equal(limited.launches.length, 0);
});

test("inert native MCP callbacks cannot execute even when called directly", async (t) => {
  const f = await fixture(t, { mode: "inert" });
  await scope(() => f.provider.complete(request()));
  const args = f.launches[0].args;
  const mcp = JSON.parse(args[args.indexOf("--mcp-config") + 1]).mcpServers.branch;
  assert.deepEqual(mcp.env, process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}, "inert MCP starts as Node inside Electron");
  const denied = JSON.parse(await readFile(join(f.root, "inert.json"), "utf8"));
  assert.equal(denied.result.isError, true); assert.match(denied.result.content[0].text, /only Branch executes/);
  await assert.rejects(stat(join(f.root, "native-should-never-write.txt")), /ENOENT/);
});

test("abort kills the owned native tree and connection, erases private files and rejects a captured late completion", async (t) => {
  const f = await fixture(t, { mode: "grandchild", options: { timeoutMs: 15000 } }), cancel = new AbortController();
  const running = scope(() => f.provider.complete(request(undefined, cancel.signal)));
  await until(async () => f.seen.length === 1 && await stat(join(f.root, "pids.json")).then(() => true, () => false));
  const ids = JSON.parse(await readFile(join(f.root, "pids.json"), "utf8"));
  cancel.abort(new Error("fixture cancelled"));
  await assert.rejects(running, /fixture cancelled/);
  await until(() => { try { process.kill(ids.child, 0); return false; } catch { return true; } });
  for (const id of [ids.parent, ids.child]) assert.throws(() => process.kill(id, 0));
  await assert.rejects(stat(f.launches[0].cwd), /ENOENT/);
});

test("generation cancellation and the provider's own deadline close an active upstream and its native tree", async (t) => {
  for (const timeout of [false, true]) {
    const f = await fixture(t, { hold: true, mode: "grandchild", options: { timeoutMs: timeout ? 1500 : 15000 } });
    const cancel = new AbortController(), running = scope(() => f.provider.complete(request(undefined, cancel.signal)));
    await until(async () => f.seen.length === 1 && await stat(join(f.root, "pids.json")).then(() => true, () => false));
    const ids = JSON.parse(await readFile(join(f.root, "pids.json"), "utf8"));
    if (!timeout) cancel.abort(new Error("cancel active generation"));
    await assert.rejects(running, timeout ? /too long/ : /cancel active generation/);
    await until(() => f.disconnected());
    assert.throws(() => process.kill(ids.parent, 0)); assert.throws(() => process.kill(ids.child, 0));
    await assert.rejects(stat(f.launches[0].cwd), /ENOENT/);
  }
});

test("subscription sign-in and plan failures are actionable without disclosing native output", async (t) => {
  const signedOut = await fixture(t, { mode: "signed-out" });
  await assert.rejects(scope(() => signedOut.provider.complete(request())), /Accounts.*sign in again/);
  assert.equal(signedOut.seen.length, 0);
  for (const status of [401, 429]) {
    const f = await fixture(t, { status });
    await assert.rejects(scope(() => f.provider.complete(request())), status === 401 ? /Accounts.*sign in again/ : { name: "ProgramLimitError" });
    // The plan's own reset time is named when the service gives one.
    if (status === 429) await assert.rejects(scope(() => f.provider.complete(request())), /plan limit until about 2026-09-29 09:00 UTC/);
  }
});

test("production connector pins the first-party TLS identity and does not follow a redirect", async () => {
  const saved = https.request, attempts = [];
  try {
    https.request = (options, callback) => {
      attempts.push(options);
      const call = new EventEmitter(); call.destroy = () => {}; call.end = () => {
        const response = new PassThrough(); response.headers = { location: "https://not-the-provider.invalid/collect" }; response.statusCode = 302;
        callback(response); response.end("fixture redirect"); call.emit("close");
      }; return call;
    };
    syncBuiltinESMExports();
    const response = await connectNative({ authorization: "Bearer fixture-native-account" }, Buffer.from("{}"), "?beta=true", new AbortController().signal);
    assert.equal(response.status, 302); await response.arrayBuffer(); assert.equal(attempts.length, 1);
    assert.equal(attempts[0].hostname, "api.anthropic.com"); assert.equal(attempts[0].servername, "api.anthropic.com");
    assert.equal(attempts[0].port, 443); assert.equal(attempts[0].rejectUnauthorized, true);
    assert.equal(attempts[0].headers.authorization, "Bearer fixture-native-account");
  } finally { https.request = saved; syncBuiltinESMExports(); }
});

test("selfdev/prompt-cache: every round of one conversation runs in the same private folder, so its request front never moves", async (t) => {
  const f = await fixture(t, { options: { timeoutMs: 60000 } }); // six native runs, two at once: room under a busy machine
  const first = [{ role: "system", content: "Owner's instructions" }, { role: "user", content: "Read the file" }];
  const later = [...first, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "files.read", arguments: '{"path":"a.txt"}' }] },
    { role: "tool", toolCallId: "c1", content: "a" }];
  await scope(() => f.provider.complete(request(first)));
  await scope(() => f.provider.complete(request(later)));
  await scope(() => f.provider.complete(request([{ role: "system", content: "Owner's instructions" }, { role: "user", content: "Something else" }])));
  const folders = f.launches.map((launch) => launch.cwd);
  assert.equal(folders[0], folders[1], "the same conversation, the same folder");
  assert.notEqual(folders[2], folders[0], "another conversation, another folder");
  closeNativeSubscriptions(); // the last transport is kept for a next turn until Branch closes it
  for (const folder of folders) await until(() => stat(folder).then(() => false, () => true));
  // Two rounds of one conversation at once never share a folder.
  const both = await Promise.all([scope(() => f.provider.complete(request(later))), scope(() => f.provider.complete(request(later)))]);
  assert.equal(both.length, 2);
  assert.notEqual(f.launches[3].cwd, f.launches[4].cwd);
  // The relay marks the history the next round sends again: the answer before the newest turn.
  const marked = f.seen[1].body.messages.findLast((message) => message.role === "assistant");
  assert.deepEqual(marked.content.at(-1).cache_control, { type: "ephemeral", ttl: "1h" });
});

/* SELF-090: a Claude Code conversation keeps one native transport across Branch's turns. Only an exact continuation of the
   last request and its answer reuses it; each turn arms the relay once, with its own marker; an idle request, a request
   for another turn, or a second generation in one turn never reaches the service. */
const gone = (folder) => stat(folder).then(() => false, () => true);
const answered = [{ role: "assistant", content: "Ready☘", toolCalls: [{ id: "call-fixture", name: "files.read", arguments: '{"path":"note.txt"}' }] },
  { role: "tool", toolCallId: "call-fixture", content: "the note" }];

test("SELF-090 the next turn of the same conversation continues one native transport, with Branch's own history", async (t) => {
  const f = await fixture(t);
  const first = [{ role: "system", content: "Owner's instructions" }, { role: "user", content: "Read the file" }];
  await scope(() => f.provider.complete(request(first)));
  const second = await scope(() => f.provider.complete(request([...first, ...answered])));
  assert.equal(second.toolCalls.length, 1);
  assert.equal(f.launches.length, 1, "no second Claude Code process");
  assert.equal(f.seen.length, 2, "one generation per turn");
  const sent = JSON.stringify(f.seen[1].body.messages);
  assert.match(sent, /the note/, "the tool's real result is in the forwarded history");
  assert.doesNotMatch(sent, /BRANCH_TRANSPORT_TURN_/, "the turn marker never reaches the model");
  // Between turns the relay is disarmed: a request from the idle native process is refused and never forwarded.
  const idle = await fetch(`${f.launches[0].env.ANTHROPIC_BASE_URL}/v1/messages`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "again" }] }) });
  assert.equal(idle.status, 400);
  assert.equal(f.seen.length, 2);
  // Another conversation, or an edited history, never continues it.
  await scope(() => f.provider.complete(request(first)), { ...account, sessionId: "another" });
  await scope(() => f.provider.complete(request([...first, { ...answered[0], content: "edited" }, answered[1]])));
  assert.equal(f.launches.length, 3);
});

test("SELF-090 a native request without this turn's marker is refused before the service", async (t) => {
  const f = await fixture(t, { mode: "no-marker" });
  await assert.rejects(scope(() => f.provider.complete(request())), /complete response/);
  assert.equal(f.seen.length, 0, "nothing reached the service");
  await until(() => gone(f.launches[0].cwd));
});

/* The ended transport is removed by the next turn's lease, which does not wait for that removal. The next turn's folder is
   then whichever the conversation's fixed folder allows (selfdev/prompt-cache): a fresh random folder while the old one is
   still being removed, or the same fixed folder once it is gone. Either way the old transport's folder does not outlive it.
   The tests below force each outcome through the fixture; this one accepts whichever the machine produced and holds the
   contract of the branch taken. */
async function folderContract(f) {
  const [old, next] = f.launches.map((launch) => launch.cwd);
  if (next !== old) { await until(() => gone(old)); return "fresh"; }
  await stat(old); // the same path is the live folder of the kept transport
  closeNativeSubscriptions();
  await until(() => gone(old));
  return "reused";
}

test("SELF-090 a Claude Code that ends after its one result falls back to a fresh transport", async (t) => {
  const f = await fixture(t, { mode: ["once", "normal"] });
  const first = [{ role: "user", content: "Read the file" }];
  await scope(() => f.provider.complete(request(first)));
  const ended = f.launches[0].child;
  await until(() => ended.exitCode !== null || ended.signalCode !== null);
  const next = await scope(() => f.provider.complete(request([...first, ...answered])));
  assert.equal(next.toolCalls.length, 1);
  assert.equal(f.launches.length, 2);
  assert.equal(f.seen.length, 2);
  assert.ok(["fresh", "reused"].includes(await folderContract(f)));
});

test("SELF-090 once the ended transport's folder is gone, the next turn reuses that exact folder until its own transport closes", async (t) => {
  const f = await fixture(t, { mode: ["once", "normal"] });
  const first = [{ role: "user", content: "Read the file" }];
  await scope(() => f.provider.complete(request(first)));
  const ended = f.launches[0].child, folder = f.launches[0].cwd;
  await until(() => ended.exitCode !== null || ended.signalCode !== null);
  // A turn stopped before it takes a folder still leases, so it removes the ended transport; its removal is then awaited.
  const cancel = new AbortController();
  const leased = scope(() => f.provider.complete(request([...first, ...answered], cancel.signal)));
  cancel.abort(new Error("stopped before a folder"));
  await assert.rejects(leased, /stopped before a folder/);
  assert.equal(f.launches.length, 1, "the stopped turn started nothing");
  await until(() => gone(folder));
  const next = await scope(() => f.provider.complete(request([...first, ...answered])));
  assert.equal(next.toolCalls.length, 1);
  assert.equal(f.launches.length, 2);
  assert.equal(f.seen.length, 2);
  assert.equal(await folderContract(f), "reused");
  assert.equal(f.launches[1].cwd, folder, "the conversation's own folder, exactly");
});

test("SELF-090 while the replaced transport is still closing, the next turn takes a fresh folder and the old one is still removed", async (t) => {
  let release;
  const closing = new Promise((go) => { release = go; });
  t.after(() => release());
  const f = await fixture(t, { holdClose: (launch) => (launch === 0 ? closing : null) });
  const first = [{ role: "user", content: "Read the file" }];
  await scope(() => f.provider.complete(request(first)));
  const folder = f.launches[0].cwd;
  // Closing the kept transport starts its removal, which cannot finish until its process is seen closed.
  closeNativeSubscriptions();
  const next = await scope(() => f.provider.complete(request([...first, ...answered])));
  assert.equal(next.toolCalls.length, 1);
  assert.equal(f.launches.length, 2);
  assert.notEqual(f.launches[1].cwd, folder, "a fresh folder while the old one is in use");
  await stat(folder); // still being removed
  release();
  assert.equal(await folderContract(f), "fresh");
});

test("SELF-090 a Claude Code that ends just after its result, before the next turn sees it gone, answers on a fresh transport", async (t) => {
  const f = await fixture(t, { mode: "exit-soon" });
  const first = [{ role: "user", content: "Read the file" }];
  await scope(() => f.provider.complete(request(first)));
  const next = await scope(() => f.provider.complete(request([...first, ...answered])));
  assert.equal(next.toolCalls.length, 1);
  assert.equal(f.launches.length, 2, "the ended session was replaced once");
  assert.equal(f.seen.length, 2, "and nothing was generated twice");
});
