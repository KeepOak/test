import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { discardTemp } from "./temp-dir.mjs";
import {
  CliAgentProvider,
  CommandSecrets,
  GatewayAuth,
  SessionTokens,
  agentPromptFrom,
  answerFrom,
  asksForHelp,
  cliAgentCatalog,
  cliAgentRows,
  cliCommands,
  clientFor,
  collectCommandReferences,
  commandHelp,
  commandReference,
  conversationFor,
  conversations,
  createBranch,
  decide,
  eventsToOtlpLogs,
  exportAgent,
  messagesOf,
  parseRunArgs,
  registerCliAgent,
  rowFor,
  saveSecretCommandSettings,
  saveSenderAllowlist,
  saveTraceExportSettings,
  scopeRefusal,
  secretProviderContract,
  setLockdown,
  since,
  transcriptLines,
  TraceExporter,
} from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { fixtureModel } from "./fixtures/fixture-model.mjs";

const run = promisify(execFile);

/* ------------------------------------------------------------------ fixtures */

const scripted = (answer = "ok") => ({
  name: "scripted", requests: [],
  async complete(request) { this.requests.push(request); return { content: answer, toolCalls: [] }; },
});

async function fixture(t, provider = scripted(), options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-w8-"));
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"), provider,
    web: { allowPrivateAddresses: true }, ...options,
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, provider, dataDir: join(root, "data") };
}

async function served(t, provider = scripted(), options = {}) {
  const made = await fixture(t, provider, options);
  const server = await startServer(made.app, { dataDir: made.dataDir, port: 0, presence: "daemon" });
  t.after(() => server.close());
  const api = async (method, path, body, headers = {}) => {
    const response = await fetch(server.url + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* JSON Lines and plain text answer too */ }
    return { status: response.status, body: parsed, text };
  };
  return { ...made, server, api };
}

/** A collector that keeps every body it was sent, so the three OTLP signals can be told apart. */
async function collector(t) {
  const seen = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      seen.push({ path: request.url, body: JSON.parse(raw || "{}") });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, url: `http://127.0.0.1:${server.address().port}` };
}

/** A chat channel that records what was sent, so a delivery can be traced without a real service. */
function fakeChannel(id = "test-chat") {
  const sent = [];
  let deliver = null;
  return {
    sent,
    receive: (message) => deliver(message),
    adapter: {
      id, kind: id, maxTextLength: 3500,
      botName: () => "Branch",
      async start(onMessage) { deliver = onMessage; },
      async send(chatId, text) { sent.push({ chatId, text }); return `m${sent.length}`; },
      async stop() { deliver = null; },
    },
  };
}
const inbound = (text, senderId = "42") => ({
  channel: "test-chat", chatId: "chat-1", chatKind: "private", messageId: `x${Math.random()}`,
  senderId, senderName: "Alice", text, addressed: true,
});

/** A fake executable: a Node script run as `process.execPath <file>`, so PATHEXT never matters. */
async function fakeProgram(root, name, body) {
  const path = join(root, name);
  await writeFile(path, body);
  return { command: process.execPath, args: [path] };
}

/* ======================================================= tracing and telemetry */

