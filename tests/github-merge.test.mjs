import test from "node:test";
import assert from "node:assert/strict";
import { GitHubAccess } from "../dist/integrations/github.js";
import { ChecksPending } from "../dist/integrations/github-merge.js";

const head = "a".repeat(40), base = "b".repeat(40), moved = "c".repeat(40);
const repo = "owner/Branch-Agent", branch = "redesign/window";
const pull = () => ({ number: 7, node_id: "PR_test123", state: "open", draft: false, merged: false, mergeable: true, mergeable_state: "clean",
  head: { sha: head, ref: "branch/self-fix", repo: { full_name: repo } }, base: { sha: base, ref: branch, repo: { full_name: repo } } });
// The real repository today: classic protection with one required check, and no admin enforcement or strict update.
const protection = () => ({ enforce_admins: { enabled: false }, required_status_checks: { strict: false, contexts: ["tests"], checks: [{ context: "tests", app_id: 123 }] } });
const runs = () => ({ total_count: 2, workflow_runs: [
  { id: 11, workflow_id: 1, name: "Checks", event: "pull_request", head_sha: head, status: "completed", conclusion: "success", run_number: 4, run_attempt: 1 },
  { id: 12, workflow_id: 2, name: "PR Fast Checks", event: "pull_request", head_sha: head, status: "completed", conclusion: "success", run_number: 9, run_attempt: 1 },
] });
function fixture({ changePull, changeProtection, rules = [], changeCheck, changeBranch, changeCompare, changeRuns, tokenHook, status = 200,
  draft = false, readyResponse, unprotected = false, enqueueResponse, timeline = [], pullRepo = repo, networkFault } = {}) {
  const calls = [], seen = { pulls: 0, branches: 0, ready: false };
  const fetchImpl = async (address, init) => {
    const url = new URL(address), path = decodeURIComponent(url.pathname);
    calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    networkFault?.(path);
    let answer;
    if (init.method === "PUT") answer = { merged: true, sha: moved };
    else if (path.endsWith("/graphql") && JSON.parse(init.body).query.includes("enqueuePullRequest"))
      answer = enqueueResponse ?? { data: { enqueuePullRequest: { mergeQueueEntry: { state: "QUEUED", position: 1, pullRequest: { number: 7, headRefOid: head } } } } };
    else if (path.endsWith("/graphql")) {
      answer = readyResponse ?? { data: { markPullRequestReadyForReview: { pullRequest: { id: "PR_test123", isDraft: false, headRefOid: head, baseRefOid: base } } } };
      seen.ready = true;
    }
    else if (path.endsWith("/issues/7/timeline")) answer = timeline.map((event) => ({ event }));
    else if (path.endsWith("/pulls/7")) {
      answer = pull(); answer.draft = draft && !seen.ready;
      if (pullRepo !== repo) { answer.head.repo.full_name = pullRepo; answer.base.repo.full_name = pullRepo; answer.head.ref = "add-knob"; }
      changePull?.(answer, ++seen.pulls);
    }
    else if (path.endsWith("/actions/runs")) { answer = runs(); changeRuns?.(answer); }
    else if (path.endsWith("/protection")) { answer = protection(); changeProtection?.(answer); }
    else if (path.includes("/rules/branches/")) answer = rules;
    else if (path.includes("/branches/")) { answer = { protected: !unprotected, commit: { sha: base } }; changeBranch?.(answer, ++seen.branches); }
    else if (path.includes("/compare/")) { answer = { status: "ahead", behind_by: 0, base_commit: { sha: base } }; changeCompare?.(answer); }
    else if (path.endsWith("/check-runs")) {
      answer = { total_count: 2, check_runs: [{ id: 1, head_sha: head, name: "tests", app: { id: 123 }, status: "completed", conclusion: "success" },
        { id: 2, head_sha: head, name: "promote", app: { id: 123 }, status: "completed", conclusion: "skipped" }] };
      changeCheck?.(answer);
    }
    else if (path.endsWith("/status")) answer = { sha: head, total_count: 0, statuses: [] };
    else if (path.endsWith(`/commits/${head}`)) answer = { sha: head };
    else throw new Error(`Unexpected route ${path}`);
    assert.equal(init.headers.authorization, "Bearer test-token");
    return new Response(JSON.stringify(answer), { status });
  };
  const github = new GitHubAccess({ checksPollSeconds: 1 }, { assertAllowed: async () => {} }, async () => { tokenHook?.(); return "test-token"; }, fetchImpl);
  return { github, calls };
}
const refused = /cannot merge/;
const waiting = (error) => error instanceof ChecksPending && /Not ready to merge yet/.test(error.message);

