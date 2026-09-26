import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { createBranch } from "../dist/index.js";

/**
 * mac7/coding-next: coding reliability, round 2 (docs/agents/STATUS-coding-next.md). Nothing here
 * starts Electron or a real program: every outside program is a fake that records what it was
 * handed, which is the only way to check the environment a child would have been given.
 */

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-coding-next-"));
  const provider = options.provider ?? { name: "scripted", async complete() { return { content: "done", toolCalls: [] }; } };
  const app = await createBranch({
    workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "alpha", name: "Alpha", provider, model: "a" }],
    ...(options.reliability ? { reliability: options.reliability } : {}),
  });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, workspace: join(root, "workspace") };
}

const contextOf = (app, extra = {}) => ({
  // FQ-routing.isolated-agents: app.workspace was never a real field (app.runtime.workspace is); this
  // always fell back to "", unnoticed while every tool used here read the app's own captured workspace
  // instead of context.workspace. code.run reads context.workspace now, so it needs the real path.
  owner: "local", workspace: app?.runtime?.workspace ?? "", runId: "", signal: AbortSignal.timeout(10_000),
  budget: { step() {}, charge() {}, remaining: () => 1000, limits: { maxSteps: 9, maxTokens: 9 }, steps: 0, tokens: 0 },
  permissions: new Set(), depth: 0, ...extra,
});

/** A stand-in for every outside program: it answers, and remembers exactly what it was asked. */
function fakeWorld() {
  const calls = [];
  const probe = async () => ({ code: null, stdout: "", stderr: "", missing: true });
  const spawn = async (options) => {
    calls.push(options);
    return { status: "completed", exitCode: 0, stdout: "3\n", stderr: "", truncated: false, durationMs: 1 };
  };
  return { calls, probe, spawn };
}

/** Runs `work` as if inside the desktop app, where process.versions says which Electron it is. */
async function asDesktopApp(work) {
  Object.defineProperty(process.versions, "electron", { value: "99.0.0", configurable: true, enumerable: true });
  try { return await work(); } finally { delete process.versions.electron; }
}

// ------------------------------------------------------------------ 5. code.run runs as Node

test("5 runAsNode adds ELECTRON_RUN_AS_NODE only for this program, and only inside the desktop app", async () => {
  const { runAsNode } = await import("../dist/child-env.js");
  assert.deepEqual(runAsNode(process.execPath), {}, "plain Node needs nothing");
  await asDesktopApp(async () => {
    assert.deepEqual(runAsNode(process.execPath), { ELECTRON_RUN_AS_NODE: "1" });
    assert.deepEqual(runAsNode("C:/Python/python.exe"), {}, "another program is left alone");
  });
});

test("5 code.run inside the desktop app starts this program as Node, not a second app", async (t) => {
  const { app, workspace } = await fixture(t);
  const { CodeRunner, saveCodeRunSettings } = await import("../dist/code-run.js");
  await saveCodeRunSettings(app.store, "local", { enabled: true });
  const world = fakeWorld();
  const runner = new CodeRunner(app.store, "local", workspace, { create: async () => null }, world.probe, world.spawn);
  await asDesktopApp(() => runner.run({ language: "javascript", source: "console.log(1 + 2)" }, contextOf(app)));
  const started = world.calls.at(-1);
  assert.equal(started.executable, process.execPath);
  assert.equal(started.env.ELECTRON_RUN_AS_NODE, "1", "without it the packaged app would start itself again");
  // Outside the desktop app nothing extra is handed on.
  await runner.run({ language: "javascript", source: "console.log(1 + 2)" }, contextOf(app));
  assert.equal(world.calls.at(-1).env.ELECTRON_RUN_AS_NODE, undefined);
});

// ------------------------------------------------------------------ 6. crash capture is a switch

test("6 crash capture ships on, and switched off a crash writes no note, and with the log off nothing at all", async (t) => {
  const { DiagnosticLog, DiagnosticLogSettingsSchema } = await import("../dist/diagnostic-log.js");
  const { readdir } = await import("node:fs/promises");
  const dir = await mkdtemp(join(tmpdir(), "branch-crash-off-"));
  t.after(() => discardTemp(dir));
  // The owner's decision (2026-09-21): crash notes are kept from the start.
  assert.equal(DiagnosticLogSettingsSchema.parse({}).crashCapture, "on");
  const log = new DiagnosticLog({ dir, settings: () => DiagnosticLogSettingsSchema.parse({ mode: "off", crashCapture: "off" }) });
  log.write({ level: "info", component: "tasks", message: "step one" });
  log.crash("engine", new Error("boom"));
  assert.deepEqual(log.crashes(), []);
  assert.deepEqual(await readdir(dir).catch(() => []), [], "off writes no file");
  // With the log on, the crash is still an ordinary log line — just no crash note.
  const logged = new DiagnosticLog({ dir, settings: () => DiagnosticLogSettingsSchema.parse({ mode: "on", crashCapture: "off" }) });
  logged.crash("engine", new Error("boom"));
  assert.equal(logged.crashes().length, 0);
  assert.match(logged.read()[0].message, /Crashed: Error: boom/);
  // On: the note is written.
  const on = new DiagnosticLog({ dir, settings: () => DiagnosticLogSettingsSchema.parse({ crashCapture: "on" }) });
  on.crash("engine", new Error("boom"));
  assert.equal(on.crashes().length, 1);
});

test("6 saving the log's mode keeps crash capture; the switch file tells the desktop app at its next start", async (t) => {
  const { diagnosticApi } = await import("../dist/diagnostic-api.js");
  const { crashReporterPlan, crashCaptureMarked } = await import("../dist/diagnostic-log.js");
  const dataDir = await mkdtemp(join(tmpdir(), "branch-crash-mark-"));
  t.after(() => discardTemp(dataDir));
  const saved = new Map();
  const app = { version: "9", runtime: { owner: "me" }, store: {
    profiles: { requireOwner() {} },
    get: (_table, _owner, key) => saved.has(key) ? { data: saved.get(key) } : undefined,
    save: (_table, _owner, key, data) => { saved.set(key, data); },
  } };
  const post = (body) => diagnosticApi({ app, dataDir, installType: "x", startedAt: 0 }, "POST", "/api/diagnostics/log/settings",
    new URL("http://local/api/diagnostics/log/settings"), async () => body);
  // The owner's decision (2026-09-21): crash capture ships on, so before anything was saved the
  // reporter starts — and it never uploads.
  assert.equal(crashReporterPlan(dataDir).uploadToServer, false, "never saved: the shipped setting, on, and still never uploads");
  assert.equal((await post({ crashCapture: "on" })).crashCapture, "on");
  assert.equal(crashCaptureMarked(dataDir), true);
  assert.equal(crashReporterPlan(dataDir).uploadToServer, false, "on: started, and still never uploads");
  const after = await post({ mode: "when-needed", keepDays: 7 });
  assert.equal(after.crashCapture, "on", "changing the log's mode must not switch crash capture off");
  assert.equal(after.maxMegabytes, 20);
  await post({ crashCapture: "off" });
  assert.equal(crashReporterPlan(dataDir), null);
});

