import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch,
  ApprovalGate,
  AuthLimiter,
  PolicySchema,
  SpanStore,
  Tracer,
  argumentFingerprint,
  collectMetrics,
  evaluatePolicy,
  formatTraceparent,
  histogram,
  hostMatches,
  parsePrometheus,
  parseTraceparent,
  pathMatches,
  presetRules,
  prometheusText,
  readPolicy,
  resourceMatches,
  resourceOf,
  ruleSentence,
  savePolicy,
  saveTraceExportSettings,
  spansToLangfuse,
  spansToLangsmith,
  spansToOtlp,
  traceExportSettings,
  TraceExporter,
} from "../dist/index.js";
import { startServer } from "../dist/server.js";
/** Q257: the fingerprint of the question the window shows for a conversation; a bare answer is refused. */
const shownFingerprint = (app, sessionId) => app.runtime.approvals.questionFor(sessionId)?.fingerprint;

const say = (content) => () => ({ content, toolCalls: [] });
const calls = (...toolCalls) => () => ({ content: "", toolCalls });
const write = (id, path, content) => ({ id, name: "files.write", arguments: JSON.stringify({ path, content }) });

function scripted(steps) {
  const provider = {
    name: "scripted",
    requests: [],
    async complete(request) {
      provider.requests.push(request);
      return steps[Math.min(provider.requests.length - 1, steps.length - 1)](request);
    },
    reset() { provider.requests.length = 0; },
  };
  return provider;
}

async function fixture(t, steps = [say("ok")], options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-tracing-"));
  const provider = scripted(steps);
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"), provider,
    web: { allowPrivateAddresses: true }, ...options,
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, provider, workspace: join(root, "workspace") };
}

