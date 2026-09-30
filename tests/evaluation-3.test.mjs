/**
 * Wave 9 (evaluation, third pass). Everything here is offline: worked examples for the new
 * scorers, the doubles asked the same question twice, one task read back as a report, and a
 * journal replaying a study and naming what changed. No network, no dataset, nothing downloaded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discardTemp } from "./temp-dir.mjs";
import {
  answerTokens, tokenF1, passageMatch, bestPassage,
  parseHtml, selectAll, makeScorer, scorerKinds, scoreAll,
  compareTrajectories, stepMatches,
  ScriptedRealtime, ScriptedSpeech, ScriptedSandbox,
  renderTrajectory,
  journalEntry, journalDiff, journalReport, journalReplayPlan, fingerprintOf,
  conditionsVersion, machineIdentity,
  ndcgAt, recallAt, precisionAt, reciprocalRank, averagePrecision, scoreRetrieval, retrievalTable,
  readBeirSet, scoreBeirSet,
  parseCall, judgeCall, nexusAdapter, findBenchmarkAdapter,
  liveScoreSummary, LiveScoringSettingsSchema, notIntegratedBenchmarks, builtInSuites,
  createBranch, ScriptedProvider, say, callTool,
} from "../dist/index.js";
import { BranchBrowser, registerBrowser } from "../dist/integrations/browser.js";
import { miniwobVerdict, miniwobPassAbove, pageAssets, serveFolder } from "../dist/benchmark-miniwob.js";

const emptyTrajectory = { runId: null, calls: [], steps: 1, ms: 10, tokens: 10, dollars: 0.001 };
const task = { id: "t", prompt: "What is the answer?", expected: "42" };
const scoreOne = (spec, answer, trajectory = emptyTrajectory, workspace = tmpdir()) =>
  makeScorer(spec, { workspace }).score(task, trajectory, answer);

async function temp(t, prefix = "branch-eval3-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => { await discardTemp(root); });
  return root;
}

/* --------------------------------------------------- A0927 token F1 and passage match */

test("A0927: words are compared without case, punctuation or articles", () => {
  assert.deepEqual(answerTokens("  The Eiffel Tower, in PARIS!  "), ["eiffel", "tower", "in", "paris"]);
  assert.deepEqual(answerTokens("a an the"), []);
});

test("A0927: token F1 on the awkward cases", () => {
  // Whitespace and punctuation only: the same answer.
  assert.equal(tokenF1("  the Eiffel Tower. ", "The eiffel tower").f1, 1);
  // Different word order: bag of words, so still the same answer.
  assert.equal(tokenF1("Paris, France", "France Paris").f1, 1);
  // Partial overlap: two words of three shared with three of three.
  const partial = tokenF1("the red brick house", "red brick");
  assert.equal(partial.shared, 2);
  assert.equal(partial.recall, 1);
  assert.equal(partial.precision, round(2 / 3));
  assert.equal(partial.f1, round((2 * (2 / 3) * 1) / ((2 / 3) + 1)));
  // Repeats count: "very very good" against "very good" shares one "very".
  assert.equal(tokenF1("very very good", "very good").shared, 2);
  // Nothing in common, and the two empty edges.
  assert.equal(tokenF1("blue", "green").f1, 0);
  assert.equal(tokenF1("", "").f1, 1);
  assert.equal(tokenF1("", "anything").f1, 0);
});

const round = (value) => Math.round(value * 1000) / 1000;

test("A0927: the f1 scorer passes a differently worded answer and refuses a wrong one", async () => {
  const spec = { kind: "f1", value: "the Eiffel Tower" };
  assert.equal((await scoreOne(spec, "the Eiffel Tower.")).score, 1, "punctuation and case only");
  const good = await scoreOne(spec, "It is the eiffel tower.");
  assert.equal(good.pass, true);
  assert.equal(good.score, 0.667, "two extra words cost precision but still clear the bar");
  const bad = await scoreOne(spec, "the Empire State Building");
  assert.equal(bad.pass, false);
  assert.match(bad.reasons[0], /shares 0% of its words/);
});

test("A0927: passage match carries the passage rather than equalling it", () => {
  const whole = "the deposit is returned within ten working days";
  assert.equal(passageMatch(`We confirm ${whole}, as agreed.`, whole).coverage, 1);
  assert.equal(passageMatch(`We confirm ${whole}, as agreed.`, whole).verbatim, true);
  // Same words, shuffled: fully covered but not word for word.
  const shuffled = passageMatch("ten working days the deposit within is returned", whole);
  assert.equal(shuffled.coverage, 1);
  assert.equal(shuffled.verbatim, false);
  // Partial overlap.
  assert.equal(passageMatch("the deposit is returned", whole).coverage, round(3 / 7));
  // The best of several sources wins, and says which.
  const best = bestPassage("returned within ten working days", ["never returned at all", whole]);
  assert.equal(best.index, 1);
});

test("A0927: the passage scorer, including verbatim", async () => {
  const passages = ["the deposit is returned within ten working days"];
  assert.equal((await scoreOne({ kind: "passage", passages }, `Yes: ${passages[0]}.`)).pass, true);
  const shuffled = await scoreOne({ kind: "passage", passages, verbatim: true }, "ten working days the deposit within is returned");
  assert.equal(shuffled.pass, false);
  assert.match(shuffled.reasons.join(" "), /word for word/);
  const short = await scoreOne({ kind: "passage", passages }, "the deposit");
  assert.equal(short.pass, false);
  assert.match(short.reasons[0], /present in the answer/);
});

/* ------------------------------------------------------------- A1766 HTML / DOM scorer */

