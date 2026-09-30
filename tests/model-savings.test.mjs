/**
 * R17-E (R17-044 … R17-051): models, cheaper and smarter. Every card ships off and leaves Branch
 * exactly as it was; each test then turns one card on and watches what the (fake) providers are
 * sent, which connection answers, and what is written down. No real service is ever called.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch, allSavings, saveSavings, readSavings, openRouterRouting, isOpenRouterEndpoint, readDifficulty,
  readingOf, chooseByDifficulty, withReported, noteReported, roundsOf, KeepAlive, MixtureProvider, syncMixtures,
  mixtureProblem, contextBudget, saveKnobs, openRouterBodyPart,
} from "../dist/index.js";
import { OpenAIProvider } from "../dist/providers.js";
import { startServer } from "../dist/server.js";
import { offersFlex, requestExtras } from "../dist/model-savings/hook.js";

const owner = "local";
const answer = (content, toolCalls = [], usage) => ({ content, toolCalls, ...(usage ? { usage } : {}) });
const planJson = '{"steps":[{"title":"Look it up","changes":false}]}';

/** A provider that answers from a function and remembers every request it was sent. */
function scripted(name, reply = () => answer("done")) {
  const provider = { name, requests: [], async complete(request) {
    provider.requests.push(request);
    const system = request.messages[0]?.content ?? "";
    if (/Summarize the conversation below/.test(system)) return answer("Handoff: short summary.");
    if (/You are planning a task/.test(system)) return answer(planJson);
    return reply(request, provider.requests.length);
  } };
  return provider;
}
const preset = (id, provider, model = id) => ({ id, name: id.toUpperCase(), provider, model });
async function fixture(t, presets, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-savings-"));
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets, ...extra });
  t.after(async () => { await app.close(); await discardTemp(root); });
  // dogfood D22: the room is the model's own now (a hosted one has far more); these conversations are held to the 20,000 they were written for.
  saveKnobs(app.store, app.runtime.owner, "compaction", { contextWindowTokens: 20000 });
  return { app, root };
}
const events = (app, runId, kind) => app.store.events(runId).filter((e) => e.kind === kind).map((e) => e.data);
const filler = (n) => `Turn ${n}: ` + "photo renaming details ".repeat(70);

test("every card that sends or spends ships off, and a fresh install sends and registers nothing extra", async (t) => {
  // The ship-on rule: the service's own token count and the per-round chart only read what came back, so they ship on;
  // pacing (Slow down near a rate limit) only waits, so it ships on too.
  const values = allSavings({ get: () => undefined }, owner);
  assert.deepEqual(values, {
    phases: { planModel: null, sideTier: "same" },
    openrouter: { mode: "off", sort: null, order: [], only: [], ignore: [], allowFallbacks: true, dataCollection: "allow" },
    difficulty: { mode: "off", classifierModel: null, easyModel: null, hardModel: null, mixHard: false },
    reportedTokens: { mode: "on" },
    roundChart: { mode: "on" },
    keepAlive: { mode: "off", everyMinutes: 4, maxPings: 3, spendCapDollars: 0.05 },
    mixtures: { mixtures: [] },
    pacing: { mode: "on" },
  });
  const main = scripted("anthropic");
  const { app } = await fixture(t, [preset("main", main, "claude-sonnet-4-5")]);
  const run = await app.runtime.run({ prompt: "hello" });
  assert.equal(run.status, "completed");
  assert.equal(main.requests.length, 1);
  assert.equal(main.requests[0].providerRouting, undefined, "no OpenRouter preferences are sent");
  assert.equal(app.runtime.keepAlive.waiting, 0, "no cache ping is waiting");
  assert.deepEqual([...app.runtime.models.presets.keys()], ["main"], "no mixture is added");
  assert.equal(events(app, run.id, "model.routed").length, 0);
  const budget = contextBudget({ limit: 20000, system: 10, catalog: 100, messages: 5000 });
  noteReported(app.store, "r-off", 1000, { input: 3000, output: 1 });
  saveSavings(app.store, owner, "reportedTokens", { mode: "off" });
  assert.equal(withReported(app.store, owner, "r-off", budget), budget, "switched off, the service's count is not used");
});

test("R17-044 plans are drafted by the planning connection; the work and the review keep the conversation's", async (t) => {
  const main = scripted("main"), planner = scripted("planner");
  const { app } = await fixture(t, [preset("main", main), preset("planner", planner)]);
  await app.runtime.run({ prompt: "look something up", plan: true });
  assert.equal(planner.requests.length, 0, "as shipped the conversation's own connection plans");
  saveSavings(app.store, owner, "phases", { planModel: "planner" });
  const before = main.requests.length;
  await app.runtime.run({ prompt: "look something up again", plan: true });
  assert.equal(planner.requests.length, 1, "the plan went to the planning connection");
  assert.match(planner.requests[0].messages[0].content, /You are planning a task/);
  assert.ok(main.requests.length > before, "the steps are still worked by the conversation's connection");
  assert.ok(main.requests.slice(before).every((r) => !/You are planning a task/.test(r.messages[0].content)));
  // R17-S11 (reused, not rebuilt): the sub-task and side-job models are the knobs' own.
  saveKnobs(app.store, owner, "subtasks", { sideJobModel: "planner" });
  assert.equal(readSavings(app.store, owner, "phases").planModel, "planner");
});