async function served(t, steps, options = {}) {
  const { app, root, workspace, provider } = await fixture(t, steps, options);
  const server = await startServer(app, { dataDir: join(root, "data"), ...(options.server ?? {}), port: 0 });
  t.after(() => server.close());
  const api = async (method, path, body, headers = {}) => {
    const response = await fetch(server.url + path, {
      method,
      headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* the counters page answers in plain text */ }
    return { status: response.status, body: parsed, text };
  };
  return { app, api, workspace, provider, server };
}

/** A collector that records what it was sent and can be told to fail the first few times. */
async function fakeCollector(t, options = {}) {
  const seen = [];
  let failures = options.failFirst ?? 0;
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      seen.push({ path: request.url, headers: { ...request.headers }, body: JSON.parse(raw || "{}") });
      if (failures > 0) { failures -= 1; response.writeHead(503); response.end("busy"); return; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { seen, url: `http://127.0.0.1:${server.address().port}` };
}

// ------------------------------------------------------------------ T1: spans

test("T1: a task's spans nest, and a sub-task sits inside the same trace", async (t) => {
  const { app } = await fixture(t, [calls(write("c1", "notes.txt", "one")), say("done")]);
  const run = await app.runtime.run({ prompt: "write notes" });
  assert.equal(run.status, "completed", run.output);
  const spans = app.store.spans.forRun(run.id);
  const root = spans.find((span) => span.kind === "run");
  assert.ok(root, "the task has a span of its own");
  assert.equal(root.parentSpanId, "", "the task's span is at the top of its trace");
  assert.equal(root.status, "ok");
  assert.match(root.traceId, /^[0-9a-f]{32}$/);
  assert.match(root.spanId, /^[0-9a-f]{16}$/);
  const tool = spans.find((span) => span.kind === "tool");
  assert.ok(tool, "the tool call has its own span");
  assert.equal(tool.parentSpanId, root.spanId, "the tool call hangs off the task");
  assert.equal(tool.traceId, root.traceId, "and shares its trace");
  assert.equal(tool.attributes["branch.tool.name"], "files.write");
  const model = spans.find((span) => span.kind === "model");
  assert.ok(model, "each round with the model has a span");
  assert.equal(model.parentSpanId, root.spanId);
  assert.ok(model.endedAt, "a finished span has an end");
  assert.ok(Number(root.attributes["branch.tokens.input"]) >= 0);

  // A sub-task started underneath it is a child span inside the same trace.
  const tracer = app.runtime.tracer;
  const parent = tracer.startRun("parent-1", "branch.run", {});
  const child = tracer.startRun("child-1", "branch.child_run", {}, { parentRunId: "parent-1" });
  assert.equal(child.traceId, parent.traceId, "a sub-task is inside the parent's trace");
  const childRow = app.store.spans.forRun("child-1")[0];
  assert.equal(childRow.kind, "child");
  assert.equal(childRow.parentSpanId, parent.spanId);
});

test("T1: a failed tool leaves a failed span, and an attribute cannot carry a saved key", async (t) => {
  const secret = "sk-live-never-in-a-span-0000";  // not-a-real-secret: a planted fixture, here to prove it gets blanked out
  const { app } = await fixture(t, [calls({ id: "c1", name: "files.read", arguments: JSON.stringify({ path: "gone.txt" }) }), say("done")]);
  app.store.secrets.scrubber.remember("SERVICE_TOKEN", secret);
  const run = await app.runtime.run({ prompt: "read it" });
  const tool = app.store.spans.forRun(run.id).find((span) => span.kind === "tool");
  assert.equal(tool.status, "error", "a tool that failed says so");
  assert.ok(tool.message.length > 0);
  // The scrubber sits in front of every attribute written straight to the spans table.
  const span = app.runtime.tracer.start(run.id, "tool", `tool ${secret}`, { "branch.note": `key ${secret}` });
  assert.equal(span, null, "a finished task has no trace open, so nothing is written");
  const open = app.runtime.tracer.startRun("scrub-1", "branch.run", { "branch.note": `key ${secret}` });
  open.end("ok", `failed with ${secret}`);
  const row = app.store.spans.forRun("scrub-1")[0];
  assert.ok(!JSON.stringify(row).includes(secret), "no span carries a saved password or key");
});

test("T1: traceparent is read, written and refused when malformed", () => {
  const header = formatTraceparent("0af7651916cd43dd8448eb211c80319c", "b7ad6b7169203331");
  assert.equal(header, "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01");
  assert.deepEqual(parseTraceparent(header), {
    traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", sampled: true,
  });
  assert.equal(parseTraceparent("nonsense"), null);
  assert.equal(parseTraceparent("00-" + "0".repeat(32) + "-b7ad6b7169203331-01"), null, "an all-zero trace id is not a trace");
  assert.equal(parseTraceparent(undefined), null);
});

test("T1: a trace goes out to another assistant and comes back in from one", async (t) => {
  const { app, api, server } = await served(t, [say("done")]);
  // Out: a task asking another assistant puts its own traceparent on the call.
  const seen = [];
  const peer = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      seen.push({ traceparent: request.headers.traceparent ?? null });
      if (request.url === "/.well-known/agent.json") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ name: "Ada", description: "peer", version: "1.0.0",
          url: `http://127.0.0.1:${peer.address().port}/a2a`, skills: [{ id: "branch.ask", name: "Ask" }] }));
        return;
      }
      const message = JSON.parse(raw || "{}");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id,
        result: { id: message.params.id, sessionId: "s1", status: { state: "completed" },
          artifacts: [{ name: "answer", parts: [{ type: "text", text: "ok" }] }] } }));
    });
  });
  await new Promise((resolve) => peer.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => peer.close(resolve)));
  await api("POST", "/api/agents/remote", { cardUrl: `http://127.0.0.1:${peer.address().port}` });
  const open = app.runtime.tracer.startRun("asking-1", "branch.run", {});
  await app.registry.execute("agents.ask", { agent: "Ada", task: "hello" }, app.runtime.context({ runId: "asking-1" }));
  const sent = seen.at(-1).traceparent;
  assert.ok(sent, "the question carried a traceparent");
  assert.equal(parseTraceparent(sent).traceId, open.traceId, "and it is this task's own trace");

  // In: work arriving with a traceparent joins that trace rather than starting a new one.
  await api("POST", "/api/mcp/settings", { enabled: true, exposedTools: [], a2a: true });
  const incoming = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  const answer = await fetch(`${server.url}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json", traceparent: incoming,
      authorization: `Bearer ${server.token}`, host: new URL(server.url).host },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t1", method: "tasks/send",
      params: { id: "t1", message: { role: "user", parts: [{ type: "text", text: "hello" }] } } }),
  });
  assert.equal(answer.status, 200);
  const joined = app.store.spans.forTrace("4bf92f3577b34da6a3ce929d0e0e4736");
  assert.ok(joined.length > 0, "the work here is inside the caller's trace");
  assert.equal(joined[0].parentSpanId, "00f067aa0ba902b7", "and hangs off the span they were in");
});

// ------------------------------------------------------- T2: sending them out

/** The smallest shape check that would catch an OTLP body the wrong way round. */
function assertOtlpShape(document) {
  assert.ok(Array.isArray(document.resourceSpans) && document.resourceSpans.length > 0);
  const resource = document.resourceSpans[0];
  assert.ok(resource.resource.attributes.some((a) => a.key === "service.name" && typeof a.value.stringValue === "string"));
  const scope = resource.scopeSpans[0];
  assert.equal(typeof scope.scope.name, "string");
  for (const span of scope.spans) {
    assert.match(span.traceId, /^[0-9a-f]{32}$/);
    assert.match(span.spanId, /^[0-9a-f]{16}$/);
    assert.equal(typeof span.name, "string");
    assert.equal(typeof span.kind, "number");
    assert.match(span.startTimeUnixNano, /^\d+$/);
    assert.match(span.endTimeUnixNano, /^\d+$/);
    assert.equal(typeof span.status.code, "number");
    for (const attribute of span.attributes) {
      assert.equal(typeof attribute.key, "string");
      const keys = Object.keys(attribute.value);
      assert.equal(keys.length, 1);
      assert.ok(["stringValue", "intValue", "boolValue"].includes(keys[0]));
    }
  }
}

const sampleSpans = () => {
  const started = "2026-09-16T10:00:00.000Z", ended = "2026-09-16T10:00:02.500Z";
  return [
    { traceId: "a".repeat(32), spanId: "b".repeat(16), parentSpanId: "", runId: "r1", owner: "local",
      kind: "run", name: "branch.run", startedAt: started, endedAt: ended, status: "ok", message: "",
      attributes: { "branch.tokens.input": 120, "branch.run.source": "owner", "branch.dry": false } },
    { traceId: "a".repeat(32), spanId: "c".repeat(16), parentSpanId: "b".repeat(16), runId: "r1", owner: "local",
      kind: "tool", name: "tool files.write", startedAt: started, endedAt: ended, status: "error",
      message: "it did not work", attributes: { "branch.tool.name": "files.write" } },
  ];
};

test("T2: the three destinations each produce the documented shape from one span model", () => {
  const rows = sampleSpans();
  const otlp = spansToOtlp(rows, { name: "branch-agent", version: "0.12.0" });
  assertOtlpShape(otlp);
  const spans = otlp.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 2);
  assert.equal(spans[1].parentSpanId, spans[0].spanId, "the tree survives the conversion");
  assert.equal(spans[1].status.code, 2, "a failed span is a failed span");
  assert.equal(spans[0].endTimeUnixNano, String(BigInt(Date.parse(rows[0].endedAt)) * 1000000n));

  const langfuse = spansToLangfuse(rows, { name: "branch-agent", version: "0.12.0" });
  assert.ok(Array.isArray(langfuse.batch));
  assert.equal(langfuse.batch[0].type, "trace-create", "the top span becomes the trace");
  assert.equal(langfuse.batch[0].body.id, rows[0].traceId);
  const observations = langfuse.batch.filter((entry) => entry.type === "span-create");
  assert.equal(observations.length, 2);
  assert.equal(observations[1].body.parentObservationId, rows[0].spanId);
  assert.equal(observations[1].body.level, "ERROR");
  assert.equal(observations[1].body.statusMessage, "it did not work");

  const langsmith = spansToLangsmith(rows, "branch-agent");
  assert.equal(langsmith.post.length, 2);
  assert.match(langsmith.post[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(langsmith.post[0].parent_run_id, undefined, "the top run has no parent");
  assert.equal(langsmith.post[1].parent_run_id, langsmith.post[0].id);
  assert.equal(langsmith.post[1].run_type, "tool");
  assert.equal(langsmith.post[1].error, "it did not work");
});

test("T2: sending is off out of the box, refuses a half-filled setting, and is audited when on", async (t) => {
  const { app } = await fixture(t);
  const owner = app.runtime.owner;
  assert.equal(traceExportSettings(app.store, owner).enabled, false, "nothing is sent until the owner says so");
  assert.equal(traceExportSettings(app.store, owner).endpoint, "");
  assert.throws(() => saveTraceExportSettings(app.store, owner, { enabled: true }), /address/);
  assert.throws(() => saveTraceExportSettings(app.store, owner, { endpoint: "ftp://nope" }), /http/);
  // With it off, even asking to send does nothing at all.
  const silent = await app.traceExport.sendSpans(sampleSpans());
  assert.deepEqual(silent, []);
  const before = app.store.audit.list(owner, { action: "data.exported" }).length;

  const collector = await fakeCollector(t);
  saveTraceExportSettings(app.store, owner, { enabled: true, endpoint: collector.url, destination: "otlp" });
  const results = await app.traceExport.sendSpans(sampleSpans());
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true, results[0].error ?? "");
  assert.equal(collector.seen[0].path, "/v1/traces", "OTLP goes where OTLP goes");
  assertOtlpShape(collector.seen[0].body);
  const after = app.store.audit.list(owner, { action: "data.exported" });
  assert.equal(after.length, before + 1, "every send is written down");
  assert.match(after[0].subject, /2 span\(s\) to 127\.0\.0\.1/);
  assert.equal(after[0].outcome, "sent");
});

test("T2: sends are batched and tried again, and the key in a header is never in a log", async (t) => {
  const { app } = await fixture(t);
  const owner = app.runtime.owner;
  const key = "lf-secret-key-do-not-print";
  await app.store.secrets.put(owner, "default", "LANGFUSE_KEY", key);
  const collector = await fakeCollector(t, { failFirst: 2 });
  saveTraceExportSettings(app.store, owner, {
    enabled: true, endpoint: collector.url, destination: "otlp", batchSize: 1, retries: 2,
    headers: { "x-api-key": "secret://default/LANGFUSE_KEY" },
  });
  const results = await app.traceExport.sendSpans(sampleSpans());
  assert.equal(results.length, 2, "two spans at one per batch is two sends");
  assert.equal(results[0].attempts, 3, "it was tried again after each refusal");
  assert.equal(results[0].ok, true);
  assert.equal(collector.seen[0].headers["x-api-key"], key, "the real key reached the endpoint");
  assert.equal(collector.seen.length, 4, "three tries for the first batch and one for the second");
  // The key is never in the settings, the audit, the events or the result.
  const saved = JSON.stringify(traceExportSettings(app.store, owner));
  assert.ok(saved.includes("secret://default/LANGFUSE_KEY"));
  assert.ok(!saved.includes(key), "the settings hold the reference, never the value");
  assert.ok(!JSON.stringify(app.store.audit.list(owner, { limit: 50 })).includes(key));
  assert.ok(!JSON.stringify(results).includes(key));

  // A dead address fails plainly and is written down as a failure rather than swallowed.
  saveTraceExportSettings(app.store, owner, { enabled: true, endpoint: "http://127.0.0.1:1/v1/traces", retries: 0 });
  const failed = await app.traceExport.sendSpans(sampleSpans());
  assert.equal(failed[0].ok, false);
  assert.ok(failed[0].error);
  assert.equal(app.store.audit.list(owner, { action: "data.exported" })[0].outcome, "failed");
});

test("T2: a finished task sends its own steps, and crashes go too when asked for", async (t) => {
  const { app } = await fixture(t, [calls(write("c1", "sent.txt", "x")), say("done")]);
  const collector = await fakeCollector(t);
  const owner = app.runtime.owner;
  // While sending is off, a finished task sends nothing at all.
  const quiet = await app.runtime.run({ prompt: "write it" });
  assert.equal(collector.seen.length, 0);
  assert.ok(!app.store.events(quiet.id).some((event) => event.kind.startsWith("trace.sent")));

  saveTraceExportSettings(app.store, owner, { enabled: true, endpoint: collector.url, includeErrors: true });
  // One recorded crash, of the kind an uncaught failure in the engine leaves behind.
  app.store.spans.begin({
    traceId: "e".repeat(32), spanId: "f".repeat(16), parentSpanId: "", runId: "", owner,
    kind: "error", name: "branch.uncaught_error", startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(), status: "error", message: "Error: something gave way",
    attributes: { "exception.type": "Error" },
  });
  app.runtime.models.default.provider.reset();
  const run = await app.runtime.run({ prompt: "write it again" });
  for (let i = 0; i < 40 && !collector.seen.length; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(collector.seen.length > 0, "the task's steps went out on their own");
  const sent = collector.seen[0].body.resourceSpans[0].scopeSpans[0].spans;
  assert.ok(sent.some((span) => span.attributes.some((a) => a.key === "branch.run.id" && a.value.stringValue === run.id)));
  assert.ok(sent.some((span) => span.name === "branch.uncaught_error"), "the crash rode along, because it was asked for");
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(app.store.events(run.id).some((event) => event.kind === "trace.sent"), "and the task says so in its own timeline");
});

test("T2: a saved key inside a tool's request never reaches the steps that are sent out", async (t) => {
  const sentinel = "sk-live-never-export-4242";  // not-a-real-secret: a planted fixture, here to prove it gets blanked out
  const written = "every line of the file the assistant was told to write, which is no step's business";
  const { app } = await fixture(t, [calls(write("c1", "keys.txt", `${written} ${sentinel}`)), say("done")]);
  const owner = app.runtime.owner;
  await app.store.secrets.put(owner, "default", "API_KEY", sentinel);
  const collector = await fakeCollector(t);
  saveTraceExportSettings(app.store, owner, { enabled: true, endpoint: collector.url });

  const run = await app.runtime.run({ prompt: "write the key down" });
  for (let i = 0; i < 40 && !collector.seen.length; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(collector.seen.length > 0, "the finished task's steps went out, so there is something to check");
  const rows = app.store.spans.forRun(run.id);
  assert.ok(rows.length >= 3, "the task, its model round and its tool call were all recorded");
  assert.ok(rows.some((span) => span.kind === "tool"), "the tool call itself is one of them");

  // The body that actually went down the wire, and the body the builder makes on its own.
  for (const [what, body] of [["what was sent", collector.seen[0].body],
    ["what the builder makes", spansToOtlp(rows, { name: "branch-agent", version: "0.0.0" })]]) {
    const text = JSON.stringify(body);
    assert.ok(text.includes(run.id), `${what} is really this task's steps`);
    assert.ok(!text.includes(sentinel), `${what} does not carry the saved key`);
    assert.ok(!text.includes(written), `${what} does not carry what the tool was asked to write`);
    assert.ok(!text.includes("keys.txt"), `${what} does not carry the tool's arguments at all`);
  }
  // And the same is true of the two other shapes, which read the same attributes.
  for (const shape of [spansToLangfuse(rows, { name: "b", version: "0" }), spansToLangsmith(rows, "b")]) {
    const text = JSON.stringify(shape);
    assert.ok(!text.includes(sentinel) && !text.includes(written), "neither does Langfuse's shape or LangSmith's");
  }
});