test("6 Report a problem still works with crash capture off: it just has no crash files to offer", async (t) => {
  const { DiagnosticLog, DiagnosticLogSettingsSchema } = await import("../dist/diagnostic-log.js");
  const { gatherReport } = await import("../dist/diagnostic-report.js");
  const dir = await mkdtemp(join(tmpdir(), "branch-crash-report-"));
  t.after(() => discardTemp(dir));
  const log = new DiagnosticLog({ dir, settings: () => DiagnosticLogSettingsSchema.parse({ crashCapture: "off" }) });
  log.crash("engine", new Error("boom"));
  const items = await gatherReport({ version: "9", dataDir: dir, installType: "x", log, logMode: "off",
    health: async () => ({ ok: true, items: [] }), settings: () => ({}), services: () => ({}), events: () => ({ events: [] }),
    crashDumpsDir: null, resolve: null });
  const crashes = items.find((item) => item.id === "crashes");
  assert.match(crashes.title, /0 noted, 0 crash files/);
});

// ------------------------------------------------------------------ 3. a local model's first reply

/** An OpenAI-shaped server on this computer that says nothing for `delay()` ms, then streams "hello". */
async function slowLocalServer(t, delay) {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    request.resume();
    const timer = setTimeout(() => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "hello" } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    }, delay());
    response.on("close", () => clearTimeout(timer));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }));
  return `http://127.0.0.1:${server.address().port}/v1`;
}

test("3 a model on this computer gets a longer first-reply wait, and the person is told it may be loading", async (t) => {
  const { app } = await fixture(t, { reliability: { stallRecovery: "fail" } });
  const { OpenAIProvider } = await import("../dist/providers.js");
  const endpoint = await slowLocalServer(t, () => 100);
  app.runtime.models.register({ id: "on-this-computer", name: "Local", model: "m",
    provider: new OpenAIProvider({ endpoint, model: "m", apiKey: "local" }) });
  // The ordinary quiet notice happens first. The local first-reply ceiling is deliberately far from
  // the reply so an overloaded runner cannot reverse two nearby real timers (shipped: 60 s / 300 s).
  app.runtime.reliability.modelStallMs = 30;
  app.runtime.reliability.localFirstReplyMs = 60000;
  const run = await app.runtime.run({ prompt: "hi", model: "on-this-computer", onTextDelta: () => undefined });
  assert.equal(run.status, "completed", run.output);
  assert.equal(run.output, "hello");
  const loading = app.store.events(run.id).filter((event) => event.kind === "model.loading");
  assert.equal(loading.length, 1, "told once, while nothing had been heard");
  assert.match(loading[0].data.message, /loading into memory/);
  assert.ok(!app.store.events(run.id).some((event) => event.kind === "model.stalled"));

  // With the first-reply wait shorter than the load, it is a stall, as before.
  app.runtime.reliability.localFirstReplyMs = 50;
  const stalled = await app.runtime.run({ prompt: "hi", model: "on-this-computer", onTextDelta: () => undefined });
  assert.equal(stalled.status, "failed");
  assert.ok(app.store.events(stalled.id).some((event) => event.kind === "model.stalled"));
});

test("3 a hosted model's wait is unchanged: its first silence is the ordinary stall time", async (t) => {
  const { app } = await fixture(t, { reliability: { stallRecovery: "fail" } });
  const slowHosted = { name: "hosted", async complete(request) {
    await new Promise((done, fail) => {
      const timer = setTimeout(done, 900);
      request.signal.addEventListener("abort", () => { clearTimeout(timer); fail(request.signal.reason); }, { once: true });
    });
    request.onTextDelta?.("late");
    return { content: "late", toolCalls: [] };
  } };
  app.runtime.models.register({ id: "hosted", name: "Hosted", provider: slowHosted, model: "h" });
  app.runtime.reliability.modelStallMs = 300;
  app.runtime.reliability.localFirstReplyMs = 5000;
  const run = await app.runtime.run({ prompt: "hi", model: "hosted", onTextDelta: () => undefined });
  assert.equal(run.status, "failed");
  const kinds = app.store.events(run.id).map((event) => event.kind);
  assert.ok(kinds.includes("model.stalled"));
  assert.ok(!kinds.includes("model.loading"), "a hosted model is never said to be loading");
});

test("3 the watchdog: the first window can be longer; after the first piece the ordinary clock runs", async () => {
  const { withStallWatchdog, StallError } = await import("../dist/reliability.js");
  const never = new AbortController().signal;
  const wait = (ms, signal) => new Promise((done, fail) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); fail(signal.reason); }, { once: true });
  });
  await assert.rejects(withStallWatchdog(never, 100, (signal) => wait(300, signal)), StallError);
  assert.equal(await withStallWatchdog(never, 100, async (signal) => { await wait(300, signal); return "ok"; }, { firstMs: 1000 }), "ok");
  // Once something was heard, a long silence is a stall again even though the first window was long.
  await assert.rejects(withStallWatchdog(never, 100, async (signal, touch) => { touch(); await wait(300, signal); }, { firstMs: 1000 }), StallError);
});

test("3 the owner's setting: localFirstReplySeconds overrides the launch figure; empty keeps it", async (t) => {
  const { app } = await fixture(t);
  const { saveKnobs } = await import("../dist/knobs/settings.js");
  const { localFirstReplyMs } = await import("../dist/knobs/apply.js");
  assert.equal(app.runtime.reliability.localFirstReplyMs, 300_000, "ships at 300 s");
  assert.equal(localFirstReplyMs(app.store, "local", app.runtime.reliability), 300_000);
  saveKnobs(app.store, "local", "limits", { localFirstReplySeconds: 45 });
  assert.equal(localFirstReplyMs(app.store, "local", app.runtime.reliability), 45_000);
  saveKnobs(app.store, "local", "limits", { localFirstReplySeconds: null });
  assert.equal(localFirstReplyMs(app.store, "local", app.runtime.reliability), 300_000);
});

// ------------------------------------------------------------------ 2. unknown tool arguments

/** A provider driven by a script of answers, one per round; the last one repeats. */
function scripted(steps) {
  const provider = { name: "scripted", requests: [], async complete(request) {
    provider.requests.push(request);
    return steps[Math.min(provider.requests.length - 1, steps.length - 1)](request);
  } };
  return provider;
}
const say = (content) => () => ({ content, toolCalls: [] });
const call = (name, args) => () => ({ content: "", toolCalls: [{ id: `c${Math.random().toString(36).slice(2, 8)}`, name, arguments: JSON.stringify(args) }] });
const toolMessages = (app, run) => app.store.messages(run.sessionId).filter((message) => message.role === "tool").map((message) => JSON.parse(message.content));

test("2 clean: unknown keys are dropped, and only when what is left is a valid call", async (t) => {
  const { app } = await fixture(t);
  const clean = (name, args) => app.registry.clean(name, args);
  assert.deepEqual(clean("files.read", { path: "a.txt", format: "js" }), { args: { path: "a.txt" }, ignored: ["format"] });
  assert.deepEqual(clean("files.read", { path: "a.txt" }), { args: { path: "a.txt" }, ignored: [] }, "a clean call is untouched");
  // A wrong type or a missing field is left exactly as sent, so the call is refused as before.
  assert.deepEqual(clean("files.read", { path: 5, format: "js" }), { args: { path: 5, format: "js" }, ignored: [] });
  assert.deepEqual(clean("files.read", { format: "js" }), { args: { format: "js" }, ignored: [] });
  // Inside a list, and through files.edit's own argument names.
  const set = clean("code.change_set", { reason: "r", edits: [{ path: "a", find: "x", replace: "y", line: 3 }], why: "?" });
  assert.deepEqual(set.ignored.sort(), ["edits.0.line", "why"]);
  assert.deepEqual(set.args, { reason: "r", edits: [{ path: "a", find: "x", replace: "y" }] });
  const edit = clean("files.edit", { file_path: "a", old_string: "x", new_string: "y", mode: "fast" });
  assert.deepEqual(edit.ignored, ["mode"]);
  assert.equal(edit.args.old_string, "x", "the other agents' names still reach files.edit's own mapping");
});