test("R17-045 side questions may ask OpenAI for flex; the main answer and every other service keep their tier", async (t) => {
  const openai = new OpenAIProvider({ endpoint: "https://api.openai.com/v1", model: "o4-mini", apiKey: "k" });
  const other = new OpenAIProvider({ endpoint: "https://openrouter.ai/api/v1", model: "x", apiKey: "k" });
  assert.equal(offersFlex({ id: "o", name: "O", provider: openai, model: "o4-mini" }), true);
  assert.equal(offersFlex({ id: "r", name: "R", provider: other, model: "x" }), false);
  assert.equal(offersFlex({ id: "f", name: "F", provider: scripted("fake"), model: "x" }), false);

  const main = scripted("main");
  const { app } = await fixture(t, [preset("main", main)]);
  const flexy = { id: "o", name: "O", provider: openai, model: "o4-mini" };
  assert.deepEqual(requestExtras(app.store, owner, flexy, true), {}, "as shipped nothing changes");
  saveSavings(app.store, owner, "phases", { sideTier: "flex" });
  assert.deepEqual(requestExtras(app.store, owner, flexy, true), { serviceTier: "flex" });
  assert.deepEqual(requestExtras(app.store, owner, flexy, false), {}, "the main answer keeps R17-S-B's tier");
  assert.deepEqual(requestExtras(app.store, owner, app.runtime.models.presets.get("main"), true), {}, "a service not known to offer flex is never asked");
  // R17-S12 (now in mac/cross-platform) still decides the main answer's tier.
  saveKnobs(app.store, owner, "reasoning", { serviceTier: "priority" });
  await app.runtime.run({ prompt: "hello" });
  assert.equal(main.requests.at(-1).serviceTier, "priority");
});