test("normal merge verifies every check itself, pins the exact head and needs no admin enforcement", async () => {
  const f = fixture();
  const evidence = await f.github.mergeReview(repo, 7);
  assert.equal(evidence.requiredChecksVerified, true);
  assert.deepEqual(evidence.required, [{ context: "tests", appId: 123 }]);
  assert.deepEqual(evidence.workflows.map((run) => run.name).sort(), ["Checks", "PR Fast Checks"]);
  let rechecked = false;
  assert.deepEqual(await f.github.mergeReviewed(evidence, () => { rechecked = true; }), { merged: true, sha: moved });
  assert.equal(rechecked, true);
  assert.deepEqual(f.calls.filter((call) => call.method === "PUT"), [{ path: `/repos/${repo}/pulls/7/merge`, method: "PUT", body: { sha: head, merge_method: "merge" } }]);
});

test("an unprotected scratch base merges on its observed checks alone", async () => {
  const f = fixture({ unprotected: true });
  const evidence = await f.github.mergeReview(repo, 7);
  assert.deepEqual(evidence.required, []);
  assert.equal(f.calls.some((call) => call.path.endsWith("/protection")), false);
});

test("a protected exact-head draft becomes ready through one fixed GraphQL mutation after review", async () => {
  const f = fixture({ draft: true });
  const checked = await f.github.draftReview(repo, 7);
  assert.equal(checked.requiredChecksVerified, true);
  let checkedAuthority = 0;
  await f.github.readyReviewed(checked, () => { checkedAuthority++; });
  assert.ok(checkedAuthority >= 2, "identity is rechecked after each authenticated network await");
  assert.deepEqual(f.calls.filter((call) => call.path === "/graphql"), [{ path: "/graphql", method: "POST",
    body: { query: "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft headRefOid baseRefOid}}}", variables: { id: "PR_test123" } } }]);
  assert.equal((await f.github.mergeReview(repo, 7)).headSha, head, "normal merge checks the ready state afresh");
});

test("draft conversion refuses changed pin, false GraphQL evidence and revoked authority", async () => {
  const movedPin = fixture({ draft: true, changePull: (row, n) => { if (n > 2) row.head.sha = moved; } });
  const before = await movedPin.github.draftReview(repo, 7);
  await assert.rejects(movedPin.github.readyReviewed(before, () => {}), /draft or its exact head/);
  assert.equal(movedPin.calls.some((call) => call.path === "/graphql"), false);
  for (const readyResponse of [{ errors: [{ message: "denied" }] },
    { data: { markPullRequestReadyForReview: { pullRequest: { id: "PR_test123", isDraft: false, headRefOid: moved, baseRefOid: base } } } }]) {
    const f = fixture({ draft: true, readyResponse });
    await assert.rejects(f.github.readyReviewed(await f.github.draftReview(repo, 7), () => {}), /did not confirm/);
    assert.equal(f.calls.some((call) => call.method === "PUT"), false);
  }
  const revoked = fixture({ draft: true });
  await assert.rejects(revoked.github.readyReviewed(await revoked.github.draftReview(repo, 7), () => { throw new Error("lock changed"); }), /lock changed/);
  assert.equal(revoked.calls.some((call) => call.path === "/graphql"), false);
});

test("queued, running, not-yet-reported or partly registered checks are pending, never passed", async () => {
  for (const change of [
    { changeCheck: (a) => { a.check_runs[0].status = "in_progress"; a.check_runs[0].conclusion = null; } },
    { changeCheck: (a) => { a.check_runs[0].status = "queued"; a.check_runs[0].conclusion = null; } },
    { changeCheck: (a) => { a.total_count = 0; a.check_runs = []; } },
    // The fast workflow finished while the slow one exists but has not reported a check yet.
    { changeCheck: (a) => { a.check_runs = [{ ...a.check_runs[1], id: 3, name: "verify-fast", conclusion: "success" }]; a.total_count = 1; } },
    { changeRuns: (r) => { r.workflow_runs[0].status = "queued"; r.workflow_runs[0].conclusion = null; } },
    { changeRuns: (r) => { r.workflow_runs[1].status = "in_progress"; r.workflow_runs[1].conclusion = null; } },
    { changePull: (p) => { p.mergeable = null; p.mergeable_state = "unknown"; } },
    { changeCheck: (a) => { a.total_count = 3; } },
    // The required check's name from another app is not the required check.
    { changeCheck: (a) => { a.check_runs[0].app.id = 999; } },
  ]) {
    const f = fixture(change);
    await assert.rejects(f.github.mergeReview(repo, 7), waiting);
    assert.equal(f.calls.some((c) => c.method === "PUT"), false);
  }
});

