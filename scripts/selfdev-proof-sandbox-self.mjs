// The self-development half of the sandbox proof (scripts/selfdev-proof.mjs --sandbox-self): Branch's OWN change path,
// contract → edit → branch.run_contract_tests → commit → push → draft pull request → exact checks →
// branch.finish_source_change (independent read-only review, ready for review, the merge queue) → merged, on a base with
// real rules: KeepOak/branch-selfdev-sandbox's selfdev-proof/queue (the `test` check required by a ruleset, and the merge
// queue on). Never KeepOak/Branch-Agent.
//
// branch.prepare_source_change only ever clones a repository named Branch-Agent, so this script lays out what it
// leaves behind by hand: branch-agent-source cloned from the sandbox, the worktree on a branch/self-<name> line, the
// contract written before anything changes (sent only to the sandbox), and the worktree's project made active. From
// there every step is Branch's own tool called by a scripted model stand-in in the owner's Full Access conversation;
// the independent reviewer is the same stand-in answering a passing verdict. Commands run behind the wall (WSL on
// Windows). The verdict comes from GitHub's record.
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startEngine } from "../tests/fixtures/selfdev-harness.mjs";
import { ContractBook } from "../dist/self-development-contract.js";
import { sandboxChange, sandboxRecord, sandboxRepo } from "./selfdev-proof-sandbox.mjs";

