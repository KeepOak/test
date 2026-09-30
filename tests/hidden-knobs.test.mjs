/**
 * R17-S08 … R17-S14: every knob that used to be hidden is a setting, ships as today's behaviour, and
 * really changes what Branch does when the owner moves it. Each test sets one card through the same
 * functions the screen's route uses and watches the runtime, the provider request or the file.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch, readKnobs, saveKnobs, allKnobs, contextWindow, compactionThresholdFor, toolLimits, retryPolicyFor,
  refusedEnvironmentName, passedEnvironment, withoutThinking, thinkingFilter, leakOptions,
  memoryProvider, saveMemoryProvider, launchFileView, saveLaunchFile, memorySnapshotLimits, commandTuning,
} from "../dist/index.js";
import { findLeaks, redactLeaks } from "../dist/leak-guard.js";
import { openaiBody, anthropicBody } from "../dist/providers.js";
import { ProviderHttpError } from "../dist/provider-retry.js";
import { BranchShell } from "../dist/integrations/shell.js";
import { ShellSessions } from "../dist/shell-session.js";
import { askMode } from "../dist/asks/settings.js";

const owner = "local";
const answer = (content, toolCalls = []) => ({ content, toolCalls });

/** A provider that answers from a function and remembers every request it was sent. */
function scripted(name, reply = () => answer("done")) {
  const provider = { name, requests: [], async complete(request) {
    provider.requests.push(request);
    if (/Summarize the conversation below/.test(request.messages[0]?.content ?? "")) return answer("Handoff: short summary.");
    return reply(request, provider.requests.length);
  } };
  return provider;
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-knobs-"));
  const provider = options.provider ?? scripted("main");
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options.extra });
  t.after(async () => { await app.close(); await discardTemp(root); });
  // dogfood D22: the room is the model's own now (a hosted one has far more); these conversations are held to the 20,000 they were written for.
  saveKnobs(app.store, owner, "compaction", { contextWindowTokens: 20000 });
  return { app, root, provider };
}
const filler = (n) => `Turn ${n}: ` + "photo renaming details ".repeat(70);
const summarised = (provider) => provider.requests.some((r) => /Summarize the conversation below/.test(r.messages[0].content));
const events = (app, runId, kind) => app.store.events(runId).filter((e) => e.kind === kind);
async function longConversation(app, turns) {
  const first = await app.runtime.run({ prompt: "start" });
  for (let n = 1; n <= turns; n++) app.store.message(first.sessionId, { role: n % 2 ? "user" : "assistant", content: filler(n) });
  return first.sessionId;
}

test("every card ships as today's behaviour (a new limit, messages per conversation per hour, ships at 60)", (t) => {
  const store = { get: () => undefined };
  const values = allKnobs(store, owner);
  assert.deepEqual(values.compaction, { autoCompact: true, compactAtPercent: null, keepRecentMessages: 6, contextWindowTokens: null });
  assert.deepEqual(values.limits, { maxSteps: null, spendCapDollars: null, apiRetries: null, localFirstReplySeconds: null, maxModelRounds: null, maxTaskTokens: null, messagesPerConversationHour: 60 });
  assert.deepEqual(values.commands, { toolAnswerChars: null, toolTimeoutSeconds: null, commandTimeoutSeconds: null, keptOpenShell: true, passEnvironment: [] });
  assert.deepEqual(values.subtasks, { subtaskModel: null, sideJobModel: null, parallelSubtasks: 4, subtaskTimeoutSeconds: 120 });
  assert.deepEqual(values.reasoning, { effortByModel: {}, showReasoning: true, serviceTier: "standard" });
  assert.deepEqual(values.memory, { snapshotFacts: memorySnapshotLimits.facts, snapshotChars: memorySnapshotLimits.chars, aboutYouOn: true, aboutYou: "", aboutYouChars: 1500 }); // defaults audit: the note is used once written
  assert.deepEqual(values.leakGuard, { sensitivity: "standard", exceptions: [] });
  assert.equal(contextWindow(store, owner, 20000), 20000);
  const budget = { limit: 20000, threshold: 12345 };
  assert.equal(compactionThresholdFor(store, owner, budget), 12345);
  assert.deepEqual(toolLimits(store, owner, { toolResultChars: 12000, toolTimeoutMs: 90000 }), { toolResultChars: 12000, toolTimeoutMs: 90000 });
  const policy = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 };
  assert.equal(retryPolicyFor(store, owner, policy), policy);
  assert.deepEqual(leakOptions(store, owner), {});
});