test("a failed or cancelled check or run refuses; skipped and neutral are fine, required or not, as GitHub counts them", async () => {
  for (const change of [
    { changeCheck: (a) => { a.check_runs[0].conclusion = "failure"; } },
    { changeCheck: (a) => { a.check_runs[1].conclusion = "cancelled"; } },
    { changeRuns: (r) => { r.workflow_runs[0].conclusion = "failure"; } },
    { changeRuns: (r) => { r.workflow_runs[0].head_sha = moved; } },
    { changeRuns: (r) => { r.total_count = 3; } },
  ]) await assert.rejects(fixture(change).github.mergeReview(repo, 7), (error) => !(error instanceof ChecksPending) && refused.test(error.message));
  const neutral = fixture({ changeCheck: (a) => { a.check_runs[1].conclusion = "neutral"; } });
  assert.equal((await neutral.github.mergeReview(repo, 7)).headSha, head);
  // The required "tests" check skipped (a job whose `if` was false), with another check passing: GitHub counts it as met.
  const skippedRequired = fixture({ changeCheck: (a) => { a.check_runs[0].conclusion = "skipped";
    a.check_runs.push({ id: 3, head_sha: head, name: "lint", app: { id: 123 }, status: "completed", conclusion: "success" }); a.total_count = 3; } });
  assert.equal((await skippedRequired.github.mergeReview(repo, 7)).headSha, head);
  // A rerun: the newest attempt of a workflow decides, not an older failed one.
  const rerun = fixture({ changeRuns: (r) => { r.total_count = 3; r.workflow_runs.push({ ...r.workflow_runs[0], id: 10, conclusion: "failure", run_attempt: 0 }); } });
  assert.equal((await rerun.github.mergeReview(repo, 7)).headSha, head);
});

test("required reviews and unknown rules are left to GitHub; required ruleset checks are verified", async () => {
  await assert.rejects(fixture({ changeProtection: (p) => { p.required_pull_request_reviews = { required_approving_review_count: 1 }; } }).github.mergeReview(repo, 7), /approving review/);
  const rule = { type: "required_status_checks", ruleset_id: 9, parameters: { required_status_checks: [{ context: "tests", integration_id: 123 }] } };
  assert.equal((await fixture({ rules: [rule, { type: "deletion" }, { type: "non_fast_forward" }] }).github.mergeReview(repo, 7)).requiredChecksVerified, true);
  for (const rules of [[{ type: "pull_request", parameters: { required_approving_review_count: 2 } }], [{ type: "required_linear_history" }]])
    await assert.rejects(fixture({ rules }).github.mergeReview(repo, 7), refused);
  await assert.rejects(fixture({ rules: [{ ...rule, parameters: { required_status_checks: [{ context: "tests", integration_id: 999 }] } }] }).github.mergeReview(repo, 7),
    waiting, "a required check from another app is still awaited");
  const missing = fixture({ rules: [{ ...rule, parameters: { required_status_checks: [{ context: "e2e", integration_id: 123 }] } }] });
  await assert.rejects(missing.github.mergeReview(repo, 7), waiting, "a required check that has not reported yet is pending");
});

test("forks, drafts, blocked PRs and stale head or base refs refuse", async () => {
  for (const changePull of [
    (p) => { p.head.repo.full_name = "attacker/Branch-Agent"; }, (p) => { p.base.repo.full_name = "attacker/Branch-Agent"; },
    (p) => { p.draft = true; }, (p) => { p.mergeable_state = "dirty"; p.mergeable = false; },
    (p) => { p.state = "closed"; }, (p, n) => { if (n > 1) p.head.sha = moved; }, (p, n) => { if (n > 1) p.base.sha = moved; },
    (p) => { p.head.ref = "main"; },
  ]) await assert.rejects(fixture({ changePull }).github.mergeReview(repo, 7), refused);
  await assert.rejects(fixture({ changeBranch: (b, n) => { if (n > 1) b.commit.sha = moved; } }).github.mergeReview(repo, 7), refused);
  await assert.rejects(fixture({ changeCompare: (c) => { c.behind_by = 1; c.status = "diverged"; } }).github.mergeReview(repo, 7), /exact base/);
});