test("2 a call with an extra key runs, and the model is told in one line what was ignored", async (t) => {
  const provider = scripted([call("files.read", { path: "notes.txt", format: "text" }), say("done")]);
  const { app, workspace } = await fixture(t, { provider });
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "notes.txt"), "hello");
  const run = await app.runtime.run({ prompt: "read notes.txt" });
  assert.equal(run.status, "completed", run.output);
  const [answer] = toolMessages(app, run);
  assert.equal(answer.ok, true);
  assert.equal(answer.result.content, "hello");
  assert.equal(answer.note, "Ignored an argument this tool does not take: format.");
  assert.deepEqual(app.store.events(run.id).find((event) => event.kind === "tool.arguments_ignored").data.keys, ["format"]);
});

test("2 a wrong type is still refused, extra key or not", async (t) => {
  const provider = scripted([call("files.read", { path: 42, format: "text" }), say("done")]);
  const { app } = await fixture(t, { provider });
  const run = await app.runtime.run({ prompt: "read" });
  const [answer] = toolMessages(app, run);
  assert.equal(answer.ok, false);
  assert.match(answer.error, /path/);
  assert.equal(answer.note, undefined);
});

test("2 an unknown key cannot steer the permission check: the rule sees the cleaned call", async (t) => {
  // files.write takes no `url`. Were the raw arguments judged, the target would be the url's host
  // (policyTarget reads `url` before `path`) and the owner's refusal for this file would be missed.
  const provider = scripted([call("files.write", { path: "keep.txt", content: "overwritten", url: "https://trusted.example/" }), say("done")]);
  const { app, workspace } = await fixture(t, { provider });
  const { addPolicyRule } = await import("../dist/policy.js");
  const { mkdir, writeFile, readFile } = await import("node:fs/promises");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "keep.txt"), "original");
  addPolicyRule(app.store, "local", { tool: "files.write", match: "keep.txt", decision: "deny", remember: "always" });
  const run = await app.runtime.run({ prompt: "write" });
  assert.equal(await readFile(join(workspace, "keep.txt"), "utf8"), "original");
  const denied = app.store.events(run.id).find((event) => event.kind === "policy.denied");
  assert.equal(denied?.data.target, "keep.txt");
});

// ------------------------------------------------------------------ 1. read before edit

/** A workspace with `a.txt` in it, the read-before-edit switch set to `mode`, and a scripted model. */
async function readFirstFixture(t, steps, mode = "on") {
  const provider = scripted(steps);
  const { app, workspace } = await fixture(t, { provider });
  const { saveCodingMode } = await import("../dist/coding/settings.js");
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, "a.txt"), "one\n");
  saveCodingMode(app.store, "local", "read-first", mode);
  return { app, workspace };
}
const fileText = async (workspace, name) => (await import("node:fs/promises")).readFile(join(workspace, name), "utf8");
const edit = (find, replace) => call("files.edit", { path: "a.txt", find, replace });

// The owner's rule (Q250, 2026-09-26): read-first is a stricter guard, so it ships on; switched off, an edit goes through.
test("1 read-first ships on, and switched off an edit to an unread file goes through as before", async (t) => {
  const { codingMode } = await import("../dist/coding/settings.js");
  const { app, workspace } = await readFirstFixture(t, [edit("one", "two"), say("done")], "off");
  assert.equal(codingMode({ get: () => undefined }, "local", "read-first"), "on", "on for a fresh install");
  assert.equal(codingMode({ get: () => ({ data: { mode: "sideways" } }) }, "local", "read-first"), "off", "a damaged record reads as off");
  const run = await app.runtime.run({ prompt: "change it" });
  assert.equal(toolMessages(app, run)[0].ok, true);
  assert.equal(await fileText(workspace, "a.txt"), "two\n");
});

test("1 read-first on (Q250): a saved recipe's step and a manual action are not held", async (t) => {
  const { app, workspace } = await readFirstFixture(t, [say("done")]);
  const context = app.runtime.context();
  // A verified recipe that overwrites a file that is already there: each replay writes it, from the second run on too.
  const recipe = app.knowledge.proposeProcedure(context, { name: "write a", preconditions: [],
    steps: [{ tool: "files.write", args: { path: "a.txt", content: "from the recipe\n" }, expected: { path: "a.txt", bytes: 16 } }] });
  assert.equal((await app.knowledge.verifyProcedure(context, recipe.id)).data.status, "verified");
  assert.equal(await fileText(workspace, "a.txt"), "from the recipe\n");
  await writeFile(join(workspace, "a.txt"), "changed since\n");
  await app.knowledge.replayProcedure(context, recipe.id);
  assert.equal(await fileText(workspace, "a.txt"), "from the recipe\n", "the replay wrote over a file it never read");
  // A manual action (a workflow's step, a button in the window) is one call and a task of its own.
  await app.runtime.executeTool("files.write", { path: "a.txt", content: "by hand\n" }, { mode: "owner" });
  assert.equal(await fileText(workspace, "a.txt"), "by hand\n");
});

test("1 read-first on (Q250): a recipe or workflow the model runs itself is held, so it is no way round the guard", async (t) => {
  const recipeId = "0b1c2d3e-4f50-4617-8829-3a4b5c6d7e80", flowId = "1c2d3e4f-5061-4728-893a-4b5c6d7e8f90";
  const write = { tool: "files.write", args: { path: "a.txt", content: "blind\n" } };
  const { app, workspace } = await readFirstFixture(t, [
    call("procedures.propose", { id: recipeId, name: "blind write", preconditions: [], steps: [{ ...write, expected: { path: "a.txt", bytes: 6 } }] }),
    call("procedures.verify", { id: recipeId }),
    call("workflows.create", { id: flowId, name: "blind write", steps: [{ name: "write", kind: "tool", ...write }] }),
    call("workflows.run", { id: flowId }),
    say("done")]);
  const run = await app.runtime.run({ prompt: "change it" });
  const answers = toolMessages(app, run);
  assert.equal(answers[1].ok, false, JSON.stringify(answers[1]));
  assert.match(answers[1].error, /read "a\.txt" with files\.read first/, "the recipe's step is held under the model's own task");
  assert.match(JSON.stringify(answers[3]), /read \\"a\.txt\\" with files\.read first/, "and so is the workflow's step it started");
  assert.equal(await fileText(workspace, "a.txt"), "one\n", "nothing was written round the guard");
});

test("1 read-first on (Q250): a workflow the model set going stays held when the owner's yes carries it on later", async (t) => {
  const flowId = "2d3e4f50-6172-4839-9a4b-5c6d7e8f9a01", ownFlowId = "3e4f5061-7283-494a-8b5c-6d7e8f9a0b12";
  const steps = [{ name: "ask", kind: "approval", question: "Go on?" },
    { name: "write", kind: "tool", tool: "files.write", args: { path: "a.txt", content: "blind\n" } }];
  const { app, workspace } = await readFirstFixture(t, [
    call("workflows.create", { id: flowId, name: "later", steps }), call("workflows.run", { id: flowId }), say("done")]);
  await app.runtime.run({ prompt: "set it going" });
  assert.equal(app.workflows.view("local", flowId).status, "waiting_approval", "it stops at the owner's question");
  // The owner's yes carries it on, outside any model's call.
  const resumed = await app.workflows.resume("local", flowId);
  assert.equal(resumed.status, "failed");
  assert.match(String(resumed.error), /read "a\.txt" with files\.read first/);
  assert.equal(await fileText(workspace, "a.txt"), "one\n", "the write after the wait is still held");
  // The owner's own workflow with the same steps is not held.
  app.workflows.create("local", { id: ownFlowId, name: "mine", steps });
  await app.workflows.run("local", ownFlowId);
  assert.equal((await app.workflows.resume("local", ownFlowId)).status, "completed");
  assert.equal(await fileText(workspace, "a.txt"), "blind\n");
});