test("T1 instrumentation coverage: runs, rounds, tools, retrievals, channel deliveries and child runs all get spans", async (t) => {
  // The steps are chosen from what is already in the transcript, so the sub-task's own rounds
  // (which reach the same provider) cannot knock the parent's sequence out of step.
  const provider = {
    name: "scripted",
    async complete(request) {
      const said = request.messages.map((message) => message.content ?? "").join("\n");
      if (said.includes("a small piece")) return { content: "the small piece is done", toolCalls: [] };
      // 0.18.1: a chat's task now waits for the owner before a write even under "No approvals", so the
      // chat message is simply answered — what is under test there is the delivery span, not the write.
      if (said.includes("say hello")) return { content: "hello", toolCalls: [] };
      const answered = request.messages.filter((message) => message.role === "tool").length;
      if (answered === 0)
        return { content: "", toolCalls: [{ id: "c1", name: "files.write", arguments: JSON.stringify({ path: "note.txt", content: "hi" }) }] };
      if (answered === 1)
        return { content: "", toolCalls: [{ id: "c2", name: "agents.subtask", arguments: JSON.stringify({ brief: "a small piece" }) }] };
      return { content: "done", toolCalls: [] };
    },
  };
  const { app } = await fixture(t, provider);
  // A tool that hands a piece of the work to a sub-task, which is how a child run comes about.
  app.registry.register({
    name: "agents.subtask", description: "Hand a small piece of this task to a sub-task.",
    permission: "specialists.use",
    parameters: (await import("zod")).z.object({ brief: (await import("zod")).z.string().min(1).max(200) }).strict(),
    execute: async (args, context) => {
      const child = await app.runtime.delegate(args.brief, context, [...context.permissions], "Do the small piece.");
      return { childRunId: child.id, status: child.status };
    },
  });
  // Looking something up in the person's own documents: the retrieval the runtime already makes.
  app.runtime.documents = { contextFor: async () => ({ text: "a passage", sources: ["note.pdf"] }) };
  const channel = fakeChannel();
  await app.channels.attach(channel.adapter, { activation: "always", pairing: false, allowlist: ["42"] });
  t.after(() => app.channels.detach?.("test-chat"));

  const parent = await app.runtime.run({ prompt: "write a note", source: "owner" });
  const kindsOf = (runId) => new Set(app.store.spans.forRun(runId).map((span) => span.kind));
  const own = kindsOf(parent.id);
  for (const kind of ["run", "model", "tool", "retrieval"])
    assert.ok(own.has(kind), `no ${kind} span for the task itself: ${[...own].join(", ")}`);

  // A message from a chat app: the answer going back out is a delivery span on the same trace.
  await channel.receive(inbound("say hello"));
  await (async () => { for (let i = 0; i < 200 && !channel.sent.length; i++) await delay(20); })();
  assert.equal(channel.sent.length, 1, "the answer never reached the chat");
  const delivered = app.store.spans.recent(app.runtime.owner, 200).filter((span) => span.kind === "delivery");
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].name, /branch\.delivery test-chat/);
  // It belongs to the trace of the task that produced it, not to a trace of its own.
  const chatRunSpans = app.store.spans.forRun(delivered[0].runId);
  assert.equal(delivered[0].traceId, chatRunSpans.find((span) => !span.parentSpanId).traceId);

  // The sub-task the parent handed a piece to is a child span inside the parent's own trace.
  const parentSpan = app.store.spans.forRun(parent.id).find((span) => !span.parentSpanId);
  const childRoot = app.store.spans.forTrace(parentSpan.traceId).find((span) => span.kind === "child");
  assert.ok(childRoot, "a sub-task got no child span");
  assert.notEqual(childRoot.runId, parent.id);
  assert.equal(childRoot.parentSpanId, parentSpan.spanId);
});

test("T2 the OTLP logs signal carries a task's own story, tied to its trace, and only to a collector", async (t) => {
  const { app } = await fixture(t);
  const sink = await collector(t);
  saveTraceExportSettings(app.store, app.runtime.owner, { enabled: true, destination: "otlp", endpoint: sink.url });
  const task = await app.runtime.run({ prompt: "say something", source: "owner" });
  for (let i = 0; i < 200 && !sink.seen.some((one) => one.path === "/v1/logs"); i++) await delay(20);
  const logs = sink.seen.find((one) => one.path === "/v1/logs");
  assert.ok(logs, `no logs signal was sent: ${sink.seen.map((one) => one.path).join(", ")}`);
  const records = logs.body.resourceLogs[0].scopeLogs[0].logRecords;
  assert.ok(records.length > 0);
  const root = app.store.spans.forRun(task.id).find((span) => !span.parentSpanId);
  assert.equal(records[0].traceId, root.traceId);
  assert.ok(records.some((record) => record.body.stringValue.startsWith("run.started")));

  // Langfuse and LangSmith have no logs signal, so nothing at all is sent for them.
  const exporter = new TraceExporter({
    store: app.store, owner: app.runtime.owner, policy: { assertAllowed: async () => undefined },
    version: "test", fillSecrets: async (headers) => headers,
  });
  saveTraceExportSettings(app.store, app.runtime.owner, { enabled: true, destination: "langfuse", endpoint: sink.url });
  assert.equal(await exporter.sendLogs([{ runId: "r", kind: "run.started", createdAt: new Date().toISOString(), data: {} }]), null);
});

test("T2b a log record says WARN for anything that went wrong and INFO for the rest", () => {
  const at = new Date().toISOString();
  const body = eventsToOtlpLogs([
    { runId: "r", kind: "run.started", createdAt: at, data: {} },
    { runId: "r", kind: "documents.retrieval_failed", createdAt: at, data: { error: "no" } },
  ], { name: "branch", version: "1" });
  const records = body.resourceLogs[0].scopeLogs[0].logRecords;
  assert.equal(records[0].severityText, "INFO");
  assert.equal(records[1].severityText, "WARN");
});