test("R17-046 OpenRouter preferences go only to openrouter.ai, and only when switched on", async (t) => {
  const bodies = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      bodies.push({ host: request.headers.host, body: JSON.parse(text) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const local = `http://127.0.0.1:${server.address().port}`;
  const routing = { sort: "price", ignore: ["deepinfra"], allow_fallbacks: false, data_collection: "deny" };
  const request = { messages: [{ role: "user", content: "hi" }], tools: [], signal: new AbortController().signal, maxTokens: 8, providerRouting: routing };
  await new OpenAIProvider({ endpoint: local, model: "m", apiKey: "k" }).complete(request);
  assert.equal(bodies[0].body.provider, undefined, "another OpenAI-shaped service never sees the preference");
  assert.equal(isOpenRouterEndpoint("https://openrouter.ai/api/v1"), true);
  assert.equal(isOpenRouterEndpoint("https://openrouter.ai.example.com/api/v1"), false);
  assert.equal(isOpenRouterEndpoint("https://evil-openrouter.ai/api/v1"), false);
  // What the OpenAI-shaped connection adds for openrouter.ai, checked without any network.
  assert.deepEqual(openRouterBodyPart("https://openrouter.ai/api/v1", routing), { provider: routing });
  assert.deepEqual(openRouterBodyPart(local, routing), {});
  assert.deepEqual(openRouterBodyPart("https://openrouter.ai/api/v1", undefined), {});

  const store = { saved: {}, get(kind, who, key) { return this.saved[key] ? { data: this.saved[key] } : undefined; }, save(kind, who, key, data) { this.saved[key] = data; } };
  assert.equal(openRouterRouting(store, owner), null);
  saveSavings(store, owner, "openrouter", { sort: "price" });
  assert.equal(openRouterRouting(store, owner), null, "saved but switched off sends nothing");
  saveSavings(store, owner, "openrouter", { mode: "on", ignore: ["deepinfra"], allowFallbacks: false, dataCollection: "deny" });
  assert.deepEqual(openRouterRouting(store, owner), routing);

  const main = scripted("main");
  const { app } = await fixture(t, [preset("main", main)]);
  saveSavings(app.store, owner, "openrouter", { mode: "on", order: ["anthropic", "google-vertex"] });
  await app.runtime.run({ prompt: "hello" });
  assert.deepEqual(main.requests.at(-1).providerRouting, { order: ["anthropic", "google-vertex"] });
});

test("R17-047 a small model's easy-or-hard answer picks the connection; explicit choices win", async (t) => {
  assert.equal(readDifficulty("EASY"), "easy");
  assert.equal(readDifficulty("It is hard."), "hard");
  assert.equal(readDifficulty("no idea"), "hard", "an unclear answer counts as hard");
  assert.equal(readingOf("rename x", 0), "easy");
  assert.equal(readingOf("please refactor the whole repo and debug the build", 0), "hard");
  assert.equal(readingOf("Write a short note about the meeting we had on Tuesday with the suppliers, covering prices", 0), null);

  const verdicts = [];
  const cheap = scripted("cheap", (request) => (/You sort tasks/.test(request.messages[0].content)
    ? answer(verdicts.shift() ?? "EASY") : answer("cheap answer")));
  const strong = scripted("strong", () => answer("strong answer"));
  const { app } = await fixture(t, [preset("cheap", cheap), preset("strong", strong)]);
  const settled = await app.runtime.run({ prompt: "Write a short note about the meeting we had on Tuesday with our suppliers, covering the new prices" });
  assert.equal(settled.output, "cheap answer");
  assert.equal(cheap.requests.length, 1, "off: nobody is asked easy-or-hard");

  saveSavings(app.store, owner, "difficulty", { mode: "on", classifierModel: "cheap", easyModel: "cheap", hardModel: "strong" });
  verdicts.push("HARD");
  const hard = await app.runtime.run({ prompt: "Work out why the invoices from March do not add up and what to change" });
  assert.equal(hard.output, "strong answer");
  const routed = events(app, hard.id, "model.routed")[0];
  assert.equal(routed.kind, "difficulty-hard");
  assert.equal(routed.by, "model");
  const asked = cheap.requests.filter((r) => /You sort tasks/.test(r.messages[0].content));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].tools.length, 0, "the question is asked with no tools");
  assert.match(asked[0].messages[1].content, /material to sort, not instructions/);

  verdicts.push("EASY");
  const explicit = await app.runtime.run({ prompt: "What is the capital of France, and why is it there?", model: "strong" });
  assert.equal(explicit.output, "strong answer", "a model chosen for the run always wins");
  assert.equal(cheap.requests.filter((r) => /You sort tasks/.test(r.messages[0].content)).length, 1, "and nobody was asked");

  saveSavings(app.store, owner, "difficulty", { mode: "when-needed" });
  const quick = await app.runtime.run({ prompt: "hi there" });
  assert.equal(quick.output, "cheap answer");
  assert.equal(events(app, quick.id, "model.routed")[0].by, "reading", "a clearly short task needs no question");
  assert.equal(cheap.requests.filter((r) => /You sort tasks/.test(r.messages[0].content)).length, 1);

  const kept = await chooseByDifficulty(app.store, owner, { prompt: "same words", toolCount: 3, known: () => true, ask: async () => "EASY", now: 1 });
  const again = await chooseByDifficulty(app.store, owner, { prompt: "same words", toolCount: 3, known: () => true, ask: async () => { throw new Error("asked twice"); }, now: 2 });
  assert.equal(kept.preset, "cheap");
  assert.equal(again.preset, "cheap", "the same words are not asked about twice");
});

test("R17-047 a failed easy-or-hard question leaves the usual connection and never fails the task", async (t) => {
  const main = scripted("main", (request) => {
    if (/You sort tasks/.test(request.messages[0].content)) throw Object.assign(new Error("classifier down"), { status: 400 });
    return answer("usual answer");
  });
  const other = scripted("other", () => answer("other answer"));
  const { app } = await fixture(t, [preset("main", main), preset("other", other)]);
  saveSavings(app.store, owner, "difficulty", { mode: "on", easyModel: "main", hardModel: "other" });
  const run = await app.runtime.run({ prompt: "Write a short note about the meeting we had on Tuesday with our suppliers, covering the new prices" });
  assert.equal(run.status, "completed");
  assert.equal(run.output, "usual answer");
  assert.match(events(app, run.id, "model.routed")[0].reason, /easy-or-hard question failed/);
});

test("R17-048 with the card on, the service's larger count folds a conversation the estimate would keep", async (t) => {
  // The service says each request is three times what Branch estimates.
  const run = async (mode) => {
    // Two rounds in the second task: the first asks for a tool and reports a request four times the
    // estimate; the second round decides whether to fold with that in hand.
    let phase = "start", rounds = 0;
    const main = scripted("main", () => {
      if (phase !== "measure") return answer("ok");
      rounds++;
      if (rounds === 1) return answer("", [{ id: "c1", name: "memory.search", arguments: '{"query":"x"}' }], { input: 90_000, output: 5 });
      return answer("next");
    });
    const { app } = await fixture(t, [preset("main", main)]);
    saveSavings(app.store, owner, "reportedTokens", { mode });
    const first = await app.runtime.run({ prompt: "start" });
    for (let n = 1; n <= 12; n++) app.store.message(first.sessionId, { role: n % 2 ? "user" : "assistant", content: filler(n) });
    phase = "measure";
    const next = await app.runtime.run({ prompt: "next?", sessionId: first.sessionId });
    return { app, next };
  };
  const off = await run("off");
  assert.equal(events(off.app, off.next.id, "context.compacted").length, 0, "off: the estimate alone does not fold");
  const on = await run("on");
  assert.equal(events(on.app, on.next.id, "context.compacted").length, 1, "on: the service's count folds it");
  assert.ok(events(on.app, on.next.id, "context.compacting").length >= 1, "a fold in progress is written down first");

  const budget = contextBudget({ limit: 20000, system: 10, catalog: 100, messages: 5000 });
  const store = { get: () => ({ data: { mode: "on" } }) };
  noteReported(store, "r-down", 1000, { input: 500, output: 1 });
  assert.equal(withReported(store, owner, "r-down", budget), budget, "a smaller count never delays a fold");
  noteReported(store, "r-up", 1000, { input: 100000, output: 1 });
  const raised = withReported(store, owner, "r-up", budget);
  assert.equal(raised.messages, 20000, "the ratio is capped at four");
  assert.equal(raised.threshold, budget.threshold);
  assert.equal(raised.headroom, budget.headroom, "the room left, which can refuse a request, is never changed");
});

