/**
 * Wave 7 (benchmarks and experiments). Everything here runs offline against scripted models and
 * the synthetic benchmark samples in tests/fixtures/benchmarks; no dataset and no network.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  createBranch, makeScorer, scoreAll, applyGates, normaliseAnswer, scorerKinds,
  benchmarkAdapters, findBenchmarkAdapter, notIntegratedBenchmarks,
  compareStudies, comparisonTable, studyTable, studyLines,
  runToolEvaluations, builtInToolSuites, toolEvaluationLine, readTrajectory, saveSuite,
  ScriptedProvider, say, callTool, findBash,
  conditionsVersion, machineIdentity,
} from "../dist/index.js";

const runFile = promisify(execFile);
const fixtures = resolve("tests/fixtures/benchmarks");
const emptyTrajectory = { runId: null, calls: [], steps: 1, ms: 10, tokens: 10, dollars: 0.001 };
const task = { id: "t", prompt: "What is the answer?", expected: "42" };
const scoreOne = (spec, answer, trajectory = emptyTrajectory, workspace = tmpdir()) =>
  makeScorer(spec, { workspace }).score(task, trajectory, answer);

async function fixture(t, routes, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "branch-eval2-"));
  const provider = new ScriptedProvider(routes);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider, ...options });
  t.after(async () => { await app.close(); await discardTemp(root); });
  return { app, root, provider };
}

/* ------------------------------------------------------------- E1 scorers */

test("every built-in scorer decides a right answer and a wrong one", async () => {
  const cases = [
    [{ kind: "exact", value: "42" }, " 42. ", "forty"],
    [{ kind: "contains", phrases: ["alpha", "beta"] }, "alpha and beta", "alpha only"],
    [{ kind: "regex", pattern: "\\b391\\b" }, "it is 391", "it is 392"],
    [{ kind: "json-schema", schema: { type: "object", required: ["city"], properties: { city: { type: "string" } } } }, '{"city":"Lagos"}', '{"town":"Lagos"}'],
    [{ kind: "numeric", value: 391, tolerance: 1 }, "about 390", "about 12"],
    [{ kind: "url", pattern: "^https://example\\.test/order/\\d+$" }, "https://example.test/order/7", "https://elsewhere.test/order/7"],
  ];
  for (const [spec, good, bad] of cases) {
    assert.equal((await scoreOne(spec, good)).pass, true, `${spec.kind} should accept ${good}`);
    const wrong = await scoreOne(spec, bad);
    assert.equal(wrong.pass, false, `${spec.kind} should refuse ${bad}`);
    assert.ok(wrong.reasons.length, `${spec.kind} should say why`);
  }
  assert.equal(scorerKinds.length, 17);
});

test("the scorers that look at the workspace and the trajectory", async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), "branch-score-"));
  t.after(async () => { await discardTemp(workspace); });
  await writeFile(join(workspace, "page.html"), "<p id=\"hours\">nine to five</p>");
  assert.equal((await scoreOne({ kind: "file-exists", path: "page.html" }, "", emptyTrajectory, workspace)).pass, true);
  assert.equal((await scoreOne({ kind: "file-exists", path: "gone.html" }, "", emptyTrajectory, workspace)).pass, false);
  assert.equal((await scoreOne({ kind: "file-contains", path: "page.html", text: "nine to five" }, "", emptyTrajectory, workspace)).pass, true);
  assert.equal((await scoreOne({ kind: "file-contains", path: "page.html", text: "midnight" }, "", emptyTrajectory, workspace)).pass, false);
  const used = { ...emptyTrajectory, calls: [{ name: "files.write", arguments: { path: "note.txt" } }] };
  assert.equal((await scoreOne({ kind: "tool-called", name: "files.write", withArgs: { path: "note.txt" } }, "", used)).pass, true);
  assert.equal((await scoreOne({ kind: "tool-called", name: "files.write", withArgs: { path: "other.txt" } }, "", used)).pass, false);
  assert.equal((await scoreOne({ kind: "tool-called", name: "web.get" }, "", used)).pass, false);
  assert.equal((await scoreOne({ kind: "budget", maxSteps: 2, maxMs: 100, maxDollars: 0.01 }, "", used)).pass, true);
  const overspent = await scoreOne({ kind: "budget", maxSteps: 1, maxMs: 1, maxDollars: 0.0001 }, "", { ...used, steps: 9 });
  assert.equal(overspent.pass, false);
  assert.equal(overspent.reasons.length, 3);
});