test("R17-S08 switching summaries off stops a long conversation being folded", async (t) => {
  const on = await fixture(t);
  const run = await on.app.runtime.run({ prompt: "next?", sessionId: await longConversation(on.app, 40) });
  assert.ok(summarised(on.provider), "as shipped, a long conversation is folded");
  assert.equal(events(on.app, run.id, "context.compacted").length, 1);

  const off = await fixture(t);
  saveKnobs(off.app.store, owner, "compaction", { autoCompact: false });
  const kept = await off.app.runtime.run({ prompt: "next?", sessionId: await longConversation(off.app, 40) });
  assert.ok(!summarised(off.provider), "with summaries off nothing is folded");
  assert.equal(events(off.app, kept.id, "context.compacted").length, 0);
});

test("R17-S08 the share of the room and a larger window move when folding happens", async (t) => {
  const early = await fixture(t);
  const session = await longConversation(early.app, 12);
  await early.app.runtime.run({ prompt: "as shipped", sessionId: session });
  assert.ok(!summarised(early.provider), "twelve turns fit as shipped");
  saveKnobs(early.app.store, owner, "compaction", { compactAtPercent: 20 });
  const folded = await early.app.runtime.run({ prompt: "now at 20%", sessionId: session });
  assert.equal(events(early.app, folded.id, "context.compacted")[0].data.threshold, 4000);

  const roomy = await fixture(t);
  saveKnobs(roomy.app.store, owner, "compaction", { contextWindowTokens: 80000 });
  const run = await roomy.app.runtime.run({ prompt: "next?", sessionId: await longConversation(roomy.app, 40) });
  assert.ok(!summarised(roomy.provider), "forty turns fit in an 80,000-token window");
  assert.equal(events(roomy.app, run.id, "context.budget")[0].data.limit, 80000);
});

test("R17-S08 the number of recent messages kept word for word follows the setting", async (t) => {
  const { app, provider } = await fixture(t);
  saveKnobs(app.store, owner, "compaction", { keepRecentMessages: 14 });
  const run = await app.runtime.run({ prompt: "next?", sessionId: await longConversation(app, 40) });
  assert.ok(summarised(provider));
  assert.ok(events(app, run.id, "context.compacted")[0].data.keptMessages >= 14);
  const last = provider.requests.at(-1).messages;
  assert.ok(last.filter((m) => /^Turn \d+:/.test(m.content)).length >= 13, "the newest turns are still there word for word");
});

test("R17-S09 most steps per task stops a task that needs more", async (t) => {
  const reply = (request, n) => (n === 1 ? answer("", [{ id: "c1", name: "memory.search", arguments: "{\"query\":\"x\"}" }]) : answer("finished"));
  const shipped = await fixture(t, { provider: scripted("main", reply) });
  assert.equal((await shipped.app.runtime.run({ prompt: "two rounds" })).status, "completed");
  const tight = await fixture(t, { provider: scripted("main", reply) });
  saveKnobs(tight.app.store, owner, "limits", { maxSteps: 1 });
  const run = await tight.app.runtime.run({ prompt: "two rounds" });
  assert.notEqual(run.status, "completed");
  // It stops at the step limit and says so in words, naming the setting, rather than in the budget's own.
  assert.match(run.output, /as many steps as one task may \(1\).*"Most steps in one task"/s);
});

test("R17-S09 a spending cap per task stops the task before its next round", async (t) => {
  const reply = (request, n) => ({ ...(n === 1 ? answer("", [{ id: "c1", name: "memory.search", arguments: "{\"query\":\"x\"}" }]) : answer("finished")),
    usage: { input: 100_000, output: 30_000 } });
  const provider = scripted("main", reply);
  const { app } = await fixture(t, { provider, extra: { presets: [{ id: "default", name: "Priced", provider, model: "gpt-4o" }] } });
  saveKnobs(app.store, owner, "limits", { spendCapDollars: 0.5 });
  const run = await app.runtime.run({ prompt: "expensive" });
  assert.notEqual(run.status, "completed");
  assert.match(run.output, /reaches the limit of \$0\.50 for one task/);
  assert.equal(provider.requests.length, 1, "no second round was paid for");
});