test("1 read-first on: an unread file is refused, in a sentence that says to read it first", async (t) => {
  const { app, workspace } = await readFirstFixture(t, [
    edit("one", "two"),
    call("files.write", { path: "a.txt", content: "whole\n" }),
    call("files.patch", { patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n" }),
    call("code.change_set", { reason: "r", edits: [{ path: "a.txt", find: "one", replace: "two" }] }),
    say("done")]);
  const run = await app.runtime.run({ prompt: "change it" });
  const answers = toolMessages(app, run);
  assert.equal(answers.length, 4);
  for (const answer of answers) {
    assert.equal(answer.ok, false, JSON.stringify(answer));
    assert.match(answer.error, /read "a\.txt" with files\.read first/);
  }
  assert.equal(await fileText(workspace, "a.txt"), "one\n", "nothing was changed");
});

test("1 read-first on: after a read the edit goes through, and the task's own change counts as read", async (t) => {
  const { app, workspace } = await readFirstFixture(t, [
    call("files.read", { path: "a.txt" }), edit("one", "two"), edit("two", "three"),
    call("files.write", { path: "a.txt", content: "four\n" }), say("done")]);
  const run = await app.runtime.run({ prompt: "change it" });
  const answers = toolMessages(app, run);
  assert.ok(answers.every((answer) => answer.ok), JSON.stringify(answers));
  assert.equal(await fileText(workspace, "a.txt"), "four\n");
});

test("1 read-first on: a change made by someone else after the read is refused until it is read again", async (t) => {
  let workspaceDir = "";
  const { writeFile } = await import("node:fs/promises");
  const { app, workspace } = await readFirstFixture(t, [
    call("files.read", { path: "a.txt" }),
    async () => { await writeFile(join(workspaceDir, "a.txt"), "one\nadded by a person\n"); return edit("one", "two")(); },
    call("files.read", { path: "a.txt" }), edit("one", "two"), say("done")]);
  workspaceDir = workspace;
  const run = await app.runtime.run({ prompt: "change it" });
  const answers = toolMessages(app, run);
  assert.equal(answers[1].ok, false);
  assert.match(answers[1].error, /has changed since this task last read it/);
  assert.equal(answers[3].ok, true, "read again, the edit goes through");
  assert.equal(await fileText(workspace, "a.txt"), "two\nadded by a person\n");
});

test("1 read-first on: a new file needs no read", async (t) => {
  const { app, workspace } = await readFirstFixture(t, [
    call("files.write", { path: "new.txt", content: "fresh\n" }),
    call("files.edit", { path: "made.txt", find: "", replace: "made\n" }),
    call("code.patch", { patch: "*** Begin Patch\n*** Add File: added.txt\n+added\n*** End Patch\n" }),
    say("done")]);
  const run = await app.runtime.run({ prompt: "make files" });
  const answers = toolMessages(app, run);
  assert.ok(answers.every((answer) => answer.ok), JSON.stringify(answers));
  assert.equal(await fileText(workspace, "new.txt"), "fresh\n");
  assert.equal(await fileText(workspace, "made.txt"), "made\n");
  assert.equal(await fileText(workspace, "added.txt"), "added\n");
});

test("1 read-first on: a file tidied after the task's own edit (format-on-edit) still counts as read", async (t) => {
  const { writeFile, readFile } = await import("node:fs/promises");
  const { app, workspace } = await readFirstFixture(t, [
    call("files.read", { path: "a.txt" }), edit("one", "two"), edit("TWO", "three"), say("done")]);
  // Stands in for a formatter run after every edit (src/coding/format-on-edit.ts), which rewrites the file.
  const before = app.registry.afterTool;
  app.registry.afterTool = async (name, args, result, context) => {
    if (name === "files.edit") await writeFile(join(workspace, "a.txt"), (await readFile(join(workspace, "a.txt"), "utf8")).toUpperCase());
    return before ? before(name, args, result, context) : result;
  };
  const run = await app.runtime.run({ prompt: "change it" });
  const answers = toolMessages(app, run);
  assert.ok(answers.every((answer) => answer.ok), JSON.stringify(answers));
  assert.equal(await fileText(workspace, "a.txt"), "THREE\n");
});

// ------------------------------------------------------------------ 4. "Let Branch run this project's tests?"

/** A Node project with one passing test, the script switch left off (as shipped), and a scripted model. */
async function testsFixture(t, steps) {
  const provider = scripted(steps);
  const { app, workspace } = await fixture(t, { provider });
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "p", type: "module" }));
  await writeFile(join(workspace, "test", "a.test.mjs"), 'import test from "node:test";\ntest("adds", () => {});\n');
  return { app, workspace };
}
const asked = (app, run) => app.store.events(run.id).filter((event) => event.kind === "policy.ask");
const ranTests = (app, run) => app.store.events(run.id).some((event) => event.kind === "code.check");