test("SELF-099: the helper scorer counts only engine-recorded helpers, not what the model claimed", async () => {
  const spec = { kind: "helper-runs", min: 1, max: 1, completed: true, output: "42" };
  const ran = (helpers) => ({ ...emptyTrajectory, runId: "parent", helpers });
  const done = { runId: "child", status: "completed", output: " 42. " };
  assert.equal((await scoreOne(spec, "42", ran([done]))).pass, true);
  assert.equal((await scoreOne(spec, "42", emptyTrajectory)).pass, false, "no provenance read is never a pass");
  assert.equal((await scoreOne(spec, "42", ran([{ ...done, status: "running" }]))).pass, false);
  assert.equal((await scoreOne(spec, "42", ran([{ ...done, output: "41" }]))).pass, false);
  assert.equal((await scoreOne(spec, "42", ran([done, { ...done, runId: "other" }]))).pass, false, "too many helpers");
  const none = { kind: "helper-runs", min: 0, max: 0, completed: false };
  assert.equal((await scoreOne(none, "21", ran([]))).pass, true);
  assert.equal((await scoreOne(none, "21", ran([{ ...done, status: "failed" }]))).pass, false, "a failed helper still counts");
  assert.throws(() => makeScorer({ kind: "helper-runs", min: 2, max: 1 }, { workspace: tmpdir() }));
});

test("the completion review catches an answer that quietly gave up", async () => {
  assert.equal((await scoreOne({ kind: "finished" }, "I wrote the file and checked it.")).pass, true);
  const gave = await scoreOne({ kind: "finished" }, "I was unable to write the file, sorry.");
  assert.equal(gave.pass, false);
  assert.match(gave.reasons[0], /did not finish/);
  assert.equal((await scoreOne({ kind: "finished" }, "   ")).pass, false);
  const missing = await scoreOne({ kind: "finished", checks: { files: ["never.txt"] } }, "All done.");
  assert.equal(missing.pass, false);
});

test("the rubric scorer refuses to guess when no model connection was chosen, and caches when one was", async () => {
  const refused = await makeScorer({ kind: "rubric", rubric: "Is it polite?" }, { workspace: tmpdir() }).score(task, emptyTrajectory, "hello");
  assert.equal(refused.pass, false);
  assert.match(refused.reasons[0], /no model connection was chosen/);
  let asked = 0;
  const cache = new Map();
  const judge = async () => { asked++; return '{"score": 0.9, "reason": "It reads well."}'; };
  const scorer = makeScorer({ kind: "rubric", rubric: "Is it polite?" }, { workspace: tmpdir(), judge, judgeCache: cache });
  assert.equal((await scorer.score(task, emptyTrajectory, "hello")).pass, true);
  assert.equal((await scorer.score(task, emptyTrajectory, "hello")).score, 0.9);
  assert.equal(asked, 1, "the same question must only be paid for once");
});

test("several scorers together pass only when every one of them passes", async () => {
  const build = (spec) => makeScorer(spec, { workspace: tmpdir() });
  const both = await scoreAll([build({ kind: "contains", phrases: ["done"] }), build({ kind: "regex", pattern: "391" })], task, emptyTrajectory, "done: 391");
  assert.equal(both.pass, true);
  assert.equal(both.parts.length, 2);
  const half = await scoreAll([build({ kind: "contains", phrases: ["done"] }), build({ kind: "regex", pattern: "999" })], task, emptyTrajectory, "done: 391");
  assert.equal(half.pass, false);
  assert.equal(half.score, 0.5);
});

test("normalising an answer takes off case, spacing and trailing punctuation", () => {
  assert.equal(normaliseAnswer('  "Five O\'clock". '), "five o'clock");
});

/* --------------------------------------------------------------- E1 gates */

test("gates mark a run failed and say exactly why", () => {
  const run = {
    summary: { accuracy: 0.5, dollars: 0.2, latencyMs: { mean: 900 } },
    tasks: [{ id: "a", passed: true, skipped: false }, { id: "b", passed: false, skipped: false }, { id: "c", passed: false, skipped: true }],
    regressions: [{ taskId: "b" }],
  };
  assert.deepEqual(applyGates(run, {}), { passed: true, failures: [] });
  const strict = applyGates(run, { minAccuracy: 0.9, maxDollars: 0.1, maxMeanMs: 500, maxRegressions: 0, mustPass: ["b", "c", "z"] });
  assert.equal(strict.passed, false);
  assert.equal(strict.failures.length, 7);
  assert.ok(strict.failures.some((line) => line.includes("50%") && line.includes("90%")));
  assert.ok(strict.failures.some((line) => line.includes("it was skipped")));
  assert.ok(strict.failures.some((line) => line.includes("not in this set of tasks")));
  assert.equal(applyGates(run, { minAccuracy: 0.4, mustPass: ["a"] }).passed, true);
});