test("R17-049 one conversation, round by round, with cache and folds", async (t) => {
  const main = scripted("main", () => answer("ok", [], { input: 900, output: 40, cachedInput: 600 }));
  const { app } = await fixture(t, [preset("main", main)]);
  const first = await app.runtime.run({ prompt: "start" });
  for (let n = 1; n <= 40; n++) app.store.message(first.sessionId, { role: n % 2 ? "user" : "assistant", content: filler(n) });
  await app.runtime.run({ prompt: "next?", sessionId: first.sessionId });
  const view = roundsOf(app.store, owner, first.sessionId);
  assert.ok(view.rounds.length >= 2);
  const measured = view.rounds.find((row) => row.measured);
  assert.deepEqual({ input: measured.input, output: measured.output, cached: measured.cached }, { input: 900, output: 40, cached: 600 });
  assert.equal(view.folds.length, 1);
  assert.equal(view.folds[0].done, true);
  assert.ok(view.folds[0].before > view.folds[0].after);
  assert.equal(view.folding, false);
  assert.equal(typeof view.towardsFold, "number");
  assert.throws(() => roundsOf(app.store, "someone-else", first.sessionId), /Conversation not found/);
});

test("R17-050 keeping the cache warm needs its switch, stops at its pings and cap, and counts every ping", async (t) => {
  const timers = [];
  const fakeTimers = { set: (run, ms) => { const handle = { run, ms, cleared: false }; timers.push(handle); return handle; }, clear: (handle) => { if (handle) handle.cleared = true; } };
  const saved = {};
  const logged = [];
  const store = { get: (kind, who, key) => (saved[key] ? { data: saved[key] } : undefined), event: (runId, kind, data) => logged.push({ kind, data }) };
  const keep = new KeepAlive(store, fakeTimers);
  let sent = 0;
  const ping = { runId: "r1", price: 0.02, send: async () => { sent++; } };
  keep.arm(owner, "s1", "anthropic", ping);
  assert.equal(timers.length, 0, "off: nothing is scheduled");

  saved["model-savings-keepAlive"] = { mode: "on", everyMinutes: 4, maxPings: 5, spendCapDollars: 0.05 };
  keep.arm(owner, "s1", "openai-compatible", ping);
  assert.equal(timers.length, 0, "only Claude connections are kept warm");
  keep.arm(owner, "s1", "anthropic", ping);
  assert.equal(timers.at(-1).ms, 240000);
  await timers.at(-1).run();
  await timers.at(-1).run();
  await timers.at(-1).run();
  assert.equal(sent, 2, "the third ping would pass the $0.05 cap, so it is not sent");
  assert.match(logged.at(-1).data.reason, /spending cap/);
  assert.equal(keep.waiting, 0);

  saved["model-savings-keepAlive"] = { mode: "on", everyMinutes: 1, maxPings: 1, spendCapDollars: 5 };
  keep.arm(owner, "s2", "anthropic", ping);
  await timers.at(-1).run();
  await timers.at(-1).run();
  assert.equal(sent, 3);
  assert.match(logged.at(-1).data.reason, /number of pings/);

  keep.arm(owner, "s3", "anthropic", { ...ping, price: null });
  await timers.at(-1).run();
  assert.equal(sent, 3, "a model with no price is never pinged");
  assert.match(logged.at(-1).data.reason, /no price/);

  keep.arm(owner, "s5", "anthropic", { ...ping, send: async () => { throw new Error("the service refused"); } });
  await timers.at(-1).run();
  assert.match(logged.at(-1).data.reason, /stopped: the service refused/, "a failed ping stops the pause and says why");
  assert.equal(timers.filter((one) => !one.cleared).length >= 1, true);
  const afterFailure = timers.length;
  assert.equal(keep.waiting, 0, "nothing more is scheduled after a failure");
  assert.equal(timers.length, afterFailure);

  keep.arm(owner, "s4", "anthropic", ping);
  const pending = timers.at(-1);
  keep.arm(owner, "s4", "anthropic", ping);
  assert.equal(pending.cleared, true, "a new round restarts the pause");
  keep.stop();
  assert.equal(timers.at(-1).cleared, true);

  // In the app: the ping goes to the same connection with one token and lands in the task's usage.
  const claude = scripted("anthropic", () => answer("hi", [], { input: 1000, output: 3 }));
  const { app } = await fixture(t, [preset("claude", claude, "claude-3-5-sonnet-latest")]);
  saveSavings(app.store, owner, "keepAlive", { mode: "on" });
  const run = await app.runtime.run({ prompt: "hello" });
  assert.equal(app.runtime.keepAlive.waiting, 1);
  const before = app.store.usage(run.id).reportedInput;
  const warm = new KeepAlive(app.store, fakeTimers);
  // The runtime's own pause is replaced by one on the fake clock, with the same ping the runtime built.
  const { afterRound } = await import("../dist/model-savings/hook.js");
  afterRound(app.runtime, warm, { run, owner, preset: app.runtime.models.presets.get("claude"), messages: claude.requests[0].messages,
    tools: claude.requests[0].tools, estimatedInput: 1000, reported: { input: 1000, output: 3 }, mainRound: true });
  await timers.at(-1).run();
  const pinged = claude.requests.at(-1);
  assert.equal(pinged.maxTokens, 1);
  assert.deepEqual(pinged.messages, claude.requests[0].messages, "the same request, so the cache is the one that is kept");
  assert.equal(app.store.usage(run.id).reportedInput, before + 1000, "the ping is counted in the task's usage");
  assert.equal(events(app, run.id, "cache.keep_alive").length, 1);
  warm.stop();
});