test("R17-S09 API retries: zero asks once, as shipped the launch setting's two retries apply", async (t) => {
  const failing = () => { throw new ProviderHttpError(503); };
  const fast = { retryPolicy: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 20 } };
  const shipped = await fixture(t, { provider: scripted("main", failing), extra: fast });
  await shipped.app.runtime.run({ prompt: "busy" });
  assert.equal(shipped.provider.requests.length, 3);
  const once = await fixture(t, { provider: scripted("main", failing), extra: fast });
  saveKnobs(once.app.store, owner, "limits", { apiRetries: 0 });
  await once.app.runtime.run({ prompt: "busy" });
  assert.equal(once.provider.requests.length, 1);
});

test("R17-S10 the longest tool answer the model reads follows the setting", async (t) => {
  const reply = (request) => (request.messages.at(-1).role === "tool" ? answer("read it")
    : answer("", [{ id: `c${request.messages.length}`, name: "files.read", arguments: "{\"path\":\"big.txt\"}" }]));
  const { app } = await fixture(t, { provider: scripted("main", reply) });
  await mkdir(app.runtime.workspace, { recursive: true });
  await writeFile(join(app.runtime.workspace, "big.txt"), "abcdefgh ".repeat(600));
  const shipped = await app.runtime.run({ prompt: "read big.txt" });
  assert.equal(events(app, shipped.id, "tool.result_clipped").length, 0, "5,400 characters fit as shipped");
  saveKnobs(app.store, owner, "commands", { toolAnswerChars: 1000 });
  const clipped = await app.runtime.run({ prompt: "read big.txt again" });
  const event = events(app, clipped.id, "tool.result_clipped")[0];
  assert.ok(event && event.data.kept <= 1100, "the answer was cut near 1,000 characters");
  assert.equal(toolLimits(app.store, owner, app.runtime.reliability).toolTimeoutMs, 90000);
  saveKnobs(app.store, owner, "commands", { toolTimeoutSeconds: 7 });
  assert.equal(toolLimits(app.store, owner, app.runtime.reliability).toolTimeoutMs, 7000);
});

test("R17-S10 environment names that could carry a secret or change code loading are refused", () => {
  for (const name of ["GITHUB_TOKEN", "OPENAI_API_KEY", "DB_PASSWORD", "AWS_SECRET_ACCESS_KEY", "SESSION_ID", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "GIT_SSH_COMMAND", "bad-name",
    // Integration review: each of these picks which program runs (java, go, git's editor), so they are refused too.
    "JAVA_HOME", "GOPATH", "EDITOR"])
    assert.ok(refusedEnvironmentName(name), `${name} should be refused`);
  for (const name of ["BUILD_MODE", "PHOTO_ALBUM", "MY_PROJECT_REGION"]) assert.equal(refusedEnvironmentName(name), null, name);
  const source = { BUILD_MODE: "fast", GITHUB_TOKEN: "ghp_x", PHOTO_ALBUM: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }; // not-a-real-secret
  assert.deepEqual(passedEnvironment(["BUILD_MODE", "GITHUB_TOKEN", "PHOTO_ALBUM", "MISSING"], source), { BUILD_MODE: "fast" },
    "a secret-like name and a key-like value are both left out");
});