test("a suite run records its scorers, its gate, and a trace tagged with the suite and task", async (t) => {
  const { app } = await fixture(t, [["capital city of France", [say("Paris is the capital city of France.")]]]);
  const suite = {
    id: "wave7-scored", name: "Scored suite", description: "One task decided by scorers.",
    tasks: [{ id: "capital", prompt: "What is the capital city of France?", scorers: [{ kind: "contains", phrases: ["Paris"] }, { kind: "budget", maxSteps: 10 }] }],
  };
  const { saveSuite } = await import("../dist/index.js");
  saveSuite(app.store, app.runtime.owner, suite);
  const result = await app.evaluationSuites.run({ suite: "wave7-scored", gates: { minAccuracy: 1, mustPass: ["capital"] } });
  assert.equal(result.tasks[0].passed, true);
  assert.equal(result.tasks[0].method, "scorers");
  assert.deepEqual(result.tasks[0].scores.map((part) => part.kind), ["contains", "budget"]);
  assert.equal(result.gate.passed, true);
  // E6: the task's own span carries the suite and task, so an export can be filtered by them.
  const spans = app.store.spans.forRun(result.tasks[0].runId);
  const root = spans.find((span) => span.kind === "run");
  assert.equal(root.attributes["branch.evaluation.suite"], "wave7-scored");
  assert.equal(root.attributes["branch.evaluation.task"], "capital");
  // The same run again, with a bar it cannot clear.
  const failed = await app.evaluationSuites.run({ suite: "wave7-scored", gates: { mustPass: ["a-task-that-is-not-there"] } });
  assert.equal(failed.gate.passed, false);
  assert.match(failed.gate.failures[0], /not in this set of tasks/);
});

test("a task whose checks fail is still failed when its scorers pass, and the checks are blamed", async (t) => {
  const { app } = await fixture(t, [["capital city of France", [say("Paris is the capital city of France.")]]]);
  const { saveSuite } = await import("../dist/index.js");
  saveSuite(app.store, app.runtime.owner, {
    id: "wave7-both", name: "Checks and scorers", description: "The checks fail; the scorers do not.",
    tasks: [{
      id: "capital", prompt: "What is the capital city of France?",
      checks: { files: ["a-file-nothing-writes.txt"] },
      scorers: [{ kind: "contains", phrases: ["Paris"] }],
    }],
  });
  const result = await app.evaluationSuites.run({ suite: "wave7-both" });
  assert.equal(result.tasks[0].passed, false);
  assert.equal(result.tasks[0].method, "checks", "the checks caught it first, so they are what decided it");
  assert.match(result.tasks[0].problem, /a-file-nothing-writes\.txt/);
  assert.equal(result.summary.accuracy, 0);
});

test("a task's rounds are counted from its record, so a budget on rounds really bites", async (t) => {
  const { app } = await fixture(t, [["write two notes", [
    callTool("files.write", { path: "one.txt", content: "one" }),
    callTool("files.write", { path: "two.txt", content: "two" }),
    say("Both notes are written."),
  ]]]);
  const run = await app.runtime.run({ prompt: "Please write two notes for me.", permissions: ["files.write"] });
  assert.equal(run.status, "completed");
  const { readTrajectory } = await import("../dist/index.js");
  const trajectory = readTrajectory(app.store, run.id, { ms: 10, tokens: 10, dollars: 0 });
  assert.equal(trajectory.steps, 3, "three turns with the model");
  assert.deepEqual(trajectory.calls.map((call) => call.arguments.path), ["one.txt", "two.txt"]);
  const within = await makeScorer({ kind: "budget", maxSteps: 3 }, { workspace: app.runtime.workspace }).score(task, trajectory, run.output);
  assert.equal(within.pass, true);
  const over = await makeScorer({ kind: "budget", maxSteps: 2 }, { workspace: app.runtime.workspace }).score(task, trajectory, run.output);
  assert.equal(over.pass, false);
  assert.match(over.reasons[0], /took 3 rounds/);
});

/* ------------------------------------------------------------ E2 adapters */

test("there are seven adapters that run (A1726 added MiniWoB) and five benchmarks documented as not integrated", () => {
  assert.deepEqual(benchmarkAdapters.map((adapter) => adapter.id).sort(),
    ["code-tasks", "gaia", "miniwob", "nexus", "swe-bench", "terminal-bench", "web-tasks"]);
  assert.equal(notIntegratedBenchmarks.length, 5);
  for (const entry of notIntegratedBenchmarks) assert.ok(entry.needs.length > 40, `${entry.id} must say what it would need`);
  assert.throws(() => findBenchmarkAdapter("osworld"), /There is no benchmark called osworld/);
});