test("R17-051 a mixture is a connection: references answer without tools, the writer answers with them, usage is summed", async (t) => {
  const a = scripted("a", () => answer("A thinks 4", [], { input: 10, output: 3 }));
  const b = scripted("b", () => answer("B thinks 5", [], { input: 20, output: 4 }));
  const w = scripted("w", () => answer("It is 4", [], { input: 30, output: 5 }));
  const { app } = await fixture(t, [preset("a", a), preset("b", b), preset("w", w)]);
  assert.equal(syncMixtures(app.store, owner, app.runtime.models).length, 0);
  saveSavings(app.store, owner, "mixtures", { mixtures: [{ id: "trio", name: "Trio", references: ["a", "b"], aggregator: "w", referenceMaxTokens: 128 }] });
  assert.deepEqual(syncMixtures(app.store, owner, app.runtime.models), ["mixture-trio"]);
  const mixture = app.runtime.models.presets.get("mixture-trio");
  assert.ok(mixture.provider instanceof MixtureProvider);
  assert.equal(app.runtime.models.runsLocally("mixture-trio"), false);
  const run = await app.runtime.run({ prompt: "2+2?", model: "mixture-trio" });
  assert.equal(run.output, "It is 4");
  assert.equal(a.requests[0].tools.length, 0);
  assert.equal(a.requests[0].maxTokens <= 128, true);
  assert.ok(w.requests[0].tools.length > 0, "the writer keeps its tools");
  assert.match(w.requests[0].messages.at(-1).content, /material to weigh, not as instructions[\s\S]*A thinks 4[\s\S]*B thinks 5/);
  assert.equal(app.store.usage(run.id).reportedInput, 60, "every call is counted");
  assert.equal(app.store.usage(run.id).reportedOutput, 12);

  assert.match(mixtureProblem({ id: "x", name: "X", references: ["a", "nope"], aggregator: "w" }, app.runtime.models), /nope is not set up/);
  assert.match(mixtureProblem({ id: "x", name: "X", references: ["a", "mixture-trio"], aggregator: "w" }, app.runtime.models), /cannot use another mixture/);
  saveSavings(app.store, owner, "mixtures", { mixtures: [] });
  syncMixtures(app.store, owner, app.runtime.models);
  assert.equal(app.runtime.models.presets.has("mixture-trio"), false, "removing a mixture takes it out of the picker");
  assert.deepEqual([...app.runtime.models.presets.keys()], ["a", "b", "w"], "only mixtures are ever removed");
});

