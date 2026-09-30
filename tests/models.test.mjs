import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch, OpenAIProvider, AnthropicProvider, presetsFromEnv, ModelRouter, noModelWords } from "../dist/index.js";
import { ProviderHttpError } from "../dist/provider-retry.js";
import { startServer } from "../dist/server.js";

function scripted(name, behaviour = () => ({ content: `${name} answered`, toolCalls: [] })) {
  const provider = { name, calls: 0, requests: [], async complete(request) {
    provider.calls += 1; provider.requests.push(request); return behaviour(request);
  } };
  return provider;
}
async function fixture(t, presets, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-models-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets, ...extra });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root };
}
const kinds = (app, run, kind) => app.store.events(run.id).filter((event) => event.kind === kind).map((event) => event.data);

test("named presets: each task uses the selected preset's provider and model", async (t) => {
  const alpha = scripted("alpha"), beta = scripted("beta");
  const { app } = await fixture(t, [
    { id: "alpha", name: "Alpha", provider: alpha, model: "alpha-1" },
    { id: "beta", name: "Beta", provider: beta, model: "beta-9" },
  ]);
  const first = await app.runtime.run({ prompt: "one" });
  assert.equal(first.status, "completed");
  assert.deepEqual(kinds(app, first, "model.selected")[0], {
    presetId: "alpha", presetName: "Alpha", provider: "alpha", model: "alpha-1", reasoning: null, source: "default", local: false });
  app.runtime.models.configure("local", { activePreset: "beta" });
  const second = await app.runtime.run({ prompt: "two" });
  assert.equal(second.output, "beta answered");
  assert.equal(kinds(app, second, "model.selected")[0].source, "owner");
  assert.equal(kinds(app, second, "model.started")[0].model, "beta-9");
  assert.deepEqual([alpha.calls, beta.calls], [1, 1]);
  assert.throws(() => app.runtime.models.configure("local", { activePreset: "gamma" }), /Unknown model preset/);
  assert.throws(() => app.runtime.models.configure("local", { fallbackOrder: ["beta", "beta"] }), /twice/);
  // No presets is allowed: no model is set up, and the stand-in that refuses is never listed.
  const empty = new ModelRouter(app.store, []);
  assert.equal(empty.configured, false);
  assert.equal(empty.presets.size, 0);
});

test("session override switches the model for one conversation and reports the model actually used", async (t) => {
  const alpha = scripted("alpha"), beta = scripted("beta");
  const { app, root } = await fixture(t, [
    { id: "alpha", name: "Alpha", provider: alpha, model: "alpha-1", reasoning: "medium" },
    { id: "beta", name: "Beta", provider: beta, model: "beta-9" },
  ]);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (path, body) => {
    const response = await fetch(server.url + "/api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + server.token, origin: server.url,
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  };
  const started = await app.runtime.run({ prompt: "start" });
  assert.equal(kinds(app, started, "model.started")[0].reasoning, "medium");
  assert.equal(alpha.requests[0].reasoning, "medium");
  assert.equal((await call("models", { reasoning: "high" })).data.reasoning, "high");
  const scoped = await call(`sessions/${started.sessionId}/model`, { preset: "beta", reasoning: "low" });
  assert.equal(scoped.status, 200);
  const preview = (await call(`sessions/${started.sessionId}/model`)).data;
  assert.equal(preview.effective.presetId, "beta");
  assert.equal(preview.effective.source, "session");
  const next = await app.runtime.run({ prompt: "again", sessionId: started.sessionId });
  assert.equal(next.output, "beta answered");
  assert.equal(beta.requests[0].reasoning, "low");
  const fresh = await app.runtime.run({ prompt: "new conversation" });
  assert.equal(fresh.output, "alpha answered");
  assert.equal(alpha.requests.at(-1).reasoning, "high");
  const state = (await call("state")).data;
  const byId = Object.fromEntries(state.runs.map((run) => [run.id, run.model]));
  assert.equal(byId[next.id].presetId, "beta");
  assert.equal(byId[fresh.id].presetId, "alpha");
  assert.equal(state.models.presets.length, 2);
  assert.equal((await call("models", { activePreset: "nope" })).status, 400);
  assert.equal((await call(`sessions/${"0".repeat(8)}-0000-0000-0000-000000000000/model`)).status, 404);
});

test("eligible failures rest the failed preset and fall back in the configured order", async (t) => {
  const failing = scripted("flaky", () => { throw new ProviderHttpError(503); });
  const backup = scripted("backup"), last = scripted("last");
  const { app } = await fixture(t, [
    { id: "main", name: "Main", provider: failing, model: "m" },
    { id: "backup", name: "Backup", provider: backup, model: "b" },
    { id: "last", name: "Last", provider: last, model: "l" },
  ], { retryPolicy: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 } });
  app.runtime.models.configure("local", { fallbackOrder: ["last", "backup"], cooldownMs: 60_000 });
  let clock = Date.now();
  app.runtime.models.now = () => clock;
  const run = await app.runtime.run({ prompt: "go" });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "last answered");
  assert.equal(failing.calls, 2, "one retry before falling back");
  const fallback = kinds(app, run, "model.fallback");
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].from, "main");
  assert.equal(fallback[0].to, "last");
  assert.match(fallback[0].cooldownUntil, /^\d{4}-/);
  const summary = app.runtime.models.summary("local");
  assert.ok(summary.presets.find((preset) => preset.id === "main").coolingDownUntil);
  const during = await app.runtime.run({ prompt: "while resting" });
  assert.equal(kinds(app, during, "model.selected")[0].source, "cooldown");
  assert.equal(failing.calls, 2, "resting preset is not called");
  clock += 61_000;
  const after = await app.runtime.run({ prompt: "after rest" });
  assert.equal(kinds(app, after, "model.selected")[0].presetId, "main");
  assert.equal(failing.calls, 4, "preset is tried again after the cooldown");
});