test("GAIA: reads metadata.jsonl, brings the attached file, and marks by normalised exact match", async (t) => {
  const into = await mkdtemp(join(tmpdir(), "branch-gaia-"));
  t.after(async () => { await discardTemp(into); });
  const adapter = findBenchmarkAdapter("gaia");
  const directory = join(fixtures, "gaia");
  const tasks = await adapter.discover(directory);
  assert.deepEqual(tasks.map((entry) => entry.id), ["gaia-hours", "gaia-sum"]);
  const ready = await adapter.prepare(tasks[0], into, directory);
  assert.equal(ready.refusal, null);
  assert.deepEqual(ready.files, ["notes.txt"]);
  assert.match(await readFile(join(into, "notes.txt"), "utf8"), /closes at five/);
  assert.equal((await adapter.judge(tasks[0], { answer: "Final answer: Five.", workspace: into }, directory)).pass, true);
  assert.equal((await adapter.judge(tasks[0], { answer: "Final answer: six", workspace: into }, directory)).pass, false);
});

test("code tasks: reads the prompt and runs the benchmark's own tests", async (t) => {
  const into = await mkdtemp(join(tmpdir(), "branch-code-"));
  t.after(async () => { await discardTemp(into); });
  const adapter = findBenchmarkAdapter("code-tasks");
  const directory = join(fixtures, "code-tasks");
  const [one] = await adapter.discover(directory);
  assert.equal(one.id, "code-add");
  const ready = await adapter.prepare(one, into, directory);
  assert.deepEqual(ready.files, ["solution.mjs"]);
  const wrong = await adapter.judge(one, { answer: "done", workspace: into }, directory);
  assert.equal(wrong.pass, false);
  await writeFile(join(into, "solution.mjs"), "export const add = (a, b) => a + b;\n");
  assert.equal((await adapter.judge(one, { answer: "done", workspace: into }, directory)).pass, true);
});

test("SWE-bench: refuses when the repository is not on this computer, and says where to put it", async (t) => {
  const into = await mkdtemp(join(tmpdir(), "branch-swe-"));
  t.after(async () => { await discardTemp(into); });
  const adapter = findBenchmarkAdapter("swe-bench");
  const directory = join(fixtures, "swe-bench");
  const tasks = await adapter.discover(directory);
  assert.deepEqual(tasks.map((entry) => entry.id), ["acme__widget-1", "missing__repo-1"]);
  const refused = await adapter.prepare(tasks[1], join(into, "missing"), directory);
  assert.match(refused.refusal, /nobody\/missing is not on this computer/);
  assert.ok(refused.refusal.includes(join(directory, "repos", "nobody__missing")), "it must say where to put it");
  assert.match(refused.refusal, /Nothing is downloaded for you/);
});