test("R17-S10 a command gets the owner's extra variables and the owner's time limit", async (t) => {
  const { app } = await fixture(t);
  await mkdir(app.runtime.workspace, { recursive: true });
  const source = { ...process.env, R17_REGION: "north", R17_TOKEN: "very-secret-value-123" };
  const shell = new BranchShell({ executables: { node: { path: process.execPath } } }, source);
  t.after(() => shell.close());
  shell.tuning = () => commandTuning(app.store, owner, source);
  const context = app.runtime.context({ runId: "knob-run" });
  const print = ["-e", "console.log(JSON.stringify([process.env.R17_REGION ?? null, process.env.R17_TOKEN ?? null]))"];
  const before = await shell.execute({ executable: "node", args: print }, context);
  assert.deepEqual(JSON.parse(before.stdout), [null, null], "as shipped only the built-in safe list is passed");
  saveKnobs(app.store, owner, "commands", { passEnvironment: ["R17_REGION", "R17_TOKEN"] });
  const after = await shell.execute({ executable: "node", args: print }, context);
  assert.deepEqual(JSON.parse(after.stdout), ["north", null], "the named variable is passed; a token never is");

  saveKnobs(app.store, owner, "commands", { commandTimeoutSeconds: 1 });
  await assert.rejects(shell.execute({ executable: "node", args: ["-e", "1"], timeoutMs: 5000 }, context), /exceeds configured maximum/);
  const slow = await shell.execute({ executable: "node", args: ["-e", "setTimeout(() => {}, 20000)"] }, context);
  assert.notEqual(slow.status, "completed");
  assert.ok(slow.durationMs < 10000, `stopped after about a second (${slow.durationMs} ms)`);
});

test("R17-S10 the launch connects the owner's command settings to the real command tool", async (t) => {
  const { loadIntegrations } = await import("../dist/integrations/bootstrap.js");
  const { app, root } = await fixture(t);
  await mkdir(app.runtime.workspace, { recursive: true });
  const configPath = join(root, "integrations.json");
  await writeFile(configPath, JSON.stringify({ shell: { executables: { node: { path: process.execPath } } } }));
  const env = { ...process.env, R17_REGION: "south" };
  const launched = await loadIntegrations(app.registry, configPath, env, app.secretsFor, app.channelHost);
  t.after(() => launched.close());
  saveKnobs(app.store, owner, "commands", { commandTimeoutSeconds: 1, passEnvironment: ["R17_REGION"] });
  const context = app.runtime.context({ runId: "launched-run" });
  const region = await app.registry.execute("shell.execute", { executable: "node", args: ["-e", "console.log(process.env.R17_REGION)"] }, context);
  assert.equal(region.stdout.trim(), "south");
  const started = Date.now();
  const slow = await app.registry.execute("shell.execute", { executable: "node", args: ["-e", "setTimeout(() => {}, 20000)"] }, context);
  assert.notEqual(slow.status, "completed");
  assert.ok(Date.now() - started < 10000, "the owner's one-second limit applied");
});

test("R17-S10 kept-open command lines can be switched off", async (t) => {
  const { app } = await fixture(t);
  await mkdir(app.runtime.workspace, { recursive: true });
  const sessions = new ShellSessions({ executables: { node: { path: process.execPath } } }, app.store, owner);
  t.after(() => sessions.closeAll());
  saveKnobs(app.store, owner, "commands", { keptOpenShell: false });
  await assert.rejects(sessions.start({ program: "node", args: [], cwd: ".", name: "kept" }, app.runtime.context({ runId: "r" })),
    /Keeping a command line open is switched off/);
});

test("R17-S11 sub-tasks and side jobs use the connections the owner chose", async (t) => {
  const main = scripted("main", (request) => answer(`main:${request.messages.at(-1).content}`));
  const helper = scripted("helper", () => answer("helper answered"));
  const presets = [{ id: "default", name: "Main", provider: main, model: "m" }, { id: "helper", name: "Helper", provider: helper, model: "h" }];
  const { app } = await fixture(t, { provider: main, extra: { presets } });
  const parent = await app.runtime.run({ prompt: "parent" });
  const context = app.runtime.context({ runId: parent.id });
  const shipped = await app.runtime.delegate("child one", context, [], "");
  assert.match(shipped.output, /^main:/, "as shipped a sub-task uses the conversation's model");
  saveKnobs(app.store, owner, "subtasks", { subtaskModel: "helper" });
  const moved = await app.runtime.delegate("child two", context, [], "");
  assert.equal(moved.output, "helper answered");

  saveKnobs(app.store, owner, "subtasks", { sideJobModel: "helper" });
  const session = await longConversation(app, 40);
  helper.requests.length = 0;
  await app.runtime.run({ prompt: "next?", sessionId: session });
  assert.ok(summarised(helper), "the summary was written by the side-job connection");
  assert.ok(!main.requests.slice(-3).some((r) => /Summarize the conversation below/.test(r.messages[0].content)));
});