test("T3 `branch trace` prints the trace number and whether it was sent anywhere", async (t) => {
  const { app, root, dataDir } = await fixture(t);
  const task = await app.runtime.run({ prompt: "hello", source: "owner" });
  const traceId = app.store.spans.forRun(task.id).find((span) => !span.parentSpanId).traceId;
  await app.close();
  const { stdout } = await run(process.execPath, ["dist/cli.js", "trace", task.id, "--json"], {
    env: { ...process.env, ...(await fixtureModel()).env, BRANCH_WORKSPACE: join(root, "workspace"), BRANCH_DATA_DIR: dataDir },
  });
  const report = JSON.parse(stdout);
  assert.equal(report.traceId, traceId);
  assert.equal(report.sending, null);
  assert.ok(report.kinds.includes("run"));
});

test("T4 the logs route answers JSON Lines, filtered, and only with the local key", async (t) => {
  const { app, api, server } = await served(t);
  await app.runtime.run({ prompt: "hello", source: "owner" });
  const all = await api("GET", "/api/logs?limit=50");
  assert.equal(all.status, 200);
  const lines = all.text.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(lines.length > 0);
  assert.ok(lines.every((line) => typeof line.kind === "string"));
  const filtered = await api("GET", "/api/logs?kind=run.started");
  assert.ok(filtered.text.trim().split("\n").every((line) => JSON.parse(line).kind === "run.started"));
  const refused = await fetch(server.url + "/api/logs", { headers: { host: new URL(server.url).host } });
  assert.equal(refused.status, 401);
});

test("T5 every widening moment reaches the record: exports, profile switches, lockdown, connections, a borrowed browser", async (t) => {
  const { app, api } = await served(t);
  const owner = app.runtime.owner;
  const actions = () => app.store.audit.list(owner, { limit: 200 }).map((entry) => entry.action);

  exportAgent(app.store, owner, "0.0.0");
  assert.ok(actions().includes("data.exported"), "exporting the whole assistant was not written down");

  setLockdown(app.store, owner, { on: true });
  assert.ok(actions().includes("lockdown.changed"), "Lockdown was not written down");
  setLockdown(app.store, owner, { on: false });

  const made = app.store.profiles.create({ name: "Sam", pin: "4321" });
  assert.equal((await api("POST", "/api/profiles/switch", { profileId: made.id, pin: "4321" })).status, 200);
  await api("POST", "/api/profiles/switch", { profileId: null });
  assert.ok(actions().includes("profile.switched"), "switching who is using the computer was not written down");

  const key = app.sessionTokens.create(owner, { scope: "read", minutes: 5 });
  assert.ok(actions().includes("token.issued"));
  app.sessionTokens.revoke(owner, key.entry.id);
  assert.equal(app.store.audit.list(owner, { action: "token.issued" }).filter((one) => one.outcome === "revoked").length, 1);

  // Connections and a borrowed browser both write a line of their own kind.
  const { audit } = await import("../dist/index.js");
  audit(app.store, owner, { action: "connection.changed", subject: "openai", reason: "test", outcome: "added" });
  audit(app.store, owner, { action: "browser.borrowed", subject: "your own browser window", reason: "test", outcome: "borrowed" });
  const counts = Object.fromEntries(app.store.audit.counts(owner).map((row) => [row.action, row.count]));
  for (const action of ["data.exported", "lockdown.changed", "profile.switched", "token.issued", "connection.changed", "browser.borrowed"])
    assert.ok(counts[action] > 0, `${action} is not counted`);
});

/* ================================================================ secrets and auth */