test("SWE-bench: copies the repository, applies the instance's test patch, and runs the tests", async (t) => {
  const into = await mkdtemp(join(tmpdir(), "branch-swe2-"));
  t.after(async () => { await discardTemp(into); });
  const adapter = findBenchmarkAdapter("swe-bench");
  const directory = join(fixtures, "swe-bench");
  const [one] = await adapter.discover(directory);
  const workspace = join(into, "work");
  const ready = await adapter.prepare(one, workspace, directory);
  assert.equal(ready.refusal, null);
  assert.match(await readFile(join(workspace, "src.mjs"), "utf8"), /items\.length/);
  const before = await adapter.judge(one, { answer: "done", workspace }, directory);
  assert.equal(before.pass, false, "the unfixed repository must fail the benchmark's tests");
  assert.match(await readFile(join(workspace, "total.test.mjs"), "utf8"), /assert\.equal\(total/);
  await writeFile(join(workspace, "src.mjs"), "export function total(items) {\n  return items.reduce((a, b) => a + b, 0);\n}\n");
  assert.equal((await adapter.judge(one, { answer: "done", workspace }, directory)).pass, true);
  // The owner's own copy is never touched.
  assert.match(await readFile(join(directory, "repos", "acme__widget", "src.mjs"), "utf8"), /items\.length/);
});

test("web tasks: a saved page is run, a live-only task is refused by name", async (t) => {
  const into = await mkdtemp(join(tmpdir(), "branch-web-"));
  t.after(async () => { await discardTemp(into); });
  const adapter = findBenchmarkAdapter("web-tasks");
  const directory = join(fixtures, "web-tasks");
  const tasks = await adapter.discover(directory);
  assert.deepEqual(tasks.map((entry) => entry.id), ["shop-hours", "live-only"]);
  const saved = await adapter.prepare(tasks[0], join(into, "a"), directory);
  assert.equal(saved.refusal, null);
  assert.match(saved.prompt, /shop-hours\.html/);
  const live = await adapter.prepare(tasks[1], join(into, "b"), directory);
  assert.match(live.refusal, /never opens a live benchmark site/);
  assert.equal((await adapter.judge(tasks[0], { answer: "It closes at five.", workspace: join(into, "a") }, directory)).pass, true);
  assert.equal((await adapter.judge(tasks[0], { answer: "It closes at nine.", workspace: join(into, "a") }, directory)).pass, false);
});

test("terminal-bench: reads task.md, keeps tests.sh out of the workspace, and runs it to decide", async (t) => {
  const into = await mkdtemp(join(tmpdir(), "branch-term-"));
  t.after(async () => { await discardTemp(into); });
  const adapter = findBenchmarkAdapter("terminal-bench");
  const directory = join(fixtures, "terminal-bench");
  const [one] = await adapter.discover(directory);
  assert.equal(one.id, "write-a-note");
  assert.match(one.prompt, /note\.txt/);
  const workspace = join(into, "work");
  const ready = await adapter.prepare(one, workspace, directory);
  assert.deepEqual(ready.files, ["starting-point.txt"]);
  await assert.rejects(readFile(join(workspace, "tests.sh"), "utf8"), "the tests must not be visible while it works");
  if (!(await findBash())) {
    const without = await adapter.judge(one, { answer: "done", workspace }, directory);
    assert.match(without.reasons[0], /there is no bash on this computer/);
    return;
  }
  assert.equal((await adapter.judge(one, { answer: "done", workspace }, directory)).pass, false);
  await writeFile(join(workspace, "note.txt"), "ready\n");
  assert.equal((await adapter.judge(one, { answer: "done", workspace }, directory)).pass, true);
});

/* -------------------------------------------------------------- E3 studies */

const twoPresets = (provider) => [
  { id: "fast", name: "Fast", provider, model: "gpt-4o-mini" },
  { id: "careful", name: "Careful", provider, model: "gpt-4o" },
];

async function studyFixture(t, routes, root) {
  const provider = new ScriptedProvider(routes);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), presets: twoPresets(provider) });
  t.after(async () => { await app.close(); });
  return { app, root, provider };
}
/** Removes the folder only once every app that opened it has been closed. */
const removeLast = (t, root) => t.after(async () => { await discardTemp(root); });

const matrixRoutes = () => [
  ["capital city of France", [say("Paris is the capital city of France.")]],
  ["17 multiplied by 23", [say("391")]],
];
const matrixSuite = {
  id: "wave7-matrix", name: "Two easy questions", description: "Two questions with scorers.",
  tasks: [
    { id: "capital", prompt: "What is the capital city of France?", scorers: [{ kind: "contains", phrases: ["Paris"] }] },
    { id: "product", prompt: "What is 17 multiplied by 23? Reply with the number only.", scorers: [{ kind: "numeric", value: 391 }] },
  ],
};

test("a study runs a 2x2 matrix in parallel, checkpoints every cell, and tabulates", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-study-"));
  const { app, provider } = await studyFixture(t, matrixRoutes(), root);
  removeLast(t, root);
  const { saveSuite } = await import("../dist/index.js");
  saveSuite(app.store, app.runtime.owner, matrixSuite);
  app.studies.save({ id: "matrix", name: "Two models, two questions", source: { kind: "suite", suite: "wave7-matrix" }, presets: ["fast", "careful"], concurrency: 2 });
  const result = await app.studies.run("matrix");
  assert.equal(result.cells.length, 4);
  assert.equal(result.resumed, 0);
  assert.equal(result.cells.filter((cell) => cell.passed).length, 4);
  assert.deepEqual(result.rows.map((row) => [row.preset, row.tasks, row.passed]), [["fast", 2, 2], ["careful", 2, 2]]);
  const checkpointed = app.store.list("governance", app.runtime.owner).filter((record) => record.id.startsWith("study-cell:matrix:"));
  assert.equal(checkpointed.length, 4, "every cell is written down as it lands");
  assert.match(studyTable(result), /\| fast \| 2 \| 2 \| 100\.0% \|/);
  assert.equal([...studyLines(result)].length, 4);
  assert.equal(JSON.parse([...studyLines(result)][0]).study, "matrix");
  // E6: each study task's trace carries the study and the task.
  const spans = app.store.spans.forRun(result.cells[0].runId);
  const root2 = spans.find((span) => span.kind === "run");
  assert.equal(root2.attributes["branch.study.id"], "matrix");
  assert.ok(result.cells.every((cell) => cell.runId), "every cell keeps its task's number");
  assert.ok(provider.requests.length >= 4);
});