test("R17-S11 sub-tasks at once and the sub-task time limit follow the setting", async (t) => {
  let release;
  const gate = new Promise((done) => { release = done; });
  const provider = scripted("main", async (request) => {
    if (/wait here|hang/.test(request.messages.at(-1).content)) await (/hang/.test(request.messages.at(-1).content)
      ? new Promise((done, fail) => request.signal.addEventListener("abort", () => fail(request.signal.reason), { once: true })) : gate);
    return answer("ok");
  });
  const { app } = await fixture(t, { provider });
  const parent = await app.runtime.run({ prompt: "parent" });
  const context = app.runtime.context({ runId: parent.id });
  saveKnobs(app.store, owner, "subtasks", { parallelSubtasks: 1, subtaskTimeoutSeconds: 1 });
  const first = app.runtime.delegate("wait here", context, [], "");
  await assert.rejects(app.runtime.delegate("second", context, [], ""), /\(1 children at once\)/);
  release();
  await first;
  const started = Date.now();
  const hung = await app.runtime.delegate("hang", context, [], "");
  assert.notEqual(hung.status, "completed");
  assert.ok(Date.now() - started < 8000, "the sub-task was stopped after about a second");
});

test("R17-S12 a default effort per connection reaches the request, and a conversation's choice still wins", async (t) => {
  const { app, provider } = await fixture(t);
  await app.runtime.run({ prompt: "as shipped" });
  assert.equal(provider.requests.at(-1).reasoning, undefined);
  saveKnobs(app.store, owner, "reasoning", { effortByModel: { default: "high" } });
  const run = await app.runtime.run({ prompt: "think hard" });
  assert.equal(provider.requests.at(-1).reasoning, "high");
  assert.equal(events(app, run.id, "model.selected")[0].data.reasoning, "high");
  await app.runtime.run({ prompt: "this run only", reasoning: "low" });
  assert.equal(provider.requests.at(-1).reasoning, "low");
});

test("R17-S12 the service tier is sent only when the owner asks for one", async (t) => {
  const { app, provider } = await fixture(t);
  await app.runtime.run({ prompt: "standard" });
  assert.equal(provider.requests.at(-1).serviceTier, undefined);
  saveKnobs(app.store, owner, "reasoning", { serviceTier: "priority" });
  await app.runtime.run({ prompt: "priority" });
  assert.equal(provider.requests.at(-1).serviceTier, "priority");
  const request = { messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 2048 };
  assert.equal(openaiBody(request, "m").service_tier, undefined);
  assert.equal(openaiBody({ ...request, serviceTier: "flex" }, "m").service_tier, "flex");
  assert.equal(anthropicBody({ ...request, serviceTier: "priority" }, "m").service_tier, "auto");
  assert.equal(anthropicBody({ ...request, serviceTier: "flex" }, "m").service_tier, undefined);
});

test("R17-S12 hiding a model's thinking removes it from the answer and the live text", async (t) => {
  const provider = scripted("main", (request) => {
    request.onTextDelta?.("<thi"); request.onTextDelta?.("nk>my private plan</think>Hel"); request.onTextDelta?.("lo");
    return answer("<think>my private plan</think>Hello");
  });
  const { app } = await fixture(t, { provider });
  const shownText = [];
  const shipped = await app.runtime.run({ prompt: "hi", onTextDelta: (text) => shownText.push(text) });
  assert.match(shipped.output, /my private plan/, "as shipped the thinking is shown");
  saveKnobs(app.store, owner, "reasoning", { showReasoning: false });
  const live = [];
  const hidden = await app.runtime.run({ prompt: "hi again", onTextDelta: (text) => live.push(text) });
  assert.equal(hidden.output, "Hello");
  assert.equal(live.join(""), "Hello");
  assert.equal(withoutThinking("<thinking>a</thinking>\nB"), "B");
  assert.equal(withoutThinking("A <b>bold</b>"), "A <b>bold</b>");
  const out = [];
  const feed = thinkingFilter((text) => out.push(text));
  for (const chunk of ["a < b and ", "<reas", "oning>x</reasoning>", "c"]) feed(chunk);
  assert.equal(out.join(""), "a < b and c");
});