test("S1 a short-lived key may look but not act, runs out, and can be taken back", async (t) => {
  const { app, api, server } = await served(t);
  const owner = app.runtime.owner;
  const reading = app.sessionTokens.create(owner, { scope: "read", minutes: 60, name: "A widget" });
  const acting = app.sessionTokens.create(owner, { scope: "run", minutes: 60 });
  assert.match(reading.token, /^branch_[a-f0-9]{48}$/);

  const withKey = (token) => ({ authorization: `Bearer ${token}` });
  const looked = await fetch(server.url + "/api/state", { headers: { ...withKey(reading.token), host: new URL(server.url).host } });
  assert.equal(looked.status, 200);
  const acted = await fetch(server.url + "/api/run", {
    method: "POST", headers: { ...withKey(reading.token), "content-type": "application/json", host: new URL(server.url).host },
    body: JSON.stringify({ prompt: "do something" }),
  });
  assert.equal(acted.status, 401);
  assert.match((await acted.json()).error, /may only look/);

  // The key that may act is allowed the same request.
  const allowed = await fetch(server.url + "/api/run", {
    method: "POST", headers: { ...withKey(acting.token), "content-type": "application/json", host: new URL(server.url).host },
    body: JSON.stringify({ prompt: "say hello" }),
  });
  assert.equal(allowed.status, 200);

  // Taken back, it stops working at once; the master key is untouched throughout.
  app.sessionTokens.revoke(owner, reading.token && reading.entry.id);
  const afterwards = await fetch(server.url + "/api/state", { headers: { ...withKey(reading.token), host: new URL(server.url).host } });
  assert.equal(afterwards.status, 401);
  assert.match((await afterwards.json()).error, /taken back/);
  assert.equal((await api("GET", "/api/state")).status, 200);

  // One that has run out is refused too, and a key of somebody else's shape is simply not a key.
  const past = new SessionTokens(app.store.sqlite, app.store);
  const short = past.create(owner, { minutes: 1 });
  assert.match(past.check(owner, short.token, { method: "GET", executes: false }, new Date(Date.now() + 120_000)), /run out/);
  assert.match(past.check(owner, "not-a-branch-key", { method: "GET", executes: false }), /Local session token required/);
});

test("S1a a short-lived key never names a program for Branch to run, nor touches the locker", async (t) => {
  const { app, server } = await served(t);
  const acting = app.sessionTokens.create(app.runtime.owner, { scope: "run", minutes: 60 });
  const host = new URL(server.url).host;
  const post = (path, body) => fetch(server.url + path, {
    method: "POST",
    headers: { authorization: `Bearer ${acting.token}`, "content-type": "application/json", host },
    body: JSON.stringify(body),
  });
  // A "run" key may start a task, so it is not simply a read key being turned away here.
  const registered = await post("/api/providers/cli-agents", { id: "sneaky", command: "calc.exe" });
  assert.equal(registered.status, 401);
  assert.match((await registered.json()).error, /cannot name a program/);
  assert.equal((await post("/api/secrets", { project: "default", name: "X", value: "y" })).status, 401);
  // Adding a model service puts a key in the locker and widens where the words go, so it is the
  // owner's step too, even though /api/connections otherwise counts as starting work.
  assert.equal((await post("/api/connections/from-preset", { preset: "openai", apiKey: "x" })).status, 401);
  // The owner's own key still does both, so nothing was closed off to the app window.
  const asOwner = await fetch(server.url + "/api/providers/cli-agents", {
    method: "POST",
    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json", host },
    body: JSON.stringify({ id: "claude-code" }),
  });
  assert.equal(asOwner.status, 200);
});

test("S1b what each scope may do is one small decision, tested on its own", () => {
  assert.equal(scopeRefusal("read", { method: "GET", executes: false }), null);
  assert.match(scopeRefusal("read", { method: "POST", executes: true }), /only look/);
  assert.equal(scopeRefusal("run", { method: "POST", executes: true }), null);
});

test("S2 a password may come from a command the owner listed, and from no other command", async (t) => {
  const { app, root } = await fixture(t);
  const owner = app.runtime.owner;
  const good = await fakeProgram(root, "prints-a-key.mjs", "process.stdout.write('super-secret-value\\n');\n");
  const bad = await fakeProgram(root, "fails.mjs", "process.stderr.write('nope');process.exit(3);\n");

  const secrets = new CommandSecrets(app.store, owner, app.store.secrets.scrubber);
  // Off until the owner turns it on.
  await assert.rejects(secrets.read(commandReference("deploy"), { purpose: "test" }), /not set up to run a command/);
  saveSecretCommandSettings(app.store, owner, {
    enabled: true,
    commands: [
      { name: "deploy", command: good.command, args: good.args, note: "the deploy key" },
      { name: "broken", command: bad.command, args: bad.args, note: "" },
    ],
  });
  assert.equal(await secrets.read(commandReference("deploy"), { purpose: "a deploy" }), "super-secret-value");
  // A name that is not in the list never starts a process, whatever it looks like.
  await assert.rejects(secrets.read(commandReference("anything-else"), { purpose: "x" }), /no command called "anything-else"/);
  await assert.rejects(secrets.read(commandReference("broken"), { purpose: "x" }), /did not finish properly/);

  // References inside a whole value are replaced at the moment of the call and nowhere earlier.
  const filled = await secrets.fill({ headers: { "x-api-key": commandReference("deploy") } }, { purpose: "a call" });
  assert.equal(filled.headers["x-api-key"], "super-secret-value");
  assert.deepEqual(collectCommandReferences({ a: [commandReference("deploy")] }), ["deploy"]);
  // Every look-up is in the record, and the value itself never is.
  const written = app.store.audit.list(owner, { action: "secret.used" });
  assert.ok(written.length >= 3);
  assert.ok(written.every((entry) => !JSON.stringify(entry).includes("super-secret-value")));
  // And the locker fills them too, because the command source is wired in front of its projects.
  const throughLocker = await app.store.secrets.fill(owner, "default", { token: commandReference("deploy") }, { purpose: "a call" });
  assert.equal(throughLocker.token, "super-secret-value");
});