test("a study that is stopped part way carries on from its checkpoints in a fresh program", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-resume-"));
  // The first program answers one question and refuses the other, as a crash part way would leave it.
  const first = await studyFixture(t, [["capital city of France", [say("Paris is the capital city of France.")]]], root);
  const { saveSuite } = await import("../dist/index.js");
  saveSuite(first.app.store, first.app.runtime.owner, matrixSuite);
  first.app.studies.save({ id: "matrix", name: "Matrix", source: { kind: "suite", suite: "wave7-matrix" }, presets: ["fast"], retries: 0 });
  const stopped = await first.app.studies.run("matrix");
  assert.equal(stopped.cells.filter((cell) => cell.passed).length, 1);
  assert.equal(stopped.cells.filter((cell) => !cell.passed).length, 1);
  await first.app.close();
  // A brand-new program over the same data folder: the question that worked is not asked again.
  const second = await studyFixture(t, matrixRoutes(), root);
  const resumed = await second.app.studies.run("matrix");
  assert.equal(resumed.resumed, 2, "both cells were already on file");
  assert.equal(second.provider.requests.length, 0, "nothing was asked a second time");
  // Starting fresh throws the checkpoints away and asks again.
  const again = await second.app.studies.run("matrix", { fresh: true });
  assert.equal(again.resumed, 0);
  assert.equal(again.cells.filter((cell) => cell.passed).length, 2);
  assert.equal(second.provider.requests.length, 2);
  removeLast(t, root);
});

test("Best-of-N keeps the best try and remembers what the others scored", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-bestof-"));
  // Three goes at the same question: wrong, wrong, right. Best-of-3 has to keep the third.
  const { app } = await studyFixture(t, [["capital city of France", [say("Lyon."), say("Marseille."), say("Paris.")]]], root);
  removeLast(t, root);
  const { saveSuite } = await import("../dist/index.js");
  saveSuite(app.store, app.runtime.owner, {
    id: "wave7-best", name: "One question", description: "One question, three goes.",
    tasks: [{ id: "capital", prompt: "What is the capital city of France?", scorers: [{ kind: "contains", phrases: ["Paris"] }] }],
  });
  app.studies.save({ id: "best", name: "Best of three", source: { kind: "suite", suite: "wave7-best" }, presets: ["fast"], bestOfN: 3 });
  const result = await app.studies.run("best");
  assert.equal(result.cells.length, 1);
  assert.equal(result.cells[0].passed, true, "the one that got it right is the one kept");
  assert.deepEqual(result.cells[0].candidates, [0, 0, 1]);
});

test("a study over a benchmark prepares a folder per task and marks it with the benchmark's own judge", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-bench-study-"));
  const { app } = await studyFixture(t, [
    ["corner shop closes", [say("Final answer: five")]],
    ["seventeen multiplied by twenty-three", [say("Final answer: 391")]],
  ], root);
  removeLast(t, root);
  // A benchmark outside the workspace is only read once the owner has named its folder.
  app.studies.configure({ benchmarksFolder: fixtures });
  app.studies.save({ id: "gaia-sample", name: "GAIA sample", presets: ["fast"], source: { kind: "benchmark", benchmark: "gaia", directory: join(fixtures, "gaia") } });
  const result = await app.studies.run("gaia-sample");
  assert.equal(result.cells.length, 2);
  assert.equal(result.cells.filter((cell) => cell.passed).length, 2);
  assert.match(await readFile(join(root, "workspace", "benchmarks", "gaia-sample", "gaia-hours", "notes.txt"), "utf8"), /closes at five/);
});

