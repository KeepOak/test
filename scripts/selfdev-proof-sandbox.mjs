// The real-GitHub plumbing half of scripts/selfdev-proof.mjs (--sandbox): an isolated engine's default Trunk, in a
// Full Access conversation, takes one change through edit → test → commit → push → pull request → exact checks →
// merge queue → merged on a THROWAWAY repository (KeepOak/branch-selfdev-sandbox: one required check, `test`, in a
// ruleset, and main takes changes only through GitHub's merge queue). Never KeepOak/Branch-Agent.
//
// The model is a scripted stand-in, so no subscription is used and every step is Branch's own tool doing real work:
// git.clone, files.write, shell.execute (the test), git.commit, git.push, github.open_pull_request,
// github.wait_for_checks, github.merge_pull_request. This script, never the model, judges the run from GitHub's own
// record. The token comes from `gh auth token` straight into the isolated engine's locker; it is never printed.
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startEngine } from "../tests/fixtures/selfdev-harness.mjs";

export const sandboxRepo = "KeepOak/branch-selfdev-sandbox";
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const ghJson = (...args) => JSON.parse(gh(...args) || "null");
const fileOnMain = (path) => Buffer.from(ghJson("api", `repos/${sandboxRepo}/contents/${path}?ref=main`).content, "base64").toString("utf8");

/** The change: one new settings knob and its test, written against what main holds now, so every run is new. */
export function sandboxChange(settings, tests, knob) {
  const line = `  ${knob}: { default: "medium", valid: (value) => ["short", "medium", "long"].includes(value) },`;
  if (!/export const knobs = \{\r?\n/.test(settings)) throw new Error("The sandbox's src/settings.mjs no longer has its knobs list.");
  const nextSettings = settings.replace(/(export const knobs = \{\r?\n)/, `$1${line}\n`);
  const nextTests = `${tests.replace(/\s*$/, "\n")}
test("${knob} defaults to medium and keeps a valid saved value", () => {
  assert.equal(readSetting({}, "${knob}"), "medium");
  assert.equal(readSetting({ ${knob}: "long" }, "${knob}"), "long");
  assert.equal(readSetting({ ${knob}: "huge" }, "${knob}"), "medium");
});
`;
  return { settings: nextSettings, tests: nextTests };
}

const call = (name, args, id) => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });
const lastTool = (request) => [...request.messages].reverse().find((message) => message.role === "tool")?.content ?? "";

/** The steps a coding model takes, one per round; waiting repeats while checks or the queue are still going. */
export function scriptedSandboxCoder({ branch, knob, change, message }) {
  const url = `https://github.com/${sandboxRepo}.git`;
  const steps = [
    () => call("git.clone", { url, folder: "sandbox" }, "clone"),
    () => call("shell.execute", { executable: "git", args: ["checkout", "-b", branch], cwd: "sandbox" }, "branch"),
    () => call("files.read", { path: "sandbox/src/settings.mjs" }, "read-settings"),
    () => call("files.write", { path: "sandbox/src/settings.mjs", content: change.settings }, "edit-settings"),
    () => call("files.read", { path: "sandbox/tests/settings.test.mjs" }, "read-tests"),
    () => call("files.write", { path: "sandbox/tests/settings.test.mjs", content: change.tests }, "edit-tests"),
    () => call("shell.execute", { executable: "node", args: ["--test", "tests/settings.test.mjs"], cwd: "sandbox" }, "run-tests"),
    () => call("git.commit", { folder: "sandbox", message }, "commit"),
    () => call("git.push", { folder: "sandbox", remote: "origin", branch }, "push"),
    () => call("github.open_pull_request", { repo: sandboxRepo, title: message, base: "main", head: branch,
      body: `Adds the ${knob} setting with its test. Opened by Branch's self-development proof (scripts/selfdev-proof.mjs --sandbox).` }, "pr"),
  ];
  const state = { index: 0, number: null, phase: "checks", rounds: 0 };
  const provider = { name: "scripted", async complete(request) {
    const said = [...request.messages].reverse().find((entry) => entry.role === "user")?.content ?? "";
    if (/Introduce yourself/.test(said)) return { content: "Hello, I am Ada.", toolCalls: [] };
    if (++state.rounds > 200) return { content: "Stopping: too many rounds.", toolCalls: [] };
    if (state.index < steps.length) return steps[state.index++]();
    const last = lastTool(request);
    if (state.number === null) {
      state.number = Number(/"number":\s*(\d+)/.exec(last)?.[1] ?? NaN);
      if (!Number.isSafeInteger(state.number)) return { content: `The pull request did not open: ${last.slice(0, 300)}`, toolCalls: [] };
      return call("github.wait_for_checks", { repo: sandboxRepo, number: state.number, seconds: 300 }, "wait-checks-1");
    }
    const verdict = /"state":"(\w+)"/.exec(last)?.[1];
    if (state.phase === "checks") {
      if (verdict === "pending") return call("github.wait_for_checks", { repo: sandboxRepo, number: state.number, seconds: 300 }, `wait-checks-${state.rounds}`);
      if (verdict !== "passed") return { content: `Checks did not pass, so nothing was merged: ${last.slice(0, 400)}`, toolCalls: [] };
      state.phase = "merge";
      return call("github.merge_pull_request", { repo: sandboxRepo, number: state.number }, "merge");
    }
    if (state.phase === "merge") {
      if (!/"queued":true/.test(last) && !/"merged":true/.test(last)) return { content: `The merge was refused: ${last.slice(0, 400)}`, toolCalls: [] };
      state.phase = "queue";
      return call("github.wait_for_checks", { repo: sandboxRepo, number: state.number, seconds: 300 }, "wait-queue-1");
    }
    if (verdict === "pending") return call("github.wait_for_checks", { repo: sandboxRepo, number: state.number, seconds: 300 }, `wait-queue-${state.rounds}`);
    return { content: `Pull request #${state.number} ${verdict === "merged" ? "is merged" : `did not merge (${verdict})`}: ${last.slice(0, 300)}`, toolCalls: [] };
  } };
  return { provider, state };
}