test("T2: a collector on this computer is refused until private addresses are allowed", async (t) => {
  const { app } = await fixture(t, [say("ok")], { web: {} });
  const collector = await fakeCollector(t);
  saveTraceExportSettings(app.store, app.runtime.owner, { enabled: true, endpoint: collector.url, retries: 2 });
  const results = await app.traceExport.sendSpans(sampleSpans());
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /private|local/i, "the address rules refuse it, like every other outbound call");
  assert.equal(results[0].attempts, 1, "an address that is not allowed is not tried again and again");
  assert.match(results[0].error, /Allow private addresses/,
    "and the refusal says which switch to flip rather than leaving the owner to guess");
});

test("T1: a second person's profile cannot read the owner's steps or rules", async (t) => {
  const { app, api } = await served(t, [calls(write("c1", "private.txt", "x")), say("done")]);
  const run = (await api("POST", "/api/run", { prompt: "write it" })).body;
  assert.ok(app.store.spans.forRun(run.id).length > 0, "the owner's task left steps behind");
  const made = await api("POST", "/api/profiles", { name: "Sam", pin: "4321" });
  assert.equal((await api("POST", "/api/profiles/switch", { profileId: made.body.id, pin: "4321" })).body.active.name, "Sam");

  for (const path of ["/api/tracing/spans", `/api/tracing/spans?run=${run.id}`, "/api/rules", "/api/tracing/settings"]) {
    const refused = await api("GET", path);
    assert.equal(refused.status, 400, `${path} is not Sam's to read`);
    assert.match(refused.body.error, /belongs to the owner/);
  }
  assert.equal((await api("POST", "/api/rules/add",
    { tool: "*", decision: "allow", resource: { kind: "path", pattern: "*" } })).status, 400,
  "nor may Sam loosen the owner's rules");
  // Q261: reading fails closed for a household person at the window, and the window never asks what a conversation
  // is allowed, so this read is refused to Sam in the one sentence too.
  const mine = await api("GET", "/api/rules/allowed?session=" + run.sessionId);
  assert.equal(mine.status, 400, "a read not in householdReads");
  assert.match(mine.body.error, /belongs to the owner/);
  await api("POST", "/api/profiles/switch", { profileId: null });
  assert.equal((await api("GET", "/api/rules")).status, 200, "the owner reads them as before");
});