const page = `<!doctype html><html><body>
  <form class="order" id="checkout">
    <h1>Your order</h1>
    <input id="agree" class="tick" type="checkbox" checked>
    <input id="news" type="checkbox">
    <button class="send" disabled>Place order</button>
  </form>
  <script>var hidden = "<div class='not-real'></div>";</script>
</body></html>`;

test("A1766: the page is read as a tree, and script contents are not markup", () => {
  const tree = parseHtml(page);
  assert.equal(selectAll(page, ".not-real").length, 0, "a tag inside a script is text, not an element");
  assert.equal(tree.text.includes("Your order"), true);
  assert.equal(selectAll(page, "input").length, 2);
  assert.equal(selectAll(page, "form.order h1")[0].text, "Your order");
  assert.equal(selectAll(page, "#agree")[0].attributes.type, "checkbox");
  assert.equal(selectAll(page, "input[checked]").length, 1);
  assert.equal(selectAll(page, "input[type=checkbox]").length, 2);
  assert.equal(selectAll(page, "input.tick[checked]").length, 1);
  assert.throws(() => selectAll(page, "li:first-child"), /more than this reader understands/);
});

test("A1766: the html scorer reads the answer and a file, and says what is wrong", async (t) => {
  const workspace = await temp(t);
  await writeFile(join(workspace, "order.html"), page, "utf8");
  const ticked = await scoreOne({ kind: "html", selector: "#agree", attribute: "checked" }, page);
  assert.equal(ticked.pass, true);
  const notTicked = await scoreOne({ kind: "html", selector: "#news", attribute: "checked" }, page);
  assert.equal(notTicked.pass, false);
  assert.match(notTicked.reasons[0], /has no checked written on it/);
  const fromFile = await scoreOne(
    { kind: "html", source: "file", path: "order.html", selector: "button.send", text: "Place order" },
    page, emptyTrajectory, workspace);
  assert.equal(fromFile.pass, true);
  const counted = await scoreOne({ kind: "html", selector: "input", count: 3 }, page);
  assert.equal(counted.pass, false);
  assert.match(counted.reasons[0], /has 2 element\(s\)/);
  const gone = await scoreOne({ kind: "html", selector: ".error", absent: true }, page);
  assert.equal(gone.pass, true);
  const outside = await scoreOne({ kind: "html", source: "file", path: "../escape.html", selector: "p" }, page, emptyTrajectory, workspace);
  assert.equal(outside.pass, false);
  assert.match(outside.reasons[0], /outside the workspace/);
});

test("A1766 and A0927: the four new scorers are among the kinds and are documented", () => {
  for (const kind of ["f1", "passage", "html", "trajectory"]) assert.ok(scorerKinds.includes(kind), kind);
  assert.equal(scorerKinds.length, 17);
});

/* ------------------------------------------------------------ A1752 trajectory scoring */

test("A1752: a path is compared with a reference path, in order", () => {
  const reference = [{ name: "files.read" }, { name: "files.write", arguments: { path: "notes.md" } }];
  const right = compareTrajectories(reference, [
    { name: "files.read", arguments: {} }, { name: "files.write", arguments: { path: "notes.md" } },
  ]);
  assert.equal(right.score, 1);
  assert.equal(right.inOrder, true);
  const backwards = compareTrajectories(reference, [
    { name: "files.write", arguments: { path: "notes.md" } }, { name: "files.read", arguments: {} },
  ]);
  assert.equal(backwards.inOrder, false);
  assert.equal(backwards.matched, 1);
  const wrongArgument = compareTrajectories(reference, [
    { name: "files.read", arguments: {} }, { name: "files.write", arguments: { path: "other.md" } },
  ]);
  assert.match(wrongArgument.missing.join(" "), /files\.write with/);
  const extra = compareTrajectories(reference, [
    { name: "files.read", arguments: {} }, { name: "web.search", arguments: {} },
    { name: "web.search", arguments: {} }, { name: "files.write", arguments: { path: "notes.md" } },
  ]);
  assert.equal(extra.inOrder, true);
  assert.deepEqual(extra.extra, ["web.search x2"]);
  assert.ok(extra.score < 1);
  assert.equal(compareTrajectories([], []).score, 1, "no reference path means nothing to fail");
  assert.equal(stepMatches({ name: "a", arguments: { x: 1 } }, { name: "a", arguments: { x: 1, y: 2 } }), true);
});

test("A1752: the trajectory scorer refuses a task that guessed the answer", async () => {
  const spec = { kind: "trajectory", steps: [{ name: "files.read" }, { name: "files.write" }] };
  const guessed = await scoreOne(spec, "done", { ...emptyTrajectory, calls: [] });
  assert.equal(guessed.pass, false);
  assert.match(guessed.reasons.join(" "), /did not happen/);
  const worked = await scoreOne(spec, "done", {
    ...emptyTrajectory,
    calls: [{ name: "files.read", arguments: {} }, { name: "files.write", arguments: {} }],
  });
  assert.equal(worked.pass, true);
});

/* ----------------------------------------------------------------- A0973 the doubles */

