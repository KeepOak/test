import test from "node:test";
import assert from "node:assert/strict";
import { GitHubAccess } from "../dist/integrations/github.js";

const head = "a".repeat(40), base = "b".repeat(40), moved = "c".repeat(40);
const repo = "owner/Branch-Agent", branch = "redesign/window";
const pull = () => ({ number: 7, node_id: "PR_test123", state: "open", draft: false, merged: false, mergeable: true, mergeable_state: "clean",
  head: { sha: head, ref: "branch/self-fix", repo: { full_name: repo } }, base: { sha: base, ref: branch, repo: { full_name: repo } } });
const protection = () => ({ enforce_admins: { enabled: true }, required_status_checks: { strict: true, contexts: ["tests"], checks: [{ context: "tests", app_id: 123 }] } });
function fixture({ changePull, changeProtection, rules = [], ruleDetail, changeCheck, changeBranch, changeCompare, tokenHook, status = 200,
  draft = false, readyResponse } = {}) {
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
    else if (path.endsWith("/protection")) { answer = protection(); changeProtection?.(answer); }
    else if (path.includes("/rules/branches/")) answer = rules;
    else if (path.includes("/rulesets/")) answer = ruleDetail ?? { id: 9, enforcement: "active", bypass_actors: [] };
    else if (path.includes("/branches/")) { answer = { protected: true, commit: { sha: base } }; changeBranch?.(answer, ++seen.branches); }
    else if (path.includes("/compare/")) { answer = { status: "ahead", behind_by: 0, base_commit: { sha: base } }; changeCompare?.(answer); }
    else if (path.endsWith("/check-runs")) { answer = { total_count: 1, check_runs: [{ id: 1, head_sha: head, name: "tests", app: { id: 123 }, status: "completed", conclusion: "success" }] }; changeCheck?.(answer); }
    else if (path.endsWith("/status")) answer = { sha: head, total_count: 0, statuses: [] };
    else if (path.endsWith(`/commits/${head}`)) answer = { sha: head };
    else throw new Error(`Unexpected route ${path}`);
    assert.equal(init.headers.authorization, "Bearer test-token");
    return new Response(JSON.stringify(answer), { status });
  };
  const github = new GitHubAccess({}, { assertAllowed: async () => {} }, async () => { tokenHook?.(); return "test-token"; }, fetchImpl);
  return { github, calls };
}

test("normal merge uses reviewed head SHA and no force, admin, bypass or async queue fields", async () => {
  const f = fixture();
  const evidence = await f.github.mergeReview(repo, 7);
  assert.equal(evidence.requiredChecksVerified, true);
  assert.deepEqual(evidence.required, [{ context: "tests", appId: 123 }]);
  let rechecked = false;
  assert.deepEqual(await f.github.mergeReviewed(evidence, () => { rechecked = true; }), { merged: true, sha: moved });
  assert.equal(rechecked, true);
  assert.deepEqual(f.calls.filter((call) => call.method === "PUT"), [{ path: `/repos/${repo}/pulls/7/merge`, method: "PUT", body: { sha: head, merge_method: "merge" } }]);
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

test("admin enforcement, latest-base enforcement and complete configured contexts are required", async () => {
  for (const changeProtection of [
    (p) => { p.enforce_admins.enabled = false; }, (p) => { delete p.enforce_admins; },
    (p) => { p.required_status_checks.strict = false; }, (p) => { p.required_status_checks.contexts.push("hidden"); },
    (p) => { p.required_status_checks.checks = []; }, (p) => { p.required_status_checks.checks[0].app_id = undefined; },
    (p) => { p.required_pull_request_reviews = { bypass_pull_request_allowances: { users: [{}] } }; },
  ]) {
    const f = fixture({ changeProtection });
    await assert.rejects(f.github.mergeReview(repo, 7), /cannot merge/);
    assert.equal(f.calls.some((c) => c.method === "PUT"), false);
  }
});

test("missing required check, wrong app, pending, neutral or skipped evidence refuses", async () => {
  for (const changeCheck of [
    (a) => { a.check_runs[0].name = "other"; }, (a) => { a.check_runs[0].app.id = 999; },
    (a) => { delete a.check_runs[0].app; }, (a) => { a.check_runs[0].status = "in_progress"; },
    (a) => { a.check_runs[0].conclusion = "neutral"; }, (a) => { a.check_runs[0].conclusion = "skipped"; },
  ]) await assert.rejects(fixture({ changeCheck }).github.mergeReview(repo, 7), /cannot merge/);
});

test("forks, drafts, blocked PRs and stale head or base refs refuse", async () => {
  for (const changePull of [
    (p) => { p.head.repo.full_name = "attacker/Branch-Agent"; }, (p) => { p.base.repo.full_name = "attacker/Branch-Agent"; },
    (p) => { p.draft = true; }, (p) => { p.mergeable_state = "blocked"; }, (p) => { p.state = "closed"; },
    (p, n) => { if (n > 1) p.head.sha = moved; }, (p, n) => { if (n > 1) p.base.sha = moved; },
    (p) => { p.head.ref = "main"; },
  ]) await assert.rejects(fixture({ changePull }).github.mergeReview(repo, 7), /cannot merge/);
  for (const changeBranch of [(b) => { b.protected = false; }, (b, n) => { if (n > 1) b.commit.sha = moved; }])
    await assert.rejects(fixture({ changeBranch }).github.mergeReview(repo, 7), /cannot merge/);
  await assert.rejects(fixture({ changeCompare: (c) => { c.behind_by = 1; c.status = "diverged"; } }).github.mergeReview(repo, 7), /exact reviewed base/);
});

test("active ruleset check app/source is reconciled and any bypass or unknown rule refuses", async () => {
  const rule = { type: "required_status_checks", ruleset_id: 9, ruleset_source_type: "Repository", ruleset_source: repo,
    parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "tests", integration_id: 123 }] } };
  assert.equal((await fixture({ rules: [rule] }).github.mergeReview(repo, 7)).requiredChecksVerified, true);
  for (const options of [
    { rules: [rule], ruleDetail: { id: 9, enforcement: "active", bypass_actors: [{ actor_type: "RepositoryRole", actor_id: 5 }] } },
    { rules: [rule], ruleDetail: { id: 9, enforcement: "evaluate", bypass_actors: [] } },
    { rules: [rule], ruleDetail: { id: 10, enforcement: "active", bypass_actors: [] } },
    { rules: [{ ...rule, ruleset_source: "attacker/repository" }] },
    { rules: [{ ...rule, type: "merge_queue" }] },
    { rules: [{ ...rule, parameters: { ...rule.parameters, required_status_checks: [{ context: "tests", integration_id: 999 }] } }] },
  ]) await assert.rejects(fixture(options).github.mergeReview(repo, 7), /cannot merge/);
});

test("state checked after token/policy awaits can stop PUT before it leaves", async () => {
  const f = fixture();
  const evidence = await f.github.mergeReview(repo, 7);
  await assert.rejects(f.github.mergeReviewed(evidence, () => { throw new Error("Lockdown became active"); }), /Lockdown became active/);
  assert.equal(f.calls.some((call) => call.method === "PUT"), false);
  for (const status of [401, 403, 404]) await assert.rejects(fixture({ status }).github.mergeReview(repo, 7));
});