// --------------------------------------------------------------- T3: counters

test("T3: the counters page is Prometheus text behind the local key", async (t) => {
  const { app, api, server } = await served(t, [calls(write("c1", "counted.txt", "x")), say("done")]);
  await api("POST", "/api/run", { prompt: "write it" });
  const page = await api("GET", "/api/metrics");
  assert.equal(page.status, 200);
  const values = parsePrometheus(page.text);
  assert.ok(values.branch_runs_total >= 1, "the task was counted");
  assert.equal(values.branch_runs_running, 0);
  assert.ok(values.branch_tool_calls_total >= 1);
  assert.ok(values.branch_spans_total >= 1, "the spans are counted too");
  assert.ok(page.text.includes("# TYPE branch_runs_total counter"));
  assert.ok(page.text.includes('branch_tool_duration_seconds_bucket{le="+Inf"}'));
  assert.ok(page.text.includes("branch_tool_duration_seconds_count"));
  // Every line is either a comment or a name and a number: that is the whole format.
  for (const row of page.text.trim().split("\n"))
    assert.ok(row.startsWith("#") || /^[a-z_]+(\{[^}]*\})? -?[\d.e+-]+$/i.test(row), `unreadable line: ${row}`);
  // Without the key it is refused like everything else.
  const refused = await fetch(server.url + "/api/metrics", { headers: { host: new URL(server.url).host } });
  assert.equal(refused.status, 401);
});