test("A0973: a live conversation with nothing running, and the same answer twice", async () => {
  const script = [{ hear: "weather", call: { name: "weather.today", arguments: { city: "Lagos" } }, say: "It is warm." }];
  const listen = () => {
    const session = new ScriptedRealtime(script);
    const seen = { transcript: [], audio: [], calls: [], usage: [] };
    session.onTranscript = (part) => seen.transcript.push(`${part.who}: ${part.text}`);
    session.onAudio = (pcm) => seen.audio.push(Buffer.from(pcm).toString("utf8"));
    session.onToolCall = (call) => seen.calls.push(call);
    session.onUsage = (usage) => seen.usage.push(usage);
    return { session, seen };
  };
  const first = listen();
  await first.session.open();
  first.session.sendAudio(Buffer.from("what is the weather", "utf8"));
  first.session.commit();
  const second = listen();
  await second.session.open();
  second.session.sendText("what is the weather");
  assert.deepEqual(first.seen, second.seen, "the same question twice gives the same answer, ids included");
  assert.deepEqual(first.seen.calls, [{ id: "scripted-turn-0", name: "weather.today", arguments: '{"city":"Lagos"}' }]);
  assert.deepEqual(first.seen.audio, ["It is warm."]);
  first.session.toolResult("scripted-turn-0", "weather.today", { degrees: 31 });
  assert.deepEqual(first.session.toolResults, [{ callId: "scripted-turn-0", name: "weather.today", result: { degrees: 31 } }]);
  first.session.interrupt();
  first.session.close("done");
  assert.equal(first.session.closedWith, "done");
  const nothing = listen();
  const errors = [];
  nothing.session.onError = (message) => errors.push(message);
  nothing.session.sendText("something else entirely");
  assert.match(errors[0], /Nothing scripted for/);
});

test("A0973: speech in and out costs nothing and repeats exactly", async () => {
  const speech = new ScriptedSpeech().hears("note.webm", "buy milk");
  const once = await speech.transcribe({ bytes: Buffer.from("ignored"), mediaType: "audio/webm", name: "note.webm" });
  const twice = await speech.transcribe({ bytes: Buffer.from("ignored"), mediaType: "audio/webm", name: "note.webm" });
  assert.deepEqual(once, twice);
  assert.equal(once.text, "buy milk");
  assert.equal(once.cost.amount, 0);
  const spokenA = await speech.speak({ text: "hello there" });
  const spokenB = await speech.speak({ text: "hello there" });
  assert.deepEqual(Buffer.from(spokenA.bytes), Buffer.from(spokenB.bytes));
  assert.equal(Buffer.from(spokenA.bytes).toString("utf8"), "hello there");
  assert.deepEqual(speech.asked.map((one) => one.text), ["hello there", "hello there"]);
});

test("A0973: a sandbox that says what would have run and never starts it", async () => {
  const sandbox = new ScriptedSandbox("docker").reply("python", { stdout: "4\n" });
  const run = async () => {
    const handle = await sandbox.prepare({ hostPath: "C:/work" });
    const result = await handle.run({ executable: "python", args: ["-c", "print(2+2)"] }, {}, new AbortController().signal);
    await handle.collect(["out.txt"]);
    await handle.dispose();
    return result;
  };
  const first = await run(), second = await run();
  assert.deepEqual(first, second, "two runs of the same command are identical");
  assert.equal(first.durationMs, 0, "no clock is read, so two studies compare equal");
  assert.equal(first.stdout, "4\n");
  assert.deepEqual(first.argv, ["python", "-c", "print(2+2)"]);
  assert.equal(sandbox.disposed, 2);
  assert.deepEqual(sandbox.collected, ["out.txt", "out.txt"]);
  assert.equal((await sandbox.available()).ok, true);
});

/* ----------------------------------------------------- A1731 one task read back as a report */

test("A1731: a finished task reads back as numbered actions and what came back", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-eval3-xray-"));
  const provider = new ScriptedProvider([["count the files", [say("There are two files.")]]]);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const run = await app.runtime.run({ prompt: "count the files", permissions: [] });
  const context = app.runtime.context({ runId: run.id });
  const record = await app.registry.execute("runs.export", { runId: run.id }, context);
  const report = await app.registry.execute("runs.export", { runId: run.id, as: "report" }, context);
  assert.ok(typeof report.report === "string");
  assert.match(report.report, /# What this task did/);
  assert.match(report.report, /Asked: count the files/);
  assert.match(report.report, /Rounds with the model: 1/);
  assert.match(report.report, /There are two files\./);
  assert.ok(record.calls, "the whole record is still what you get without asking for a report");
});

