/**
 * The self-development loop on an isolated engine, end to end with real Git: a Trunk clones a scratch
 * repository from a local bare "origin", adds a settings knob, runs the test, commits, pushes, opens a pull
 * request, waits for checks and merges only when they are green (tests/fixtures/fake-github.mjs runs the
 * pushed head's test for real). The model here is scripted so the check is fast and exact; the same loop
 * with a real model is scripts/selfdev-proof.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import { startFakeGitHub } from "./fixtures/fake-github.mjs";
import { scratchTestFile, seedScratchRepo, startEngine } from "./fixtures/selfdev-harness.mjs";

const repo = "owner/scratch", token = "fake-token-for-tests";
const knob = [
  "/** The app's settings knobs: each has a default and says which values it accepts. */",
  "export const knobs = {",
  "  theme: { default: \"light\", valid: (value) => [\"light\", \"dark\"].includes(value) },",
  "  replyLength: { default: \"medium\", valid: (value) => [\"short\", \"medium\", \"long\"].includes(value) },",
  "};",
  "",
  "/** A saved value when it is valid, else the knob's default. Unknown names are refused. */",
  "export function readSetting(saved, name) {",
  "  const knob = knobs[name];",
  "  if (!knob) throw new Error(`No setting called ${name}`);",
  "  return Object.hasOwn(saved, name) && knob.valid(saved[name]) ? saved[name] : knob.default;",
  "}",
  "",
].join("\n");
const knobTest = (expected) => [
  "import test from \"node:test\";",
  "import assert from \"node:assert/strict\";",
  "import { readSetting } from \"../src/settings.mjs\";",
  "",
  "test(\"theme defaults to light and keeps a valid saved value\", () => {",
  "  assert.equal(readSetting({}, \"theme\"), \"light\");",
  "  assert.equal(readSetting({ theme: \"dark\" }, \"theme\"), \"dark\");",
  "});",
  "",
  "test(\"replyLength defaults to medium and keeps a valid saved value\", () => {",
  `  assert.equal(readSetting({}, "replyLength"), "${expected}");`,
  "  assert.equal(readSetting({ replyLength: \"short\" }, \"replyLength\"), \"short\");",
  "});",
  "",
].join("\n");

const call = (name, args, id) => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const lastTool = (request) => [...request.messages].reverse().find((message) => message.role === "tool")?.content ?? "";

