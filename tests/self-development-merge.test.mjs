import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { createBranch, setLockdown } from "../dist/index.js";
import { SelfDevelopmentMerges } from "../dist/self-development-merge.js";
import { ContractBook } from "../dist/self-development-contract.js";
import { ToolRegistry } from "../dist/registry.js";
import { GitRunner } from "../dist/integrations/git-run.js";
import { registerGitHubProject } from "../dist/integrations/git-tools.js";
import { underTask } from "../dist/task-scope.js";
import { underShortLivedKey } from "../dist/key-context.js";
import { discardTemp } from "./temp-dir.mjs";

const repo = "owner/Branch-Agent", worktree = "branch-agent-source/.branch-worktrees/self-fix";
const git = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();
async function fixture(t, auto = false) {
  const scratch = join(tmpdir(), "Codex-session-files"); await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "selfdev-merge-")), workspace = join(root, "workspace"), dataDir = join(root, "data");
  const app = await createBranch({ workspace, dataDir, provider: { name: "scripted", complete: async () => ({ content: "done", toolCalls: [] }) } });
  t.after(async () => { await app.close(); await discardTemp(root); });
  const source = join(workspace, "branch-agent-source"), cwd = join(workspace, worktree);
  await mkdir(source, { recursive: true });
  git(source, "init", "-q", "-b", "redesign/window");
  await mkdir(join(source, "scripts"), { recursive: true });
  await writeFile(join(source, "scripts", "review.mjs"), "// Stand-in entry script; this fixture does not execute it.\n");
  await writeFile(join(source, "scripts", "build-ts.mjs"), "// Stand-in build script; this fixture does not execute it.\n");
  await writeFile(join(source, "package.json"), JSON.stringify({ scripts: { build: "node scripts/build-ts.mjs" } }));
  await writeFile(join(source, "README.md"), "before\n"); git(source, "add", "."); git(source, "commit", "-q", "-m", "base");
  const baseSha = git(source, "rev-parse", "HEAD");
  git(source, "worktree", "add", "-q", "-b", "branch/self-fix", cwd, baseSha);
  await writeFile(join(cwd, "README.md"), "after\n"); git(cwd, "add", "."); git(cwd, "commit", "-q", "-m", "change");
  const headSha = git(cwd, "rev-parse", "HEAD");
  const registry = new ToolRegistry(), runner = new GitRunner(), contracts = new ContractBook(app.store.sqlite);
  const terms = { allowedPaths: ["**"], permissions: ["shell.execute", ...(auto ? ["branch.finish_source_change"] : [])], expectedTests: ["tests/fixture.test.mjs"], definitionOfDone: "README improved", sideEffects: ["normal merge after owner review"], rollbackPlan: "Revert the merge" };
  contracts.create(app.runtime.owner, { taskRunId: "", sourceSha: baseSha, worktreePath: worktree, terms, sendRepositories: [repo] });
  const state = { locked: false, full: true, changed: false, ready: false, readyCalls: 0, calls: 0, beforeSend: null, beforeReady: null, review: null, output: "PASS  tests/fixture.test.mjs  0.1s  2/2 passed\nall steps passed in 1.0s\n" };
  const evidence = async () => ({ repo, number: 7, headSha, baseSha, base: "redesign/window", head: "branch/self-fix",
    requiredChecksVerified: true, rulesHash: state.changed ? "changed" : "original", required: [{ context: "tests", appId: 123 }], checks: { checks: [{ id: 1, name: "tests", status: "completed", result: "success" }] } });
  const fakeGitHub = { checks: async () => ({}), mergeReview: async () => {
    if (auto && !state.ready) throw new Error("Draft is not ready");
    return evidence();
  }, draftReview: async () => {
    if (!auto || state.ready) throw new Error("No matching draft");
    return evidence();
  }, readyReviewed: async (_pin, beforeSend) => { state.beforeReady?.(); beforeSend(); state.ready = true; state.readyCalls++; },
    mergeReviewed: async (_pin, beforeSend) => { state.beforeSend?.(); beforeSend(); state.calls++;
      return state.queue ? { merged: false, queued: true, state: "QUEUED", position: 1 } : { merged: true, sha: "d".repeat(40) }; } };
  registerGitHubProject(registry, fakeGitHub);
  // The command result and confinement guard are explicit stand-ins; repository/head/diff checks use real Git.
  registry.beforeTool = async () => ({ writesConfinedTo: cwd });
  registry.register({ name: "shell.execute", permission: "shell.execute", description: "stand-in review command", parameters: z.object({}).passthrough(),
    execute: async () => ({ status: "completed", exitCode: 0, truncated: false, stdout: state.output }) });
  const deps = { workspace, owner: app.runtime.owner, store: app.store, projects: app.store.projects, registry, contracts,
    policy: { assertAllowed: async () => {} }, git: (options, signal) => runner.run(options, signal) };
  const reviewer = async (_snapshot, context) => {
    const child = app.store.createRun(app.runtime.owner, "independent source review", undefined, false, "owner", "default");
    app.store.finish(child.id, "completed", "reviewed");
    state.review?.();
    return { runId: child.id, passed: true, findings: [] };
  };
  const merges = new SelfDevelopmentMerges(deps, () => state.locked, auto ? reviewer : undefined,
    auto ? () => state.full ? "owner (Full Access in fixture)" : null : undefined);
  merges.evidence.install();
  const command = { executable: "node", cwd: worktree, args: ["scripts/review.mjs", "--jobs", "1", "tests/fixture.test.mjs"] };
  const tested = async (overrides = {}, dryRun = false) => registry.execute("shell.execute", { ...command, ...overrides }, {
    owner: app.runtime.owner, runId: "fixture-run", workspace, source: "owner", dryRun, depth: 0,
    signal: AbortSignal.timeout(20_000), permissions: new Set(["shell.execute"]), budget: { step() {} },
  });
  const input = { worktree, repo, number: 7 };
  return { app, state, merges, tested, command, input, cwd, contracts, terms, headSha, baseSha, registry };
}