test("A1731: every action is numbered, in order, with what it was given and what came back", () => {
  const report = renderTrajectory({
    run: { id: "abc", prompt: "tidy the notes", status: "completed", output: "Done." },
    seconds: 4.2,
    rounds: [{ model: "fast", seconds: 1 }, { model: "fast", failed: true, error: "the service was busy" }],
    calls: [
      { name: "files.read", status: "done", seconds: 0.2, input: '{"path":"notes.md"}', output: "one\ntwo", receipt: "proven" },
      { name: "files.write", status: "failed", seconds: null, input: '{"path":"notes.md"}', output: "no permission", receipt: null },
    ],
    plan: [{ title: "plan started", detail: "read, then write" }],
    verdicts: [{ verdict: "not done", reason: "the file was not written" }],
    usage: { estimatedInput: 120, estimatedOutput: 30 },
  });
  const lines = report.split("\n");
  assert.ok(lines.some((line) => line.startsWith("1. **files.read** came back in 0.2s")), report);
  assert.ok(lines.some((line) => line.startsWith("2. **files.write** failed")), report);
  assert.ok(lines.indexOf("   - given: {\"path\":\"notes.md\"}") < lines.findIndex((line) => line.startsWith("2.")));
  assert.match(report, /- back: one two/);
  assert.match(report, /the service was busy/);
  assert.match(report, /not done: the file was not written/);
  assert.match(report, /Tokens: 150 \(120 in, 30 out\)/);
  assert.match(report, /## The answer it gave/);
  assert.match(renderTrajectory({ calls: [] }), /It took no actions at all/);
  const long = renderTrajectory({ calls: [{ name: "x", status: "done", seconds: null, input: "y".repeat(500), output: null, receipt: null }] }, { clip: 10 });
  assert.match(long, /\(490 more characters\)/);
});

/* ------------------------------------------------- A1736 and A1082 the journal */

const study = {
  id: "gaia-one", name: "GAIA, level one", description: "", source: { kind: "suite", suite: "everyday" },
  subset: [], limit: 20, presets: ["fast"], repeats: 1, concurrency: 2, retries: 1,
  maxSteps: 30, maxTokens: 120000, bestOfN: 1,
};
const result = (id, cells) => ({
  id, studyId: study.id, name: study.name, startedAt: `2026-09-1${id.length}T00:00:00.000Z`,
  finishedAt: "2026-09-16T00:00:00.000Z", presets: ["fast"], tasks: cells.map((cell) => cell.taskId),
  cells: cells.map((cell) => ({ preset: "fast", repeat: 0, attempts: 1, ms: 100, tokens: 10, dollars: 0.001, runId: null, reasons: [], score: cell.passed ? 1 : 0, ...cell })),
  rows: [], resumed: 0, stoppedEarly: null,
});
// mac7/eval-honesty: an entry now also carries the conditions the run was made under. These two
// were made the same way, so the report is about what changed in the study, not about the machine.
const madeUnder = (over = {}) => ({
  version: conditionsVersion, presets: ["fast"], models: ["demo"], judgeModel: null,
  settings: { maxSteps: 30 }, appVersion: "0.16.0", machine: machineIdentity(),
  taskSetHash: "abc123", scorerDigest: "def456", costBasis: "estimated", ...over,
});
const inputs = (over = {}) => ({
  study, tasks: ["one", "two"], scorerKinds: ["exact"], benchmarksFolder: "", version: "0.16.0",
  conditions: madeUnder(), ...over,
});

test("A1736: an entry keeps what the study was, and the fingerprint only moves when an input does", () => {
  const before = journalEntry(result("aa", [{ taskId: "one", passed: true }, { taskId: "two", passed: false }]), inputs());
  assert.equal(before.outcome.accuracy, 0.5);
  assert.equal(before.inputs.version, "0.16.0");
  assert.equal(fingerprintOf(inputs()), before.fingerprint);
  assert.equal(fingerprintOf(inputs({ tasks: ["two", "one"] })), fingerprintOf(inputs({ tasks: ["two", "one"] })));
  assert.notEqual(fingerprintOf(inputs({ version: "0.17.0" })), before.fingerprint);
  assert.notEqual(fingerprintOf(inputs({ tasks: ["one"] })), before.fingerprint);
});

test("A1736: replaying names what changed before it names what moved", () => {
  const before = journalEntry(result("aa", [{ taskId: "one", passed: false }, { taskId: "two", passed: false }]), inputs());
  const after = journalEntry(
    result("bb", [{ taskId: "one", passed: true }, { taskId: "two", passed: true }]),
    inputs({ study: { ...study, presets: ["careful"] }, version: "0.17.0", scorerKinds: ["exact", "f1"] }));
  const difference = journalDiff(before, after);
  assert.equal(difference.same, false);
  assert.deepEqual(difference.changes.map((change) => change.what),
    ["Model choices", "Scorers used", "Version of Branch Agent"]);
  assert.deepEqual(difference.changes[0], { what: "Model choices", before: "fast", after: "careful" });
  const report = journalReport(before, after);
  assert.match(report, /did \*\*not\*\* measure the same thing/);
  assert.match(report, /\| Model choices \| fast \| careful \|/);
  // mac7/eval-honesty: the accuracy line used to be printed underneath the table of what changed,
  // and that line is the one that gets quoted. Two runs that measured different experiments now
  // get the table and a refusal, and no accuracy at all.
  assert.doesNotMatch(report, /Accuracy went from/);
  assert.match(report, /Change one thing at a time/);
  // The same experiment twice says so instead.
  const same = journalEntry(result("cc", [{ taskId: "one", passed: true }, { taskId: "two", passed: false }]), inputs());
  assert.equal(journalDiff(before, same).same, true);
  assert.match(journalReport(before, same), /measured the same thing \(fingerprint/);
});

test("A1082 and A1736: the plan to repeat a run names exactly the tasks that ran", () => {
  const entry = journalEntry(result("aa", [{ taskId: "one", passed: true }]), inputs({ tasks: ["one"] }));
  const plan = journalReplayPlan(entry);
  assert.deepEqual(plan.subset, ["one"]);
  assert.equal(plan.limit, 1);
  assert.equal(plan.id, study.id);
});

test("A1082: a study writes a journal entry, and replay reads it back", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-eval3-journal-"));
  const provider = new ScriptedProvider([["", [say("Paris")]]]);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  app.studies.save({ id: "small", name: "A small study", source: { kind: "suite", suite: "cost" }, presets: ["default"], limit: 1 });
  await app.studies.run("small");
  const entries = app.studies.journals("small");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].format, "branch-agent-study-journal");
  assert.ok(entries[0].inputs.tasks.length >= 1);
  assert.notEqual(entries[0].inputs.version, "unknown", "the version that ran it is written down");
  const first = app.studies.replay("small");
  assert.match(first.report, /nothing to compare it with yet/);
  await app.studies.run("small", { fresh: true });
  const again = app.studies.replay("small");
  assert.equal(app.studies.journals("small").length, 2);
  assert.match(again.report, /measured the same thing|did \*\*not\*\* measure/);
  assert.deepEqual(again.plan.subset, again.entry.inputs.tasks);
});

