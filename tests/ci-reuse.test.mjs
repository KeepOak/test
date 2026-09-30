// scripts/ci-reuse.mjs: a push to redesign/window reuses a merge-queue run's whole-suite result only when that run is
// this repository's Checks, finished green, on the same commit or a commit with the same tree. Mutations that go red
// here: accepting a red, running, cancelled, pull-request or push run, another repository's or workflow's run, or a
// different tree; preferring an older run over a newer one; or reading trees when the commit itself matched.
import assert from "node:assert/strict";
import test from "node:test";
import { reusableRun, trustedGroupRun, WORKFLOW_PATH } from "../scripts/ci-reuse.mjs";

const repo = "KeepOak/Branch-Agent";
const sha = "a".repeat(40), other = "b".repeat(40), third = "c".repeat(40);
const run = (id, head, extra = {}) => ({ id, head_sha: head, path: WORKFLOW_PATH, event: "merge_group", status: "completed",
  conclusion: "success", repository: { full_name: repo }, head_repository: { full_name: repo }, ...extra });
const trees = { [sha]: "t1", [other]: "t1", [third]: "t2" };
const treeOf = async (commit) => trees[commit] ?? null;

test("only a finished, green merge-queue Checks run of this repository is trusted", () => {
  assert.equal(trustedGroupRun(run(1, sha), repo), true);
  for (const extra of [{ conclusion: "failure" }, { conclusion: "cancelled" }, { status: "in_progress", conclusion: null },
    { event: "pull_request" }, { event: "push" }, { path: ".github/workflows/beta.yml" },
    { repository: { full_name: "someone/fork" } }, { head_repository: { full_name: "someone/fork" } }, { head_sha: "nope" }])
    assert.equal(trustedGroupRun(run(1, sha, extra), repo), false, JSON.stringify(extra));
});

test("the same commit is reused first, then a commit with the same tree, never a different tree", async () => {
  let asked = 0;
  const counting = async (commit) => { asked += 1; return treeOf(commit); };
  assert.equal((await reusableRun([run(1, other), run(2, sha)], { sha, tree: "t1", repo, treeOf: counting }))?.id, 2);
  assert.equal(asked, 0, "the commit matched: no tree is read");
  assert.equal((await reusableRun([run(3, third), run(1, other)], { sha, tree: "t1", repo, treeOf }))?.id, 1);
  assert.equal(await reusableRun([run(3, third)], { sha, tree: "t1", repo, treeOf }), null);
  assert.equal(await reusableRun([run(1, other)], { sha, tree: null, repo, treeOf }), null, "an unknown tree reuses nothing");
  assert.equal(await reusableRun([run(2, sha, { conclusion: "failure" })], { sha, tree: "t1", repo, treeOf }), null);
  assert.equal((await reusableRun([run(4, sha), run(9, sha)], { sha, tree: "t1", repo, treeOf }))?.id, 9, "newest first");
});
