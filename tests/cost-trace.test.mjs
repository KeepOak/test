import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { discardTemp } from "./temp-dir.mjs";
import { UsageStore } from "../dist/usage.js";
import { estimateCost, formatCost, normalizeModelId, pricedAt } from "../dist/pricing.js";
import { buildTraceDocument, resolveTraceFolder, traceRoots, saveTraceSettings, writeRunTrace } from "../dist/trace.js";
import { redactEvent, scrubText, writeDiagnosticsBundle } from "../dist/diagnostics.js";
import { createBranch } from "../dist/index.js";
import { startServer } from "../dist/server.js";

/** A key that must never survive into a diagnostics folder. */
const fixtureKey = "sk-testonly0000ZZZZ1111secretvalue";  // not-a-real-secret: a planted fixture, here to prove it gets blanked out

async function scratch(t, label) {
  const base = join(tmpdir(), "Codex-session-files");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, `branch-${label}-`));
  t.after(() => discardTemp(root));
  return root;
}

function schema(db) {
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE sessions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE tasks(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), owner TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, output TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'web');
    CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES tasks(id), kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE usage(run_id TEXT PRIMARY KEY REFERENCES tasks(id), estimated_input INTEGER NOT NULL DEFAULT 0, estimated_output INTEGER NOT NULL DEFAULT 0, reported_input INTEGER NOT NULL DEFAULT 0, reported_output INTEGER NOT NULL DEFAULT 0, reports INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, unreported_calls INTEGER NOT NULL DEFAULT 0, incomplete_calls INTEGER NOT NULL DEFAULT 0);
  `);
  return db;
}

/** Adds one finished task with tokens and a model.completed event naming `model`. */
function addRun(db, { id, session = "sess1", model, input = 1_000_000, output = 1_000_000, source = "web", status = "completed" }) {
  const now = new Date().toISOString();
  const exists = db.prepare("SELECT id FROM sessions WHERE id=?").get(session);
  if (!exists) db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(session, "owner", now);
  db.prepare("INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)").run(id, session, "owner", "test", status, "", now, now, source);
  db.prepare("INSERT INTO usage VALUES(?,?,?,?,?,?,?,?,?)").run(id, input, output, input, output, 1, 1, 0, 0);
  if (model)
    db.prepare("INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)")
      .run(id, "model.completed", JSON.stringify({ preset: `preset-${model}`, provider: "test", model }), now);
}

// ---------------------------------------------------------------- C1: prices

test("estimateCost: a price from the table, the owner's own price, and no price at all", () => {
  // A fixture model with an owner override, so the assertion never rots when a provider changes prices.
  const overrides = { "fixture-model": { input: 2, output: 10 } };
  const own = estimateCost("fixture-model", { input: 1_000_000, output: 500_000 }, overrides);
  assert.equal(own.confidence, "override");
  assert.equal(own.amount, 7);
  assert.equal(own.currency, "USD");

  const table = estimateCost("gpt-4o", { input: 1000, output: 1000 });
  assert.equal(table.confidence, "table");
  assert.ok(table.amount > 0, "a known model has a positive price");
  assert.match(table.note, new RegExp(pricedAt));

  const unknown = estimateCost("nobody-has-heard-of-this", { input: 10_000, output: 10_000 });
  assert.equal(unknown.confidence, "unknown");
  assert.equal(unknown.amount, null, "an unknown model never reports a number");
  assert.equal(formatCost(unknown), "no price on file");
});

test("estimateCost: a model running on this computer genuinely costs nothing", () => {
  const local = estimateCost("local-model", { input: 5_000_000, output: 5_000_000 });
  assert.equal(local.confidence, "table");
  assert.equal(local.amount, 0, "local models are free, which is not the same as unpriced");
});

test("model names are matched past a vendor prefix and a date suffix", () => {
  assert.equal(normalizeModelId("openai/GPT-4o"), "gpt-4o");
  assert.equal(normalizeModelId("claude-3-5-sonnet-20241022"), "claude-3-5-sonnet");
  assert.equal(estimateCost("claude-3-5-sonnet-20241022", { input: 1000, output: 0 }).confidence, "table");
});

test("aggregates never show an unpriced task as costing nothing", async (t) => {
  const root = await scratch(t, "cost-agg");
  const db = schema(new DatabaseSync(join(root, "t.db")));
  addRun(db, { id: "run-priced", model: "fixture-model", session: "s1", source: "web" });
  addRun(db, { id: "run-unknown", model: "a-model-with-no-price", session: "s2", source: "telegram" });
  const usage = new UsageStore(db);
  const [day] = usage.aggregateUsage("30d", "day", { "fixture-model": { input: 2, output: 10 } });

  assert.equal(day.runs, 2);
  assert.equal(day.pricedRuns, 1);
  assert.equal(day.unpricedRuns, 1);
  assert.equal(day.estimatedCost, 12, "one million in at $2 plus one million out at $10");

  const unpriced = day.presets.find((p) => p.id === "preset-a-model-with-no-price");
  assert.equal(unpriced.cost, null, "no price on file is null, never 0");
  const priced = day.presets.find((p) => p.id === "preset-fixture-model");
  assert.equal(priced.cost, 12);
  assert.equal(day.byConversation.find((c) => c.sessionId === "s1").cost, 12);
  assert.equal(day.byChannel.find((c) => c.source === "telegram").cost, null);
  db.close();
});

test("a task's cost is counted once, not once per model round", async (t) => {
  const root = await scratch(t, "cost-rounds");
  const db = schema(new DatabaseSync(join(root, "t.db")));
  addRun(db, { id: "run-multi", model: "fixture-model" });
  const now = new Date().toISOString();
  for (let i = 0; i < 4; i++)
    db.prepare("INSERT INTO events(run_id,kind,data,created_at) VALUES(?,?,?,?)")
      .run("run-multi", "model.completed", JSON.stringify({ preset: "preset-fixture-model", provider: "test", model: "fixture-model" }), now);
  const [day] = new UsageStore(db).aggregateUsage("30d", "day", { "fixture-model": { input: 2, output: 10 } });
  assert.equal(day.estimatedCost, 12, "five model rounds still cost one task's worth");
  db.close();
});

test("monthly figures carry money as well as tokens", async (t) => {
  const root = await scratch(t, "cost-month");
  const db = schema(new DatabaseSync(join(root, "t.db")));
  addRun(db, { id: "run-a", model: "fixture-model" });
  addRun(db, { id: "run-b", model: "unpriced-model" });
  const stats = new UsageStore(db).getMonthlyStats(10_000_000, { "fixture-model": { input: 2, output: 10 } });
  assert.equal(stats.currentMonthlyTokens, 4_000_000);
  assert.equal(stats.estimatedCost, 12);
  assert.equal(stats.unpricedRuns, 1);
  db.close();
});

// ------------------------------------------------- C2/C5: routes, CSV, tests

async function app(t, label) {
  const base = join(tmpdir(), "Codex-session-files");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, `branch-${label}-`));
  const branch = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data") });
  const server = await startServer(branch, { dataDir: join(root, "data"), port: 0 });
  // Close in this order, then remove the folder: the same order the other server tests use.
  t.after(async () => {
    await server.close();
    await branch.close();
    await discardTemp(root);
  });
  const call = async (path, body, raw = false) => {
    const response = await fetch(server.url + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + server.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = raw ? await response.text() : await response.json();
    return { status: response.status, value };
  };
  return { root, branch, server, call };
}

test("the usage screen, the spreadsheet file and a task all carry costs", async (t) => {
  const { branch, call } = await app(t, "cost-routes");
  const run = await branch.runtime.run({ prompt: "Write a greeting file" });

  const usage = await call("/api/usage?range=30d&by=day");
  assert.equal(usage.status, 200);
  assert.ok(usage.value.pricing.pricedAt, "the prices in use are named");
  assert.equal(typeof usage.value.stats.estimatedCost, "number");
  assert.equal(typeof usage.value.stats.unpricedRuns, "number");

  const csv = await call("/api/usage/export.csv?range=30d", undefined, true);
  const [header, ...rows] = csv.value.split("\n");
  assert.match(header, /estimatedCostUsd/, "the spreadsheet gains a cost column");
  assert.match(header, /runsWithoutPrice/);
  assert.equal(header.split(",").length, rows[0].split(",").length);

  const detail = await call(`/api/runs/${run.id}`);
  assert.ok(detail.value.cost, "a task reports what it probably cost");
  assert.equal(detail.value.cost.currency, "USD");
  const receipts = await call(`/api/runs/${run.id}/receipts`);
  assert.ok(receipts.value.cost, "the receipts view reports cost too");

  // The offline demonstration model has no price, so nothing may claim it was free.
  assert.equal(detail.value.cost.amount, null);
  assert.equal(detail.value.cost.display, "no price on file");
});

test("prices the owner types in are used, and a monthly limit may be money", async (t) => {
  const { call } = await app(t, "cost-settings");
  const saved = await call("/api/pricing", { overrides: { "demo-model": { input: 1, output: 2 } } });
  assert.equal(saved.status, 200);
  assert.equal((await call("/api/pricing")).value.overrides["demo-model"].input, 1);

  // The older tokens-only shape still saves, and a dollars-only limit is accepted too.
  assert.equal((await call("/api/usage/budget", { maxMonthlyTokens: 1000, pauseAtBudget: true })).status, 200);
  // Dropping the token limit for a dollar one takes a limit away, so it goes with the owner's yes (tests/loosening-caps.test.mjs).
  assert.equal((await call("/api/usage/budget", { maxMonthlyDollars: 5, pauseAtBudget: true })).status, 409);
  assert.equal((await call("/api/usage/budget", { maxMonthlyDollars: 5, pauseAtBudget: true, confirmLoosening: true })).status, 200);
  const empty = await call("/api/usage/budget", { pauseAtBudget: true });
  assert.equal(empty.status, 400, "a limit with no number is refused");
});

test("a dollar limit that is reached refuses new tasks in money", async (t) => {
  const { branch, call } = await app(t, "cost-refusal");
  // "demo" is the model id of the offline demonstration provider these tests run on.
  await call("/api/pricing", { overrides: { demo: { input: 1000, output: 1000 } } });
  await branch.runtime.run({ prompt: "Spend something" });
  await call("/api/usage/budget", { maxMonthlyDollars: 0.000001, pauseAtBudget: true });
  await assert.rejects(
    () => branch.runtime.run({ prompt: "One more" }),
    (error) => {
      assert.match(error.message, /Monthly budget reached/);
      assert.match(error.message, /\$/, "the refusal says the figure in dollars");
      return true;
    },
  );
});

test("a token limit that is reached mentions the dollars when a price is on file", async (t) => {
  const { branch, call } = await app(t, "cost-refusal-tokens");
  await call("/api/pricing", { overrides: { demo: { input: 1000, output: 1000 } } });
  await branch.runtime.run({ prompt: "Spend something" });
  await call("/api/usage/budget", { maxMonthlyTokens: 1, pauseAtBudget: true });
  await assert.rejects(
    () => branch.runtime.run({ prompt: "One more" }),
    (error) => {
      assert.match(error.message, /Token budget exceeded/);
      assert.match(error.message, /That is about \$/, "the token refusal also says the money");
      return true;
    },
  );
});

// ------------------------------------------------------------- C3: the trace

/** Checks a document really is shaped like an OpenTelemetry trace, not merely close to one. */
function validateTrace(document) {
  assert.ok(Array.isArray(document.resourceSpans) && document.resourceSpans.length === 1);
  const resource = document.resourceSpans[0];
  assert.ok(Array.isArray(resource.resource.attributes));
  assert.equal(resource.scopeSpans.length, 1);
  const spans = resource.scopeSpans[0].spans;
  assert.ok(spans.length >= 1, "there is at least the task's own span");
  const roots = spans.filter((s) => s.parentSpanId === "");
  assert.equal(roots.length, 1, "exactly one span has no parent");
  const root = roots[0];
  for (const span of spans) {
    assert.match(span.traceId, /^[0-9a-f]{32}$/, "traceId is 32 hex characters");
    assert.match(span.spanId, /^[0-9a-f]{16}$/, "spanId is 16 hex characters");
    assert.equal(span.traceId, root.traceId, "every span belongs to the same trace");
    if (span !== root) assert.equal(span.parentSpanId, root.spanId, "children hang off the task's span");
    assert.equal(typeof span.name, "string");
    assert.match(span.startTimeUnixNano, /^\d+$/, "times are whole numbers written as text");
    assert.match(span.endTimeUnixNano, /^\d+$/);
    assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano), "a span cannot end before it starts");
    assert.ok(BigInt(span.startTimeUnixNano) >= BigInt(root.startTimeUnixNano), "nothing starts before the task does");
    assert.ok([0, 1, 2].includes(span.status.code));
    for (const attribute of span.attributes) {
      assert.equal(typeof attribute.key, "string");
      assert.equal(Object.keys(attribute.value).length, 1);
    }
  }
  return { root, spans };
}

test("a finished task becomes a trace document a tracing viewer can read", async (t) => {
  const { branch, call } = await app(t, "trace-doc");
  const run = await branch.runtime.run({
    prompt: "Write a file called hello.txt containing the word hello, then read it back.",
  });
  const document = buildTraceDocument(branch.store, run.id, branch.version);
  const { root, spans } = validateTrace(document);
  assert.equal(root.name, "branch.run");
  assert.ok(spans.some((s) => s.name.startsWith("model ")), "each model round is a span");
  assert.ok(spans.some((s) => s.name.startsWith("tool ")), "each tool call is a span");

  const overHttp = await call(`/api/runs/${run.id}/trace?format=document`);
  assert.equal(overHttp.status, 200);
  validateTrace(overHttp.value);
  assert.deepEqual(overHttp.value, document, "the route returns the same document");

  const missing = await call("/api/runs/00000000-0000-0000-0000-000000000000/trace");
  assert.equal(missing.status, 404);

  // The same event now names the model for the run timeline, which used to read "unknown".
  const timeline = (await call(`/api/runs/${run.id}/timeline`)).value.timeline;
  const modelLine = timeline.find((entry) => entry.type === "model.completed");
  assert.ok(modelLine, "the timeline has a model entry");
  assert.match(modelLine.title, /Model: demo/, `expected the real model name, got ${modelLine.title}`);
  assert.equal(modelLine.details.preset, "default");
});

test("a cached usage row never claims a cost nobody worked out", async (t) => {
  const root = await scratch(t, "cache-row");
  const db = schema(new DatabaseSync(join(root, "t.db")));
  const usage = new UsageStore(db);
  usage.updateCache("2026-01-01", {
    date: "2026-01-01", runs: 3, toolCalls: 0, tokens: { input: 1, output: 1 }, estimatedCost: 0,
    pricedRuns: 0, unpricedRuns: 3, failures: 0, topFailures: [], presets: [], byConversation: [], byChannel: [],
  }, 1);
  const cached = usage.getCachedUsage("2026-01-01");
  assert.equal(cached.pricedRuns, 0, "a cached row carries no price confidence, so nothing is priced");
  assert.equal(cached.unpricedRuns, 3);
  db.close();
});

test("a trace folder outside the allowed places is refused", async (t) => {
  const root = await scratch(t, "trace-folder");
  const workspace = join(root, "workspace");
  // The real roots are the owner's user folder and the workspace; both are accepted.
  assert.equal(resolveTraceFolder(join(workspace, "traces"), traceRoots(workspace)), join(workspace, "traces"));
  assert.equal(resolveTraceFolder(join(homedir(), "Traces"), traceRoots(workspace)), join(homedir(), "Traces"));
  assert.deepEqual(traceRoots(workspace), [homedir(), workspace]);

  // The temporary folder these tests run in sits inside the user folder, so the negative cases are
  // checked against the workspace alone: everything below is genuinely outside it.
  const only = [workspace];
  const outside = [
    join(root, "elsewhere"),          // a sibling of the workspace
    join(workspace, "..", "escape"),  // a path that climbs back out
    `${workspace}EVIL`,               // a name that merely starts with the workspace's name
    "\\\\server\\share\\traces",      // a network share
    "relative/traces",                // not a full path
    "",                               // nothing at all
  ];
  for (const bad of outside)
    assert.throws(() => resolveTraceFolder(bad, only), /folder|full path|network share/i, `should refuse ${bad}`);
});

test("trace files are written only after the owner turns them on", async (t) => {
  const { branch, root } = await app(t, "trace-write");
  const folder = join(root, "workspace", "traces");

  assert.equal(await writeRunTrace(branch.store, "local", join(root, "workspace"), "no-such-run"), null, "off means nothing is written");
  assert.throws(
    () => saveTraceSettings(branch.store, "local", join(root, "workspace"), { enabled: true, folder: null }),
    /Choose a folder before/,
  );

  saveTraceSettings(branch.store, "local", join(root, "workspace"), { enabled: true, folder });
  const run = await branch.runtime.run({ prompt: "Say hello" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const files = await readdir(folder);
  assert.ok(files.includes(`${run.id}.json`), `expected ${run.id}.json among ${files.join(", ")}`);
  validateTrace(JSON.parse(await readFile(join(folder, `${run.id}.json`), "utf8")));
});

// ------------------------------------------------------- C4: the diagnostics

test("redaction removes keys, tokens and bearer headers from text", () => {
  assert.equal(scrubText(`Authorization: Bearer ${fixtureKey}`), "Authorization: [removed]");
  assert.equal(scrubText(`the key is ${fixtureKey} ok`), "the key is [removed] ok");
  assert.ok(!scrubText("ghp_0123456789abcdefghij").includes("ghp_"));
  assert.ok(!scrubText("a".repeat(5) + " " + "abcdef0123456789abcdef0123456789").includes("abcdef0123456789"));
  assert.equal(scrubText("nothing secret here"), "nothing secret here");
});

test("an event keeps its shape and loses its payload", () => {
  const redacted = redactEvent({
    id: 7, runId: "run-1", kind: "tool.completed", createdAt: "2026-01-01T00:00:00.000Z",
    data: {
      name: "files.write", id: "call-1", apiKey: fixtureKey,
      result: { path: "notes.txt", content: "PRIVATE WORKSPACE FILE CONTENTS" },
      args: { path: "notes.txt", content: "PRIVATE WORKSPACE FILE CONTENTS" },
      error: `failed with Bearer ${fixtureKey}`,
    },
  });
  assert.equal(redacted.data.name, "files.write");
  assert.equal(redacted.data.apiKey, undefined, "a field nobody asked to keep is dropped outright");
  assert.equal(redacted.data.result, undefined, "tool results are dropped, not merely scrubbed");
  assert.match(String(redacted.data.error), /\[removed\]/, "a kept field still has its secrets scrubbed");
  assert.equal(redacted.data.args, undefined, "tool arguments are dropped");
  assert.ok(!JSON.stringify(redacted).includes(fixtureKey));
  assert.ok(!JSON.stringify(redacted).includes("PRIVATE WORKSPACE FILE CONTENTS"));
});

test("the diagnostics folder holds no secret and no workspace file contents", async (t) => {
  const { branch, root, call } = await app(t, "diagnostics");
  const workspaceSecret = "PRIVATE-WORKSPACE-CONTENTS-9182";
  await branch.files.write("notes.txt", `${workspaceSecret} and the key ${fixtureKey}`, AbortSignal.timeout(5000));
  await branch.runtime.run({ prompt: `Read notes.txt. My key is ${fixtureKey}.` });
  branch.store.event(branch.store.runs("local")[0].id, "tool.completed", {
    name: "shell.run", id: "c1", authorization: `Bearer ${fixtureKey}`,
    result: { stdout: `${workspaceSecret} ${fixtureKey}` },
  });

  const response = await call("/api/diagnostics/bundle", {});
  assert.equal(response.status, 200);
  const bundle = response.value;
  assert.ok(bundle.folder.startsWith(join(root, "data")));
  for (const name of ["health.json", "versions.json", "events.json", "pricing.json", "README.txt"])
    assert.ok(bundle.files.includes(name), `the folder holds ${name}`);

  // Grep every file in the folder, not only the events file.
  const names = await readdir(bundle.folder);
  assert.deepEqual(names.sort(), [...bundle.files].sort());
  for (const name of names) {
    const body = await readFile(join(bundle.folder, name), "utf8");
    assert.ok(!body.includes(fixtureKey), `${name} must not contain the key`);
    assert.ok(!body.includes(workspaceSecret), `${name} must not contain workspace file contents`);
    assert.ok((await stat(join(bundle.folder, name))).isFile());
  }
  const pricing = JSON.parse(await readFile(join(bundle.folder, "pricing.json"), "utf8"));
  assert.ok(pricing.pricedAt, "the prices in use travel with the folder");
  const health = JSON.parse(await readFile(join(bundle.folder, "health.json"), "utf8"));
  assert.ok(Array.isArray(health.items));
  const promise = await readFile(join(bundle.folder, "README.txt"), "utf8");
  assert.match(promise, /sends no usage data to anyone/);
});

test("nothing is written anywhere until the owner asks", async (t) => {
  const { root } = await app(t, "diagnostics-off");
  const entries = await readdir(join(root, "data"));
  assert.ok(!entries.includes("diagnostics"), "no diagnostics folder exists until it is asked for");
});

test("the diagnostics folder can be written straight from the store", async (t) => {
  const { branch, root } = await app(t, "diagnostics-direct");
  const bundle = await writeDiagnosticsBundle(branch.store, "local", join(root, "data"), {
    health: { ok: true, items: [] }, version: branch.version,
  });
  assert.equal(bundle.events, 0, "a fresh install has nothing to report");
  // health, versions, events, spans (batch 19, wave 7), pricing, allowed (wave 6), tools and
  // memory (batch 25, wave 7), and the README.
  assert.equal(bundle.files.length, 9);
  assert.ok(bundle.files.includes("allowed.json"));
  assert.ok(bundle.files.includes("spans.json"));
  assert.ok(bundle.files.includes("tools.json"), "how the assistant is finding its tools");
  assert.ok(bundle.files.includes("memory.json"), "how the saved facts are made up");
});