test("T3: the histogram counts durations into its buckets", () => {
  const counted = histogram([0.05, 0.4, 3, 45, 200]);
  assert.equal(counted.count, 5);
  assert.equal(counted.buckets.find((b) => b.le === 0.1).count, 1);
  assert.equal(counted.buckets.find((b) => b.le === 0.5).count, 2);
  assert.equal(counted.buckets.find((b) => b.le === 60).count, 4, "200 seconds is past every bucket");
  const text = prometheusText({ points: [{ name: "branch_x_total", description: "x", unit: "1", value: 3 }], toolLatency: counted });
  assert.equal(parsePrometheus(text).branch_x_total, 3);
});

test("T3: the counters read from a database that has no spans table yet", async (t) => {
  const { app } = await fixture(t);
  app.store.sqlite.exec("DROP TABLE spans");
  const snapshot = collectMetrics(app.store.sqlite, app.runtime.owner, 1.25);
  assert.equal(snapshot.points.find((p) => p.name === "branch_spans_total").value, 0, "a missing table counts as nothing");
  assert.equal(snapshot.points.find((p) => p.name === "branch_cost_usd_total").value, 1.25);
});

// ------------------------------------------------- T4: there is no telemetry

test("T4: the promise that nothing is collected is written where the owner reads it", async (t) => {
  const { app, api } = await served(t);
  const bundle = (await api("POST", "/api/diagnostics/bundle", {})).body;
  assert.ok(bundle.files.includes("spans.json"), "the last steps travel with the folder, scrubbed");
  const { readFile } = await import("node:fs/promises");
  const promise = await readFile(join(bundle.folder, "README.txt"), "utf8");
  assert.match(promise, /sends no usage data to anyone/);
  assert.match(promise, /no "anonymous statistics" setting to switch\s*\n?off/);
  assert.match(promise, /never will be/);
  const docs = await readFile(new URL("../docs/configuration.md", import.meta.url), "utf8");
  assert.match(docs, /There is no telemetry, and there never will be/);
  assert.match(docs, /nothing is ever\s*\n?collected in the first place/);
  const spans = JSON.parse(await readFile(join(bundle.folder, "spans.json"), "utf8"));
  assert.ok(Array.isArray(spans.spans));
});

// ------------------------------------------------ P1: rules about one thing

test("P1: a rule can be about a folder, a website or a command, and says so as a sentence", () => {
  assert.equal(pathMatches("finance", "finance/2026/q1.xlsx"), true, "a folder covers what is inside it");
  assert.equal(pathMatches("finance", "financial-notes.txt"), false, "and nothing that merely starts the same");
  assert.equal(pathMatches("/finance", "finance\\2026\\q1.xlsx"), true, "slashes either way, leading slash or not");
  assert.equal(hostMatches("example.com", "shop.example.com"), true);
  assert.equal(hostMatches("example.com", "notexample.com"), false);
  assert.equal(hostMatches("*.example.com", "shop.example.com"), true);

  assert.deepEqual(resourceOf("files.write", "files.write", "finance/a.txt", { path: "finance/a.txt" }),
    { kind: "path", value: "finance/a.txt" });
  assert.deepEqual(resourceOf("browser.click", "browser.interact", "shop.example.com", { name: "Buy" }),
    { kind: "host", value: "shop.example.com" });
  // Wave mac3 (tool-safety): the whole command is kept, so a rule can name the program or one of its actions.
  assert.deepEqual(resourceOf("shell.execute", "shell.execute", "rm -rf build", { executable: "rm" }),
    { kind: "command", value: "rm -rf build" }, "a command rule is about the command being run");
  assert.equal(resourceMatches({ kind: "command", pattern: "rm" }, resourceOf("shell.execute", "shell.execute", "/bin/rm -rf build", {}), "deny"), true,
    "a refusal naming the program still covers it, from any folder");
  // Integration review (mac3/tool-safety): an allow does not, since `/tmp/rm` is not the program said yes to.
  assert.equal(resourceMatches({ kind: "command", pattern: "rm" }, resourceOf("shell.execute", "shell.execute", "/tmp/rm -rf build", {})), false);
  assert.equal(resourceOf("files.write", "files.write", "", {}), null, "nothing to be about is not a resource");
  // A tool that says what it touches through its own target() has no top-level path, and is still
  // covered by a folder rule: the target's shape decides, not the arguments.
  assert.deepEqual(resourceOf("media.image", "media.write", "media/poster.png", { prompt: "a poster", save: "poster.png" }),
    { kind: "path", value: "media/poster.png" });
  assert.deepEqual(resourceOf("agents.ask", "agents.ask", "ada.example.com", { agent: "Ada" }),
    { kind: "host", value: "ada.example.com" }, "a bare host name is a website wherever it came from");

  assert.equal(
    ruleSentence({ tool: "files.write", match: "*", applies: "any", decision: "ask", resource: { kind: "path", pattern: "finance" } }),
    "Ask before writing files under finance.");
  assert.equal(
    ruleSentence({ tool: "browser.*", match: "*", applies: "any", decision: "deny", resource: { kind: "host", pattern: "example.com" } }),
    "Never allow browsing example.com.");
  assert.equal(
    ruleSentence({ tool: "shell.execute", match: "*", applies: "any", decision: "deny", resource: { kind: "command", pattern: "rm" } }),
    "Never allow running commands named rm.");
  assert.equal(ruleSentence({ tool: "*", match: "*", applies: "changes", decision: "ask" }), "Ask before changing anything.");
});