test("real isolated repository requires fresh exact command evidence, explicit owner approval and one merge attempt", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.merges.review(f.input), /confined command tool first/);
  await f.tested();
  const review = await f.merges.review(f.input);
  assert.equal(review.approved, false);
  assert.equal(review.github.headSha, f.headSha);
  assert.equal(review.tests.passed, 2);
  assert.equal(review.diff.files[0].path, "README.md");
  await assert.rejects(f.merges.merge({ id: review.id }), /explicitly approve/);
  assert.equal(f.state.calls, 0);
  assert.equal(f.merges.approve({ id: review.id }).approved, true);
  assert.equal((await f.merges.merge({ id: review.id })).merged, true);
  assert.equal(f.state.calls, 1);
  await assert.rejects(f.merges.merge({ id: review.id }), /already used/);
});

test("wrong command, practice, failed or skipped tests cannot create evidence", async (t) => {
  const f = await fixture(t);
  for (const [overrides, dryRun] of [[{ args: ["-e", "console.log('passed')"] }, false], [{}, true], [{ cwd: "." }, false]]) {
    await f.tested(overrides, dryRun);
    assert.equal(f.merges.evidence.get(worktree), null);
  }
  for (const output of ["PASS  tests/fixture.test.mjs  2/3 passed\nall steps passed in 1s", "PASS  tests/fixture.test.mjs  2/2 passed, 1 skipped\nall steps passed in 1s", "unverified model claims"]) {
    f.state.output = output; await f.tested();
    assert.equal(f.merges.evidence.get(worktree), null);
  }
});