test("R17-S13 the memory budget and the note about you shape what a conversation starts with", async (t) => {
  const { app, provider } = await fixture(t);
  for (const text of ["likes tea", "lives in Lagos", "works nights"])
    app.store.save("memory", owner, `fact-${text.replace(/\W/g, "")}`, { text, source: "Owner" });
  const shipped = await app.runtime.run({ prompt: "hello" });
  assert.equal(events(app, shipped.id, "memory.snapshot")[0].data.count, 3);
  assert.ok(!provider.requests.at(-1).messages.some((m) => /in their own words/.test(m.content)));

  saveKnobs(app.store, owner, "memory", { snapshotFacts: 1, aboutYouOn: true, aboutYou: "I am a nurse. " + "x".repeat(300), aboutYouChars: 100 });
  const tight = await app.runtime.run({ prompt: "hello in a new conversation" });
  assert.equal(events(app, tight.id, "memory.snapshot")[0].data.count, 1);
  const note = provider.requests.at(-1).messages.find((m) => /in their own words/.test(m.content));
  assert.ok(note, "the note about you is in front of the conversation");
  assert.match(note.content, /I am a nurse/);
  assert.ok(note.content.length < 200, "and cut to its budget");
});

test("R17-S13 the memory provider is the Hindsight switch, so the two never disagree", async (t) => {
  const { app } = await fixture(t);
  assert.equal(memoryProvider(app.store, owner), "branch");
  saveMemoryProvider(app.store, owner, "branch-and-hindsight");
  assert.equal(askMode(app.store, owner, "hindsight"), "when-needed");
  saveMemoryProvider(app.store, owner, "branch");
  assert.equal(askMode(app.store, owner, "hindsight"), "off");
});

test("R17-S14 strict sensitivity hides more, and an exception lets one kind through but never a private key", async (t) => {
  const random = "aZ3kQ9mW2xL7pR4tY8vN1cB6hJ5gF0dS";
  assert.equal(findLeaks(`id ${random}`).length, 0, "standard leaves a random-looking id alone");
  assert.equal(findLeaks(`id ${random}`, { strict: true }).length, 1);
  assert.equal(findLeaks("sha 0123456789abcdef0123456789abcdef", { strict: true }).length, 0, "a lower-case hash still passes");
  const token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  const key = "-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----"; // not-a-real-secret
  assert.equal(redactLeaks(token, { except: new Set(["GitHub token"]) }).text, token);
  assert.match(redactLeaks(key, { except: new Set(["private key"]) }).text, /hidden key-like value: private key/);

  const { app } = await fixture(t);
  assert.match(JSON.stringify(app.runtime.leakGuard.toolResult("r", "t", { out: token })), /hidden key-like value/);
  saveKnobs(app.store, owner, "leakGuard", { exceptions: ["GitHub token", "private key"] });
  assert.equal(app.runtime.leakGuard.toolResult("r", "t", { out: token }).out, token, "the owner's exception applies at once");
  assert.match(app.runtime.leakGuard.toolResult("r", "t", { out: key }).out, /private key/);
  saveKnobs(app.store, owner, "leakGuard", { exceptions: [], sensitivity: "strict" });
  assert.match(app.runtime.leakGuard.toolResult("r", "t", { out: `id ${random}` }).out, /random-looking value/);
});