test("S2b a password a command printed never leaves the computer in a trace, a log record or the record", async (t) => {
  const { app, root } = await fixture(t);
  const sink = await collector(t);
  const owner = app.runtime.owner;
  const prints = await fakeProgram(root, "prints.mjs", "process.stdout.write('SUPER-SECRET-VALUE')");
  saveSecretCommandSettings(app.store, owner, {
    enabled: true, commands: [{ name: "deploy", command: prints.command, args: prints.args, note: "" }],
  });
  const source = new CommandSecrets(app.store, owner, app.store.secrets.scrubber);
  const filled = await source.fill({ token: commandReference("deploy") }, { purpose: "a test" });
  assert.equal(filled.token, "SUPER-SECRET-VALUE", "the caller still gets the real value");

  saveTraceExportSettings(app.store, owner, { enabled: true, destination: "otlp", endpoint: sink.url });
  const task = await app.runtime.run({ prompt: "use SUPER-SECRET-VALUE now", source: "owner" });
  app.store.event(task.id, "tool.finished", { output: "here is SUPER-SECRET-VALUE in the output" });
  await app.runtime.exportSpans(task.id);
  for (let i = 0; i < 200 && !sink.seen.some((one) => one.path === "/v1/logs"); i++) await delay(20);
  const sent = JSON.stringify(sink.seen);
  assert.ok(sink.seen.some((one) => one.path === "/v1/logs"), "no log records were sent at all");
  assert.ok(!sent.includes("SUPER-SECRET-VALUE"), "the password left this computer in an OTLP body");
  assert.ok(!JSON.stringify(app.store.audit.list(owner, { limit: 200 })).includes("SUPER-SECRET-VALUE"),
    "the password reached the record of what the assistant was allowed to do");
});

test("S3 the sources a saved password can come from are one written-down contract", () => {
  const schemes = secretProviderContract().map((one) => one.scheme);
  for (const scheme of ["<project>", "cmd", "bitwarden", "1password", "env", "file"])
    assert.ok(schemes.includes(scheme), `${scheme} is not in the contract`);
  assert.ok(secretProviderContract().every((one) => one.label && one.description));
});

test("S4 one list says who may message the assistant, and a block anywhere wins", async (t) => {
  const { app } = await fixture(t);
  const owner = app.runtime.owner;
  const list = saveSenderAllowlist(app.store, owner, {
    unknown: "block",
    rules: [
      { channel: "*", sender: "42", decision: "allow", note: "Alice" },
      { channel: "*", sender: "99", decision: "allow", note: "Bob" },
      { channel: "test-chat", sender: "99", decision: "block", note: "not in this one" },
    ],
  });
  assert.equal(decide(list, "telegram", "42"), "allow");
  assert.equal(decide(list, "telegram", "99"), "allow");
  assert.equal(decide(list, "test-chat", "99"), "block");
  assert.equal(decide(list, "telegram", "1000"), null);

  // The router reads it: a blocked sender is turned away, an allowed one is answered.
  const channel = fakeChannel();
  await app.channels.attach(channel.adapter, { activation: "always", pairing: true, allowlist: [] });
  await channel.receive(inbound("hello", "99"));
  assert.equal(channel.sent.length, 0, "a blocked sender is told nothing (UP-CHAT-008)");
  await channel.receive(inbound("hello", "42"));
  for (let i = 0; i < 200 && channel.sent.length < 1; i++) await delay(20);
  assert.equal(channel.sent.length, 1);
  assert.ok(!/private/i.test(channel.sent[0].text));
});