test("changed rules, changed head, changed contract or uncommitted edits invalidate review", async (t) => {
  for (const change of [
    async (f) => { f.state.changed = true; },
    async (f) => { await writeFile(join(f.cwd, "README.md"), "new version\n"); git(f.cwd, "add", "."); git(f.cwd, "commit", "-q", "-m", "later"); },
    async (f) => { f.contracts.widen(f.app.runtime.owner, worktree, { taskRunId: "", terms: { definitionOfDone: "wider" }, approvedBy: f.app.runtime.owner, reason: "fixture" }); },
    async (f) => { await writeFile(join(f.cwd, "README.md"), "dirty\n"); },
  ]) {
    const f = await fixture(t); await f.tested(); const review = await f.merges.review(f.input); f.merges.approve({ id: review.id });
    await change(f); await assert.rejects(f.merges.merge({ id: review.id }));
    assert.equal(f.state.calls, 0);
  }
});

test("tasks, keys, Lockdown, App lock and a state change immediately before send refuse", async (t) => {
  const f = await fixture(t); await f.tested();
  await assert.rejects(underTask("model-task", () => f.merges.review(f.input)), /tasks and keys cannot/);
  await assert.rejects(underShortLivedKey(() => f.merges.review(f.input)), /tasks and keys cannot/);
  setLockdown(f.app.store, f.app.runtime.owner, { on: true });
  await assert.rejects(f.merges.review(f.input), /Lockdown/);
  setLockdown(f.app.store, f.app.runtime.owner, { on: false });
  f.state.locked = true; await assert.rejects(f.merges.review(f.input), /Unlock Branch/); f.state.locked = false;
  const review = await f.merges.review(f.input); f.merges.approve({ id: review.id });
  f.state.beforeSend = () => { f.state.locked = true; };
  await assert.rejects(f.merges.merge({ id: review.id }), /Unlock Branch/);
  assert.equal(f.state.calls, 0);
});

test("only an active task in this exact worktree blocks owner review; unrelated chat work continues", async (t) => {
  const f = await fixture(t); await f.tested();
  const owner = f.app.runtime.owner;
  const unrelated = f.app.store.createRun(owner, "unrelated chat", undefined, false, "owner", "default");
  assert.ok((await f.merges.review(f.input)).id);
  f.app.store.projects.save(owner, { id: "source-fix", name: "Source fix", folder: worktree, repository: repo });
  const editing = f.app.store.createRun(owner, "editing source", undefined, false, "owner", "source-fix");
  await assert.rejects(f.merges.review(f.input), (error) => error.message.includes(editing.id) && error.message.includes(worktree));
  assert.equal(f.app.store.run(unrelated.id).status, "running");
  f.app.store.finish(editing.id, "completed", "Ready for owner review");
  assert.ok((await f.merges.review(f.input)).id);
  f.app.store.finish(unrelated.id, "completed", "done");
});

test("a modified review/build entry or package script cannot certify itself", async (t) => {
  for (const path of ["scripts/review.mjs", "scripts/build-ts.mjs", "package.json"]) {
    const f = await fixture(t);
    await writeFile(join(f.cwd, path), path === "package.json" ? JSON.stringify({ scripts: { build: "node -e fake" } }) : "// fake PASS summary\n");
    git(f.cwd, "add", "."); git(f.cwd, "commit", "-q", "-m", "replace runner");
    await assert.rejects(f.tested(), /runner evidence needs independent review/);
    assert.equal(f.merges.evidence.get(worktree), null);
  }
});