/* -------------------------------------------------- A0858 and A1210 marking a search */

test("A0858: the retrieval measures on worked examples", () => {
  const graded = new Map([["d1", 3], ["d2", 2], ["d3", 1]]);
  // Perfect order: nDCG is 1 whatever the gains are.
  assert.equal(ndcgAt(["d1", "d2", "d3"], graded, 10), 1);
  // Best document second: the discount is 1/log2(3) on the 3, and 1/log2(2) on the 2.
  const dcg = 2 / Math.log2(2) + 3 / Math.log2(3);
  const ideal = 3 / Math.log2(2) + 2 / Math.log2(3) + 1 / Math.log2(4);
  assert.equal(ndcgAt(["d2", "d1"], graded, 10), Math.round((dcg / ideal) * 10000) / 10000);
  assert.equal(ndcgAt(["x", "y"], graded, 10), 0);
  assert.equal(ndcgAt(["d1"], new Map(), 10), 0, "nothing relevant scores zero rather than dividing by nothing");
  const binary = new Map([["a", 1], ["b", 1]]);
  assert.equal(recallAt(["z", "a"], binary, 10), 0.5);
  assert.equal(recallAt(["z", "a"], binary, 1), 0);
  assert.equal(precisionAt(["z", "a"], binary, 2), 0.5);
  assert.equal(reciprocalRank(["z", "a"], binary), 0.5);
  assert.equal(reciprocalRank(["z", "y"], binary), 0);
  assert.equal(averagePrecision(["a", "z", "b"], binary), Math.round(((1 / 1 + 2 / 3) / 2) * 10000) / 10000);
  const score = scoreRetrieval([{ ranked: ["a", "b"], relevance: binary }, { ranked: ["z", "a"], relevance: binary }], 10);
  assert.equal(score.questions, 2);
  assert.equal(score.recall, 0.75);
  assert.equal(score.mrr, 0.75);
  assert.match(retrievalTable(score, "BM25"), /\| BM25 \| 2 \| 69\.3% \| 75\.0% \| 75\.0% \| 75\.0% \| 62\.5% \|/);
});

test("A0858: a BEIR-shaped set is read from a folder on this computer", async (t) => {
  const root = await temp(t, "branch-eval3-beir-");
  await writeFile(join(root, "corpus.jsonl"),
    ['{"_id":"d1","title":"Deposits","text":"the deposit is returned within ten working days"}',
      '{"_id":"d2","title":"Keys","text":"keys are handed back at the office"}'].join("\n"), "utf8");
  await writeFile(join(root, "queries.jsonl"), '{"_id":"q1","text":"when is my deposit returned"}\n', "utf8");
  await mkdir(join(root, "qrels"), { recursive: true });
  await writeFile(join(root, "qrels", "test.tsv"), "query-id\tcorpus-id\tscore\nq1\td1\t1\nq1\td2\t0\n", "utf8");
  const set = await readBeirSet(root);
  assert.equal(set.documents.size, 2);
  assert.equal(set.documents.get("d1").title, "Deposits");
  assert.equal(set.queries.get("q1"), "when is my deposit returned");
  assert.equal(set.relevance.get("q1").get("d1"), 1);
  const good = await scoreBeirSet(set, async () => ["d1", "d2"], 10);
  assert.equal(good.ndcg, 1);
  const bad = await scoreBeirSet(set, async () => ["d2", "d1"], 10);
  assert.ok(bad.ndcg < 1);
  assert.equal(bad.mrr, 0.5);
});

/* ------------------------------------------------------------------ A1231 Nexus */

test("A1231: a reference call is read, including quotes, nesting and positions", () => {
  assert.deepEqual(parseCall('get_weather(city="Paris", units=\'metric\')'),
    { name: "get_weather", arguments: { city: "paris", units: "metric" } });
  assert.deepEqual(parseCall("search(query=\"a, b\", limit=[1, 2])"),
    { name: "search", arguments: { query: "a, b", limit: "[1, 2]" } });
  assert.deepEqual(parseCall("area(3, 4)"), { name: "area", arguments: { 0: "3", 1: "4" } });
  assert.equal(parseCall("no call here at all"), null);
});

test("A1231: a question is right when the call is right, and partly right when one argument is not", () => {
  const reference = parseCall('get_weather(city="Paris", units="metric")');
  assert.equal(judgeCall(reference, parseCall('get_weather(city="paris", units="metric")')).pass, true);
  const wrongName = judgeCall(reference, parseCall("get_forecast(city='Paris')"));
  assert.equal(wrongName.pass, false);
  assert.match(wrongName.reasons[0], /called get_forecast and get_weather was expected/);
  const half = judgeCall(reference, parseCall('get_weather(city="Lagos", units="metric")'));
  assert.equal(half.pass, false);
  assert.equal(half.score, 0.5);
  const extra = judgeCall(reference, parseCall('get_weather(city="Paris", units="metric", lang="en")'));
  assert.equal(extra.pass, true, "an optional argument the reference does not name is not held against it");
  assert.match(judgeCall(reference, null).reasons[0], /Nothing called get_weather/);
});