test("state checked after token/policy awaits can stop PUT before it leaves", async () => {
  const f = fixture();
  const evidence = await f.github.mergeReview(repo, 7);
  await assert.rejects(f.github.mergeReviewed(evidence, () => { throw new Error("Lockdown became active"); }), /Lockdown became active/);
  assert.equal(f.calls.some((call) => call.method === "PUT"), false);
  for (const status of [401, 403, 404]) await assert.rejects(fixture({ status }).github.mergeReview(repo, 7));
});

test("waiting reports pending while checks run, then passed; the ordinary merge tool refuses Branch's own source", async () => {
  let polls = 0;
  const f = fixture({ changeCheck: (a) => { if (++polls < 3) { a.check_runs[0].status = "in_progress"; a.check_runs[0].conclusion = null; } } });
  const slept = [];
  const verdict = await f.github.waitForChecks({ repo, number: 7, seconds: 60 }, AbortSignal.timeout(5000), async (ms) => { slept.push(ms); });
  assert.equal(verdict.state, "passed");
  assert.equal(verdict.headSha, head);
  assert.equal(slept.length, 2, "it looked again while checks were still running");
  const quick = fixture({ changeCheck: (a) => { a.check_runs[0].status = "queued"; a.check_runs[0].conclusion = null; } });
  assert.equal((await quick.github.waitForChecks({ repo, number: 7, seconds: 0 }, AbortSignal.timeout(5000))).state, "pending");
  const red = fixture({ changeCheck: (a) => { a.check_runs[0].conclusion = "failure"; } });
  assert.equal((await red.github.waitForChecks({ repo, number: 7, seconds: 60 }, AbortSignal.timeout(5000))).state, "failed");
  await assert.rejects(fixture().github.mergeChecked(repo, 7), /branch\.finish_source_change/);
  assert.equal(f.calls.some((call) => call.method === "PUT"), false);
});

// SELF-025: KeepOak/Branch-Agent's redesign/window (and the sandbox) take changes only through GitHub's merge queue. A
// direct merge there is refused by GitHub ("Changes must be made through the merge queue", HTTP 405), so the checked head
// joins the queue, pinned to that exact commit, and waiting reports pending until GitHub itself says merged.
const queueRules = [{ type: "merge_queue", parameters: { merge_method: "MERGE", grouping_strategy: "ALLGREEN" } },
  { type: "required_status_checks", parameters: { required_status_checks: [{ context: "tests", integration_id: 123 }] } }];
const enqueueCalls = (calls) => calls.filter((call) => call.path === "/graphql" && call.body.query.includes("enqueuePullRequest"));

test("a merge-queue base: the exact checked head joins the queue, with no direct merge", async () => {
  const f = fixture({ rules: queueRules });
  const evidence = await f.github.mergeReview(repo, 7);
  assert.equal(evidence.mergeQueue, true);
  assert.ok(evidence.required.some((need) => need.context === "tests" && need.appId === 123), "the required check is still verified first");
  let rechecked = 0;
  assert.deepEqual(await f.github.mergeReviewed(evidence, () => { rechecked++; }), { merged: false, queued: true, state: "QUEUED", position: 1 });
  assert.ok(rechecked >= 2, "authority is checked again before each request leaves");
  assert.equal(f.calls.some((call) => call.method === "PUT"), false, "never a direct merge on a queue base");
  const [sent] = enqueueCalls(f.calls);
  assert.deepEqual(sent.body.variables, { id: "PR_test123", oid: head }, "pinned to the checked head with expectedHeadOid");
  assert.match(sent.body.query, /expectedHeadOid:\$oid/);
  // Without a queue the same call is still one normal merge.
  const plain = fixture();
  assert.deepEqual(await plain.github.mergeReviewed(await plain.github.mergeReview(repo, 7), () => {}), { merged: true, sha: moved });
  assert.equal(enqueueCalls(plain.calls).length, 0);
});