/** What GitHub itself recorded for the pull request: the exact head, its checks, the queue's run and the merge. */
export function sandboxRecord(number) {
  const pull = ghJson("api", `repos/${sandboxRepo}/pulls/${number}`);
  const headRuns = ghJson("api", `repos/${sandboxRepo}/commits/${pull.head.sha}/check-runs`, "--jq", "[.check_runs[] | {name, status, conclusion, id}]");
  const actions = ghJson("api", `repos/${sandboxRepo}/actions/runs?per_page=30`, "--jq",
    "[.workflow_runs[] | {id, event, head_branch, head_sha, status, conclusion, html_url}]");
  const timeline = ghJson("api", `repos/${sandboxRepo}/issues/${number}/timeline?per_page=100`, "--jq", "[.[] | .event]");
  const prRun = actions.find((run) => run.event === "pull_request" && run.head_sha === pull.head.sha) ?? null;
  const queueRun = actions.find((run) => run.event === "merge_group" && new RegExp(`/pr-${number}-`).test(run.head_branch)) ?? null;
  return { number, url: pull.html_url, headSha: pull.head.sha, merged: pull.merged === true, mergeSha: pull.merge_commit_sha,
    mergedAt: pull.merged_at, headChecks: headRuns, prRun, queueRun, timeline,
    mainNow: gh("api", `repos/${sandboxRepo}/git/ref/heads/main`, "--jq", ".object.sha") };
}

export async function sandboxProof({ root, stamp, log, evidence, health, roomToWork, defaultTrunkConversation }) {
  const suffix = stamp.slice(5, 19).toLowerCase().replace(/[^a-z0-9]/g, "");
  const knob = `knob${suffix}`, branch = `selfdev/${knob}`, message = `feat: add the ${knob} setting`;
  const before = gh("api", `repos/${sandboxRepo}/git/ref/heads/main`, "--jq", ".object.sha");
  const rules = ghJson("api", `repos/${sandboxRepo}/rules/branches/main`, "--jq", "[.[] | .type]");
  const change = sandboxChange(fileOnMain("src/settings.mjs"), fileOnMain("tests/settings.test.mjs"), knob);
  const coder = scriptedSandboxCoder({ branch, knob, change, message });
  await log({ step: "sandbox", repo: sandboxRepo, mainBefore: before, rules, branch, knob });
  // GitHub is shared: checks are looked at every 15 seconds, and only through REST (apart from the one enqueue).
  const engine = await startEngine(root, { token: gh("auth", "token"), githubPollSeconds: 15, provider: coder.provider });
  roomToWork(engine.app);
  const results = [], poller = setInterval(() => void health(engine, results), 5000);
  let summary;
  try {
    const sessionId = await defaultTrunkConversation(engine);
    const began = Date.now();
    const started = await engine.api("run", { prompt: `Add a ${knob} setting to ${sandboxRepo}, test it, open a pull request and merge it once its checks pass.`, sessionId });
    const runId = started.body?.id;
    const run = runId ? engine.app.store.run(runId) : null;
    await health(engine, results);
    const found = run ? evidence(engine, runId) : {};
    const events = run ? engine.app.store.events(runId) : [];
    const done = (id) => events.find((event) => event.kind === "tool.completed" && event.data.id === id)?.data.result;
    const tested = done("run-tests");
    const localTest = tested ? { exitCode: tested.exitCode, pass: Number(/pass (\d+)/.exec(tested.stdout)?.[1] ?? NaN),
      fail: Number(/fail (\d+)/.exec(tested.stdout)?.[1] ?? NaN) } : null;
    // Every verdict github.wait_for_checks gave, in order: pending while checks and the queue ran, passed, then merged.
    const verdicts = events.filter((event) => event.kind === "tool.completed" && event.data.name === "github.wait_for_checks")
      .map((event) => ({ state: event.data.result?.state, headSha: event.data.result?.headSha, mergeSha: event.data.result?.mergeSha, queued: event.data.result?.queued }));
    const merge = done("merge");
    const record = Number.isSafeInteger(coder.state.number) ? sandboxRecord(coder.state.number) : null;
    summary = { mode: "sandbox", model: "scripted", repo: sandboxRepo, status: run?.status ?? `http ${started.status}`, output: run?.output?.slice(0, 1500),
      elapsedSeconds: Math.round((Date.now() - began) / 1000), mainBefore: before, rules, ...found,
      localTest, verdicts, merge: merge ? { merged: merge.merged, queued: merge.queued, state: merge.state, headSha: merge.headSha } : null, record,
      health: { checks: results.length, allOk: results.every((status) => status === 200) } };
  } finally {
    clearInterval(poller);
    await engine.close();
  }
  const record = summary.record;
  const passed = summary.status === "completed" && summary.asked?.length === 0 && !!record?.merged
    && record.prRun?.conclusion === "success" && record.queueRun?.conclusion === "success"
    && record.timeline.includes("added_to_merge_queue") && record.mainNow !== before && summary.health.allOk
    && (summary.tools ?? []).every((tool) => tool.ok) && summary.localTest?.exitCode === 0 && summary.localTest.fail === 0
    && summary.merge?.queued === true && summary.merge.headSha === record.headSha && summary.verdicts.at(-1)?.state === "merged";
  await log({ step: "summary", passed, ...summary });
  await writeFile(join(root, "summary.json"), JSON.stringify({ passed, ...summary }, null, 2));
  return passed;
}
