import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch, openApiDocument, apiMarkdown, apiRoutes,
  saveCacheSettings, requestHash,
  saveBatchSettings, runBatch, supportsBatch,
  lockdownState, setLockdown, lockedDown,
  costByProject, maximumFlowDepth, watchFolder, ignored,
} from "../dist/index.js";
import { startServer } from "../dist/server.js";
import { rounds } from "../dist/inspect.js";

/** A provider driven by a script; each entry is a function of the request, or a plain answer. */
function scripted(steps = []) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push({ messages: request.messages.map((m) => ({ role: m.role, content: m.content })) });
    const step = steps[Math.min(provider.requests.length - 1, steps.length - 1)] ?? { content: `Answer ${provider.requests.length}`, toolCalls: [] };
    return typeof step === "function" ? step(request) : step;
  } };
  return provider;
}
const discard = (base) => discardTemp(base).catch(() => undefined);

async function fixture(t, steps) {
  const base = await mkdtemp(join(tmpdir(), "branch-other2-"));
  const provider = scripted(steps);
  const app = await createBranch({ workspace: join(base, "workspace"), dataDir: join(base, "data"), provider });
  t.after(async () => { await app.close().catch(() => undefined); await discard(base); });
  return { app, base, provider };
}
async function served(t, steps) {
  const base = await mkdtemp(join(tmpdir(), "branch-other2-"));
  const provider = scripted(steps);
  const app = await createBranch({ workspace: join(base, "workspace"), dataDir: join(base, "data"), provider });
  const server = await startServer(app, { dataDir: join(base, "data"), port: 0 });
  t.after(async () => {
    await server.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    await discard(base);
  });
  const headers = { authorization: `Bearer ${server.token}`, "content-type": "application/json", origin: server.url };
  const call = async (path, body, method) => {
    const response = await fetch(server.url + path, body === undefined && !method
      ? { headers } : { method: method ?? "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  return { app, provider, server, call };
}

/* ---- A0758: the app's own OpenAPI description ---- */

test("the OpenAPI description is well formed and lists the run, conversation and memory routes", async (t) => {
  const { call } = await served(t);
  const { status, body } = await call("/api/openapi.json");
  assert.equal(status, 200);
  assert.equal(body.openapi, "3.1.0");
  assert.equal(body.info.title, "Branch Agent");
  assert.ok(body.info.version, "it says which build it came from");
  assert.deepEqual(body.servers.map((s) => s.url), ["http://127.0.0.1:3210"]);
  assert.ok(body.components.securitySchemes.sessionKey, "the session key is described");

  for (const wanted of ["/api/run", "/api/sessions/{sessionId}", "/api/sessions/{sessionId}/tree", "/api/memory/export", "/api/memory/search"])
    assert.ok(body.paths[wanted], `${wanted} is described`);

  // Every operation says the session key is needed, and says what a missing one gets back.
  assert.deepEqual(body.security, [{ sessionKey: [] }]);
  for (const methods of Object.values(body.paths))
    for (const [method, operation] of Object.entries(methods)) {
      assert.deepEqual(operation.security, [{ sessionKey: [] }], `${method} says the session key is needed`);
      assert.ok(operation.responses["401"], `${method} says what a wrong key gets back`);
    }

  // Every operation carries the parts another program needs to call it.
  for (const [path, methods] of Object.entries(body.paths))
    for (const [method, operation] of Object.entries(methods)) {
      assert.ok(operation.summary, `${method} ${path} says what it is for`);
      assert.ok(operation.operationId, `${method} ${path} has a name`);
      assert.ok(operation.responses["200"], `${method} ${path} describes its answer`);
      const named = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      assert.deepEqual((operation.parameters ?? []).map((p) => p.name), named, `${path} names its path parts`);
    }

  // The body of /api/run comes from the app's own check, so it cannot drift.
  const runBody = body.paths["/api/run"].post.requestBody.content["application/json"].schema;
  assert.ok(runBody.properties.prompt, "the prompt is described");
  assert.deepEqual(runBody.required, ["prompt"]);
  assert.equal(runBody.$schema, undefined, "the JSON-Schema marker is taken off for OpenAPI");
});

test("every route the description promises is really served", async (t) => {
  const { app, call } = await served(t);
  const run = await app.runtime.run({ prompt: "hello" });
  const flowId = "00000000-0000-4000-8000-000000000000";
  const missing = [];
  for (const route of apiRoutes) {
    const path = route.path.replace("{runId}", run.id).replace("{sessionId}", run.sessionId).replace("{flowId}", flowId);
    const { status, body } = await call(path, route.method === "get" ? undefined : {}, route.method.toUpperCase());
    // A described route may refuse the empty body this sends; what it may never do is not exist.
    if (status === 404 && /not found/i.test(String(body?.error ?? ""))) missing.push(`${route.method} ${route.path}`);
  }
  assert.deepEqual(missing, [], "the description must not promise a route the app does not answer");
});

test("the readable version of the API page is written from the same description", async () => {
  const markdown = apiMarkdown(openApiDocument("9.9.9"));
  assert.match(markdown, /^# Branch Agent — the web API/);
  assert.match(markdown, /Version 9\.9\.9/);
  assert.match(markdown, /\| `POST` \| `\/api\/run` \|/);
  assert.match(markdown, /^## sessions$/m);
  // One row per operation, and every route in the table.
  const rows = markdown.split("\n").filter((line) => line.startsWith("| `") && !line.startsWith("| `Method"));
  assert.equal(rows.length, apiRoutes.length);
});

/* ---- A0928: an answer kept for an identical request ---- */

test("a kept answer skips the provider, costs nothing, and says so in the inspector", async (t) => {
  const { app, provider } = await fixture(t, [{ content: "Paris.", toolCalls: [] }]);
  saveCacheSettings(app.store, app.runtime.owner, { enabled: true, ttlMinutes: 60 });

  const first = await app.runtime.run({ prompt: "What is the capital of France?" });
  assert.equal(first.status, "completed");
  assert.equal(provider.requests.length, 1);

  const second = await app.runtime.run({ prompt: "What is the capital of France?" });
  assert.equal(second.status, "completed");
  assert.equal(second.output, "Paris.");
  assert.equal(provider.requests.length, 1, "the second identical request never reached the provider");

  const seen = rounds(app.store, second.id, () => ({ amount: 1.23, display: "$1.23" }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].cached, true);
  assert.equal(seen[0].cost.amount, 0, "a kept answer is counted as costing nothing");
  assert.match(seen[0].cacheReason, /answered before/);
  assert.equal(app.store.usage(second.id).estimatedOutput, 0, "no tokens were charged for it");
  assert.equal(app.store.usage(second.id).estimatedInput, 0, "nor were any counted going in");
  assert.equal(app.store.usage(second.id).incompleteCalls, 0, "the round is not left looking unfinished");

  // The figures a person reads must say the same thing as the inspector: the second task cost nothing.
  const ledger = costByProject(app.store, app.runtime.owner, 30);
  const tokens = ledger.reduce((total, entry) => total + entry.tokens.input + entry.tokens.output, 0);
  const firstUsage = app.store.usage(first.id);
  assert.equal(tokens, firstUsage.estimatedInput + firstUsage.estimatedOutput,
    "only the task that really reached the provider is counted");

  // A different question is a different request.
  await app.runtime.run({ prompt: "What is the capital of Spain?" });
  assert.equal(provider.requests.length, 2);
});

test("a request carrying a picture or the name of a saved secret is never kept", async (t) => {
  const { app } = await fixture(t, [{ content: "Same answer.", toolCalls: [] }]);
  const owner = app.runtime.owner;
  saveCacheSettings(app.store, owner, { enabled: true });
  const cache = app.runtime.requestCache;
  const base = { provider: "p", model: "m", reasoning: null, maxTokens: 100, tools: [] };
  const answer = { content: "Same answer.", toolCalls: [] };

  const withPicture = { ...base, messages: [{ role: "user", content: "what is this", images: [{ data: "AAAA", mediaType: "image/png" }] }] };
  assert.equal(cache.keep(withPicture, answer), false, "a picture is never kept");
  assert.equal(cache.look(withPicture), null);

  const withSecret = { ...base, messages: [{ role: "user", content: "use secret://default/API_KEY" }] };
  assert.equal(cache.keep(withSecret, answer), false, "the name of a saved secret is never kept");
  assert.equal(cache.look(withSecret), null);

  // Plain text still is, and the words describing a tool are part of what makes a request the same.
  const plain = { ...base, messages: [{ role: "user", content: "hello" }], tools: [{ name: "files.list", description: "List files." }] };
  assert.equal(cache.keep(plain, answer), true);
  assert.equal(cache.look(plain)?.content, "Same answer.");
  assert.equal(cache.look({ ...plain, tools: [{ name: "files.list", description: "List everything, everywhere." }] }), null,
    "a tool whose description changed is a different request");
});

test("one person in the household never reads another's kept answers", async (t) => {
  const { app } = await fixture(t, [{ content: "Paris.", toolCalls: [] }]);
  const owner = app.runtime.owner;
  saveCacheSettings(app.store, owner, { enabled: true });
  const parts = { provider: "p", model: "m", reasoning: null, maxTokens: 100, tools: [],
    messages: [{ role: "user", content: "What is the capital of France?" }] };
  assert.equal(app.runtime.requestCache.keep(parts, { content: "Paris.", toolCalls: [] }), true);

  const profile = app.store.profiles.create({ name: "Sam", pin: "4321" });
  app.store.profiles.switch({ profileId: profile.id, pin: "4321" });
  assert.equal(app.runtime.requestCache.look(parts), null, "the other person's answer is not theirs to read");
  app.store.profiles.switch({ profileId: null });
  assert.equal(app.runtime.requestCache.look(parts)?.content, "Paris.", "the owner's own answer is still there");
});

test("an answer that asks for a tool is never kept, and the hash follows the request", async (t) => {
  const { app, provider } = await fixture(t, [
    { content: "", toolCalls: [{ id: "c1", name: "files.list", arguments: "{}" }] },
    { content: "Done.", toolCalls: [] },
  ]);
  saveCacheSettings(app.store, app.runtime.owner, { enabled: true });
  const first = await app.runtime.run({ prompt: "list the files" });
  assert.equal(first.status, "completed");
  const before = provider.requests.length;
  const second = await app.runtime.run({ prompt: "list the files" });
  assert.equal(second.status, "completed");
  assert.ok(provider.requests.length > before, "the round that asked for a tool was asked again, not replayed");

  const base = { provider: "p", model: "m", reasoning: null, maxTokens: 100,
    messages: [{ role: "user", content: "hello" }], tools: [{ name: "files.list" }] };
  assert.equal(requestHash(base), requestHash({ ...base }), "the same request hashes the same");
  assert.notEqual(requestHash(base), requestHash({ ...base, model: "other" }));
  assert.notEqual(requestHash(base), requestHash({ ...base, messages: [{ role: "user", content: "hi" }] }));
  assert.notEqual(requestHash(base), requestHash({ ...base, tools: [] }));
});

/* ---- A1351 / A1352: a whole set of questions at once ---- */

/** A service that takes whole sets, driven by a script so nothing goes near a network. */
function batchProvider(plan = {}) {
  const calls = { submit: 0, poll: 0, collect: 0, complete: 0 };
  const provider = {
    name: "batching", calls,
    async complete(request) {
      calls.complete += 1;
      return { content: `direct ${calls.complete}`, toolCalls: [], usage: { input: 5, output: 2 } };
    },
    batch: () => plan.none ? null : ({
      async submit(requests) {
        calls.submit += 1;
        if (plan.submitFails) throw new Error("the service would not take the set");
        provider.sent = requests;
        return { batchId: "batch-1" };
      },
      async poll() {
        calls.poll += 1;
        if (plan.failsAfter && calls.poll >= plan.failsAfter) return { status: "failed", error: "the set failed" };
        return { status: calls.poll >= (plan.readyAfter ?? 2) ? "completed" : "working" };
      },
      async collect() {
        calls.collect += 1;
        if (plan.collectFails) throw new Error("the answers could not be read");
        return provider.sent.map((request) => ({ id: request.id, content: `batched ${request.id}`, usage: { input: 10, output: 4 } }));
      },
    }),
  };
  return provider;
}

const questions = [
  { id: "q1", messages: [{ role: "user", content: "one" }] },
  { id: "q2", messages: [{ role: "user", content: "two" }] },
];
const noWait = async () => undefined;

test("batch mode hands the whole set over, waits for it, and collects the answers", async (t) => {
  const { app } = await fixture(t);
  saveBatchSettings(app.store, app.runtime.owner, { enabled: true, pollMs: 10, maxWaitMs: 5000 });
  const provider = batchProvider({ readyAfter: 3 });
  assert.equal(supportsBatch(provider), true);
  const preset = { id: "b", name: "Batching", provider, model: "gpt-4o-mini" };

  const outcome = await runBatch(app.store, app.runtime.owner, preset, questions,
    AbortSignal.timeout(5000), { sleep: noWait });
  assert.equal(outcome.route, "batch");
  assert.equal(outcome.batchId, "batch-1");
  assert.equal(provider.calls.submit, 1);
  assert.equal(provider.calls.poll, 3, "it kept asking until the set was done");
  assert.equal(provider.calls.collect, 1);
  assert.equal(provider.calls.complete, 0, "not one ordinary call was made");
  assert.deepEqual(outcome.answers.map((a) => a.id), ["q1", "q2"]);
  assert.deepEqual(outcome.answers.map((a) => a.content), ["batched q1", "batched q2"]);
  // What it cost comes from what the service reported, not from a guess.
  assert.deepEqual(outcome.usage, { input: 20, output: 8 });
  assert.ok(outcome.cost.display, "the set is priced");
});

test("batch mode falls back to ordinary calls when it cannot be used", async (t) => {
  const { app } = await fixture(t);
  const owner = app.runtime.owner;

  // Off by default: nothing is handed over at all.
  const offProvider = batchProvider({ readyAfter: 1 });
  const off = await runBatch(app.store, owner, { id: "b", name: "B", provider: offProvider, model: "m" },
    questions, AbortSignal.timeout(5000), { sleep: noWait });
  assert.equal(off.route, "direct");
  assert.match(off.reason, /switched off/);
  assert.equal(offProvider.calls.submit, 0);
  assert.equal(offProvider.calls.complete, 2);

  saveBatchSettings(app.store, owner, { enabled: true, pollMs: 10 });

  // A connection that cannot take whole sets.
  const plain = batchProvider({ none: true });
  assert.equal(supportsBatch(plain), false);
  const unsupported = await runBatch(app.store, owner, { id: "p", name: "P", provider: plain, model: "m" },
    questions, AbortSignal.timeout(5000), { sleep: noWait });
  assert.equal(unsupported.route, "direct");
  assert.match(unsupported.reason, /does not take a whole set/);
  assert.equal(plain.calls.complete, 2);

  // The hand-over is refused.
  const refused = batchProvider({ submitFails: true });
  const afterRefusal = await runBatch(app.store, owner, { id: "r", name: "R", provider: refused, model: "m" },
    questions, AbortSignal.timeout(5000), { sleep: noWait });
  assert.equal(afterRefusal.route, "direct");
  assert.match(afterRefusal.reason, /would not take the set/);
  assert.equal(refused.calls.complete, 2);

  // The set itself failed at the service, and nothing could be collected from it either.
  const broken = batchProvider({ failsAfter: 1, collectFails: true });
  const afterFailure = await runBatch(app.store, owner, { id: "f", name: "F", provider: broken, model: "m" },
    questions, AbortSignal.timeout(5000), { sleep: noWait });
  assert.equal(afterFailure.route, "direct");
  assert.match(afterFailure.reason, /the set failed/);
  assert.equal(broken.calls.complete, 2, "the questions were still answered");

  // A set the service called failed, but whose answers are still there, keeps them rather than
  // asking everything again. See tests/faster-cheaper.test.mjs for the half-failed case in full.
  const halfWorked = batchProvider({ failsAfter: 1 });
  const harvested = await runBatch(app.store, owner, { id: "h", name: "H", provider: halfWorked, model: "m" },
    questions, AbortSignal.timeout(5000), { sleep: noWait });
  assert.equal(harvested.route, "batch");
  assert.equal(halfWorked.calls.complete, 0, "nothing was paid for twice");
  assert.deepEqual(harvested.answers.map((a) => a.content), ["batched q1", "batched q2"]);
});

/* ---- A0390: the shape branched conversations make, and carrying an answer back ---- */

test("branches show up as a tree, and a branch's answer is carried back as a note", async (t) => {
  const { app, call } = await served(t, [{ content: "The first answer.", toolCalls: [] }]);
  const owner = app.runtime.owner;
  const root = await app.runtime.run({ prompt: "start here" });

  const messages = app.store.sessionView(owner, root.sessionId).messages;
  // Branching through the reply means the branch carries an answer that can be carried back.
  const point = messages.find((message) => message.role === "assistant");
  const branch = (await app.store.branchSession(owner, { sessionId: root.sessionId, messageId: point.messageId }));
  // A copied conversation gets its own message numbers, so the second branch point is read from it.
  const branchPoint = app.store.sessionView(owner, branch.sessionId).messages.find((message) => message.role === "assistant");
  const deeper = (await app.store.branchSession(owner, { sessionId: branch.sessionId, messageId: branchPoint.messageId }));

  const tree = await call(`/api/sessions/${root.sessionId}/tree`);
  assert.equal(tree.status, 200);
  assert.equal(tree.body.sessionId, root.sessionId);
  assert.equal(tree.body.branchPointMessageId, null, "the root came off nothing");
  assert.match(tree.body.title, /start here/);
  assert.equal(tree.body.children.length, 1);
  assert.equal(tree.body.children[0].sessionId, branch.sessionId);
  assert.equal(tree.body.children[0].branchPointMessageId, point.messageId);
  assert.equal(tree.body.children[0].children[0].sessionId, deeper.sessionId);

  // Asking from anywhere in the shape gives the whole shape back.
  const fromLeaf = await call(`/api/sessions/${deeper.sessionId}/tree`);
  assert.equal(fromLeaf.body.sessionId, root.sessionId);

  // Carrying an answer back adds one note to the parent and changes the branch not at all.
  const branchMessagesBefore = app.store.sessionView(owner, branch.sessionId).messages.length;
  const parentBefore = app.store.sessionView(owner, root.sessionId).messages.length;
  const carried = await call(`/api/sessions/${branch.sessionId}/merge-note`, {});
  assert.equal(carried.status, 200);
  assert.equal(carried.body.parentSessionId, root.sessionId);
  assert.match(carried.body.note, /carried back from a branch/);
  assert.match(carried.body.note, /The first answer\./);
  const parentAfter = app.store.sessionView(owner, root.sessionId).messages;
  assert.equal(parentAfter.length, parentBefore + 1, "exactly one note was added");
  assert.match(parentAfter.at(-1).content, /carried back from a branch/);
  assert.equal(app.store.sessionView(owner, branch.sessionId).messages.length, branchMessagesBefore,
    "the branch itself is untouched");

  // A conversation that came off nothing has no answer to carry back.
  const refused = await call(`/api/sessions/${root.sessionId}/merge-note`, {});
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /did not come off another one/);
});

/* ---- A1274: one flow inside another ---- */

const step = (name, extra) => ({ name, kind: "tool", tool: "memory.put", args: { text: name, source: "test" }, ...extra });

test("a flow can work through another flow, with a cap on depth and no way round in a circle", async (t) => {
  const { app } = await fixture(t);
  const owner = app.runtime.owner;
  const inner = app.workflows.create(owner, { name: "Inner", steps: [step("inner step")] });
  const outer = app.workflows.create(owner, { name: "Outer", steps: [{ name: "run the inner one", kind: "flow", flowId: inner.id }, step("after")] });

  const finished = await app.workflows.run(owner, outer.id);
  assert.equal(finished.status, "completed");
  assert.equal(app.workflows.view(owner, inner.id).status, "completed", "the inner flow really ran");
  const [first] = finished.state;
  assert.equal(first.kind, "flow");
  assert.equal(first.status, "done");
  assert.match(first.output, /Inner/);

  // A flow that leads back to one already running is refused by name.
  const loopB = app.workflows.create(owner, { name: "B", steps: [step("placeholder")] });
  const loopA = app.workflows.create(owner, { name: "A", steps: [{ name: "into B", kind: "flow", flowId: loopB.id }] });
  app.workflows.create(owner, { id: loopB.id, name: "B", steps: [{ name: "back into A", kind: "flow", flowId: loopA.id }] });
  const looped = await app.workflows.run(owner, loopA.id);
  assert.equal(looped.status, "failed");
  assert.match(looped.error, /leads back to one already running/);
  assert.match(looped.error, new RegExp(loopA.id));

  // A chain longer than the cap is refused before it starts.
  const deepest = app.workflows.create(owner, { name: "D4", steps: [step("leaf")] });
  let below = deepest.id;
  const ids = [];
  for (let level = 3; level >= 1; level--) {
    const made = app.workflows.create(owner, { name: `D${level}`, steps: [{ name: "deeper", kind: "flow", flowId: below }] });
    ids.push(made.id);
    below = made.id;
  }
  const tooDeep = await app.workflows.run(owner, below);
  assert.equal(tooDeep.status, "failed");
  assert.match(tooDeep.error, new RegExp(`only go ${maximumFlowDepth} deep`));
  assert.equal(app.workflows.view(owner, deepest.id).status, "idle", "the flow past the cap never started");
});

/* ---- A0615: Lockdown ---- */

test("Lockdown flips every switch, is written down, and puts back exactly what was there", async (t) => {
  const { app, call } = await served(t);
  const owner = app.runtime.owner, store = app.store;

  // Something set before Lockdown, and something that was never set at all.
  store.save("settings", owner, "code-run", { enabled: true, python: "", network: true, timeoutMs: 15000, maxMemoryMb: 512, maxCpuSeconds: 20, maxOutputBytes: 8192 });
  store.save("settings", owner, "policy", { preset: "workspace", rules: [{ tool: "files.write", match: "*", applies: "any", decision: "allow", remember: "session" }], limits: { toolCallsPerMinute: 0, modelRoundsPerMinute: 0 } });
  store.save("settings", owner, "background-processes", { programs: { site: { path: "C:/x/node.exe", args: [] } }, maxRunning: 3, maxMinutes: 120, maxMemoryMb: 2048, maxCpuSeconds: 1800, bufferBytes: 16384 });
  assert.equal(store.get("settings", owner, "desktop-control"), undefined, "the screen switch was never saved");
  const processesBefore = JSON.stringify(store.get("settings", owner, "background-processes").data);
  // A "yes, for this conversation" given before Lockdown must not still be standing afterwards.
  app.runtime.approvals.remember("session-1", "files.write", "notes.txt", "allow");
  const policyBefore = JSON.stringify(store.get("settings", owner, "policy").data);
  const codeRunBefore = JSON.stringify(store.get("settings", owner, "code-run").data);

  const before = await call("/api/lockdown", undefined, "GET");
  assert.equal(before.body.on, false);
  assert.ok(before.body.effects.length >= 5, "it says in plain words what it stops");

  const on = await call("/api/lockdown", { on: true });
  assert.equal(on.status, 200);
  assert.equal(on.body.on, true);
  assert.ok(on.body.since, "it says when it went on");
  assert.equal(lockedDown(store, owner), true);

  // Every switch is down.
  assert.equal(store.get("settings", owner, "code-run").data.enabled, false);
  assert.equal(store.get("settings", owner, "desktop-control").data.enabled, false);
  assert.equal(store.get("settings", owner, "browser-attach").data.enabled, false);
  assert.deepEqual(store.get("settings", owner, "background-processes").data.programs, {},
    "no program may be left running while it is on");
  assert.equal(app.runtime.approvals.answer("session-1", "files.write", "notes.txt"), undefined,
    "a yes given earlier no longer stands in for the question");
  const locked = store.get("settings", owner, "policy").data;
  assert.equal(locked.preset, "custom");
  assert.deepEqual(locked.rules, [{ tool: "*", match: "*", applies: "any", decision: "ask", remember: "never" }]);

  // Nothing goes out of a messaging account while it is on.
  const refusedSend = await app.channels.outboundGuard("here is the answer");
  assert.equal(refusedSend.blocked, true);
  assert.match(refusedSend.reason, /Lockdown is on/);

  // And no note about what happened reaches another program: nothing is even attempted.
  const hook = app.webhooks.create({ owner, permissions: new Set(["webhooks.manage"]) },
    { name: "Somewhere", url: "http://127.0.0.1:9/never", events: ["run.completed"] });
  app.runtime.notifyEvent("run.completed", { runId: "none" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(app.store.getWebhookLog(hook.id, owner), [], "no delivery was even tried");

  // It is in the record of what the assistant was allowed to do.
  const written = store.audit.list(owner, { limit: 50 }).filter((entry) => entry.subject.startsWith("Lockdown"));
  assert.equal(written.length, 1);
  // Batch 20 (wave 8): Lockdown has its own kind in the record rather than sharing "policy.changed".
  assert.equal(written[0].action, "lockdown.changed");
  assert.equal(written[0].subject, "Lockdown on");

  const off = await call("/api/lockdown", { on: false });
  assert.equal(off.body.on, false);
  assert.equal(lockedDown(store, owner), false);
  // Exactly what was there before, and nothing invented for what was never set.
  assert.equal(JSON.stringify(store.get("settings", owner, "policy").data), policyBefore);
  assert.equal(JSON.stringify(store.get("settings", owner, "code-run").data), codeRunBefore);
  assert.equal(JSON.stringify(store.get("settings", owner, "background-processes").data), processesBefore);
  assert.equal(store.get("settings", owner, "desktop-control"), undefined, "a switch never set stays unset");
  assert.equal(store.audit.list(owner, { limit: 50 }).filter((e) => e.subject === "Lockdown off").length, 1);

  // Asking for what it already is changes nothing and writes nothing.
  const again = setLockdown(store, owner, { on: false });
  assert.equal(again.on, false);
  assert.equal(store.audit.list(owner, { limit: 50 }).filter((e) => e.subject.startsWith("Lockdown")).length, 2);
  assert.equal(lockdownState(store, owner).on, false);
});

/* ---- A0794: what a project brings to a task, and what each has cost ---- */

test("a project's instructions, model and knowledge bases apply, and cost groups by project", async (t) => {
  const { app, provider, call } = await served(t);
  const owner = app.runtime.owner;

  app.store.projects.save(owner, { id: "roofing", name: "Roofing", instructions: "Always give measurements in metres.",
    modelPreset: null, repository: "", folder: "", profile: null, knowledgeBases: ["handbook"] });
  app.store.projects.setActive(owner, { active: "roofing" });

  const defaults = app.store.projects.defaults(owner);
  assert.equal(defaults.projectId, "roofing");
  assert.deepEqual(defaults.knowledgeBases, ["handbook"]);

  const run = await app.runtime.run({ prompt: "how wide is the ridge" });
  assert.equal(run.status, "completed");
  assert.equal(run.project, "roofing", "the task records the project it was done under");
  assert.equal(app.store.run(run.id).project, "roofing");
  // The project's instructions really reached the model.
  const system = provider.requests[0].messages.find((message) => message.role === "system");
  assert.match(system.content, /Always give measurements in metres/);

  // A task in another project is counted separately.
  app.store.projects.setActive(owner, { active: "default" });
  const other = await app.runtime.run({ prompt: "something else" });
  assert.equal(other.project, "default");

  const grouped = costByProject(app.store, owner, 30);
  const ids = grouped.map((entry) => entry.projectId).sort();
  assert.deepEqual(ids, ["default", "roofing"]);
  const roofing = grouped.find((entry) => entry.projectId === "roofing");
  assert.equal(roofing.name, "Roofing");
  assert.equal(roofing.runs, 1);
  assert.ok(roofing.tokens.input > 0, "the tokens are counted against the project");

  const over = await call("/api/projects/costs?days=7");
  assert.equal(over.status, 200);
  assert.deepEqual(over.body.projects.map((entry) => entry.projectId).sort(), ["default", "roofing"]);
});

/* ---- A0344: watching a folder ---- */

test("the context branch watch builds is allowed to replay a saved procedure", async (t) => {
  const { app } = await fixture(t);
  // `watchCommand` builds exactly this context and hands it to knowledge.replayProcedure, which
  // opens by demanding procedures.use. Without it every change would throw instead of running.
  const context = app.runtime.context({ signal: AbortSignal.timeout(1000), source: "owner" });
  assert.equal(context.permissions.has("procedures.use"), true);
});

/** The short ("8.3") name Windows may also keep for a folder, or null where it keeps none. */
function shortPathOf(folder) {
  if (process.platform !== "win32") return null;
  const script = `(Get-Item -LiteralPath '${folder.replace(/'/g, "''")}').FullName; ` +
    `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${folder.replace(/'/g, "''")}').ShortPath`;
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf8" });
    const short = out.trim().split(/\r?\n/).pop()?.trim();
    return short && short.includes("~") ? short : null;
  } catch { return null; }
}

/**
 * Saves into the folder until the watcher has noticed. The system starts a watch on its own time
 * (on a Mac, FSEvents arms on another thread), so a save made in the first instants can go unseen on
 * a busy machine; saving again is what a person would do, and the wait ends on the run itself.
 */
async function saveUntilNoticed(handle, save) {
  for (let round = 0; round < 30 && handle.runs === 0; round++) {
    await save(round);
    for (let waited = 0; waited < 25 && handle.runs === 0; waited++)
      await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("branch watch runs the action on a change, never twice at once, and stops cleanly", { timeout: 60_000 }, async (t) => {
  const base = await mkdtemp(join(tmpdir(), "branch-watch-"));
  t.after(() => discard(base));
  const folder = join(base, "src");
  await mkdir(folder, { recursive: true });

  const reasons = [];
  let running = 0, overlapped = false;
  const handle = watchFolder(folder, async (reason) => {
    running += 1;
    if (running > 1) overlapped = true;
    reasons.push(reason);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
  }, { settleMs: 20, ignore: ["node_modules"] });
  // Stopped whatever happens below: a watch left open keeps this whole file from ever finishing.
  t.after(() => handle.stop());

  // A burst of saves settles into a single run.
  await saveUntilNoticed(handle, async (round) => {
    await writeFile(join(folder, "one.txt"), `hello ${round}`);
    await writeFile(join(folder, "two.txt"), `there ${round}`);
  });
  assert.ok(handle.runs >= 1, "a change set the action going");
  assert.ok(reasons.length >= 1);
  assert.match(reasons[0], /changed/);
  assert.equal(overlapped, false, "it never runs twice at once");

  await handle.stop();
  const after = handle.runs;
  await writeFile(join(folder, "three.txt"), "ignored");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(handle.runs, after, "nothing runs once it has stopped");

  // Build output and the like never set anything off.
  assert.equal(ignored("node_modules/x/index.js", ["node_modules"]), true);
  assert.equal(ignored("dist\\app.js", ["dist"]), true);
  assert.equal(ignored("src/app.ts~", ["dist"]), true);
  assert.equal(ignored("src/app.ts", ["dist", "node_modules"]), false);
});

test("branch watch survives a folder named the short Windows way", { timeout: 60_000 }, async (t) => {
  // Windows keeps short names like RUNNER~1 for some folders, and the watcher underneath Node stops
  // the whole program with an assertion when it is handed one. A build machine's temp folder is
  // often named that way even though a desktop's is not, so the short name is asked for outright
  // and the test says plainly when this disk has none rather than quietly proving nothing.
  const base = await mkdtemp(join(tmpdir(), "branch-watch-short-"));
  t.after(() => discard(base));
  const folder = join(base, "a folder with spaces");
  await mkdir(folder, { recursive: true });

  const short = shortPathOf(folder);
  if (!short) { t.skip("this disk keeps no short names, so there is nothing to watch through"); return; }
  assert.notEqual(short.toLowerCase(), folder.toLowerCase(), "the short name is the long one again");

  const reasons = [];
  const handle = watchFolder(short, async (reason) => { reasons.push(reason); }, { settleMs: 20 });
  t.after(() => handle.stop());
  await saveUntilNoticed(handle, (round) => writeFile(join(folder, "one.txt"), `hello ${round}`));
  assert.ok(handle.runs >= 1, "watching through the short name never noticed the change");
  assert.match(reasons[0] ?? "", /changed/);
});