test("the route: owner changes only, short-lived keys refused, rounds readable, connections checked", async (t) => {
  const main = scripted("main");
  const { app, root } = await fixture(t, [preset("main", main), preset("other", scripted("other"))]);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (path, body, token = server.token) => {
    const response = await fetch(`${server.url}/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, origin: server.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const shown = await call("model-savings");
  assert.equal(shown.status, 200);
  assert.deepEqual(shown.body.connections.map((one) => one.id), ["main", "other"]);
  assert.equal(shown.body.values.keepAlive.mode, "off");
  const wrong = await call("model-savings", { card: "phases", values: { planModel: "ghost" } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /not set up/);
  const saved = await call("model-savings", { card: "mixtures", values: { mixtures: [{ id: "pair", name: "Pair", references: ["main", "other"], aggregator: "main" }] } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.liveMixtures, ["mixture-pair"]);
  assert.ok(!saved.body.connections.some((one) => one.id === "mixture-pair"), "a mixture is not offered as a member of another");
  const reset = await call("model-savings", { card: "mixtures", reset: true });
  assert.deepEqual(reset.body.liveMixtures, []);

  const run = await app.runtime.run({ prompt: "hello" });
  const rounds = await call(`model-savings/rounds?session=${run.sessionId}`);
  assert.equal(rounds.status, 200);
  assert.equal(rounds.body.rounds.length, 1);
  assert.equal((await call("model-savings/rounds?session=nope")).status, 404);

  const runKey = app.sessionTokens.create(app.runtime.owner, { name: "script", scope: "run", minutes: 5 }).token;
  const refused = await call("model-savings", { card: "keepAlive", values: { mode: "on" } }, runKey);
  assert.equal(refused.status, 401);
  assert.match(refused.body.error, /short-lived key cannot change how models are chosen/);
  assert.equal(readSavings(app.store, owner, "keepAlive").mode, "off", "nothing was switched on");
  assert.equal((await call(`model-savings/rounds?session=${run.sessionId}`, undefined, runKey)).status, 200, "reading the rounds is a look");
});

// ── Integration review (integrate/mac7-r17-e): the holes the adversarial pass found. ──

test("review: difficulty.ts holds no raw NUL bytes, and its kept answers are per app and bounded", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/model-savings/difficulty.ts", import.meta.url));
  assert.equal(source.includes(0), false, "a raw NUL byte makes the file binary to git and to reviewers");
  const card = { data: { mode: "on", easyModel: "e", hardModel: "h" } };
  const first = { get: () => card }, second = { get: () => card };
  let asked = 0;
  const ask = async () => { asked++; return "EASY"; };
  const input = (prompt, now = 1) => ({ prompt, toolCount: 3, known: () => true, ask, now });
  await chooseByDifficulty(first, owner, input("same words"));
  await chooseByDifficulty(second, owner, input("same words"));
  assert.equal(asked, 2, "another app never reuses this app's answer");
  await chooseByDifficulty(first, owner, input("same words"));
  assert.equal(asked, 2, "the same app does");
  for (let n = 0; n < 300; n++) await chooseByDifficulty(first, owner, input(`task ${n}`));
  asked = 0;
  await chooseByDifficulty(first, owner, input("task 299"));
  assert.equal(asked, 0, "recent answers are kept");
  await chooseByDifficulty(first, owner, input("task 0"));
  assert.equal(asked, 1, "the oldest are dropped, so memory stays bounded");
});

test("R17-047 the easy-or-hard question goes to the owner's pick, else a model on this computer, else the easy connection", async () => {
  const cardWith = (classifierModel) => ({ get: () => ({ data: { mode: "on", easyModel: "e", hardModel: "h", classifierModel } }) });
  const askedOf = async (store, prompt, localPreset) => {
    const asked = [];
    const choice = await chooseByDifficulty(store, owner, { prompt, toolCount: 3, known: () => true, localPreset,
      ask: async (preset) => { asked.push(preset); return "EASY"; } });
    return { asked, reason: choice.reason };
  };
  const explicit = await askedOf(cardWith("small"), "explicit pick", "here");
  assert.deepEqual(explicit.asked, ["small"], "the owner's own pick always wins, even with a model on this computer");
  assert.match(explicit.reason, /^small called this task easy/);

  const local = await askedOf(cardWith(null), "local model", "here");
  assert.deepEqual(local.asked, ["here"], "with no pick, the free model on this computer is asked");
  assert.match(local.reason, /^here called this task easy/);

  const none = await askedOf(cardWith(null), "no local model", null);
  assert.deepEqual(none.asked, ["e"], "with no model on this computer, the easy connection is asked, as before");
  assert.match(none.reason, /^e called this task easy/);

  const missing = await chooseByDifficulty(cardWith(null), owner, { prompt: "local not in picker", toolCount: 3,
    known: (id) => id !== "here", localPreset: "here", ask: async (preset) => { assert.equal(preset, "e"); return "HARD"; } });
  assert.equal(missing.reason, "e called this task hard", "a local connection missing from the model picker is not asked");

  // The model on this computer is not answering: the easy connection answers, once, and its answer is the one kept.
  const store = cardWith(null);
  let asked = [];
  const localDown = async (preset) => { asked.push(preset); if (preset === "here") throw new Error("local server stopped"); return "HARD"; };
  const down = (now) => chooseByDifficulty(store, owner, { prompt: "local is down", toolCount: 3, known: () => true, localPreset: "here", ask: localDown, now });
  const fellBack = await down(1);
  assert.deepEqual(asked, ["here", "e"], "local throws, so the easy connection is asked once");
  assert.equal(fellBack.reason, "e called this task hard", "the reason names the model that answered");
  assert.equal(fellBack.difficulty, "hard");
  asked = [];
  assert.equal((await down(2)).reason, "e called this task hard");
  assert.deepEqual(asked, ["here"], "the kept answer is filed under the easy connection, which is not asked again");
  const fine = await chooseByDifficulty(store, owner, { prompt: "local is down", toolCount: 3, known: () => true, localPreset: "here",
    ask: async () => "EASY", now: 3 });
  assert.equal(fine.reason, "here called this task easy", "nothing was kept under the local model while it was down");

  // An owner's own pick that fails is not retried: the error goes up to the hook, as it always did.
  await assert.rejects(chooseByDifficulty(cardWith("small"), owner, { prompt: "picked is down", toolCount: 3, known: () => true, localPreset: "here",
    ask: async (preset) => { if (preset === "small") throw new Error("picked model down"); return "EASY"; } }), /picked model down/);
});

test("review: reported counts are per app, ignore nonsense, and stay capped at four", () => {
  const on = { get: () => ({ data: { mode: "on" } }) };
  const other = { get: () => ({ data: { mode: "on" } }) };
  const budget = contextBudget({ limit: 20000, system: 10, catalog: 100, messages: 5000 });
  noteReported(on, "shared-id", 1000, { input: 1e12, output: 1 });
  assert.equal(withReported(on, owner, "shared-id", budget).messages, 20000, "an absurd count is still capped at four");
  assert.equal(withReported(other, owner, "shared-id", budget), budget, "another app's count is never used");
  noteReported(other, "nan", 1000, { input: Number.NaN, output: 1 });
  noteReported(other, "inf", 1000, { input: Number.POSITIVE_INFINITY, output: 1 });
  assert.equal(withReported(other, owner, "nan", budget), budget);
  assert.equal(withReported(other, owner, "inf", budget), budget);
});

test("review: cache pings stop on Lockdown, a gone conversation, a spent budget, and when Branch is locked", async (t) => {
  const timers = [];
  const fakeTimers = { set: (run, ms) => { const handle = { run, ms, cleared: false }; timers.push(handle); return handle; }, clear: (handle) => { if (handle) handle.cleared = true; } };
  const logged = [];
  const store = { get: () => ({ data: { mode: "on", everyMinutes: 4, maxPings: 5, spendCapDollars: 5 } }), event: (runId, kind, data) => logged.push({ kind, data }) };
  const keep = new KeepAlive(store, fakeTimers);
  let sent = 0, refusal = null;
  keep.arm(owner, "s1", "anthropic", { runId: "r1", price: 0.001, send: async () => { sent++; }, refusal: () => refusal });
  await timers.at(-1).run();
  assert.equal(sent, 1);
  refusal = "Lockdown is on";
  await timers.at(-1).run();
  assert.equal(sent, 1, "a refusal found at ping time stops the pings");
  assert.match(logged.at(-1).data.reason, /Lockdown is on/);
  assert.equal(keep.waiting, 0);

  const claude = scripted("anthropic", () => answer("hi", [], { input: 1000, output: 3 }));
  const { app } = await fixture(t, [preset("claude", claude, "claude-3-5-sonnet-latest")]);
  saveSavings(app.store, owner, "keepAlive", { mode: "on" });
  const { pingRefusal } = await import("../dist/model-savings/hook.js");
  const run = await app.runtime.run({ prompt: "hello" });
  assert.equal(app.runtime.keepAlive.waiting, 1);
  const check = (active = false) => pingRefusal(app.store, owner, { sessionId: run.sessionId, family: [run.id], model: "claude-3-5-sonnet-latest", active: () => active, monthly: () => null });
  assert.equal(check(), null);
  assert.match(check(true), /conversation is working/);
  app.store.addUsage(run.id, 0, 0, { input: 10000, output: 0 });
  saveKnobs(app.store, owner, "limits", { spendCapDollars: 0.01 });
  assert.match(check(), /limit/);
  saveKnobs(app.store, owner, "limits", { spendCapDollars: null });
  assert.match(pingRefusal(app.store, owner, { sessionId: "gone", family: [run.id], model: "m", active: () => false, monthly: () => null }), /conversation is gone/);
  assert.match(pingRefusal(app.store, owner, { sessionId: run.sessionId, family: [run.id], model: "m", active: () => false, monthly: () => "Monthly budget reached." }), /Monthly budget/);
  app.store.save("settings", owner, "lockdown", { on: true, since: null, before: {} });
  assert.match(check(), /Lockdown/);
  app.store.save("settings", owner, "lockdown", { on: false, since: null, before: {} });
  app.sessionLock.lock();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.runtime.keepAlive.waiting, 0, "locking Branch stops the pings");
});

test("review: a household person cannot read the owner's rounds", async (t) => {
  const { app } = await fixture(t, [preset("main", scripted("main"))]);
  const run = await app.runtime.run({ prompt: "hello" });
  const { savingsApi } = await import("../dist/model-savings/api.js");
  const { asPerson } = await import("../dist/people/context.js");
  const url = new URL(`http://branch.invalid/api/model-savings/rounds?session=${run.sessionId}`);
  const read = () => savingsApi(app, { method: "GET" }, "/api/model-savings/rounds", url, async () => ({}));
  assert.equal((await read()).rounds.length, 1);
  await assert.rejects(asPerson({ profileId: "p1", keyId: "k1" }, read), (error) => error.status === 403);
});

test("review: service_tier goes only to OpenAI's own address or Azure, on both OpenAI routes", async (t) => {
  const { serviceTierPart } = await import("../dist/providers.js");
  const { OpenAIResponsesProvider } = await import("../dist/providers/openai-responses.js");
  assert.deepEqual(serviceTierPart("https://api.openai.com/v1", "flex"), { service_tier: "flex" });
  assert.deepEqual(serviceTierPart("https://mine.openai.azure.com/openai", "priority"), { service_tier: "priority" });
  assert.deepEqual(serviceTierPart("https://openrouter.ai/api/v1", "flex"), {});
  assert.deepEqual(serviceTierPart("https://api.openai.com.evil.example/v1", "flex"), {});
  assert.deepEqual(serviceTierPart("https://api.openai.com/v1", undefined), {});

  const bodies = [];
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => { text += chunk; });
    request.on("end", () => {
      bodies.push(JSON.parse(text));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }], output: [] }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const local = `http://127.0.0.1:${server.address().port}`;
  const request = { messages: [{ role: "user", content: "hi" }], tools: [], signal: new AbortController().signal, maxTokens: 8, serviceTier: "flex" };
  await new OpenAIProvider({ endpoint: local, model: "m", apiKey: "k" }).complete(request);
  assert.equal(bodies.at(-1).service_tier, undefined, "another OpenAI-shaped service never sees the tier");

  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ output: [] }), { status: 200, headers: { "content-type": "application/json" } }); };
  await new OpenAIResponsesProvider({ endpoint: "https://api.openai.com/v1", model: "m", apiKey: "k", fetchImpl }).complete(request);
  assert.equal(sent.at(-1).body.service_tier, "flex", "the Responses route carries the tier to OpenAI");
  await new OpenAIResponsesProvider({ endpoint: local, model: "m", apiKey: "k", fetchImpl }).complete(request);
  assert.equal(sent.at(-1).body.service_tier, undefined, "and nowhere else");
});