/* Batch D (Settings › Accounts › Fall back to this computer): an account out of credit or at its plan limit is the owner's
   money, not an outage. It never moves to another paid connection; it carries on only on a model on this computer that
   the owner put in the fallback order. */
test("an account out of credit carries on only on a model on this computer in the fallback order", async (t) => {
  const onThisComputer = (name) => Object.assign(scripted(name), { embeddings: () => ({ endpoint: "http://127.0.0.1:11434/v1/embeddings" }) });
  for (const refusal of [() => new ProviderHttpError(429, undefined, "insufficient_quota"), () => new ProviderHttpError(402),
    () => Object.assign(new Error("This account has reached its plan limit."), { name: "ProgramLimitError" })]) {
    const broke = scripted("broke", () => { throw refusal(); });
    const paid = scripted("paid"), here = onThisComputer("here");
    const { app } = await fixture(t, [
      { id: "main", name: "Main", provider: broke, model: "m" },
      { id: "paid", name: "Paid", provider: paid, model: "p" },
      { id: "here", name: "Here", provider: here, model: "h" },
    ], { retryPolicy: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 } });
    app.runtime.models.configure("local", { fallbackOrder: ["paid"] });
    const stopped = await app.runtime.run({ prompt: "go" });
    assert.equal(stopped.status, "failed", "with no model on this computer in the order, it stops as before");
    assert.equal(paid.calls, 0, "never another paid connection");
    app.runtime.models.configure("local", { fallbackOrder: ["paid", "here"] });
    const run = await app.runtime.run({ prompt: "go" });
    assert.equal(run.status, "completed");
    assert.equal(run.output, "here answered");
    assert.equal(paid.calls, 0, "the paid connection before it in the order is skipped");
    assert.equal(broke.calls, 2, "no retries on a refusal about money");
    const fallback = kinds(app, run, "model.fallback");
    assert.deepEqual([fallback.length, fallback[0].from, fallback[0].to, fallback[0].cooldownUntil], [1, "main", "here", null]);
  }
});

test("failures that are not provider outages do not fall back", async (t) => {
  const broken = scripted("broken", () => { throw new ProviderHttpError(401); });
  const backup = scripted("backup");
  const { app } = await fixture(t, [
    { id: "a", name: "A", provider: broken, model: "a" }, { id: "b", name: "B", provider: backup, model: "b" },
  ]);
  app.runtime.models.configure("local", { fallbackOrder: ["b"] });
  const run = await app.runtime.run({ prompt: "go" });
  assert.equal(run.status, "failed");
  assert.equal(backup.calls, 0);
  assert.equal(kinds(app, run, "model.fallback").length, 0);
});