test("expired grants and concurrent duplicate merge attempts cannot send another merge", async (t) => {
  const f = await fixture(t); await f.tested();
  let review = await f.merges.review(f.input); f.merges.approve({ id: review.id });
  const now = Date.now;
  try {
    Date.now = () => now() + 600_001;
    await assert.rejects(f.merges.merge({ id: review.id }), /expired/);
    assert.equal(f.state.calls, 0);
  } finally { Date.now = now; }
  review = await f.merges.review(f.input); f.merges.approve({ id: review.id });
  const results = await Promise.allSettled([f.merges.merge({ id: review.id }), f.merges.merge({ id: review.id })]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(f.state.calls, 1);
});

async function autoTask(t) {
  const f = await fixture(t, true); await f.tested();
  const owner = f.app.runtime.owner;
  f.app.store.projects.save(owner, { id: "source-fix", name: "Source fix", folder: worktree, repository: repo });
  const run = f.app.store.createRun(owner, "finish Branch source fix", undefined, false, "owner", "source-fix");
  const context = { owner, runId: run.id, workspace: f.app.runtime.workspace, source: "owner", depth: 0,
    signal: AbortSignal.timeout(30_000), permissions: new Set(["git.remote"]), budget: { step() {} } };
  return { ...f, run, context, finish: () => underTask(run.id, () => f.merges.autoFinish(f.input, context)) };
}

test("owner Full Access task gets independent review and exact protected normal merge", async (t) => {
  const f = await autoTask(t);
  const result = await f.finish();
  assert.equal(result.merged, true);
  assert.equal(result.reviewedHead, f.headSha);
  assert.ok(f.app.store.run(result.reviewerRunId));
  assert.equal(f.state.readyCalls, 1);
  assert.equal(f.state.calls, 1);
  await assert.rejects(f.finish(), /No matching draft/);
  assert.equal(f.state.calls, 1);
});

test("automatic finish refuses lost Full Access, stale review and late locks", async (t) => {
  for (const change of [
    (f) => { f.state.full = false; },
    (f) => { f.state.review = () => { f.state.changed = true; }; },
    (f) => { f.state.beforeReady = () => { f.state.full = false; }; },
    (f) => { f.state.beforeSend = () => { f.state.locked = true; }; },
  ]) {
    const f = await autoTask(t); change(f);
    await assert.rejects(f.finish());
    assert.equal(f.state.calls, 0, "no normal merge follows lost authority or changed evidence");
    if (f.state.changed || !f.state.full) assert.equal(f.state.readyCalls, 0);
  }
});

test("SELF-025: on a merge-queue base, the owner's merge and the Full Access finish join the queue and say so", async (t) => {
  const f = await fixture(t); await f.tested();
  f.state.queue = true;
  const review = await f.merges.review(f.input); f.merges.approve({ id: review.id });
  const sent = await f.merges.merge({ id: review.id });
  assert.deepEqual([sent.merged, sent.queued, sent.reviewedHead], [false, true, f.headSha]);
  const owner = f.app.store.audit.list(f.app.runtime.owner, { action: "self_development.merge", limit: 10 }).map((entry) => entry.outcome);
  assert.ok(owner.includes("queued") && !owner.includes("merged"), `a queued change is never written down as merged: ${owner}`);
  const auto = await autoTask(t);
  auto.state.queue = true;
  const finished = await auto.finish();
  assert.deepEqual([finished.merged, finished.queued], [false, true]);
  assert.match(finished.note, /until it says merged/);
  const entry = auto.app.store.audit.list(auto.app.runtime.owner, { action: "self_development.merge", limit: 10 })[0];
  assert.equal(entry.outcome, "queued");
  assert.match(entry.reason, /joined the base's merge queue/);
});

test("SELF-014: the contract's tests run as evidence needs them, and a failed run is recorded with why, never as evidence", async (t) => {
  const { runContractTests } = await import("../dist/self-development-tests.js");
  const f = await fixture(t);
  const sent = [];
  const call = (name, args, context) => { sent.push(args); return f.registry.execute(name, args, context); };
  const context = { owner: f.app.runtime.owner, runId: "fixture-run", workspace: f.app.runtime.workspace, source: "owner", depth: 0,
    signal: AbortSignal.timeout(20_000), permissions: new Set(["shell.execute"]), budget: { step() {} } };
  const green = await runContractTests(f.contracts, f.merges, call, f.app.runtime.owner, worktree, context);
  assert.deepEqual(sent[0], f.command, "exactly the command evidence counts");
  assert.deepEqual([green.recorded, green.passed, green.testsPassed, green.commit], [true, true, 2, f.headSha]);
  assert.equal(f.merges.evidence.get(worktree).sha, f.headSha);
  f.state.output = "FAIL  tests/fixture.test.mjs  0.1s  1/2 passed\n✖ fixture adds\n";
  const red = await runContractTests(f.contracts, f.merges, call, f.app.runtime.owner, worktree, context);
  assert.deepEqual([red.recorded, red.passed], [true, false]);
  assert.match(red.reason, /Not every step passed/);
  assert.deepEqual(red.failing, ["FAIL  tests/fixture.test.mjs  0.1s  1/2 passed", "✖ fixture adds"]);
  assert.equal(f.merges.evidence.get(worktree), null, "a failed run is never evidence, and the earlier pass no longer counts");
  f.state.output = "PASS  tests/fixture.test.mjs  0.1s  2/2 passed\nall steps passed in 1.0s\n";
  for (const other of [{ ...context, source: "channel" }, { ...context, source: "schedule" }]) {
    const outside = await runContractTests(f.contracts, f.merges, call, f.app.runtime.owner, worktree, other);
    assert.equal(outside.recorded, false, `a ${other.source} task never records evidence`);
  }
  const unnamed = { ...context }; delete unnamed.source;
  assert.equal((await runContractTests(f.contracts, f.merges, call, f.app.runtime.owner, worktree, unnamed)).passed, true,
    "the owner's own task in the app names no source, and counts");
  await writeFile(join(f.cwd, "README.md"), "uncommitted\n");
  await assert.rejects(runContractTests(f.contracts, f.merges, call, f.app.runtime.owner, worktree, context), /Commit all changes/);
  await assert.rejects(runContractTests(f.contracts, f.merges, call, f.app.runtime.owner, "branch-agent-source/.branch-worktrees/self-none", context), /no self-development contract/);
});

test("SELF-014: passed tests survive an engine restart, for the exact commit and contract they name", async (t) => {
  const { SelfDevelopmentEvidence } = await import("../dist/self-development-evidence.js");
  const f = await fixture(t); await f.tested();
  const kept = f.merges.evidence.get(worktree);
  assert.equal(kept.sha, f.headSha);
  // A new engine on the same data reads what the old one wrote.
  const restarted = new SelfDevelopmentEvidence({ store: f.app.store, owner: f.app.runtime.owner, workspace: f.app.runtime.workspace });
  assert.deepEqual(restarted.get(worktree), kept);
  assert.equal(restarted.lastRun(worktree).passed, true);
  const review = await f.merges.review(f.input);
  assert.equal(review.tests.sha, f.headSha, "owner review needs no second test run after a restart");
});

test("the old repository name is asked for as KeepOak/Branch-Agent: GitHub only redirects it, and Branch refuses redirects", async () => {
  const { canonicalRepo, officialRepo } = await import("../dist/desktop/repo-pair.js");
  assert.equal(officialRepo("stabrea/Branch-Agent"), "KeepOak/Branch-Agent");
  assert.equal(officialRepo("stabrea/branch-agent"), "KeepOak/Branch-Agent");
  assert.equal(officialRepo("alice/Branch-Agent"), "alice/Branch-Agent", "a fork keeps its own name");
  assert.equal(canonicalRepo("KeepOak/Branch-Agent"), canonicalRepo("stabrea/Branch-Agent"));
  assert.notEqual(canonicalRepo("alice/Branch-Agent"), canonicalRepo("KeepOak/Branch-Agent"));
});

test("SELF-102: a test copy is a detached checkout of the exact reviewed commit with its own data, and a changed copy runs nothing", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.cwd, "README.md"), "uncommitted\n");
  await assert.rejects(f.merges.testCopy({ worktree }), /.+/);
  git(f.cwd, "checkout", "--", "README.md");
  const copy = await f.merges.testCopy({ worktree });
  assert.equal(copy.sha, f.headSha);
  assert.equal(git(copy.folder, "rev-parse", "HEAD"), f.headSha);
  assert.equal(git(copy.folder, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD", "detached, not on the change's branch");
  assert.deepEqual([copy.tested, copy.launched], [false, false]);
  assert.notEqual(copy.dataDirectory, f.app.store.dataDir);
  await writeFile(join(copy.folder, "README.md"), "edited in the copy\n");
  await assert.rejects(f.merges.testCopyJob("start", { id: copy.id, mode: "tests" }), /copy changed/);
});
