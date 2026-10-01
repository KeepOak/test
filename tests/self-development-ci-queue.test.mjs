/**
 * SELF-103: the CI queue read in Branch. A selected pull request is "observed-passed" only when its
 * checks and workflow runs are for its exact current head; a head that moved during the read is unknown.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readCiQueue } from "../dist/self-development-ci.js";

const A = "a".repeat(40), B = "b".repeat(40);
function github({ headNow = A } = {}) {
  const paths = [];
  const request = async (method, path) => {
    paths.push(`${method} ${path}`);
    if (path.startsWith("repos/o/r/pulls?")) return [{ number: 7, title: "Fix", head: { sha: A }, draft: false, labels: [{ name: "queue" }] },
      { number: 8, title: "Other", head: { sha: B }, labels: [] }];
    if (path === "repos/o/r/pulls/7") return { number: 7, state: "open", head: { sha: headNow } };
    if (path.startsWith(`repos/o/r/commits/${A}/check-runs`)) return { total_count: 1,
      check_runs: [{ id: 1, head_sha: A, name: "test", status: "completed", conclusion: "success" }] };
    if (path.startsWith(`repos/o/r/commits/${A}/status`)) return { total_count: 0, sha: A, statuses: [] };
    if (path.startsWith("repos/o/r/commits/")) return { sha: A };
    if (path.startsWith("repos/o/r/actions/runs?")) return { total_count: 1, workflow_runs: [{ id: 9, head_sha: A, workflow_id: 3,
      run_number: 4, run_attempt: 1, event: "pull_request", name: "CI", status: "completed", conclusion: "success" }] };
    throw new Error(`unexpected ${path}`);
  };
  return { request, paths };
}

test("SELF-103: only selected pull requests are read in detail, and a passing exact head is observed passed", async () => {
  const { request, paths } = github();
  const queue = await readCiQueue(request, "o/r", [7]);
  assert.equal(queue.listComplete, true);
  assert.equal(queue.requiredChecksVerified, false);
  assert.deepEqual(queue.rows.map((row) => [row.number, row.state]), [[7, "observed-passed"], [8, "unread"]]);
  assert.equal(paths.some((path) => path.includes(B)), false);
  assert.equal(paths.every((path) => path.startsWith("GET ")), true);
});

test("SELF-103: a head that moved during the read is never shown as passed", async () => {
  const { request } = github({ headNow: B });
  const [row] = (await readCiQueue(request, "o/r", [7])).rows;
  assert.equal(row.exactHead, false);
  assert.equal(row.state, "unknown");
});