test("R17-S14 the launch settings file becomes a card: read in plain words, changed safely for the next start", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-launch-"));
  t.after(() => discardTemp(root));
  assert.deepEqual(await launchFileView(null), { path: null, problem: null, facts: null, editable: null });
  const path = join(root, "integrations.json");
  await writeFile(path, JSON.stringify({ shell: { executables: { node: { path: process.execPath } } },
    browser: { allowedOrigins: ["https://example.com"] } }));
  const view = await launchFileView(path);
  assert.deepEqual(view.facts.programs, ["node"]);
  assert.deepEqual(view.editable, { commands: { commandTimeoutSeconds: 30, commandOutputBytes: 8192, commandsOffline: false }, browserSites: ["https://example.com"] });
  const saved = await saveLaunchFile(path, { commandTimeoutSeconds: 12, commandsOffline: true, browserSites: ["https://example.com", "https://docs.example.org"] });
  assert.equal(saved.savedForNextStart, true);
  const written = JSON.parse(await readFile(path, "utf8"));
  assert.equal(written.shell.timeoutMs, 12000);
  assert.equal(written.shell.netless, true);
  assert.deepEqual(written.browser.allowedOrigins, ["https://example.com", "https://docs.example.org"]);
  assert.equal(written.shell.executables.node.path, process.execPath, "everything else is kept");
  await assert.rejects(saveLaunchFile(path, { browserSites: ["https://example.com/some/path"] }), /without a path/);
  await assert.rejects(saveLaunchFile(path, { commandTimeoutSeconds: 500 }));
  await assert.rejects(saveLaunchFile(null, { commandTimeoutSeconds: 5 }), /without a launch settings file/);
});

test("the knobs route: the owner saves, bad values and loosening from elsewhere are refused", async (t) => {
  const { startServer } = await import("../dist/server.js");
  const { app, root } = await fixture(t);
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(() => server.close());
  const call = async (method, body, token = server.token) => {
    const response = await fetch(server.url + "/api/knobs", { method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const read = await call("GET");
  assert.equal(read.status, 200);
  assert.equal(read.body.values.limits.maxSteps, null, "auto: no limit on a sign-in, 60 on a key");
  assert.ok(read.body.leakKinds.includes("GitHub token") && !read.body.leakKinds.includes("private key"));
  assert.equal((await call("POST", { card: "limits", values: { maxSteps: 12 } })).body.values.limits.maxSteps, 12);
  assert.equal(readKnobs(app.store, owner, "limits").maxSteps, 12);
  assert.equal((await call("POST", { card: "limits", reset: true })).body.values.limits.maxSteps, null);
  assert.equal((await call("POST", { card: "limits", values: { maxSteps: "none" } })).body.values.limits.maxSteps, "none");
  assert.equal((await call("POST", { card: "limits", values: { maxSteps: "lots" } })).status, 400);
  assert.equal((await call("POST", { card: "limits", values: { maxSteps: 0 } })).status, 400);
  const secret = await call("POST", { card: "commands", values: { passEnvironment: ["STRIPE_SECRET"] } });
  assert.equal(secret.status, 400);
  assert.match(secret.body.error, /never handed to commands/);
  assert.equal((await call("POST", { card: "leakGuard", values: { exceptions: ["private key"] } })).status, 400);
  assert.equal((await call("POST", { card: "subtasks", values: { subtaskModel: "nobody" } })).status, 400);

  const key = app.sessionTokens.create(owner, { scope: "run", minutes: 5 });
  const refused = await call("POST", { card: "leakGuard", values: { exceptions: ["GitHub token"] } }, key.token);
  assert.equal(refused.status, 401);
  assert.match(refused.body.error, /cannot change Branch's limits/);
  assert.equal((await call("GET", undefined, key.token)).status, 200, "a short-lived key may still look");

  const person = app.store.profiles.create({ name: "Sam", pin: "4321" });
  app.store.profiles.switch({ profileId: person.id, pin: "4321" });
  const household = await call("POST", { card: "commands", values: { passEnvironment: ["BUILD_MODE"] } });
  assert.equal(household.status, 400); // profile-audit: refused at one place in src/server.ts, as requireOwner answers
  // Integration review: every card is the owner's own setting (the spending cap included), so a profile changes none.
  assert.equal((await call("POST", { card: "limits", values: { maxSteps: 30 } })).status, 400);
  app.store.profiles.switch({ profileId: null });
  assert.deepEqual(readKnobs(app.store, owner, "commands").passEnvironment, []);
  assert.equal((await call("POST", { card: "commands", values: { passEnvironment: ["BUILD_MODE"] } })).status, 200);
});