test("A1231: the Nexus adapter reads the published shape and marks the call that was really made", async (t) => {
  const root = await temp(t, "branch-eval3-nexus-");
  await writeFile(join(root, "sample.jsonl"), [
    JSON.stringify({ id: "w1", Input: "What is the weather in Paris?", Function: "get_weather(city: str)", Output: 'get_weather(city="Paris")' }),
    JSON.stringify({ sample_id: "w2", prompt: "How big is a 3 by 4 rectangle?", call: "area(width=3, height=4)" }),
    JSON.stringify({ note: "a line with no question is skipped" }),
  ].join("\n"), "utf8");
  assert.equal(findBenchmarkAdapter("nexus"), nexusAdapter);
  const tasks = await nexusAdapter.discover(root);
  assert.deepEqual(tasks.map((one) => one.id), ["w1", "w2"]);
  const ready = await nexusAdapter.prepare(tasks[0], join(root, "work"), root);
  assert.match(ready.prompt, /functions you may use/);
  assert.match(ready.prompt, /get_weather\(city: str\)/);
  assert.equal(ready.refusal, null);
  // Marked from the tool call the task really made, not from its prose.
  const fromCall = await nexusAdapter.judge(tasks[0], {
    answer: "I checked the weather for you.", workspace: root,
    trajectory: { runId: null, calls: [{ name: "get_weather", arguments: { city: "Paris" } }], steps: 1, ms: 1, tokens: 1, dollars: null },
  }, root);
  assert.equal(fromCall.pass, true);
  // Falling back to a call written out in the answer.
  const fromText = await nexusAdapter.judge(tasks[1], { answer: "I would call area(width=3, height=4).", workspace: root }, root);
  assert.equal(fromText.pass, true);
  const wrong = await nexusAdapter.judge(tasks[1], { answer: "area(width=3, height=9)", workspace: root }, root);
  assert.equal(wrong.pass, false);
  await assert.rejects(nexusAdapter.discover(join(root, "work")), /No \.jsonl file in/);
});

/* ------------------------------ A1726 MiniWoB++ in Branch's own browser, and the live environments */

/** A stand-in for MiniWoB's core.js: the episode starts, shows its goal, and scores a click on the named button. */
const fakeMiniwobCore = `
window.WOB_REWARD_GLOBAL = 0; window.WOB_RAW_REWARD_GLOBAL = 0; window.WOB_DONE_GLOBAL = false;
window.core = {
  EPISODE_MAX_TIME: 10000, started: false,
  startEpisodeReal() {
    core.started = true;
    document.getElementById("query").textContent = document.body.dataset.goal;
  },
  getUtterance() { return { utterance: document.getElementById("query").textContent, fields: {} }; },
  endEpisode(reward) {
    window.WOB_REWARD_GLOBAL = reward; window.WOB_RAW_REWARD_GLOBAL = reward; window.WOB_DONE_GLOBAL = true;
  },
};
document.addEventListener("click", (event) => {
  if (!core.started || event.target.tagName !== "BUTTON") return;
  core.endEpisode(event.target.textContent === document.body.dataset.answer ? 1 : -1);
});`;
/** A page in MiniWoB's own shape: the core is loaded from the folder beside it, and the goal starts empty. */
const fakeMiniwobPage = (goal, answer) => `<!DOCTYPE html>
<html><head><title>MiniWoB task</title><script src="../core/core.js"></script></head>
<body data-goal="${goal}" data-answer="${answer}">
  <div id="query"></div>
  <button>Cancel</button><button>${answer}</button>
</body></html>`;

async function fakeMiniwob(root) {
  const folder = join(root, "bench");
  await mkdir(join(folder, "html", "miniwob"), { recursive: true });
  await mkdir(join(folder, "html", "core"), { recursive: true });
  await writeFile(join(folder, "html", "core", "core.js"), fakeMiniwobCore);
  await writeFile(join(folder, "html", "miniwob", "click-submit.html"), fakeMiniwobPage("Click on the Submit button.", "Submit"));
  await writeFile(join(folder, "html", "miniwob", "click-go.html"), fakeMiniwobPage("Press the button called Go.", "Go"));
  return folder;
}

/** Skips only when Playwright's Chromium is not installed on this computer. */
async function chromiumMissing() {
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: true }).then((browser) => browser.close().then(() => false), () => true);
}

test("A1726: a MiniWoB study runs in Branch's own browser and is judged from the page, never the answer", async (t) => {
  if (await chromiumMissing()) return t.skip("Playwright's Chromium is not installed");
  const root = await mkdtemp(join(tmpdir(), "branch-eval3-miniwob-"));
  const folder = await fakeMiniwob(root);
  const provider = new ScriptedProvider([
    // The goal is only in the page until the episode starts, so finding it here proves it was read from the page.
    ["Click on the Submit button.", [callTool("browser.click", { role: "button", name: "Submit" }), say("I pressed Submit.")]],
    // This one claims success and never touches the page.
    ["Press the button called Go.", [say("Task completed successfully, reward 1.")]],
  ]);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "fast", name: "Fast", provider, model: "gpt-4o-mini" }] });
  // No origin is configured for this browser: the page's own loopback server is allowed for its window alone.
  const browser = new BranchBrowser({ allowedOrigins: ["https://example.org"] });
  registerBrowser(app.registry, browser);
  app.studies.browser = browser;
  t.after(async () => { await browser.close(); await app.close(); await discardTemp(root); });
  app.studies.configure({ benchmarksFolder: folder });
  app.studies.save({ id: "miniwob", name: "MiniWoB", presets: ["fast"], retries: 0, concurrency: 1,
    source: { kind: "benchmark", benchmark: "miniwob", directory: folder } });
  const result = await app.studies.run("miniwob");
  const cell = (id) => result.cells.find((one) => one.taskId === id);
  assert.equal(cell("click-submit").passed, true, cell("click-submit").reasons.join(" "));
  assert.match(cell("click-submit").reasons.join(" "), /WOB_REWARD_GLOBAL = 1, WOB_RAW_REWARD_GLOBAL = 1, WOB_DONE_GLOBAL = true/);
  assert.equal(cell("click-go").passed, false, "saying it worked is not a reward");
  assert.match(cell("click-go").reasons.join(" "), /did not finish.*WOB_REWARD_GLOBAL = 0/);
  // The prompt names the address it was served from, and the core file was copied beside the page.
  const asked = provider.requests.map((request) => request.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n")).join("\n");
  assert.match(asked, /http:\/\/127\.0\.0\.1:\d+\/miniwob\/click-submit\.html is already open/);
  assert.match(await readFile(join(root, "workspace", "benchmarks", "miniwob", "click-submit", "html", "core", "core.js"), "utf8"), /startEpisodeReal/);
  // Every window was closed again once it had been judged.
  assert.equal(browser.hostFor({ owner: app.runtime.owner, runId: cell("click-submit").runId }), "");
});