test("P1: a rule about one thing beats the broad ones, and old rule lists decide as they did", () => {
  const policy = PolicySchema.parse({
    preset: "custom",
    rules: [
      { tool: "*", decision: "allow" },
      { tool: "files.write", decision: "deny", resource: { kind: "path", pattern: "finance" } },
    ],
  });
  // The narrow rule is second in the list, yet it decides: naming a thing puts it in front.
  assert.equal(evaluatePolicy(policy, { tool: "files.write", target: "finance/q1.xlsx", readOnly: false,
    resource: { kind: "path", value: "finance/q1.xlsx" } }).decision, "deny");
  assert.equal(evaluatePolicy(policy, { tool: "files.write", target: "notes.txt", readOnly: false,
    resource: { kind: "path", value: "notes.txt" } }).decision, "allow", "elsewhere the broad rule still applies");
  // A rule about a website never fires on a path, whatever the pattern looks like.
  assert.equal(evaluatePolicy(PolicySchema.parse({ rules: [{ tool: "*", decision: "deny", resource: { kind: "host", pattern: "finance" } }] }),
    { tool: "files.write", target: "finance/q1.xlsx", readOnly: false, resource: { kind: "path", value: "finance/q1.xlsx" } }).decision,
    "allow", "a website rule is not a folder rule");
  // Every rule written before this existed still decides exactly as it did.
  const legacy = PolicySchema.parse({ rules: [
    { tool: "files.write", match: "notes/*", decision: "allow" },
    { tool: "files.*", decision: "deny" },
    { tool: "*", decision: "ask" },
  ] });
  assert.equal(evaluatePolicy(legacy, { tool: "files.write", target: "notes/a.txt", readOnly: false }).decision, "allow");
  assert.equal(evaluatePolicy(legacy, { tool: "files.write", target: "other.txt", readOnly: false }).decision, "deny");
  assert.equal(evaluatePolicy(legacy, { tool: "shell.execute", target: "git status", readOnly: false }).decision, "ask");
  assert.deepEqual(presetRules("ask-before-changes")[0],
    { tool: "*", match: "*", applies: "changes", decision: "ask", remember: "session" },
    "a preset rule still has exactly the shape it had, with no resource field");
});

test("P1: a folder rule really stops a real task, and the sentences and test box are served", async (t) => {
  const { app, api } = await served(t, [calls(write("c1", "finance/q1.txt", "money")), say("done")]);
  await api("POST", "/api/rules/add", { tool: "files.write", decision: "deny", resource: { kind: "path", pattern: "finance" } });
  const listed = (await api("GET", "/api/rules")).body;
  assert.equal(listed.rules.length, 1);
  assert.equal(listed.rules[0].sentence, "Never allow writing files under finance.");
  const tried = (await api("POST", "/api/rules/test", { tool: "files.write", target: "finance/q1.txt" })).body;
  assert.equal(tried.decision, "deny");
  assert.equal(tried.because, "Never allow writing files under finance.");
  const elsewhere = (await api("POST", "/api/rules/test", { tool: "files.write", target: "notes.txt" })).body;
  assert.equal(elsewhere.decision, "allow");
  assert.match(elsewhere.because, /No rule covers this/);
  const run = (await api("POST", "/api/run", { prompt: "write the figures" })).body;
  assert.equal(run.status, "completed");
  assert.ok(app.store.events(run.id).some((event) => event.kind === "policy.denied"), "the write was refused by the rule");
  const { readFile } = await import("node:fs/promises");
  await assert.rejects(readFile(join(app.runtime.workspace, "finance", "q1.txt"), "utf8"), /ENOENT/);
  const removed = (await api("POST", "/api/rules/remove", { index: 0 })).body;
  assert.equal(removed.rules.length, 0);
  assert.equal((await api("POST", "/api/rules/remove", { index: 0 })).status, 404);
});

test("P5: a browser action goes through the same rules, with the website as the thing", async (t) => {
  const { z } = await import("zod");
  const { app, api } = await served(t, [calls({ id: "c1", name: "browser.click", arguments: JSON.stringify({ name: "Buy" }) }), say("done")]);
  app.registry.register({
    name: "browser.click", permission: "browser.interact", description: "click",
    parameters: z.object({ name: z.string() }).strict(),
    execute: async () => ({ clicked: true }),
    target: () => "shop.example.org",
  });
  await api("POST", "/api/rules/add", { tool: "browser.*", decision: "deny", resource: { kind: "host", pattern: "example.org" } });
  const run = (await api("POST", "/api/run", { prompt: "buy it" })).body;
  assert.equal(run.status, "completed");
  const denied = app.store.events(run.id).find((event) => event.kind === "policy.denied");
  assert.ok(denied, "clicking on that site was refused by the host rule, not by a second mechanism");
  assert.equal(denied.data.target, "shop.example.org");
  const other = (await api("POST", "/api/rules/test", { tool: "browser.click", target: "other.example.net" })).body;
  assert.equal(other.decision, "allow", "a different website is untouched");
});

// ------------------------------------- P2 and P3: grants and the exact bytes

test("P2: a yes for this conversation has an end, is listed, and goes when Branch locks", async (t) => {
  const gate = new ApprovalGate();
  gate.remember("s1", "files.write", "notes.txt", "allow", { label: "Writing notes.txt" });
  assert.equal(gate.answer("s1", "files.write", "notes.txt"), "allow");
  const grants = gate.grants("s1");
  assert.equal(grants.length, 1);
  assert.equal(grants[0].label, "Writing notes.txt");
  assert.ok(Date.parse(grants[0].expiresAt) > Date.now(), "it says when it runs out");
  assert.ok(Date.parse(grants[0].expiresAt) - Date.parse(grants[0].grantedAt) > 0);
  gate.forget("s1");
  assert.equal(gate.answer("s1", "files.write", "notes.txt"), undefined, "it ends with the conversation");

  const { app, api } = await served(t, [calls(write("c1", "notes.txt", "one")), say("done")]);
  await api("POST", "/api/policy", { preset: "ask-before-changes" });
  const paused = (await api("POST", "/api/run", { prompt: "write notes" })).body;
  assert.equal(paused.status, "needs_input");
  await api("POST", "/api/policy/approve", { sessionId: paused.sessionId, fingerprint: shownFingerprint(app, paused.sessionId), decision: "allow", remember: "session" });
  const allowed = (await api("GET", `/api/rules/allowed?session=${paused.sessionId}`)).body;
  assert.equal(allowed.grants.length, 1, "the conversation can say what it is allowed to do right now");
  assert.equal(allowed.grants[0].tool, "files.write");
  assert.ok(allowed.grants[0].expiresAt);
  // Locking Branch ends every standing yes, in every conversation.
  await api("POST", "/api/lock", { lock: true });
  assert.equal((await api("GET", `/api/rules/allowed?session=${paused.sessionId}`)).body.grants.length, 0);
});