export const selfBase = "selfdev-proof/queue";
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (cwd, ...args) => execFileSync("git", ["-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();
const call = (name, args, id) => ({ content: "", toolCalls: [{ id, name, arguments: JSON.stringify(args) }] });

/** Branch's own steps for its change, one per model round, and a passing verdict when it is asked to review independently. */
export function scriptedSelfCoder({ worktree, branch, change, message }) {
  const steps = [
    () => call("files.read", { path: `${worktree}/src/settings.mjs` }, "read-settings"),
    () => call("files.write", { path: `${worktree}/src/settings.mjs`, content: change.settings }, "edit-settings"),
    () => call("files.read", { path: `${worktree}/tests/settings.test.mjs` }, "read-tests"),
    () => call("files.write", { path: `${worktree}/tests/settings.test.mjs`, content: change.tests }, "edit-tests"),
    () => call("git.commit", { folder: worktree, message }, "commit"),
    () => call("branch.run_contract_tests", { worktree }, "contract-tests"),
    () => call("git.push", { folder: worktree, remote: "origin", branch }, "push"),
    () => call("github.open_pull_request", { repo: sandboxRepo, title: message, base: selfBase, head: branch, draft: true,
      body: "Why merge this: it adds one setting with its test. Tested with node scripts/review.mjs --jobs 1 tests/settings.test.mjs (pass). Opened by Branch's self-development proof (scripts/selfdev-proof.mjs --sandbox-self)." }, "pr"),
  ];
  const state = { index: 0, number: null, phase: "checks", rounds: 0, reviews: 0 };
  const wait = () => call("github.wait_for_checks", { repo: sandboxRepo, number: state.number, seconds: 300 }, `wait-${state.rounds}`);
  const provider = { name: "scripted", async complete(request) {
    const said = [...request.messages].reverse().find((entry) => entry.role === "user")?.content ?? "";
    if (/Introduce yourself/.test(said)) return { content: "Hello, I am Ada.", toolCalls: [] };
    if (/Review this proposed Branch source change independently/.test(said)) { state.reviews++; return { content: '{"passed":true,"findings":[]}', toolCalls: [] }; }
    if (++state.rounds > 200) return { content: "Stopping: too many rounds.", toolCalls: [] };
    const last = [...request.messages].reverse().find((entry) => entry.role === "tool")?.content ?? "";
    if (state.index > 0 && /"ok":false/.test(last)) return { content: `A step was refused: ${last.slice(0, 500)}`, toolCalls: [] };
    if (state.index < steps.length) return steps[state.index++]();
    if (state.number === null) {
      state.number = Number(/"number":\s*(\d+)/.exec(last)?.[1] ?? NaN);
      return Number.isSafeInteger(state.number) ? wait() : { content: `The pull request did not open: ${last.slice(0, 300)}`, toolCalls: [] };
    }
    const verdict = /"state":"(\w+)"/.exec(last)?.[1];
    if (state.phase === "checks") {
      if (verdict === "pending") return wait();
      if (verdict !== "passed") return { content: `Checks did not pass, so nothing was finished: ${last.slice(0, 400)}`, toolCalls: [] };
      state.phase = "finish";
      return call("branch.finish_source_change", { worktree, repo: sandboxRepo, number: state.number }, "finish");
    }
    if (state.phase === "finish") {
      if (!/"queued":true/.test(last) && !/"merged":true/.test(last)) return { content: `Finishing was refused: ${last.slice(0, 500)}`, toolCalls: [] };
      state.phase = "queue";
      return wait();
    }
    if (verdict === "pending") return wait();
    return { content: `Pull request #${state.number} ${verdict === "merged" ? "is merged" : `did not merge (${verdict})`}: ${last.slice(0, 300)}`, toolCalls: [] };
  } };
  return { provider, state };
}

/**
 * What `branch.prepare_source_change` leaves behind, laid out by hand for a repository it will not clone: the clone
 * and the worktree now, and the contract (`writeContract`) from inside the task, as prepare writes it, so the task
 * that prepared the change is the one that may run its commands and finish it.
 */
async function layOut(engine, name) {
  const source = join(engine.workspace, "branch-agent-source"), folder = `branch-agent-source/.branch-worktrees/self-${name}`;
  git(engine.workspace, "clone", "--quiet", `https://github.com/${sandboxRepo}.git`, "branch-agent-source");
  git(source, "fetch", "--quiet", "origin", selfBase);
  const base = git(source, "rev-parse", `origin/${selfBase}^{commit}`);
  git(source, "worktree", "add", "--quiet", "-b", `branch/self-${name}`, `.branch-worktrees/self-${name}`, base);
  const owner = engine.app.runtime.owner;
  const writeContract = (taskRunId) => new ContractBook(engine.app.store.sqlite).create(owner, { taskRunId, sourceSha: base, worktreePath: folder, terms: {
    allowedPaths: ["**"], permissions: ["files.write", "files.edit", "shell.execute", "git.commit", "git.push", "github.open_pull_request", "branch.finish_source_change"],
    expectedTests: ["tests/settings.test.mjs"], definitionOfDone: "The sandbox has one more setting, with its test, merged by the merge queue.",
    sideEffects: [`a pull request into ${selfBase}`], rollbackPlan: "close the pull request" }, sendRepositories: [sandboxRepo.toLowerCase()] });
  engine.app.store.projects.save(owner, { id: `self-${name}`, name: `Branch self-development proof: ${name}`, folder, repository: sandboxRepo });
  engine.app.store.projects.setActive(owner, { active: `self-${name}` });
  return { folder, base, writeContract };
}

export async function sandboxSelfProof({ root, stamp, log, evidence, health, roomToWork, defaultTrunkConversation }) {
  const name = `k${stamp.slice(5, 19).toLowerCase().replace(/[^a-z0-9]/g, "")}`.slice(0, 24), branch = `branch/self-${name}`;
  const message = `feat: add the ${name} setting`;
  const rules = JSON.parse(gh("api", `repos/${sandboxRepo}/rules/branches/${encodeURIComponent(selfBase)}`, "--jq", "[.[] | .type]"));
  if (!rules.includes("merge_queue") || !rules.includes("required_status_checks")) throw new Error(`${selfBase} on ${sandboxRepo} has no merge queue or required check: ${rules}`);
  const before = gh("api", `repos/${sandboxRepo}/git/ref/heads/${selfBase}`, "--jq", ".object.sha");
  const file = (path) => Buffer.from(JSON.parse(gh("api", `repos/${sandboxRepo}/contents/${path}?ref=${encodeURIComponent(selfBase)}`)).content, "base64").toString("utf8");
  const change = sandboxChange(file("src/settings.mjs"), file("tests/settings.test.mjs"), name);
  await mkdir(root, { recursive: true });
  let coder, laid, contract = null;
  const provider = { name: "scripted", complete: (request) => {
    // The task's first round writes the contract, as branch.prepare_source_change does inside the task.
    const said = [...request.messages].reverse().find((entry) => entry.role === "user")?.content ?? "";
    if (!contract && laid && /to Branch's source in/.test(said)) {
      const task = engine.app.store.activeRuns(engine.app.runtime.owner).find((run) => run.prompt?.includes(laid.folder));
      if (task) contract = laid.writeContract(task.id);
    }
    return coder.provider.complete(request);
  } };
  const engine = await startEngine(root, { token: gh("auth", "token"), githubPollSeconds: 15, npm: true, provider });
  roomToWork(engine.app);
  const results = [], poller = setInterval(() => void health(engine, results), 5000);
  let summary;
  try {
    laid = await layOut(engine, name);
    coder = scriptedSelfCoder({ worktree: laid.folder, branch, change, message });
    await log({ step: "sandbox-self", repo: sandboxRepo, base: selfBase, baseBefore: before, rules, worktree: laid.folder });
    const sessionId = await defaultTrunkConversation(engine);
    const began = Date.now();
    const started = await engine.api("run", { prompt: `Add a ${name} setting to Branch's source in ${laid.folder}, test it, and finish it.`, sessionId });
    const runId = started.body?.id, run = runId ? engine.app.store.run(runId) : null;
    await health(engine, results);
    const events = run ? engine.app.store.events(runId) : [];
    const done = (id) => events.find((event) => event.kind === "tool.completed" && event.data.id === id)?.data.result;
    const tests = done("contract-tests"), finish = done("finish");
    const verdicts = events.filter((event) => event.kind === "tool.completed" && event.data.name === "github.wait_for_checks")
      .map((event) => ({ state: event.data.result?.state, headSha: event.data.result?.headSha, mergeSha: event.data.result?.mergeSha, queued: event.data.result?.queued }));
    const audit = engine.app.store.audit.list(engine.app.runtime.owner, { action: "self_development.merge", limit: 5 }).map((entry) => ({ outcome: entry.outcome, subject: entry.subject, reason: entry.reason }));
    const record = Number.isSafeInteger(coder.state.number) ? sandboxRecord(coder.state.number) : null;
    summary = { mode: "sandbox-self", model: "scripted", repo: sandboxRepo, base: selfBase, status: run?.status ?? `http ${started.status}`,
      contract: contract ? { revision: contract.revision, taskRunId: contract.taskRunId, sourceSha: contract.sourceSha } : null,
      output: run?.output?.slice(0, 1500), elapsedSeconds: Math.round((Date.now() - began) / 1000), baseBefore: before, rules,
      ...(run ? evidence(engine, runId) : {}), contractTests: tests ? { recorded: tests.recorded, passed: tests.passed, testsPassed: tests.testsPassed, commit: tests.commit } : null,
      finish: finish ? { merged: finish.merged, queued: finish.queued, reviewedHead: finish.reviewedHead, reviewerRunId: finish.reviewerRunId } : null,
      reviews: coder.state.reviews, verdicts, audit, record, baseNow: gh("api", `repos/${sandboxRepo}/git/ref/heads/${selfBase}`, "--jq", ".object.sha"),
      health: { checks: results.length, allOk: results.every((status) => status === 200) } };
  } finally {
    clearInterval(poller);
    await engine.close();
  }
  const record = summary.record;
  const passed = summary.status === "completed" && summary.asked?.length === 0 && (summary.tools ?? []).every((tool) => tool.ok)
    && summary.contractTests?.recorded === true && summary.contractTests.passed === true
    && summary.finish?.queued === true && summary.finish.reviewedHead === record?.headSha && summary.reviews === 1
    && summary.audit.some((entry) => entry.outcome === "queued") && !summary.audit.some((entry) => entry.outcome === "merged")
    && !!record?.merged && record.timeline.includes("ready_for_review") && record.timeline.includes("added_to_merge_queue")
    && summary.verdicts.at(-1)?.state === "merged" && summary.baseNow !== before && summary.health.allOk;
  await log({ step: "summary", passed, ...summary });
  await writeFile(join(root, "summary.json"), JSON.stringify({ passed, ...summary }, null, 2));
  return passed;
}