test("comparing two studies reports the difference with a range, and the same answer every time", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-compare-"));
  removeLast(t, root);
  const cells = (ids, passed) => ids.map((id, index) => ({
    taskId: id, preset: "fast", repeat: 0, attempts: 1, passed: passed[index],
    score: passed[index] ? 1 : 0, ms: 10, tokens: 10, dollars: 0.001, runId: null, reasons: [],
  }));
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h"];
  // mac7/eval-honesty: two studies may only be compared when both wrote down the conditions they
  // ran under and those conditions match. These two were measured the same way.
  const measured = {
    version: conditionsVersion, presets: ["fast"], models: ["demo"], judgeModel: null,
    settings: { maxSteps: 30 }, appVersion: "0.17.0", machine: machineIdentity(),
    taskSetHash: "abc123", scorerDigest: "def456", costBasis: "estimated",
  };
  const before = { id: "11111111-1111-4111-8111-111111111111", name: "Before", conditions: measured, cells: cells(ids, [true, false, false, false, false, false, false, false]) };
  const after = { id: "22222222-2222-4222-8222-222222222222", name: "After", conditions: measured, cells: cells(ids, [true, true, true, true, true, true, true, true]) };
  const comparison = compareStudies(before, after);
  assert.equal(comparison.tasks, 8);
  assert.equal(comparison.delta, 0.875);
  assert.ok(comparison.interval.low > 0 && comparison.interval.high <= 1);
  assert.equal(comparison.clear, true);
  assert.deepEqual(compareStudies(before, after).interval, comparison.interval, "the interval must not wander");
  assert.match(comparisonTable(comparison), /worth believing/);
  // Two studies that did the same thing: the range includes zero, so nothing is claimed.
  const flat = compareStudies(before, { ...before, id: "33333333-3333-4333-8333-333333333333", name: "Same" });
  assert.equal(flat.delta, 0);
  assert.equal(flat.clear, false);
  assert.match(comparisonTable(flat), /not yet a real difference/);
  assert.throws(() => compareStudies(before, { id: "44444444-4444-4444-8444-444444444444", name: "Other", conditions: measured, cells: cells(["z"], [true]) }), /no task in common/);
  // mac7/eval-honesty: and a run that never wrote its conditions down is refused before any of that.
  assert.throws(() => compareStudies(before, { id: "55555555-5555-4555-8555-555555555555", name: "Unrecorded", cells: cells(ids, [true, true, true, true, true, true, true, true]) }),
    /did not write down the conditions/i);
});

/* --------------------------------------------- E5 tool checks, and the CLI */

test("the tool checks that ship run every case against the tools that are installed", async (t) => {
  const { app } = await fixture(t, []);
  const suites = builtInToolSuites();
  assert.ok(suites.length >= 3);
  const result = await runToolEvaluations(app.registry, app.runtime.context({ signal: AbortSignal.timeout(60000) }));
  assert.equal(result.summary.passed, result.summary.total);
  assert.equal(result.summary.missing.length, 0);
  assert.match(toolEvaluationLine(result), /behaved as documented/);
  // A case whose expectation is wrong fails, so these checks can actually catch something.
  const wrong = await runToolEvaluations(app.registry, app.runtime.context({ signal: AbortSignal.timeout(60000) }),
    [{ tool: "files.write", description: "", cases: [{ name: "impossible", input: { path: "x.txt", content: "hi" }, contains: ["nowhere"] }] }]);
  assert.equal(wrong.summary.passed, 0);
  assert.match(wrong.cases[0].problem, /does not mention "nowhere"/);
  // A suite for a tool nobody has installed is reported, not counted as a failure.
  const absent = await runToolEvaluations(app.registry, app.runtime.context({ signal: AbortSignal.timeout(60000) }),
    [{ tool: "not.installed", description: "", cases: [{ name: "n", input: {} }] }]);
  assert.deepEqual(absent.summary.missing, ["not.installed"]);
});

test("branch eval --gate stops a release when the bar is not cleared, and passes when it is", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-cli-gate-"));
  t.after(async () => { await discardTemp(root); });
  await mkdir(join(root, "workspace"), { recursive: true });
  const environment = {
    ...process.env, BRANCH_DATA_DIR: join(root, "data"), BRANCH_WORKSPACE: join(root, "workspace"),
    BRANCH_DEMO: "1", BRANCH_INTEGRATIONS: "",
  };
  const cli = (args) => runFile(process.execPath, [resolve("dist/cli.js"), ...args], { env: environment });
  const good = await cli(["eval", "--suite", "safety", "--gate", JSON.stringify({ minAccuracy: 0 })]);
  assert.match(good.stdout, /cleared the bar/);
  const bad = await cli(["eval", "--suite", "safety", "--gate", JSON.stringify({ minAccuracy: 1, maxMeanMs: 1 })])
    .catch((error) => error);
  assert.equal(bad.code, 1, "a run that misses its bar must stop a build");
  assert.match(bad.stdout, /did not clear the bar/);
});