test("S5 the extra door's checks are a chain, and every step in it must pass", async (t) => {
  const { app } = await fixture(t);
  const gateway = new GatewayAuth(app.store, app.runtime.owner);
  const headers = (extra = {}) => ({ headers: extra });
  // Out of the box: the key, and a phone that has been let in once.
  assert.match(gateway.check(headers(), true), /No phone has been let in/);
  const first = gateway.remember("Alice's phone");
  assert.equal(gateway.check(headers(), true), null);
  assert.match(gateway.check(headers(), false), /does not have the key/);

  // Adding the "this exact phone" step can only make the door harder to open.
  const { saveGatewayAuth, deviceHeader, deviceSecretHeader } = await import("../dist/index.js");
  saveGatewayAuth(app.store, app.runtime.owner, { chain: ["token", "pairing", "device"] });
  assert.match(gateway.check(headers(), true), /not the one that was let in/);
  assert.equal(gateway.check(headers({ [deviceHeader]: first.device.id, [deviceSecretHeader]: first.secret }), true), null);
  assert.match(gateway.check(headers({ [deviceHeader]: first.device.id, [deviceSecretHeader]: "wrong" }), true), /not the one/);
  // Taking a phone off the list shuts it out at once.
  assert.equal(gateway.forget(first.device.id), true);
  assert.match(gateway.check(headers({ [deviceHeader]: first.device.id, [deviceSecretHeader]: first.secret }), true), /No phone has been let in/);
  // The secret itself is never kept, only its fingerprint.
  assert.ok(!JSON.stringify(app.store.get("settings", app.runtime.owner, "remote-devices")).includes(first.secret));
});

test("S6 a household profile needs its PIN, and a run of wrong ones is made to wait", async (t) => {
  const { app } = await fixture(t);
  const profiles = app.store.profiles;
  const sam = profiles.create({ name: "Sam", pin: "1234" });
  assert.throws(() => profiles.switch({ profileId: sam.id, pin: "0000" }), /not right/);
  assert.equal(profiles.switch({ profileId: sam.id, pin: "1234" }).active.name, "Sam");
  profiles.switch({ profileId: null });
  for (let i = 0; i < 5; i++) assert.throws(() => profiles.switch({ profileId: sam.id, pin: "0000" }));
  assert.throws(() => profiles.switch({ profileId: sam.id, pin: "1234" }), /Wait a few minutes/);
});

/* ========================================================================== CLI */

test("C1 every command Branch knows has help of its own, and asking never does the work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-help-"));
  t.after(() => discardTemp(root));
  const env = {
    ...process.env, ...(await fixtureModel()).env,
    BRANCH_WORKSPACE: join(root, "workspace"), BRANCH_DATA_DIR: join(root, "data"),
  };
  assert.ok(cliCommands.length >= 25);
  assert.ok(asksForHelp(["--help"]) && asksForHelp(["-h"]) && !asksForHelp(["--json"]));
  for (const command of cliCommands) {
    assert.ok(commandHelp(command.name)?.includes(command.summary), `${command.name} has no help text`);
    const { stdout } = await run(process.execPath, ["dist/cli.js", command.name, "--help"], { env });
    assert.match(stdout, new RegExp(`^branch ${command.name}`), `branch ${command.name} --help did not print help`);
    for (const option of command.options)
      assert.ok(stdout.includes(option), `branch ${command.name} --help left out ${option}`);
  }
  // Asking never created a workspace or a database: nothing was opened at all.
  await assert.rejects(readdir(join(root, "data")));
});