test("4 the tests are not run until the person says yes; Once lets the next run go and then asks again", async (t) => {
  const check = call("code.check", {});
  const { app, workspace } = await testsFixture(t, [check, check, say("done"), check]);
  const first = await app.runtime.run({ prompt: "fix it" });
  assert.equal(first.status, "needs_input");
  assert.equal(ranTests(app, first), false, "nothing ran before the answer");
  const [question] = asked(app, first);
  assert.equal(question.data.kind, "project-tests");
  assert.equal(question.data.name, "code.tests");
  assert.equal(question.data.target, workspace);
  assert.match(question.data.question, /^Let Branch run this project's tests\?/);
  app.runtime.approve(first.sessionId, "allow", "never");
  const second = await app.runtime.run({ prompt: "carry on", sessionId: first.sessionId });
  assert.equal(second.status, "completed", second.output);
  assert.equal(ranTests(app, second), true);
  const [answer] = toolMessages(app, second).slice(-1);
  assert.equal(answer.result.ran, true);
  assert.equal(answer.result.ok, true, answer.result.output);
  const third = await app.runtime.run({ prompt: "again", sessionId: first.sessionId });
  assert.equal(third.status, "needs_input", "Once was used up");
});

test("4 Always for this folder is kept: later conversations run the tests without asking", async (t) => {
  const check = call("code.check", {});
  const { app, workspace } = await testsFixture(t, [check, check, say("done"), check, say("done")]);
  const first = await app.runtime.run({ prompt: "fix it" });
  app.runtime.approve(first.sessionId, "allow", "always");
  const { readPolicy } = await import("../dist/policy.js");
  assert.ok(readPolicy(app.store, "local").rules.some((rule) => rule.tool === "code.tests" && rule.match === workspace && rule.decision === "allow"));
  const second = await app.runtime.run({ prompt: "carry on", sessionId: first.sessionId });
  assert.equal(ranTests(app, second), true);
  const elsewhere = await app.runtime.run({ prompt: "a new conversation" });
  assert.equal(elsewhere.status, "completed", elsewhere.output);
  assert.equal(asked(app, elsewhere).length, 0);
  assert.equal(ranTests(app, elsewhere), true);
});

test("4 No is remembered for the conversation: the task is told, and not asked again", async (t) => {
  const check = call("code.check", {});
  const { app } = await testsFixture(t, [check, check, say("done")]);
  const first = await app.runtime.run({ prompt: "fix it" });
  app.runtime.approve(first.sessionId, "deny", "session");
  const second = await app.runtime.run({ prompt: "carry on", sessionId: first.sessionId });
  assert.equal(second.status, "completed", second.output);
  assert.equal(asked(app, second).length, 0);
  assert.equal(ranTests(app, second), false);
  const [answer] = toolMessages(app, second).slice(-1);
  assert.equal(answer.result.ran, false);
  assert.match(answer.result.note, /chose not to let Branch run this project's tests/);
});

test("4 Always cannot be given from a chat app or for a task a chat app started; Once still can", async (t) => {
  const check = call("code.check", {});
  const { app } = await testsFixture(t, [check]);
  const run = await app.runtime.run({ prompt: "fix it" });
  assert.throws(() => app.runtime.approve(run.sessionId, "allow", "always", undefined, "telegram"), /Only the owner, in the app/);
  const fromChat = await app.runtime.run({ prompt: "fix it", source: "channel" });
  assert.equal(fromChat.status, "needs_input");
  assert.throws(() => app.runtime.approve(fromChat.sessionId, "allow", "always"), /standing yes|Only the owner/);
  app.runtime.approve(fromChat.sessionId, "allow", "never");
  const { readPolicy } = await import("../dist/policy.js");
  assert.ok(!readPolicy(app.store, "local").rules.some((rule) => rule.tool === "code.tests"), "no standing rule was written");
});

test("4 Lockdown refuses without asking; the script switch on runs the tests as before", async (t) => {
  const check = call("code.check", {});
  const { app } = await testsFixture(t, [check, say("done"), check, say("done")]);
  app.store.save("settings", "local", "lockdown", { on: true });
  const locked = await app.runtime.run({ prompt: "fix it" });
  assert.equal(asked(app, locked).length, 0, "not asked");
  assert.equal(ranTests(app, locked), false);
  app.store.save("settings", "local", "lockdown", { on: false });
  const { saveCodeRunSettings } = await import("../dist/code-run.js");
  await saveCodeRunSettings(app.store, "local", { enabled: true });
  const scripts = await app.runtime.run({ prompt: "fix it" });
  assert.equal(asked(app, scripts).length, 0, "the owner already said yes to running scripts");
  assert.equal(ranTests(app, scripts), true);
});

test("1 read-first on: a file the task had tidied with code.format still counts as read", async (t) => {
  const { app, workspace } = await fixture(t);
  const { EditChecks } = await import("../dist/coding/format-on-edit.js");
  const { saveCodingMode } = await import("../dist/coding/settings.js");
  const { mkdir, writeFile, readFile } = await import("node:fs/promises");
  await mkdir(join(workspace, "src"), { recursive: true });
  await mkdir(join(workspace, "..", "bin"), { recursive: true });
  const formatter = join(workspace, "..", "bin", "fmt");
  await writeFile(formatter, "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(join(workspace, "src", "a.ts"), "const  a =  1;\n");
  saveCodingMode(app.store, "local", "read-first", "on");
  saveCodingMode(app.store, "local", "format-on-edit", "on");
  // A formatter that squeezes spaces, started through a stand-in for the wall (no program runs).
  const runner = async (run) => {
    const file = run.args.at(-1);
    await writeFile(file, (await readFile(file, "utf8")).replace(/  +/g, " "));
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  };
  const checks = new EditChecks({ store: app.store, owner: "local", files: app.coding["deps"].files, runner,
    areas: () => app.runtime.protectedAreas, servers: { enabled: () => false }, trusted: () => true,
    wall: () => ({ network: "none" }), walled: async (run, start) => run(start) });
  await checks.save({ formatters: { fmt: { path: formatter, args: ["{file}"], extensions: [".ts"] } } });
  const task = app.store.createRun("local", "tidy and edit");
  const context = contextOf(app, { runId: task.id, permissions: new Set(["files.read", "files.write"]) });
  await app.registry.execute("files.read", { path: "src/a.ts" }, context);
  // What code.format does, then what the registry does after every call.
  assert.equal((await checks.check("src/a.ts", context)).reformatted, true);
  await app.registry.afterWrites(context);
  const edited = await app.registry.execute("files.edit", { path: "src/a.ts", find: "a = 1", replace: "a = 2" }, context);
  assert.equal(edited.path, "src/a.ts");
  assert.equal(await readFile(join(workspace, "src", "a.ts"), "utf8"), "const a = 2;\n");
});

// ------------------------------------------------------------------ integration review (adversarial)

test("review 5 every place that starts this program to run a script says to run it as Node", async () => {
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const files = [];
  const walk = (dir) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (path.endsWith(".ts")) files.push(path); } };
  walk("src");
  const starts = /(?:spawn|execFile|execFileSync|spawnSync|fork|runBenchmarkCommand)\(\s*process\.execPath|(?:executable|command):\s*process\.execPath/;
  // The Linux wall's door bridge: its environment is put together further down, in linuxWall.
  const bridge = (line) => line.includes("executable: process.execPath, args: [bridge,");
  assert.match(readFileSync(join("src", "sandbox-backends.ts"), "utf8"), /proxyEnvironment\([^\n]*runAsNode\(process\.execPath\)/);
  const missing = [];
  for (const file of files) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!starts.test(line) || bridge(line)) return;
      const near = lines.slice(Math.max(0, index - 3), index + 4).join("\n");
      if (!/runAsNode\(|ELECTRON_RUN_AS_NODE/.test(near)) missing.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(missing, [], "inside the desktop app these would open a second copy of the app");
});

test("review 2 a key that respells one the tool takes, or asks for nothing to really happen, is never dropped", async (t) => {
  const { app } = await fixture(t);
  const clean = (name, args) => app.registry.clean(name, args);
  for (const [name, args] of [
    ["code.patch", { patch: "x", dry_run: true }],
    ["code.change_set", { reason: "r", edits: [{ path: "a", find: "x", replace: "y" }], "dry-run": true }],
    ["files.write", { path: "a.txt", content: "x", preview: true }],
    ["files.edit", { path: "a.txt", find: "x", replace: "y", replace_all: true }],
  ]) assert.deepEqual(clean(name, args), { args, ignored: [] }, `${name} ${JSON.stringify(args)}`);
  assert.deepEqual(clean("files.read", { path: "a.txt", format: "js" }).ignored, ["format"], "a key that means nothing still goes");
});

test("review 2 a patch sent with dry_run is refused, not applied for real", async (t) => {
  const { app, workspace } = await readFirstFixture(t, [
    call("code.patch", { patch: "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n", dry_run: true }), say("done")], "off");
  const run = await app.runtime.run({ prompt: "show me the change" });
  const [answer] = toolMessages(app, run);
  assert.equal(answer.ok, false, JSON.stringify(answer));
  assert.equal(await fileText(workspace, "a.txt"), "one\n");
});

test("review 2 the question shows the call as it will run, without the ignored key; the yes stays bound to what was sent", async (t) => {
  const sent = { path: "keep.txt", content: "new", format: "markdown" };
  const provider = scripted([call("files.write", sent), say("done")]);
  const { app } = await fixture(t, { provider });
  const { addPolicyRule } = await import("../dist/policy.js");
  const { argumentFingerprint } = await import("../dist/runtime.js");
  addPolicyRule(app.store, "local", { tool: "files.write", match: "keep.txt", decision: "ask", remember: "never" });
  const run = await app.runtime.run({ prompt: "write" });
  assert.equal(run.status, "needs_input");
  const [question] = asked(app, run);
  assert.deepEqual(JSON.parse(question.data.bytes), { path: "keep.txt", content: "new" });
  assert.equal(question.data.fingerprint, argumentFingerprint("files.write", JSON.stringify(sent)));
});

test("review 4 a plain yes with no choice made is Once; carrying a workflow on never writes a standing rule", async (t) => {
  const { app, workspace } = await testsFixture(t, [call("code.check", {})]);
  const run = await app.runtime.run({ prompt: "fix it" });
  assert.equal(asked(app, run)[0].data.remember, "never", "the terminal's y and other defaults answer Once");
  const flow = app.workflows.create("local", { name: "check it", steps: [{ name: "tests", kind: "tool", tool: "code.check", args: {} }] });
  const waiting = await app.workflows.run("local", flow.id);
  assert.equal(waiting.status, "waiting_approval");
  const done = await app.workflows.resume("local", flow.id);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.match(done.state[0].output, /"ran":true/, "the pass let the tests run once");
  const { readPolicy } = await import("../dist/policy.js");
  assert.ok(!readPolicy(app.store, "local").rules.some((rule) => rule.tool === "code.tests"), "no standing rule");
  const { projectTestsVerdict } = await import("../dist/coding/project-tests.js");
  const host = { store: app.store, owner: "local", approvals: app.runtime.approvals, sessionId: "somewhere-else" };
  assert.equal(projectTestsVerdict(host, workspace), "ask");
  assert.throws(() => app.runtime.grantApproval("wf", { tool: "code.tests", target: workspace, label: "x", source: "schedule" }, "always"));
});

test("review 4 a dry run (plan) never runs the tests and never asks", async (t) => {
  const { app } = await testsFixture(t, [call("code.check", {}), say("done")]);
  const run = await app.runtime.run({ prompt: "plan it", dryRun: true });
  assert.equal(asked(app, run).length, 0);
  assert.equal(ranTests(app, run), false);
  assert.ok(app.store.events(run.id).some((event) => event.kind === "tool.simulated"));
});

test("--allow-tests with a dry run still never runs the tests", async (t) => {
  const { app } = await testsFixture(t, [call("code.check", {}), say("done")]);
  const run = await app.runtime.run({ prompt: "plan it", dryRun: true, allowProjectTests: true });
  assert.equal(asked(app, run).length, 0);
  assert.equal(ranTests(app, run), false);
  assert.ok(app.store.events(run.id).some((event) => event.kind === "tool.simulated"));
});

test("branch headless --allow-tests runs the tests for its requests; without it they are skipped", async (t) => {
  const { runHeadless } = await import("../dist/headless.js");
  const { parseRunArgs } = await import("../dist/cli-run.js");
  const check = call("code.check", {});
  const { app } = await testsFixture(t, [check, say("done"), check, say("done")]);
  const writer = { line() {}, note() {} };
  const skipped = await runHeadless(app.runtime, { prompts: ["fix it"], flags: parseRunArgs([]), stopEarly: false }, writer);
  assert.equal(skipped.exitCode, 0);
  assert.equal(ranTests(app, { id: skipped.steps[0].runId }), false);
  const allowed = await runHeadless(app.runtime, { prompts: ["fix it"], flags: parseRunArgs(["--allow-tests"]), stopEarly: false }, writer);
  assert.equal(allowed.exitCode, 0);
  assert.equal(ranTests(app, { id: allowed.steps[0].runId }), true);
});

test("review 1 with the switch off the guard is never consulted", async (t) => {
  const { app, workspace } = await readFirstFixture(t, [edit("one", "two"),
    call("files.write", { path: "a.txt", content: "three\n" }), say("done")], "off");
  const guard = app.coding["deps"].files.readFirst;
  guard.require = async () => { throw new Error("looked at while off"); };
  const run = await app.runtime.run({ prompt: "change it" });
  assert.ok(toolMessages(app, run).every((answer) => answer.ok), JSON.stringify(toolMessages(app, run)));
  assert.equal(await fileText(workspace, "a.txt"), "three\n");
});

test("review 6 a missing switch file means the shipped setting (on), a damaged one means off, and a late crash never throws", async (t) => {
  const { DiagnosticLog, crashReporterPlan, crashCaptureMarked } = await import("../dist/diagnostic-log.js");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dataDir = await mkdtemp(join(tmpdir(), "branch-crash-bad-"));
  t.after(() => discardTemp(dataDir));
  assert.equal(crashCaptureMarked(dataDir), true, "no file yet: a fresh install keeps crash notes, as shipped");
  await mkdir(join(dataDir, "logs"), { recursive: true });
  for (const bad of ["{not json", JSON.stringify({ crashCapture: "yes" }), JSON.stringify("on"), ""]) {
    await writeFile(join(dataDir, "logs", "crash-capture.json"), bad);
    assert.equal(crashReporterPlan(dataDir), null, bad);
    const log = new DiagnosticLog({ dir: join(dataDir, "logs"), settings: () => { throw new Error("database is not open"); } });
    assert.doesNotThrow(() => log.crash("engine", new Error("late")));
    assert.equal(log.crashes(5).length, 0, bad);
  }
});

// ------------------------------------------------------------------ mac7/tests-unattended

const lastAnswer = (app, run) => toolMessages(app, run).at(-1);
const testsRules = async (app) => (await import("../dist/policy.js")).readPolicy(app.store, "local").rules.filter((rule) => rule.tool === "code.tests");
const scriptFlags = async (...words) => (await import("../dist/cli-run.js")).parseRunArgs(["fix it", ...words]);
const quietWriter = () => { const notes = []; return { notes, line() {}, note(text) { notes.push(text); } }; };
const escaped = (text) => text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

test("unattended: nobody to ask, so the tests are skipped with a note and the task carries on to the end", async (t) => {
  const { app, workspace } = await testsFixture(t, [call("code.check", {}), call("files.write", { path: "fixed.txt", content: "ok\n" }), say("done")]);
  const run = await app.runtime.run({ prompt: "fix it", unattended: true });
  assert.equal(run.status, "completed", run.output);
  assert.equal(asked(app, run).length, 0, "no question was put");
  assert.equal(ranTests(app, run), false, "the tests did not run");
  const [skipped] = toolMessages(app, run).filter((answer) => answer.result?.note?.includes("were not run"));
  assert.equal(skipped.result.ran, false);
  assert.match(skipped.result.note, new RegExp(`^This project's tests were not run: running them has not been allowed for ${escaped(workspace)}\\.`));
  assert.match(skipped.result.note, /Always for this folder.+branch run --allow-tests/);
  assert.equal(await fileText(workspace, "fixed.txt"), "ok\n", "the work after the check went ahead");
  assert.deepEqual(await testsRules(app), [], "nothing was saved");
  assert.equal(app.runtime.approvals.answer(run.sessionId, "code.tests", workspace), undefined, "no answer was remembered either");
});

test("unattended: a script's branch run skips; the same run from a terminal still asks", async (t) => {
  const { runForScripts } = await import("../dist/cli-run.js");
  const { app } = await testsFixture(t, [call("code.check", {}), say("done"), call("code.check", {})]);
  const script = await runForScripts(app.runtime, await scriptFlags(), quietWriter());
  assert.equal(script.status, "completed", script.output);
  assert.equal(asked(app, script).length, 0);
  assert.equal(ranTests(app, script), false);
  const typed = await runForScripts(app.runtime, await scriptFlags(), quietWriter(), true);
  assert.equal(typed.status, "needs_input", "a person at a terminal is asked, as before");
  assert.equal(asked(app, typed)[0].data.kind, "project-tests");
  assert.equal(ranTests(app, typed), false);
});

test("unattended: work nobody watches skips the tests question; an editor over ACP is still asked", async (t) => {
  const check = call("code.check", {});
  const { app } = await testsFixture(t, [check, check, say("done"), check, check]);
  // Outside work is held to "Ask before changes", so code.check itself waits for a yes first (0.18.1).
  const scheduled = await app.runtime.run({ prompt: "fix it", source: "schedule" });
  assert.equal(scheduled.status, "needs_input");
  assert.equal(asked(app, scheduled)[0].data.name, "code.check", "the change-hold is untouched");
  app.runtime.approve(scheduled.sessionId, "allow", "session");
  const carried = await app.runtime.run({ prompt: "carry on", sessionId: scheduled.sessionId, source: "schedule" });
  assert.equal(carried.status, "completed", carried.output);
  assert.equal(asked(app, carried).length, 0, "the tests question was not put");
  assert.equal(ranTests(app, carried), false);
  assert.match(lastAnswer(app, carried).result.note, /were not run/);
  const editor = await app.runtime.run({ prompt: "fix it", source: "acp" });
  app.runtime.approve(editor.sessionId, "allow", "session");
  const again = await app.runtime.run({ prompt: "carry on", sessionId: editor.sessionId, source: "acp" });
  assert.equal(again.status, "needs_input", "the editor has a person to answer");
  assert.equal(asked(app, again).at(-1).data.kind, "project-tests");
});

test("--allow-tests runs the tests in that one task, every time it checks, and saves nothing", async (t) => {
  const { runForScripts } = await import("../dist/cli-run.js");
  const check = call("code.check", {});
  const { app, workspace } = await testsFixture(t, [check, check, say("done"), check]);
  const writer = quietWriter();
  const run = await runForScripts(app.runtime, await scriptFlags("--allow-tests"), writer);
  assert.equal(run.status, "completed", run.output);
  assert.equal(asked(app, run).length, 0);
  assert.equal(app.store.events(run.id).filter((event) => event.kind === "code.check").length, 2, "both checks ran the tests");
  assert.equal(lastAnswer(app, run).result.ran, true);
  assert.match(writer.notes.join("\n"), /may run the project's tests without asking; nothing is saved/);
  assert.deepEqual(await testsRules(app), [], "no standing rule");
  assert.equal(app.runtime.approvals.answer(run.sessionId, "code.tests", workspace), undefined, "no answer remembered");
  assert.equal(app.runtime.approvals.takeOnce(run.sessionId, "code.tests", workspace), false, "no Once left behind");
  const next = await app.runtime.run({ prompt: "again", sessionId: run.sessionId });
  assert.equal(next.status, "needs_input", "the next task in the same conversation asks again");
});

test("--allow-tests: a No already given still wins", async (t) => {
  const { app, workspace } = await testsFixture(t, [call("code.check", {}), say("done")]);
  const { addPolicyRule } = await import("../dist/policy.js");
  addPolicyRule(app.store, "local", { tool: "code.tests", match: workspace, decision: "deny", remember: "always" });
  const run = await app.runtime.run({ prompt: "fix it", allowProjectTests: true });
  assert.equal(ranTests(app, run), false);
  assert.match(lastAnswer(app, run).result.note, /chose not to let Branch run/);
});

test("--allow-tests is refused under Lockdown and for anyone but the owner; the flag cannot come in over the API", async (t) => {
  const { runForScripts } = await import("../dist/cli-run.js");
  const { underShortLivedKey } = await import("../dist/key-context.js");
  const { RunInputSchema } = await import("../dist/contracts.js");
  const { app } = await testsFixture(t, [call("code.check", {}), say("done")]);
  const flags = await scriptFlags("--allow-tests");
  app.store.save("settings", "local", "lockdown", { on: true });
  await assert.rejects(runForScripts(app.runtime, flags, quietWriter()), /cannot be used while Lockdown is on/);
  app.store.save("settings", "local", "lockdown", { on: false });
  await assert.rejects(underShortLivedKey(() => runForScripts(app.runtime, flags, quietWriter())), /the owner's alone/);
  const person = app.store.profiles.create({ name: "Sam", pin: "1234" });
  app.store.profiles.switch({ profileId: person.id, pin: "1234" });
  await assert.rejects(runForScripts(app.runtime, flags, quietWriter()), /the owner's alone/);
  app.store.profiles.switch({ profileId: null });
  assert.equal(app.store.runs("local").length, 0, "no task was started");
  assert.equal(RunInputSchema.safeParse({ prompt: "fix it", allowTests: true }).success, false);
  assert.equal(RunInputSchema.safeParse({ prompt: "fix it", allowProjectTests: true }).success, false);
});

test("--allow-tests reaching the runtime some other way is still held to the owner's own task, outside Lockdown", async (t) => {
  const { underShortLivedKey } = await import("../dist/key-context.js");
  const { allowedForThisRun } = await import("../dist/coding/project-tests.js");
  const check = call("code.check", {});
  const { app } = await testsFixture(t, [check, check, say("done"), check, say("done")]);
  const keyed = await underShortLivedKey(() => app.runtime.run({ prompt: "fix it", allowProjectTests: true }));
  assert.equal(ranTests(app, keyed), false);
  assert.equal(keyed.status, "needs_input", "asked as if the flag were not there");
  const own = await app.runtime.run({ prompt: "fix it", allowProjectTests: true });
  assert.equal(ranTests(app, own), true, "the owner's own task with the flag runs them (the control)");
  for (const source of ["channel", "schedule", "trigger", "mcp", "a2a", "acp"])
    assert.equal(allowedForThisRun(app.store, "local", contextOf(app, { allowProjectTests: true, source })), false, source);
  app.store.save("settings", "local", "lockdown", { on: true });
  const locked = await app.runtime.run({ prompt: "fix it", allowProjectTests: true });
  assert.equal(ranTests(app, locked), false, "Lockdown refuses even when the flag reached the runtime");
  assert.equal(asked(app, locked).length, 0);
});

test("branch run --help says what --allow-tests does", async () => {
  const { commandHelp } = await import("../dist/cli-completion.js");
  for (const name of ["run", "headless"]) {
    const help = commandHelp(name);
    assert.match(help, /^ {2}--allow-tests$/m, name);
    assert.match(help, /--allow-tests lets this one task run the project's tests without asking.+Lockdown refuses it/, name);
  }
});

/**
 * A model on this computer that opens the code toolbox, calls code.check once, and then says done:
 * enough to drive the real `branch run` in a child process, which has no terminal of its own.
 */
async function checkingModel(t) {
  const { createServer } = await import("node:http");
  const named = (payload, pattern) => (payload.tools ?? []).find((tool) => pattern.test(tool.function.description))?.function.name;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const payload = JSON.parse(body);
    const checked = payload.messages.some((message) => message.role === "tool" && /"ran"/.test(String(message.content)));
    const check = named(payload, /^Run the check the owner set up/), open = named(payload, /^Open a (whole )?toolbox/);
    const pick = checked ? null : check ? [check, "{}"] : open ? [open, JSON.stringify({ groups: ["code"] })] : null;
    const delta = pick ? { tool_calls: [{ index: 0, id: `c${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name: pick[0], arguments: pick[1] } }] } : { content: "done" };
    const frames = [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: pick ? "tool_calls" : "stop" }] }];
    response.setHeader("Content-Type", "text/event-stream");
    response.end(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}/v1`;
}
async function branchRun(t, args, extraEnv = {}) {
  const { execFile } = await import("node:child_process");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "branch-tests-unattended-"));
  t.after(() => discardTemp(root));
  const workspace = join(root, "ws");
  await mkdir(join(workspace, "test"), { recursive: true });
  await writeFile(join(workspace, "package.json"), JSON.stringify({ name: "p", type: "module" }));
  await writeFile(join(workspace, "test", "a.test.mjs"), 'import test from "node:test";\ntest("adds", () => {});\n');
  const env = { ...process.env, BRANCH_WORKSPACE: workspace, BRANCH_DATA_DIR: join(root, "data"), BRANCH_PROVIDER: "openai",
    BRANCH_ENDPOINT: await checkingModel(t), BRANCH_MODEL: "m", BRANCH_API_KEY: "k" };
  delete env.FORCE_TTY; // a child started here has no terminal; that alone must make it a script
  Object.assign(env, extraEnv);
  return new Promise((resolve) => execFile(process.execPath, ["dist/cli.js", "run", "fix it", ...args], { env, timeout: 120_000 },
    (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));
}
const kinds = (stdout, kind) => stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((line) => line.kind === kind);

test("the real branch run from a script skips the tests and finishes; typed in a terminal it still asks", async (t) => {
  const script = await branchRun(t, ["--json"]);
  assert.equal(script.code, 0, script.stderr);
  assert.equal(kinds(script.stdout, "policy.ask").length, 0);
  assert.equal(kinds(script.stdout, "code.check").length, 0, "the tests did not run");
  assert.match(script.stdout, /This project's tests were not run: running them has not been allowed for /);
  const typed = await branchRun(t, [], { FORCE_TTY: "1" });
  assert.equal(typed.code, 2, "a person at the terminal is asked, as before (exit 2: stopped to ask)");
  assert.match(typed.stdout, /Let Branch run this project's tests\?/);
});

test("the real branch run --allow-tests runs them once for that task; under Lockdown it is refused", async (t) => {
  const allowed = await branchRun(t, ["--json", "--allow-tests"]);
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(kinds(allowed.stdout, "code.check").length, 1, "the tests ran");
  assert.match(allowed.stderr, /nothing is saved/);
  const { createBranch: open } = await import("../dist/index.js");
  const root = await mkdtemp(join(tmpdir(), "branch-tests-unattended-lock-"));
  t.after(() => discardTemp(root));
  const app = await open({ workspace: join(root, "ws"), dataDir: join(root, "data"), presets: [{ id: "alpha", name: "Alpha", provider: { name: "none", async complete() { return { content: "", toolCalls: [] }; } }, model: "a" }] });
  app.store.save("settings", "local", "lockdown", { on: true });
  await app.close();
  const locked = await branchRun(t, ["--json", "--allow-tests"], { BRANCH_DATA_DIR: join(root, "data") });
  assert.notEqual(locked.code, 0);
  assert.match(locked.stderr, /--allow-tests cannot be used while Lockdown is on/);
});

// ------------------------------------------------------------------ mac7/smoke-fixes (B6)

/**
 * The smoke test found `--allow-tests` "making the tests less likely to run": five rounds straight
 * to a command without it, twelve rounds wandering with it. The flag cannot do that —
 * `allowProjectTests` reaches exactly one place, the tests question — and these two hold that down.
 * What the flag really got wrong was announcing itself in a folder where it can do nothing.
 */
test("B6 --allow-tests changes nothing about which tools a task is offered, or how far it gets", async (t) => {
  const steps = [call("files.read", { path: "package.json" }), call("code.check", {}), say("done")];
  const { readPolicy } = await import("../dist/policy.js");
  const prompt = "Run the test suite in this project with node --test and say whether it passes";
  const rounds = (app, run) => app.store.events(run.id).filter((event) => event.kind === "catalog.size").length;
  const offered = (app) => app.runtime.provider.requests.map((request) => (request.tools ?? []).map((tool) => tool.name).join(","));
  const preselected = (app, run) => app.store.events(run.id).filter((event) => event.kind === "catalog.preselected")
    .map((event) => JSON.stringify({ guessed: event.data.guessed, tools: event.data.tools }));

  // With the question already answered for this folder, the flag has nothing left to do: both runs
  // must be the same task, tool for tool and round for round.
  const settled = async (allow) => {
    const made = await testsFixture(t, steps);
    const first = await made.app.runtime.run({ prompt: "warm up" });
    made.app.runtime.approve(first.sessionId, "allow", "always");
    assert.ok(readPolicy(made.app.store, "local").rules.some((rule) => rule.tool === "code.tests"));
    made.app.runtime.provider.requests.length = 0;
    const run = await made.app.runtime.run({ prompt, ...(allow ? { allowProjectTests: true } : {}) });
    return { ...made, run };
  };
  const plainSettled = await settled(false), flagSettled = await settled(true);
  assert.deepEqual(offered(flagSettled.app), offered(plainSettled.app), "the same tools are shown, round for round");
  assert.deepEqual(preselected(flagSettled.app, flagSettled.run), preselected(plainSettled.app, plainSettled.run),
    "the same toolboxes are pre-loaded");
  assert.equal(rounds(flagSettled.app, flagSettled.run), rounds(plainSettled.app, plainSettled.run),
    "and the task takes the same number of rounds");
  assert.equal(ranTests(flagSettled.app, flagSettled.run), true);
  assert.equal(ranTests(plainSettled.app, plainSettled.run), true);

  // Unanswered, the only difference is the question: the flagged run does everything the plain one
  // did, in the same order, and then carries on instead of stopping. It never reaches for less.
  const plain = await testsFixture(t, steps);
  const flagged = await testsFixture(t, steps);
  const a = await plain.app.runtime.run({ prompt });
  const b = await flagged.app.runtime.run({ prompt, allowProjectTests: true });
  assert.deepEqual(offered(flagged.app).slice(0, offered(plain.app).length), offered(plain.app),
    "the flag must not change which tools the model is shown");
  assert.deepEqual(preselected(flagged.app, b), preselected(plain.app, a), "nor the pre-loaded toolboxes");
  assert.ok(rounds(flagged.app, b) >= rounds(plain.app, a), "and it never makes the task get less far");
  assert.equal(asked(plain.app, a).length, 1);
  assert.equal(ranTests(plain.app, a), false, "without it, the task stops on the question");
  assert.equal(asked(flagged.app, b).length, 0);
  assert.equal(ranTests(flagged.app, b), true, "with it, the question is not put and the tests run");
});

test("B6 --allow-tests says so plainly when this folder has no question for it to remove", async (t) => {
  const { runForScripts, parseRunArgs } = await import("../dist/cli-run.js");
  const notes = [];
  const writer = { line() {}, note(text) { notes.push(text); } };

  // A Node project with the script switch off: the flag does remove a question here.
  const node = await testsFixture(t, [call("code.check", {}), say("done")]);
  await runForScripts(node.app.runtime, parseRunArgs(["--allow-tests", "fix", "it"]), writer);
  assert.deepEqual(notes, ["[this task may run the project's tests without asking; nothing is saved]"]);

  // A folder with no package.json and no check set up: there is nothing to allow, and it says so.
  notes.length = 0;
  const bare = await fixture(t, { provider: scripted([say("done")]) });
  await runForScripts(bare.app.runtime, parseRunArgs(["--allow-tests", "fix", "it"]), writer);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /there is no package\.json in .* and no check is set up for this project/);
  assert.match(notes[0], /--allow-tests changes nothing here/);

  // Running scripts on: the tests already run without the question, so the flag changes nothing.
  notes.length = 0;
  const { saveCodeRunSettings } = await import("../dist/code-run.js");
  await saveCodeRunSettings(node.app.store, "local", { enabled: true });
  await runForScripts(node.app.runtime, parseRunArgs(["--allow-tests", "fix", "it"]), writer);
  assert.match(notes[0], /running scripts is switched on/);
});