test("joining the queue refuses a moved head, a revoked authority and an answer that names another commit", async () => {
  const movedHead = fixture({ rules: queueRules, changePull: (row, n) => { if (n > 2) row.head.sha = moved; } });
  await assert.rejects(movedHead.github.mergeReviewed(await movedHead.github.mergeReview(repo, 7), () => {}), /changed before it joined the merge queue/);
  assert.equal(enqueueCalls(movedHead.calls).length, 0);
  for (const enqueueResponse of [{ errors: [{ message: "Pull request is not mergeable" }] },
    { data: { enqueuePullRequest: { mergeQueueEntry: { state: "QUEUED", position: 1, pullRequest: { number: 7, headRefOid: moved } } } } },
    { data: { enqueuePullRequest: { mergeQueueEntry: null } } }]) {
    const f = fixture({ rules: queueRules, enqueueResponse });
    await assert.rejects(f.github.mergeReviewed(await f.github.mergeReview(repo, 7), () => {}), /did not confirm this exact commit joined the merge queue/);
  }
  const revoked = fixture({ rules: queueRules });
  const evidence = await revoked.github.mergeReview(repo, 7);
  await assert.rejects(revoked.github.mergeReviewed(evidence, () => { throw new Error("Lockdown became active"); }), /Lockdown/);
  assert.equal(enqueueCalls(revoked.calls).length, 0);
});

test("an ordinary project's merge tool joins the queue and says it is not merged yet", async () => {
  const sandbox = "KeepOak/branch-selfdev-sandbox";
  const f = fixture({ rules: queueRules, pullRepo: sandbox });
  const result = await f.github.mergeChecked(sandbox, 7);
  assert.equal(result.merged, false);
  assert.equal(result.queued, true);
  assert.equal(result.headSha, head);
  assert.match(result.note, /wait with github\.wait_for_checks until it says merged/);
  assert.equal(f.calls.some((call) => call.method === "PUT"), false);
});

test("waiting on a queued pull request is pending, a queue that dropped it is failed, and only GitHub's merged is merged", async () => {
  const wait = (f) => f.github.waitForChecks({ repo, number: 7, seconds: 0 }, AbortSignal.timeout(5000));
  const queued = await wait(fixture({ rules: queueRules, timeline: ["committed", "added_to_merge_queue"] }));
  assert.equal(queued.state, "pending");
  assert.equal(queued.queued, true);
  const dropped = await wait(fixture({ rules: queueRules, timeline: ["committed", "added_to_merge_queue", "removed_from_merge_queue"] }));
  assert.equal(dropped.state, "failed");
  assert.match(dropped.summary, /took it out without merging/);
  // A new commit after the queue dropped it is judged afresh on its own checks.
  const pushedAgain = await wait(fixture({ rules: queueRules, timeline: ["added_to_merge_queue", "removed_from_merge_queue", "committed"] }));
  assert.equal(pushedAgain.state, "passed");
  assert.match(pushedAgain.summary, /merge queue: merging adds it to the queue/);
  const merged = await wait(fixture({ rules: queueRules, changePull: (row) => { row.merged = true; row.state = "closed"; row.merge_commit_sha = moved; } }));
  assert.deepEqual([merged.state, merged.mergeSha], ["merged", moved]);
});

test("SELF-022: 'blocked' while a required check runs is pending, never a refusal; blocked after every check passed is still pending", async () => {
  // Seen on the sandbox (pull request #2): GitHub says "blocked" while the required `test` check is still queued.
  const running = fixture({ changePull: (p) => { p.mergeable_state = "blocked"; },
    changeCheck: (a) => { a.check_runs[0].status = "queued"; a.check_runs[0].conclusion = null; } });
  await assert.rejects(running.github.mergeReview(repo, 7), (error) => waiting(error) && /still running/.test(error.message));
  const verdict = await running.github.waitForChecks({ repo, number: 7, seconds: 0 }, AbortSignal.timeout(5000));
  assert.equal(verdict.state, "pending", verdict.summary);
  const stale = fixture({ changePull: (p) => { p.mergeable_state = "blocked"; } });
  await assert.rejects(stale.github.mergeReview(repo, 7), (error) => waiting(error) && /still says the pull request is blocked/.test(error.message));
  const red = fixture({ changePull: (p) => { p.mergeable_state = "blocked"; }, changeCheck: (a) => { a.check_runs[0].conclusion = "failure"; } });
  await assert.rejects(red.github.mergeReview(repo, 7), (error) => !(error instanceof ChecksPending) && refused.test(error.message));
});

test("a merge-queue base lets a head behind its base join the queue, which tests it on the newest base itself", async () => {
  const behind = (c) => { c.status = "diverged"; c.behind_by = 3; };
  assert.equal((await fixture({ rules: queueRules, changeCompare: behind }).github.mergeReview(repo, 7)).mergeQueue, true);
  await assert.rejects(fixture({ changeCompare: behind }).github.mergeReview(repo, 7), /exact base/, "without a queue the head must contain the base");
});