test("review: current Claude models have prices, so a Claude cache ping can keep its cap", async () => {
  const { tablePrice } = await import("../dist/pricing.js");
  assert.deepEqual(tablePrice("claude-opus-5"), { input: 5, output: 25, cached: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 });
  assert.deepEqual(tablePrice("claude-sonnet-4-5-20250929"), { input: 3, output: 15, cached: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 });
  assert.deepEqual(tablePrice("claude-haiku-4-5"), { input: 1, output: 5, cached: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 });
  assert.deepEqual(tablePrice("claude-sonnet-5"), { input: 2, output: 10, cached: 0.2, cacheWrite: 2.5, cacheWrite1h: 4 });
  assert.deepEqual(tablePrice("claude-opus-5-5"), { input: 4, output: 20, cached: 0.2, cacheWrite: 5, cacheWrite1h: 8 });
});

test("review: a mixture is priced at its dearest known member, and its summed cost meets the task limit and the month", async (t) => {
  const { pricedAs, spendCapCheck } = await import("../dist/index.js");
  const big = { input: 400, output: 100 };
  const a = scripted("a", () => answer("A", [], big));
  const b = scripted("b", () => answer("B", [], big));
  const w = scripted("w", () => answer("done", [], big));
  const presets = [preset("a", a, "mystery-model"), preset("b", b, "claude-opus-4-1"), preset("w", w, "claude-haiku-4-5")];
  const { app } = await fixture(t, presets);
  const mix = { id: "trio", name: "Trio", references: ["a", "b"], aggregator: "w", referenceMaxTokens: 128 };
  const resolve = (id) => app.runtime.models.presets.get(id);
  assert.equal(pricedAs(mix, resolve), "claude-opus-4-1", "an unpriced member never drops the price to the writer's");
  saveSavings(app.store, owner, "mixtures", { mixtures: [mix] });
  syncMixtures(app.store, owner, app.runtime.models);
  const run = await app.runtime.run({ prompt: "2+2?", model: "mixture-trio" });
  assert.equal(app.store.usage(run.id).reportedInput, 1200, "all three calls are in the task's usage");
  saveKnobs(app.store, owner, "limits", { spendCapDollars: 0.02 });
  // 1200 in at $15 + 300 out at $75 per million = $0.0405, over the $0.02 limit.
  assert.match(spendCapCheck(app.store, owner, [run.id], resolve("mixture-trio").model).refusal ?? "", /limit/);
  const month = app.store.usageStore().getMonthlyStats(undefined, {});
  assert.ok(month.estimatedCost >= 0.04, `the month counts the whole mixture (${month.estimatedCost})`);
});