test("P3: a yes is bound to the exact bytes, so a changed command has to ask again", async (t) => {
  assert.equal(argumentFingerprint('{"a":1}'), argumentFingerprint('{"a":1}'));
  assert.notEqual(argumentFingerprint('{"a":1}'), argumentFingerprint('{"a":2}'));
  assert.match(argumentFingerprint("x"), /^[a-f0-9]{32}$/);
  const gate = new ApprovalGate();
  gate.remember("s1", "shell.execute", "git status", "allow", { fingerprint: "aaaa" });
  assert.equal(gate.answer("s1", "shell.execute", "git status", "aaaa"), "allow");
  assert.equal(gate.answer("s1", "shell.execute", "git status", "bbbb"), undefined, "different bytes, no answer");

  const command = (id, args) => ({ id, name: "shell.execute", arguments: JSON.stringify(args) });
  const { app, api, provider } = await served(t, [calls(command("c1", { executable: "git", args: ["status"] })), say("done")]);
  const { z } = await import("zod");
  app.registry.register({
    name: "shell.execute", permission: "shell.execute", description: "run a command",
    parameters: z.object({ executable: z.string(), args: z.array(z.string()).default([]) }).strict(),
    execute: async () => ({ ok: true }),
  });
  await api("POST", "/api/policy", { preset: "ask-before-changes" });
  const paused = (await api("POST", "/api/run", { prompt: "check the repo" })).body;
  assert.equal(paused.status, "needs_input");
  const waiting = (await api("GET", "/api/policy")).body.waiting[0];
  assert.ok(waiting.bytes, "the person is shown the exact request");
  assert.equal(waiting.bytes, JSON.stringify({ executable: "git", args: ["status"] }));
  assert.equal(waiting.fingerprint, argumentFingerprint(waiting.bytes));
  // An answer meant for a different request is refused rather than landing on this one.
  const wrong = await api("POST", "/api/policy/approve",
    { sessionId: paused.sessionId, decision: "allow", remember: "session", fingerprint: "f".repeat(32) });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /different request/);
  const right = await api("POST", "/api/policy/approve",
    { sessionId: paused.sessionId, decision: "allow", remember: "session", fingerprint: waiting.fingerprint });
  assert.equal(right.status, 200);

  // The very same command runs without asking again.
  provider.reset();
  const same = (await api("POST", "/api/run", { prompt: "again", sessionId: paused.sessionId })).body;
  assert.equal(same.status, "completed", same.output);
});