test("a base guarded only by rulesets has no classic protection to read, and its ruleset's required check still counts", async () => {
  // Seen on the sandbox (pull request #3): GitHub says the branch is protected, and /protection answers 404 "Branch not protected".
  const f = fixture({ rules: queueRules, changeBranch: (b) => { b.protection = { enabled: false, required_status_checks: { contexts: [], checks: [] } }; },
    changeProtection: () => { throw new Error("classic protection must not be read for a ruleset-only base"); } });
  const evidence = await f.github.mergeReview(repo, 7);
  assert.deepEqual(evidence.required, [{ context: "tests", appId: 123 }]);
  assert.equal(f.calls.some((call) => call.path.endsWith("/protection")), false);
  const missing = fixture({ rules: [{ ...queueRules[1], parameters: { required_status_checks: [{ context: "e2e", integration_id: 123 }] } }],
    changeBranch: (b) => { b.protection = { enabled: false }; } });
  await assert.rejects(missing.github.mergeReview(repo, 7), waiting, "the ruleset's own required check is awaited");
});

test("on a busy merge-queue base another change landing meanwhile does not refuse; the head stays pinned exactly", async () => {
  // redesign/window moves every few minutes, and a pull request's base.sha is only refreshed when the pull request changes.
  const landed = fixture({ rules: queueRules, changeBranch: (b) => { b.commit.sha = moved; } });
  const evidence = await landed.github.mergeReview(repo, 7);
  assert.equal(evidence.mergeQueue, true);
  assert.deepEqual(await landed.github.mergeReviewed(evidence, () => {}), { merged: false, queued: true, state: "QUEUED", position: 1 });
  const midway = fixture({ rules: queueRules, changeBranch: (b, n) => { if (n > 1) b.commit.sha = moved; }, changePull: (p, n) => { if (n > 2) p.base.sha = moved; } });
  const pinned = await midway.github.mergeReview(repo, 7);
  assert.equal((await midway.github.mergeReviewed(pinned, () => {})).queued, true, "a base refreshed while it was read is not a moved head");
  const pushed = fixture({ rules: queueRules, changePull: (p, n) => { if (n > 1) p.head.sha = moved; } });
  await assert.rejects(pushed.github.mergeReview(repo, 7), /head or base moved/, "a head pushed while checks were read still refuses");
  await assert.rejects(fixture({ changeBranch: (b) => { b.commit.sha = moved; } }).github.mergeReview(repo, 7), /base branch moved/,
    "without a queue the tested head must still sit on the exact base");
});

test("a pull-request rule that needs a person (code owner, approval after the last push, resolved threads) refuses up front", async () => {
  const zero = { required_approving_review_count: 0, require_code_owner_review: false, require_last_push_approval: false, required_review_thread_resolution: false };
  assert.equal((await fixture({ rules: [{ type: "pull_request", parameters: zero }, ...queueRules] }).github.mergeReview(repo, 7)).mergeQueue, true);
  for (const needs of ["require_code_owner_review", "require_last_push_approval", "required_review_thread_resolution"])
    await assert.rejects(fixture({ rules: [{ type: "pull_request", parameters: { ...zero, [needs]: true } }] }).github.mergeReview(repo, 7),
      (error) => !(error instanceof ChecksPending) && /pull_request rule needs review on GitHub/.test(error.message), needs);
});

test("a network blip or GitHub's own trouble while waiting is looked at again, never reported as failed checks", async () => {
  // Seen on the sandbox proof (pull request #8): one "fetch failed" mid-wait came back as failed, and the task stopped.
  let faults = 0;
  const blip = fixture({ networkFault: (path) => { if (path.endsWith("/check-runs") && faults++ < 1) throw new TypeError("fetch failed"); } });
  const once = await blip.github.checkVerdict(repo, 7);
  assert.equal(once.state, "pending", once.summary);
  assert.match(once.summary, /could not be reached just now \(fetch failed\)\. Looking again/);
  assert.equal((await blip.github.waitForChecks({ repo, number: 7, seconds: 60 }, AbortSignal.timeout(5000), async () => {})).state, "passed");
  const trouble = fixture({ status: 502 });
  assert.equal((await trouble.github.checkVerdict(repo, 7)).state, "pending", "a 5xx from GitHub is not a verdict");
  const refused = fixture({ status: 404 });
  await assert.rejects(refused.github.checkVerdict(repo, 7), /could not find that repository/, "a real refusal still says so");
  const redirected = fixture({ networkFault: () => { throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") }); } });
  await assert.rejects(redirected.github.checkVerdict(repo, 7), /fetch failed/, "a redirect is refused on purpose, not retried");
});