test("C2 the packed tarball installs a working `branch` command", async (t) => {
  const out = await mkdtemp(join(tmpdir(), "branch-pack-"));
  // The linked-in dependencies below are a junction to the real folder, so it is taken away first:
  // deleting through it would empty the one every other test is using.
  t.after(async () => {
    const fs = await import("node:fs/promises");
    await fs.unlink(join(out, "package", "node_modules")).catch(() => undefined);
    await discardTemp(out);
  });
  const packed = await run(process.execPath, ["scripts/pack-cli.mjs", out], { maxBuffer: 1024 * 1024 * 32 });
  const tarball = packed.stdout.split(/\r?\n/)[0].trim();
  assert.match(tarball, /branch-agent-\d+\.\d+\.\d+\.tgz$/);
  // Unpacked from inside the folder: a Windows path with a drive letter looks like a host to tar.
  await run("tar", ["-xzf", tarball.split(/[\\/]/).pop()], { cwd: out });
  const fs = await import("node:fs/promises");
  const manifest = JSON.parse(await fs.readFile(join(out, "package", "package.json"), "utf8"));
  assert.match(manifest.bin.branch, /(^|\/)dist\/cli\.js$/);
  assert.ok(manifest.files.includes("dist"));
  // The data files the command reads are named one by one (Q47), and they are in the tarball.
  await fs.access(join(out, "package", "data", "providers.json"));
  await fs.access(join(out, "package", "data", "add-ons"));
  // `npm install -g` would put the dependencies beside it; nothing here touches the real computer,
  // so they are linked in instead and the packed command is run exactly as it would be installed.
  await fs.symlink(join(process.cwd(), "node_modules"), join(out, "package", "node_modules"), "junction");
  const { stdout } = await run(process.execPath, [join(out, "package", "dist", "cli.js"), "--help"]);
  assert.match(stdout, /Usage: branch <command>/);
  // It starts with the line that makes it runnable as a command on a path, not only through node.
  assert.match(await fs.readFile(join(out, "package", "dist", "cli.js"), "utf8"), /^#!\/usr\/bin\/env node/);
});

test("C3 two terminals share one conversation on the engine that is already running", async (t) => {
  const { app, api, server, dataDir } = await served(t, scripted("the answer"));
  // The first terminal starts a conversation the ordinary way.
  const started = await api("POST", "/api/run", { prompt: "what is the plan" });
  assert.equal(started.status, 200);
  const sessionId = started.body.sessionId ?? started.body.run?.sessionId;
  assert.ok(sessionId);

  const attachment = { url: server.url, token: server.token, instance: { port: 0, pid: process.pid, url: server.url, mode: "daemon", version: "t", startedAt: new Date().toISOString() } };
  const one = clientFor(attachment), two = clientFor(attachment);
  // Both clients see the same conversations and the same words in them.
  const listed = await conversations(one, 10);
  assert.ok(listed.some((row) => row.id === sessionId), "the second terminal could not list the conversation");
  const caught = transcriptLines(await messagesOf(two, sessionId));
  assert.ok(caught.some((line) => line.startsWith("you: what is the plan")));

  // The second terminal says something; the first one sees it without having sent it.
  const mark = (await since(one, sessionId, -1)).last;
  await two.post("/api/run", { prompt: "and after that?", sessionId });
  const fresh = await since(one, sessionId, mark);
  assert.ok(fresh.lines.some((line) => line.includes("and after that?")), fresh.lines.join(" | "));
  assert.ok(fresh.lines.some((line) => line.startsWith("branch: the answer")));

  // Without a running engine there is a plain sentence rather than a stack.
  const { connect, notRunning } = await import("../dist/index.js");
  await assert.rejects(connect(join(dataDir, "nowhere")), new RegExp(notRunning.slice(0, 30)));
});

test("C4 `branch run` can join a conversation, carry a stopped task on, or work in a copy", async (t) => {
  const { app } = await fixture(t, scripted("fine"));
  const owner = app.runtime.owner;
  assert.deepEqual(
    (({ sessionId, resumeRunId, forkFrom }) => ({ sessionId, resumeRunId, forkFrom }))(parseRunArgs(["hello", "--session", "s1", "--fork", "s2"])),
    { sessionId: "s1", resumeRunId: undefined, forkFrom: "s2" },
  );
  assert.throws(() => parseRunArgs(["x", "--session"]), /--session needs a number/);
  assert.throws(() => parseRunArgs(["x", "--resume", "a", "--fork", "b"]), /either --resume or --fork/);

  const first = await app.runtime.run({ prompt: "start here", source: "owner" });
  // --session joins the conversation that task is in.
  assert.deepEqual((await conversationFor(app.store, owner, parseRunArgs(["again", "--session", first.sessionId]))),
    { sessionId: first.sessionId });
  // --resume picks the task's own conversation up again, and takes up its request.
  const resumed = (await conversationFor(app.store, owner, parseRunArgs(["--resume", first.id])));
  assert.equal(resumed.sessionId, first.sessionId);
  assert.equal(resumed.resumeFrom, first.id);
  assert.equal(resumed.prompt, "start here");
  // --fork works in a copy and leaves the conversation it came from exactly as it was.
  const before = app.store.sessionView(owner, first.sessionId).messages.length;
  const forked = (await conversationFor(app.store, owner, parseRunArgs(["a different way", "--fork", first.sessionId])));
  assert.notEqual(forked.sessionId, first.sessionId);
  assert.equal(app.store.sessionView(owner, first.sessionId).messages.length, before);
  assert.equal(app.store.sessionView(owner, forked.sessionId).messages.length, before);
  await assert.rejects(async () => (await conversationFor(app.store, owner, parseRunArgs(["--resume", "00000000-0000-4000-8000-000000000000"]))), /no task of yours/);
});

test("C5 schedules can be added, listed and removed over the running engine's own door", async (t) => {
  const { api } = await served(t);
  const added = await api("POST", "/api/schedules", {
    prompt: "water the plants", kind: "reminder", dueAt: new Date(Date.now() + 3_600_000).toISOString(),
  });
  assert.equal(added.status, 200);
  const id = added.body.id;
  const listed = await api("GET", "/api/schedules");
  assert.equal(listed.body.schedules.length, 1);
  assert.equal(listed.body.schedules[0].data.prompt, "water the plants");
  const removed = await api("POST", `/api/schedules/${id}/remove`, {});
  assert.equal(removed.body.removed, true);
  assert.equal((await api("GET", "/api/schedules")).body.schedules.length, 0);
  assert.equal((await api("POST", `/api/schedules/${id}/remove`, {})).status, 404);
});

test("C5a `branch schedule` stays a client of the engine already running", async (t) => {
  const { api, dataDir, root } = await served(t);
  const env = { ...process.env, BRANCH_DATA_DIR: dataDir, BRANCH_WORKSPACE: join(root, "workspace") };
  const cli = (...args) => run(process.execPath, ["dist/cli.js", "schedule", ...args], { env, timeout: 30_000 });
  const added = JSON.parse((await cli("add", "--prompt", "water the plants", "--every", "60000", "--json")).stdout);
  const listed = JSON.parse((await cli("list", "--json")).stdout);
  assert.equal(listed.schedules.find((row) => row.id === added.id).data.prompt, "water the plants");
  assert.equal(JSON.parse((await cli("remove", added.id, "--json")).stdout).removed, true);
  assert.equal((await api("GET", "/api/schedules")).body.schedules.length, 0);
});

test("C6 a coding assistant already installed here can answer as a model", async (t) => {
  const { app, root } = await fixture(t);
  const words = await fakeProgram(root, "fake-agent.mjs",
    "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{"
    + "process.stdout.write(JSON.stringify({result:'I read '+input.length+' characters'}));});\n");
  const broken = await fakeProgram(root, "fake-agent-broken.mjs", "process.exit(2);\n");

  // The rows Branch knows say plainly that they use the owner's own tool and sign-in.
  assert.deepEqual(cliAgentCatalog.map((row) => row.id).sort(), ["claude-code", "codex", "copilot", "gemini-cli"]);
  assert.ok(cliAgentRows().every((row) => /own .* with your own sign-in\. Branch never sees or keeps that sign-in\./.test(row.note)));
  // mac5/providers: each row names its route and links the maker's terms.
  assert.ok(cliAgentRows().every((row) => row.terms?.url.startsWith("https://") && row.terms.standing === "official"));
  assert.match(cliAgentCatalog.find((row) => row.id === "claude-code").terms.warning, /plan's usage limits/);
  assert.ok(cliAgentRows().every((row) => row.shape === "cli-agent"));

  const row = rowFor({ id: "fake", command: words.command, args: words.args, jsonField: "result", name: "A fake assistant" });
  const provider = new CliAgentProvider(row, { timeoutMs: 20_000 });
  const request = { messages: [{ role: "user", content: "hello there" }], tools: [], signal: AbortSignal.timeout(20_000), maxTokens: 100 };
  const answer = await provider.complete(request);
  assert.match(answer.content, /^I read \d+ characters$/);
  assert.deepEqual(answer.toolCalls, []);
  assert.equal(provider.modelsList(), null);
  // Branch's transcript goes in as the one question; the answer comes out of the JSON field.
  assert.equal(agentPromptFrom(request), "user: hello there");
  assert.equal(answerFrom(row, '{"result":"  spaced  "}'), "spaced");
  assert.equal(answerFrom({ ...row, jsonField: "" }, " plain words "), "plain words");

  // A tool that is not there, and one that fails, both say so in a sentence a person can act on.
  const missing = new CliAgentProvider(rowFor({ id: "gone", command: "definitely-not-a-program-here" }), { timeoutMs: 5000 });
  await assert.rejects(missing.complete(request), /is not on this computer/);
  const fails = new CliAgentProvider(rowFor({ id: "broken", command: broken.command, args: broken.args }), { timeoutMs: 20_000 });
  await assert.rejects(fails.complete(request), /could not finish the task \(exit code 2\)/);

  // Registering one only offers it; the model in use is not changed by that.
  const before = app.runtime.models.presets.size;
  const offered = registerCliAgent(app.runtime.models, { id: "fake", command: words.command, args: words.args, jsonField: "result" });
  assert.equal(offered.id, "cli-fake");
  assert.equal(app.runtime.models.presets.size, before + 1);
  assert.throws(() => rowFor({ id: "unknown-tool" }), /Give the command to run as well/);
});