test("P3: same tool, same target, different bytes — the old yes does not cover it", async (t) => {
  // files.write reports the path as its target, so the grant key is identical either way. Only the
  // fingerprint of the exact bytes tells the two calls apart, which is what this proves.
  const first = [calls(write("c1", "notes.txt", "one")), say("done")];
  const second = [calls(write("c2", "notes.txt", "two")), say("done")];
  let script = first, at = 0;
  const provider = {
    name: "scripted",
    async complete() { return script[Math.min(at++, script.length - 1)](); },
  };
  const root = await mkdtemp(join(tmpdir(), "branch-bytes-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); await app.close(); await discardTemp(root); });
  const api = async (method, path, body) => {
    const response = await fetch(server.url + path, {
      method, headers: { authorization: `Bearer ${server.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  await api("POST", "/api/policy", { preset: "ask-before-changes" });
  const paused = (await api("POST", "/api/run", { prompt: "write notes" })).body;
  assert.equal(paused.status, "needs_input");
  const asked = (await api("GET", "/api/policy")).body.waiting[0];
  assert.equal(asked.target, "notes.txt");
  await api("POST", "/api/policy/approve", { sessionId: paused.sessionId, fingerprint: shownFingerprint(app, paused.sessionId), decision: "allow", remember: "session" });
  at = 0;
  const repeat = (await api("POST", "/api/run", { prompt: "write notes", sessionId: paused.sessionId })).body;
  assert.equal(repeat.status, "completed", "the identical write is not asked about again");

  script = second; at = 0;
  const changed = (await api("POST", "/api/run", { prompt: "write it differently", sessionId: paused.sessionId })).body;
  assert.equal(changed.status, "needs_input", "the same file with different contents is a new question");
  const again = (await api("GET", "/api/policy")).body.waiting[0];
  assert.equal(again.target, "notes.txt", "the target is the same, so only the bytes told them apart");
  assert.notEqual(again.fingerprint, asked.fingerprint);
});

test("P3: the question, its exact bytes and its fingerprint reach a phone over the socket", async (t) => {
  const { app, api, server } = await served(t, [calls(write("c1", "over-the-wire.txt", "x")), say("done")]);
  await api("POST", "/api/policy", { preset: "ask-before-changes" });
  const paused = (await api("POST", "/api/run", { prompt: "write it" })).body;
  assert.equal(paused.status, "needs_input");
  const messages = await readSocket(server, paused.id);
  const question = messages.find((message) => message.kind === "policy.ask");
  assert.ok(question, "the question itself travels over the socket");
  assert.equal(question.data.name, "files.write");
  assert.equal(question.data.target, "over-the-wire.txt");
  assert.equal(question.data.bytes, JSON.stringify({ path: "over-the-wire.txt", content: "x" }),
    "the exact bytes, cleaned of anything saved, go with it");
  assert.equal(question.data.fingerprint, argumentFingerprint(question.data.bytes));
  assert.ok(messages.some((message) => message.kind === "end"), "the socket closes when the task stops");
  // A client that read the socket can answer with what it was shown, and the binding accepts it.
  const answered = await api("POST", "/api/policy/approve",
    { sessionId: paused.sessionId, decision: "allow", remember: "session", fingerprint: question.data.fingerprint });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.fingerprint, question.data.fingerprint);
  assert.ok(app.store.events(paused.id).some((event) => event.kind === "policy.ask"));
});

/** Opens the run socket the way a phone would and reads every message until it ends. */
async function readSocket(server, runId) {
  const { connect } = await import("node:net");
  const { createHash, randomBytes } = await import("node:crypto");
  const { readFrame } = await import("../dist/ws.js");
  const url = new URL(server.url);
  const key = randomBytes(16).toString("base64");
  const socket = connect(Number(url.port), url.hostname);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write([
    `GET /api/runs/${runId}/ws HTTP/1.1`, `Host: ${url.host}`, "Upgrade: websocket", "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`, "Sec-WebSocket-Version: 13", `Sec-WebSocket-Protocol: bearer, ${server.token}`, "", "",
  ].join("\r\n"));
  const messages = [];
  await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0), upgraded = false;
    const finish = () => { socket.destroy(); resolve(); };
    const timer = setTimeout(finish, 8000);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const at = buffer.indexOf("\r\n\r\n");
        if (at < 0) return;
        const head = buffer.subarray(0, at).toString("utf8");
        if (!head.startsWith("HTTP/1.1 101")) { clearTimeout(timer); socket.destroy(); reject(new Error(head)); return; }
        assert.ok(head.includes(createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64")));
        buffer = buffer.subarray(at + 4);
        upgraded = true;
      }
      for (let frame = readFrame(buffer); frame; frame = readFrame(buffer)) {
        buffer = buffer.subarray(frame.consumed);
        if (frame.opcode !== 0x1) continue;
        const message = JSON.parse(frame.payload.toString("utf8"));
        messages.push(message);
        if (message.kind === "end") { clearTimeout(timer); finish(); return; }
      }
    });
    socket.on("error", () => { clearTimeout(timer); resolve(); });
    socket.on("close", () => { clearTimeout(timer); resolve(); });
  });
  return messages;
}

// ----------------------------------------------------- P4: wrong keys counted

test("P4: wrong keys are counted per place, then made to wait, and written down", async (t) => {
  const limiter = new AuthLimiter({ attempts: 3, lockoutMs: 1000, windowMs: 10000 });
  assert.equal(limiter.waitMs("1.2.3.4", 0), 0);
  assert.equal(limiter.fail("1.2.3.4", 0).until, null);
  assert.equal(limiter.fail("1.2.3.4", 1).until, null);
  assert.equal(limiter.fail("1.2.3.4", 2).until, 1002, "the third wrong try starts the wait");
  assert.ok(limiter.refusal("1.2.3.4", "key", 3));
  assert.equal(limiter.refusal("5.6.7.8", "key", 3), null, "another place is unaffected");
  limiter.succeed("1.2.3.4");
  assert.equal(limiter.refusal("1.2.3.4", "key", 3), null, "a correct key clears the count at once");

  const { app, server } = await served(t, [say("ok")], { server: { authLimits: { attempts: 3, lockoutMs: 60000 } } });
  const host = new URL(server.url).host;
  const tryKey = (key) => fetch(server.url + "/api/state", { headers: { authorization: `Bearer ${key}`, host } });
  const wrong = "0".repeat(64);
  assert.equal((await tryKey(wrong)).status, 401);
  assert.equal((await tryKey(wrong)).status, 401);
  assert.equal((await tryKey(wrong)).status, 401);
  const locked = await tryKey(wrong);
  assert.equal(locked.status, 429, "after three wrong keys that place is made to wait");
  assert.match((await locked.json()).error, /Too many wrong tries/);
  const entry = app.store.audit.list(app.runtime.owner, { action: "auth.refused" })[0];
  assert.ok(entry, "the lockout is written into the record under its own heading");
  assert.match(entry.reason, /wrong tries in a row/);
  assert.equal(entry.outcome, "refused");
  assert.equal(entry.source, "system");
  assert.ok(app.store.audit.counts(app.runtime.owner).some((row) => row.action === "auth.refused" && row.count === 1));
  // The owner's own key is checked first, so a wait can never shut them out of their own app.
  assert.equal((await tryKey(server.token)).status, 200, "the right key still works, and clears the count");
  assert.equal((await tryKey(wrong)).status, 401, "and the count really started again");
});

// ------------------------------------------------------- the store underneath

test("spans are kept, read back and pruned without touching the events", async (t) => {
  const { app } = await fixture(t);
  const spans = app.store.spans;
  assert.ok(spans instanceof SpanStore);
  const tracer = new Tracer(spans, "local");
  const open = tracer.startRun("r-keep", "branch.run", { "branch.note": "kept" });
  const child = tracer.start("r-keep", "tool", "tool files.read", {});
  child.end("ok");
  child.end("error", "this second end changes nothing");
  open.end("ok");
  const rows = spans.forRun("r-keep");
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.kind === "tool").status, "ok", "a span is closed once");
  assert.equal(spans.forTrace(open.traceId).length, 2);
  assert.equal(spans.get(open.spanId).attributes["branch.note"], "kept");
  assert.equal(spans.recent("local", 10).length >= 2, true);
  assert.equal(spans.since("local", "1970-01-01T00:00:00.000Z").length >= 2, true);
  for (let i = 0; i < 5; i++) tracer.startRun(`r-${i}`, "branch.run", {}).end("ok");
  assert.ok(spans.prune("local", 3) > 0, "old spans are dropped so the table cannot grow for ever");
  assert.equal(spans.recent("local", 100).length, 3);
  assert.equal(tracer.current("r-keep").traceId, open.traceId);
  tracer.forget("r-keep");
  assert.equal(tracer.current("r-keep"), null);
  assert.equal(tracer.start("r-keep", "tool", "nothing", {}), null, "a forgotten task writes no more spans");
});