/** The steps a coding model takes for this task, one per model round; waiting repeats until the checks settle. */
function scriptedCoder(origin, expected, syntaxError = false) {
  const steps = [
    () => call("git.clone", { url: origin, folder: "scratch" }, "clone"),
    () => call("shell.execute", { executable: "git", args: ["checkout", "-b", "add-reply-length"], cwd: "scratch" }, "branch"),
    () => call("files.read", { path: "scratch/src/settings.mjs" }, "read-knobs"),
    () => call("files.write", { path: "scratch/src/settings.mjs", content: syntaxError ? `${knob}export const = ;
` : knob }, "knob"),
    () => call("files.read", { path: `scratch/${scratchTestFile}` }, "read-test"),
    () => call("files.write", { path: `scratch/${scratchTestFile}`, content: knobTest(expected) }, "test"),
    () => call("shell.execute", { executable: "node", args: ["--test", scratchTestFile], cwd: "scratch" }, "run-tests"),
    () => call("git.commit", { folder: "scratch", message: "feat: add a replyLength setting" }, "commit"),
    () => call("git.push", { folder: "scratch", remote: "origin", branch: "add-reply-length" }, "push"),
    () => call("github.open_pull_request", { repo, title: "Add a replyLength setting", base: "main", head: "add-reply-length" }, "pr"),
  ];
  let index = 0, waits = 0, merged = false;
  const provider = { name: "scripted", async complete(request) {
    const said = [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
    if (/Introduce yourself/.test(said)) return { content: "Hello, I am Ada.", toolCalls: [] };
    if (index < steps.length) return steps[index++]();
    const last = lastTool(request);
    if (merged) return { content: `Finished: ${last.slice(0, 200)}`, toolCalls: [] };
    if (/"state":"pending"/.test(last) || /"id":"pr"/.test(last) || index === steps.length) {
      index = steps.length + 1;
      return call("github.wait_for_checks", { repo, number: 1, seconds: 30 }, `wait-${++waits}`);
    }
    // Whatever the checks said, a careless model still tries to merge: Branch alone decides.
    merged = true;
    return call("github.merge_pull_request", { repo, number: 1 }, "merge");
  } };
  return provider;
}

async function loop(t, { expected = "medium", mode = "full", trunk = "default", syntaxError = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-selfdev-loop-"));
  const origin = await seedScratchRepo(root);
  const github = await startFakeGitHub({ bare: origin.bare, repo, token, testFile: scratchTestFile,
    timing: { fastAfterMs: 300, fastDoneMs: 600, slowAfterMs: 900 } });
  const engine = await startEngine(root, { githubApiBase: github.apiBase, githubPollSeconds: 1, token, privateAddresses: true,
    provider: scriptedCoder(origin.bare, expected, syntaxError) });
  t.after(async () => { await engine.close(); await github.close(); await discardTemp(root); });
  const health = [];
  const poller = setInterval(() => { void engine.api("health").then((answer) => health.push(answer.status), () => health.push(0)); }, 200);
  t.after(() => clearInterval(poller));
  // The owner's conversations go to their designated default Trunk; "other" is a second, ordinary Trunk.
  const { trunks } = engine.app;
  trunks.setMode("trunks", { mode: "on" });
  const ada = trunks.create({ name: "Ada" }), bo = trunks.create({ name: "Bo" });
  trunks.setDefault(ada.id);
  await trunks.introduced();
  const sessionId = (trunk === "other" ? bo : ada).chatSessionId;
  assert.equal((await engine.api("conversation-mode", { sessionId, mode })).status, 200);
  const started = await engine.api("run", { prompt: "Add a replyLength setting to the scratch project, test it, and merge it when its checks pass.", sessionId });
  clearInterval(poller);
  const bareMain = () => execFileSync("git", ["show", "main:src/settings.mjs"], { cwd: origin.bare, encoding: "utf8" });
  return { engine, github, started, health, bareMain, origin };
}

test("in owner Full Access a Trunk takes a knob from edit to a merge on green checks, with no question asked", async (t) => {
  const { engine, github, started, health, bareMain } = await loop(t);
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const run = engine.app.store.run(started.body.id);
  const events = engine.app.store.events(run.id);
  if (process.env.SELFDEV_DEBUG) console.log(events.filter((e) => /^tool\./.test(e.kind)).map((e) => `${e.kind} ${e.data.name} ${String(e.data.error ?? "").slice(0, 200)}`).join("\n"));
  assert.equal(run.status, "completed", run.output);
  assert.deepEqual(events.filter((event) => /approval|needs_input|input\.needed/.test(event.kind)), [], "no question was asked");
  const names = events.filter((event) => event.kind === "tool.completed").map((event) => event.data.name);
  for (const name of ["git.clone", "shell.execute", "files.write", "git.commit", "git.push", "github.open_pull_request", "github.wait_for_checks", "github.merge_pull_request"])
    assert.ok(names.includes(name), `${name} ran`);
  assert.equal(github.mergeAttempts.length, 1, "one merge");
  assert.equal(github.mergeAttempts[0].pending, false, "never while anything was still running");
  assert.equal(github.mergeAttempts[0].green, true);
  assert.match(bareMain(), /replyLength/, "origin's main has the knob");
  assert.ok(health.length > 0 && health.every((status) => status === 200), "the engine kept serving throughout");
});

test("a self-edit whose test fails is refused at the merge and origin is untouched", async (t) => {
  const { engine, github, started, bareMain } = await loop(t, { expected: "long" });
  assert.equal(started.status, 200);
  const events = engine.app.store.events(started.body.id);
  if (process.env.SELFDEV_DEBUG) console.log(events.filter((e) => /^tool\./.test(e.kind)).map((e) => `${e.kind} ${e.data.name} ${JSON.stringify(e.data).slice(0, 300)}`).join("\n"), JSON.stringify(github.mergeAttempts));
  const waits = events.filter((event) => event.kind === "tool.completed" && event.data.name === "github.wait_for_checks");
  assert.ok(waits.length >= 1);
  const merge = events.find((event) => /^tool\./.test(event.kind) && event.data.name === "github.merge_pull_request" && event.kind !== "tool.started");
  assert.equal(merge?.kind, "tool.failed", "Branch refused the merge");
  assert.match(String(merge.data.error), /did not pass/);
  assert.equal(github.mergeAttempts.length, 0, "no merge request ever reached GitHub");
  assert.doesNotMatch(bareMain(), /replyLength/, "origin's main is unchanged");
  assert.equal((await engine.api("health")).status, 200, "the running engine still serves");
});

test("a self-edit with a syntax error is refused at the merge and origin is untouched", async (t) => {
  const { engine, github, started, bareMain } = await loop(t, { syntaxError: true });
  assert.equal(started.status, 200);
  const events = engine.app.store.events(started.body.id);
  const merge = events.find((event) => event.kind === "tool.failed" && event.data.name === "github.merge_pull_request");
  assert.match(String(merge?.data.error), /did not pass/, "Branch refused the merge");
  assert.equal(github.mergeAttempts.length, 0);
  assert.doesNotMatch(bareMain(), /replyLength/);
  assert.equal((await engine.api("health")).status, 200, "the running engine still serves");
});

test("outside Full Access the same work stops for the owner's answer before anything changes", async (t) => {
  const { engine, github, started } = await loop(t, { mode: "ask" });
  assert.equal(started.status, 200);
  const run = engine.app.store.run(started.body.id);
  assert.equal(run.status, "needs_input", "Ask first holds the first change for a yes");
  assert.equal(github.pulls.size, 0);
  assert.equal(github.mergeAttempts.length, 0);
});

test("another Trunk in a Full Access conversation keeps its own reach: no commands, nothing merged", async (t) => {
  const { engine, github, started, bareMain } = await loop(t, { trunk: "other" });
  assert.equal(started.status, 200);
  const events = engine.app.store.events(started.body.id);
  const commands = events.filter((event) => event.kind === "tool.failed" && event.data.name === "shell.execute");
  assert.ok(commands.length >= 1 && commands.every((event) => /Permission denied/.test(String(event.data.error))), "its commands stay off");
  assert.equal(events.some((event) => event.kind === "tool.completed" && ["shell.execute", "git.push", "github.merge_pull_request"].includes(event.data.name)), false);
  assert.equal(github.mergeAttempts.length, 0);
  assert.doesNotMatch(bareMain(), /replyLength/);
});

test("git.clone brings a repository into a new workspace folder only, never Branch's own source, never with sign-in details", async (t) => {
  const { engine, origin } = await loop(t, { mode: "ask" });
  const context = { ...engine.app.runtime.context({ runId: engine.app.store.runs(engine.app.runtime.owner)[0].id }), permissions: new Set(["git.remote"]) };
  const cloned = await engine.app.registry.execute("git.clone", { url: origin.bare, folder: "copies/one" }, context);
  assert.equal(cloned.branch, "main");
  for (const [args, refusal] of [
    [{ url: origin.bare, folder: "copies/one" }, /already exists/],
    [{ url: origin.bare, folder: "branch-agent-source" }, /branch\.prepare_source_change|self-development contract/],
    [{ url: "https://user:secret@example.com/a/b.git", folder: "copies/two" }, /no sign-in details/],
    [{ url: "ext::sh -c touch% /tmp/x", folder: "copies/three" }, /https:\/\/ address or from a repository folder/],
    [{ url: "relative/path", folder: "copies/four" }, /full path/],
  ]) await assert.rejects(engine.app.registry.execute("git.clone", args, context), refusal);
});