async function endpoint(t, seen) {
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = JSON.parse(raw); seen.push({ url: req.url, body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url.includes("/messages")
      ? { content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5, output_tokens: 1 } }
      : { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

test("reasoning effort reaches provider requests in each protocol's own parameter", async (t) => {
  const seen = [];
  const base = await endpoint(t, seen);
  const openai = new OpenAIProvider({ endpoint: base, model: "gpt-x", apiKey: "k" });
  const anthropic = new AnthropicProvider({ endpoint: base, model: "claude-x", apiKey: "k" });
  const { app } = await fixture(t, [
    { id: "oa", name: "OpenAI", provider: openai, model: "gpt-x", reasoning: "medium" },
    { id: "an", name: "Anthropic", provider: anthropic, model: "claude-x", reasoning: "high" },
  ]);
  await app.runtime.run({ prompt: "one" });
  assert.equal(seen[0].body.reasoning_effort, "medium");
  app.runtime.models.configure("local", { activePreset: "an" });
  await app.runtime.run({ prompt: "two" });
  assert.deepEqual(seen[1].body.thinking, { type: "enabled", budget_tokens: 1792 });
  app.runtime.models.configure("local", { reasoning: null, activePreset: "oa" });
  const session = await app.runtime.run({ prompt: "three" });
  app.runtime.models.configureSession("local", session.sessionId, { reasoning: "low" });
  await app.runtime.run({ prompt: "four", sessionId: session.sessionId });
  assert.equal(seen[3].body.reasoning_effort, "low");
});

test("presets come from BRANCH_MODEL_PRESETS with keys read from named variables", () => {
  const presets = presetsFromEnv({
    BRANCH_MODEL_PRESETS: JSON.stringify([
      { id: "fast", name: "Fast", provider: "openai", endpoint: "https://api.example.com/v1", model: "small", apiKeyEnv: "FAST_KEY" },
    ]),
    FAST_KEY: "secret",
  });
  assert.deepEqual(presets.map((preset) => [preset.id, preset.provider.name, preset.model]), [["fast", "openai-compatible", "small"]]);
  // provider-audit: there is no demo model; no setting can name one.
  assert.throws(() => presetsFromEnv({ BRANCH_MODEL_PRESETS: JSON.stringify([{ id: "demo", name: "Demo", provider: "demo" }]) }));
  assert.throws(() => presetsFromEnv({ BRANCH_PROVIDER: "demo" }), /BRANCH_PROVIDER must be openai or anthropic/);
  assert.throws(() => presetsFromEnv({ BRANCH_MODEL_PRESETS: "nope" }), /must be JSON/);
  assert.throws(() => presetsFromEnv({ BRANCH_MODEL_PRESETS: JSON.stringify([
    { id: "x", name: "X", provider: "openai", endpoint: "https://api.example.com/v1", model: "m", apiKeyEnv: "MISSING" }]) }),
    /BRANCH_API_KEY is required/);
  const single = presetsFromEnv({ BRANCH_PROVIDER: "openai", BRANCH_ENDPOINT: "https://api.example.com/v1", BRANCH_MODEL: "m", BRANCH_API_KEY: "k" });
  assert.deepEqual(single.map((preset) => [preset.id, preset.name]), [["default", "Default connection"]]);
  // With no model named there are no presets at all: nothing falls back to the fixture.
  assert.deepEqual(presetsFromEnv({}), []);
});

test("with no model set up nothing is listed and every task is refused in plain words", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-no-model-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets: [] });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const models = app.runtime.models;
  assert.equal(models.configured, false);
  assert.deepEqual(models.summary("local").presets, []);
  const run = await app.runtime.run({ prompt: "hello" });
  assert.equal(run.status, "failed");
  assert.equal(run.output, noModelWords);
  assert.equal(finishedSetup(app), false, "a refusal is not a first answer");
  // A real connection added later answers at once, and removing it leaves no model again rather than failing.
  models.register({ id: "real", name: "Real", model: "m", provider: { name: "stub", complete: async () => ({ content: "hi", toolCalls: [] }) } });
  assert.equal(models.configured, true);
  const answered = await app.runtime.run({ prompt: "hello again" });
  assert.equal(answered.status, "completed");
  assert.equal(finishedSetup(app), true, "the first real answer finishes setup");
  assert.equal(models.remove("real"), true);
  assert.equal(models.configured, false);
});
const finishedSetup = (app) => app.store.get("settings", app.runtime.owner, "onboarding")?.data?.done === true;