test("A1726: a MiniWoB page or file outside the benchmark's folder is refused, and nothing passes without a page", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-eval3-miniwob-out-"));
  let app;
  t.after(async () => { await app?.close(); await discardTemp(root); });
  const folder = await fakeMiniwob(root);
  await writeFile(join(root, "secret.html"), "<p>not a task</p>");
  await writeFile(join(folder, "html", "miniwob", "reaches-out.html"), `<script src="../../../secret.js"></script>`);
  const adapter = findBenchmarkAdapter("miniwob");
  const into = join(root, "into");
  const outside = await adapter.prepare({ id: "escape", prompt: "p", tags: [], raw: { file: "../../../secret.html" } }, into, folder);
  assert.match(outside.refusal, /points outside the miniwob folder/);
  const [reaching] = (await adapter.discover(folder)).filter((one) => one.id === "reaches-out");
  assert.match((await adapter.prepare(reaching, into, folder)).refusal, /outside the MiniWoB folder/);
  assert.deepEqual(await readdir(into).catch(() => []), [], "nothing is copied for a refused task");
  // The plain judge has no page to read, so even a confident answer fails.
  const verdict = await adapter.judge(reaching, { answer: "completed successfully, reward 1", workspace: into }, folder);
  assert.equal(verdict.pass, false);
  // A study with no browser refuses the task by name instead of asking the model.
  app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"),
    presets: [{ id: "fast", name: "Fast", provider: new ScriptedProvider([]), model: "gpt-4o-mini" }] });
  app.studies.configure({ benchmarksFolder: folder });
  app.studies.save({ id: "nobrowser", name: "No browser", presets: ["fast"], subset: ["click-submit"],
    source: { kind: "benchmark", benchmark: "miniwob", directory: folder } });
  const refused = await app.studies.run("nobrowser");
  assert.match(refused.cells[0].reasons[0], /runs in Branch's own browser, and this launch has none/);
});

test("A1726: a benchmark window only opens a page on 127.0.0.1, and its origin is not given to other tasks", async (t) => {
  if (await chromiumMissing()) return t.skip("Playwright's Chromium is not installed");
  const browser = new BranchBrowser({ allowedOrigins: ["https://example.org"] });
  await assert.rejects(browser.benchmarkWindow("owner", "https://example.org/page.html"), /127\.0\.0\.1/);
  await assert.rejects(browser.benchmarkWindow("owner", "http://localhost:9/page.html"), /127\.0\.0\.1/);
  const root = await mkdtemp(join(tmpdir(), "branch-eval3-miniwob-win-"));
  await writeFile(join(root, "page.html"), "<title>Served</title>");
  const served = await serveFolder(root);
  t.after(async () => { await browser.close(); await served.close(); await discardTemp(root); });
  const opened = await browser.benchmarkWindow("owner", `${served.origin}/page.html`);
  assert.equal(await opened.evaluate("document.title"), "Served");
  assert.equal((await fetch(`${served.origin}/../page.html`)).status, 200, "the address is normalised inside the folder");
  assert.equal((await fetch(`${served.origin}/%2e%2e/%2e%2e/etc/hosts`)).status, 404);
  const other = { owner: "owner", runId: "someone-else", signal: new AbortController().signal, permissions: new Set(["browser.read"]) };
  await assert.rejects(browser.navigate(`${served.origin}/page.html`, other), /not an allowed origin/);
  opened.handTo("mine");
  const mine = { ...other, runId: "mine" };
  assert.match((await browser.snapshot(mine)).url, /page\.html$/, "the task works in the very page that was opened");
  await browser.closeRun(mine);
  assert.equal(await opened.evaluate("document.title"), "Served", "the end of the task leaves it open for the judge");
  await opened.close();
  await assert.rejects(opened.evaluate("1"), /closed/);
});

test("A1726: the verdict needs a finished episode with a reward above zero", () => {
  assert.equal(miniwobPassAbove, 0);
  assert.equal(miniwobVerdict({ reward: 0.8, raw: 1, done: true }).pass, true);
  assert.equal(miniwobVerdict({ reward: 0, raw: 0, done: true }).pass, false);
  assert.equal(miniwobVerdict({ reward: -1, raw: -1, done: true }).pass, false);
  assert.equal(miniwobVerdict({ reward: 1, raw: 1, done: false }).pass, false);
  assert.equal(miniwobVerdict({}).pass, false);
  assert.deepEqual(pageAssets(`<script src="../core/core.js"></script><link href="https://x.org/a.css"><img src="/abs.png"><a href="#top">`), ["../core/core.js"]);
});