test("branch eval tools and branch study list run from the command line", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-cli-tools-"));
  t.after(async () => { await discardTemp(root); });
  await mkdir(join(root, "workspace"), { recursive: true });
  const environment = { ...process.env, BRANCH_DATA_DIR: join(root, "data"), BRANCH_WORKSPACE: join(root, "workspace"), BRANCH_INTEGRATIONS: "" };
  const checks = await runFile(process.execPath, [resolve("dist/cli.js"), "eval", "tools"], { env: environment });
  assert.match(checks.stdout, /behaved as documented/);
  const studies = await runFile(process.execPath, [resolve("dist/cli.js"), "study", "list"], { env: environment });
  assert.equal(studies.stdout.trim(), "No studies yet.", "an empty list says so in plain words");
});

test("the benchmark and study routes are on the web front door", async (t) => {
  const { app, root } = await fixture(t, []);
  const { startServer } = await import("../dist/server.js");
  const server = await startServer(app, { dataDir: join(root, "data"), port: 0 });
  t.after(async () => { await server.close(); });
  const api = async (path, body) => {
    const response = await fetch(`${server.url}/api/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${server.token}`, origin: server.url, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json();
    if (!response.ok) throw new Error(json.error);
    return json;
  };
  const benchmarks = await api("evaluation/benchmarks");
  assert.equal(benchmarks.adapters.length, 7); // A1726: MiniWoB
  assert.equal(benchmarks.notIntegrated.length, 5);
  assert.ok(benchmarks.scorers.includes("rubric"));
  await api("studies", { id: "web", name: "From the web", source: { kind: "suite", suite: "cost" }, presets: ["default"] });
  const listed = await api("studies");
  assert.deepEqual(listed.studies.map((study) => study.id), ["web"]);
  const checks = await api("evaluation/tools", {});
  assert.equal(checks.summary.passed, checks.summary.total);
});

/* ------------------- integration review: confinement and the owner's switch */

test("a benchmark that runs the tests it ships waits for the owner's switch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-switch-"));
  const { app } = await studyFixture(t, [["adds two numbers", [say("done")]]], root);
  removeLast(t, root);
  app.studies.configure({ benchmarksFolder: fixtures });
  app.studies.save({
    id: "code-sample", name: "Code sample", presets: ["fast"],
    source: { kind: "benchmark", benchmark: "code-tasks", directory: join(fixtures, "code-tasks") },
  });
  const refused = await app.studies.run("code-sample");
  assert.equal(refused.cells.every((cell) => !cell.passed), true);
  assert.match(refused.cells[0].reasons[0], /switched off/);
  assert.match(refused.cells[0].reasons[0], /running small scripts/);
});

test("a dataset may not name a file outside its own folder", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "branch-escape-"));
  const workspace = await mkdtemp(join(tmpdir(), "branch-escape-into-"));
  t.after(async () => { await discardTemp(directory); await discardTemp(workspace); });
  const record = { task_id: "escape", Question: "Read the file.", "Final answer": "x", file_name: "..\\..\\secret.txt" };
  await writeFile(join(directory, "metadata.jsonl"), JSON.stringify(record) + "\n");
  const gaia = findBenchmarkAdapter("gaia");
  const [one] = await gaia.discover(directory);
  assert.match((await gaia.prepare(one, workspace, directory)).refusal, /points outside/);
  const swe = findBenchmarkAdapter("swe-bench");
  const away = await swe.prepare({ id: "away", prompt: "fix it", tags: [], raw: { repo: "..\\..\\elsewhere" } }, workspace, directory);
  assert.match(away.refusal, /points outside/);
});

test("a benchmark may only start a program named in full", async () => {
  const { runBenchmarkCommand } = await import("../dist/index.js");
  await assert.rejects(runBenchmarkCommand("git", ["status"], tmpdir()), /named in full/);
});

test("a scripted tool double records what it was called with", async (t) => {
  const { app } = await fixture(t, [["write a note", [callTool("double.note", { text: "hello" }), say("done")]]]);
  const { ScriptedTools } = await import("../dist/index.js");
  const doubles = new ScriptedTools().reply("double.note", { written: true });
  doubles.register(app.registry, ["double.note"], "files.write");
  const run = await app.runtime.run({ prompt: "Please write a note for me.", permissions: ["files.write"] });
  assert.equal(run.status, "completed");
  assert.deepEqual(doubles.calledWith("double.note"), [{ text: "hello" }]);
});

test("benchmark scripts see only the system's own tool folders, and nothing on Windows", async () => {
  const { benchmarkPath } = await import("../dist/benchmark-shell.js");
  assert.equal(benchmarkPath("win32"), "");
  assert.equal(benchmarkPath("darwin"), "/usr/bin:/bin");
  assert.equal(benchmarkPath("linux"), "/usr/bin:/bin");
});