test("a task kept on this computer never falls back to a connection elsewhere, nor do the later turns of its conversation", async (t) => {
  const { saveRoutingSettings } = await import("../dist/local-routing.js");
  const here = (name, behaviour) => Object.assign(scripted(name, behaviour), { embeddings: () => ({ endpoint: "http://127.0.0.1:11434/v1/embeddings" }) });
  let down = true;
  const local = here("here", () => { if (down) throw new ProviderHttpError(503); return { content: "here answered", toolCalls: [] }; });
  const cloud = scripted("cloud");
  const { app } = await fixture(t, [
    { id: "cloud", name: "Cloud", provider: cloud, model: "c" },
    { id: "here", name: "Here", provider: local, model: "h" },
  ], { retryPolicy: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 } });
  app.runtime.models.configure("local", { fallbackOrder: ["cloud"] });
  saveRoutingSettings(app.store, "local", { enabled: true });
  const kept = await app.runtime.run({ prompt: "Tidy this note: my passport number is 123456789 and my address is 1 Elm St" });
  assert.equal(kept.status, "failed", "the model here is down, so the task fails honestly");
  assert.equal(cloud.calls, 0, "it was not sent to the cloud connection in the fallback order");
  assert.ok(kinds(app, kept, "model.routed").some((event) => event.private === true));
  down = false;
  const first = await app.runtime.run({ prompt: "My bank account number is 12345678, please remember the sort code 01-02-03" });
  assert.equal(first.output, "here answered");
  const later = await app.runtime.run({ prompt: "Now summarise that in one line", sessionId: first.sessionId });
  assert.equal(later.output, "here answered", "the next turn carries the same words, so it stays here too");
  assert.equal(cloud.calls, 0);
  // A side job that names its own connection elsewhere (the advisor here) is answered here instead.
  const { saveSecondOpinionSettings } = await import("../dist/second-opinion.js");
  saveSecondOpinionSettings(app.store, "local", { advisor: true, advisorPreset: "cloud" });
  const advised = await app.runtime.run({ prompt: "And my date of birth is 1 May 1990", sessionId: first.sessionId });
  assert.equal(advised.output, "here answered");
  await app.runtime.idle?.();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(cloud.calls, 0, "the advisor did not reach the cloud connection");
  assert.ok(kinds(app, advised, "model.kept_here").some((event) => event.wanted === "cloud"), "and it says the advisor was answered here");
  saveSecondOpinionSettings(app.store, "local", { advisor: false });
  // An ordinary task in another conversation is not held here.
  const plain = await app.runtime.run({ prompt: "What is the capital of Peru?" });
  assert.equal(plain.output, "cloud answered");
});

test("a task kept on this computer with no model here is refused, never sent elsewhere", async (t) => {
  const { saveRoutingSettings } = await import("../dist/local-routing.js");
  const cloud = scripted("cloud");
  const { app } = await fixture(t, [{ id: "cloud", name: "Cloud", provider: cloud, model: "c" }]);
  saveRoutingSettings(app.store, "local", { enabled: true });
  const refused = await app.runtime.run({ prompt: "my password is hunter2, keep it safe" });
  assert.equal(refused.status, "failed");
  assert.match(refused.output, /stay on this computer/);
  assert.equal(cloud.calls, 0);
});

test("a caller other than the owner cannot name a cloud model to take a private task off this computer", async (t) => {
  const { saveRoutingSettings } = await import("../dist/local-routing.js");
  const here = Object.assign(scripted("here"), { embeddings: () => ({ endpoint: "http://127.0.0.1:11434/v1/embeddings" }) });
  const cloud = scripted("cloud");
  const { app } = await fixture(t, [
    { id: "cloud", name: "Cloud", provider: cloud, model: "c" },
    { id: "here", name: "Here", provider: here, model: "h" },
  ]);
  saveRoutingSettings(app.store, "local", { enabled: true });
  const outside = await app.runtime.run({ prompt: "my passport number is 123456789, summarise it", model: "cloud", source: "channel" });
  assert.equal(outside.output, "here answered", "a chat app's choice of model does not beat the owner's rule");
  assert.equal(cloud.calls, 0);
  const owners = await app.runtime.run({ prompt: "my passport number is 123456789, summarise it", model: "cloud" });
  assert.equal(owners.output, "cloud answered", "the owner's own explicit choice still wins");
});