test("A1726: WebArena and WorkArena are still listed as needing the owner's own servers, with what each needs", () => {
  const entry = notIntegratedBenchmarks.find((one) => one.id === "browsergym-live");
  assert.ok(entry, "browsergym-live must be listed rather than left out");
  assert.doesNotMatch(entry.name, /MiniWoB/);
  assert.match(entry.needs, /servers that have to be running/);
  assert.match(entry.needs, /WebArena needs its own self-hosted websites .*Docker images/);
  assert.match(entry.needs, /WorkArena needs a ServiceNow developer instance of the owner's own/);
  assert.ok(findBenchmarkAdapter("miniwob"), "MiniWoB has an adapter of its own");
});

/* ---------------------------------------------- A1499 the research suite that ships */

test("A1499: a research suite ships, uses the new scorers, and reaches the internet nowhere", () => {
  const suite = builtInSuites().find((one) => one.id === "research");
  assert.ok(suite, "the research suite must ship");
  assert.equal(suite.source, "built-in");
  const kinds = suite.tasks.flatMap((one) => (one.scorers ?? []).map((scorer) => scorer.kind));
  for (const kind of ["passage", "f1", "trajectory"]) assert.ok(kinds.includes(kind), kind);
  assert.ok(suite.tasks.some((one) => one.deny?.mentions?.length), "one task must refuse an invented figure");
  for (const one of suite.tasks) assert.ok(!/https?:\/\//.test(one.prompt), `${one.id} must not name a website`);
});

/* ---------------------------------------------- A1210 scoring the real work as it finishes */

test("A1210: live scoring is off until it is switched on, and refuses the scorer that costs money", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-eval3-live-"));
  const provider = new ScriptedProvider([["say the word", [say("The word is rhubarb.")]], ["say nothing", [say("I could not do that.")]]]);
  const app = await createBranch({ workspace: join(root, "workspace"), dataDir: join(root, "data"), provider });
  t.after(async () => { await app.close(); await discardTemp(root); });
  assert.equal(app.liveScoring.settings().enabled, false);
  await app.runtime.run({ prompt: "say the word", permissions: [] });
  assert.equal(app.liveScoring.recent().length, 0, "nothing is written while it is off");
  assert.throws(() => app.liveScoring.configure({ enabled: true, scorers: [{ kind: "rubric", rubric: "is it good" }] }),
    /second bill on ordinary work/);
  assert.throws(() => app.liveScoring.configure({ enabled: true, scorers: [{ kind: "budget", maxDollars: 0.01 }] }),
    /money limit cannot be checked here/);
  assert.equal(app.liveScoring.settings().enabled, false, "a refused setting is not half-saved");
  app.liveScoring.configure({ enabled: true, scorers: [{ kind: "finished" }] });
  const good = await app.runtime.run({ prompt: "say the word", permissions: [] });
  const bad = await app.runtime.run({ prompt: "say nothing", permissions: [] });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const recent = app.liveScoring.recent();
  const forGood = recent.find((one) => one.runId === good.id);
  const forBad = recent.find((one) => one.runId === bad.id);
  assert.equal(forGood?.pass, true);
  assert.equal(forBad?.pass, false);
  assert.match(forBad.reasons.join(" "), /did not finish/);
  // A limit on time is a real limit here: the task's own timestamps, not a zero that always passes.
  app.liveScoring.configure({ scorers: [{ kind: "budget", maxMs: 1 }] });
  const slow = await app.runtime.run({ prompt: "say the word", permissions: [] });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const forSlow = app.liveScoring.recent().find((one) => one.runId === slow.id);
  assert.equal(forSlow?.pass, false);
  assert.match(forSlow.reasons.join(" "), /ms and 1 ms was the limit/);
  app.liveScoring.configure({ scorers: [{ kind: "finished" }] });
  const summary = app.liveScoring.summary();
  assert.equal(summary.runs, 3);
  assert.equal(summary.passed, 1);
});

test("A1210: the summary of the recent verdicts, and the settings' own limits", () => {
  assert.deepEqual(liveScoreSummary([]), { runs: 0, passed: 0, accuracy: 0, reasons: [] });
  const summary = liveScoreSummary([
    { runId: "a", at: "1", status: "completed", score: 1, pass: true, reasons: [] },
    { runId: "b", at: "2", status: "completed", score: 0, pass: false, reasons: ["it gave up"] },
    { runId: "c", at: "3", status: "failed", score: 0, pass: false, reasons: ["it gave up"] },
  ]);
  assert.equal(summary.accuracy, 0.333);
  assert.deepEqual(summary.reasons, ["it gave up"], "the same reason twice is said once");
  assert.equal(LiveScoringSettingsSchema.parse({}).keep, 200);
  assert.throws(() => LiveScoringSettingsSchema.parse({ scorers: new Array(5).fill({ kind: "finished" }) }));
});

/* ------------------------------------------------------- the new scorers inside a suite */

test("the new scorers combine with the old ones the way every scorer does", async () => {
  const scorers = [
    makeScorer({ kind: "f1", value: "the Eiffel Tower" }, { workspace: tmpdir() }),
    makeScorer({ kind: "contains", phrases: ["Paris"] }, { workspace: tmpdir() }),
  ];
  const both = await scoreAll(scorers, task, emptyTrajectory, "The eiffel tower, in Paris.");
  assert.equal(both.pass, true);
  assert.deepEqual(both.parts.map((part) => part.kind), ["f1", "contains"]);
  const one = await scoreAll(scorers, task, emptyTrajectory, "The eiffel tower.");
  assert.equal(one.pass, false);
  assert.equal(one.score, 0.5);
});
