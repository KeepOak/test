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
  draft = false, readyResponse, unprotected = false } = {}) {
  const calls = [], seen = { pulls: 0, branches: 0, ready: false };
  const fetchImpl = async (address, init) => {
    const url = new URL(address), path = decodeURIComponent(url.pathname);
    calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    let answer;
    if (init.method === "PUT") answer = { merged: true, sha: moved };
    else if (path.endsWith("/graphql")) {
      answer = readyResponse ?? { data: { markPullRequestReadyForReview: { pullRequest: { id: "PR_test123", isDraft: false, headRefOid: head, baseRefOid: base } } } };
      seen.ready = true;
    }
    else if (path.endsWith("/pulls/7")) { answer = pull(); answer.draft = draft && !seen.ready; changePull?.(answer, ++seen.pulls); }
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

test("a failed, cancelled or required-but-skipped check or run refuses; optional skipped and neutral are fine", async () => {
  for (const change of [
    { changeCheck: (a) => { a.check_runs[0].conclusion = "failure"; } },
    { changeCheck: (a) => { a.check_runs[1].conclusion = "cancelled"; } },
    { changeCheck: (a) => { a.check_runs[0].conclusion = "skipped"; } },
    { changeRuns: (r) => { r.workflow_runs[0].conclusion = "failure"; } },
    { changeRuns: (r) => { r.workflow_runs[0].head_sha = moved; } },
    { changeRuns: (r) => { r.total_count = 3; } },
  ]) await assert.rejects(fixture(change).github.mergeReview(repo, 7), (error) => !(error instanceof ChecksPending) && refused.test(error.message));
  const neutral = fixture({ changeCheck: (a) => { a.check_runs[1].conclusion = "neutral"; } });
  assert.equal((await neutral.github.mergeReview(repo, 7)).headSha, head);
  // A rerun: the newest attempt of a workflow decides, not an older failed one.
  const rerun = fixture({ changeRuns: (r) => { r.total_count = 3; r.workflow_runs.push({ ...r.workflow_runs[0], id: 10, conclusion: "failure", run_attempt: 0 }); } });
  assert.equal((await rerun.github.mergeReview(repo, 7)).headSha, head);
});

test("required reviews, merge queues and unknown rules are left to GitHub; required ruleset checks are verified", async () => {
  await assert.rejects(fixture({ changeProtection: (p) => { p.required_pull_request_reviews = { required_approving_review_count: 1 }; } }).github.mergeReview(repo, 7), /approving review/);
  const rule = { type: "required_status_checks", ruleset_id: 9, parameters: { required_status_checks: [{ context: "tests", integration_id: 123 }] } };
  assert.equal((await fixture({ rules: [rule, { type: "deletion" }, { type: "non_fast_forward" }] }).github.mergeReview(repo, 7)).requiredChecksVerified, true);
  for (const rules of [[{ type: "merge_queue" }], [{ type: "pull_request", parameters: { required_approving_review_count: 2 } }]])
    await assert.rejects(fixture({ rules }).github.mergeReview(repo, 7), refused);
  await assert.rejects(fixture({ rules: [{ ...rule, parameters: { required_status_checks: [{ context: "tests", integration_id: 999 }] } }] }).github.mergeReview(repo, 7),
    waiting, "a required check from another app is still awaited");
  const missing = fixture({ rules: [{ ...rule, parameters: { required_status_checks: [{ context: "e2e", integration_id: 123 }] } }] });
  await assert.rejects(missing.github.mergeReview(repo, 7), waiting, "a required check that has not reported yet is pending");
});

test("forks, drafts, blocked PRs and stale head or base refs refuse", async () => {
  for (const changePull of [
    (p) => { p.head.repo.full_name = "attacker/Branch-Agent"; }, (p) => { p.base.repo.full_name = "attacker/Branch-Agent"; },
    (p) => { p.draft = true; }, (p) => { p.mergeable_state = "blocked"; }, (p) => { p.mergeable_state = "dirty"; p.mergeable = false; },
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
