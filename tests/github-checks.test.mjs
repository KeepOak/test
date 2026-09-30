import test from "node:test";
import assert from "node:assert/strict";
import { GitHubAccess } from "../dist/integrations/github.js";

const sha = "a".repeat(40);
const moved = "b".repeat(40);
const run = (id, overrides = {}) => ({ id, head_sha: sha, name: `check-${id}`, status: "completed", conclusion: "success", ...overrides });
const legacy = (id, state = "success") => ({ id, context: `status-${id}`, state });
function fixture({ runs = [run(1)], statuses = [], change, checkPage, statusPage } = {}) {
  const calls = [];
  let resolutions = 0;
  const fetchImpl = async (address, init) => {
    const url = new URL(address);
    calls.push({ url, init });
    let answer;
    const page = Number(url.searchParams.get("page"));
    if (url.pathname.endsWith("/commits/main")) answer = { sha: ++resolutions > 1 && change ? moved : sha };
    else if (url.pathname.endsWith(`/commits/${sha}/check-runs`)) answer = checkPage?.(page) ?? { total_count: runs.length, check_runs: runs.slice((page - 1) * 100, page * 100) };
    else if (url.pathname.endsWith(`/commits/${sha}/status`)) answer = statusPage?.(page) ?? { sha, total_count: statuses.length, statuses: statuses.slice((page - 1) * 100, page * 100) };
    else throw new Error(`Unexpected request: ${url}`);
    assert.equal(init.headers.authorization, "Bearer test-token");
    return new Response(JSON.stringify(answer));
  };
  const policy = { assertAllowed: async () => {} };
  return { calls, github: new GitHubAccess({}, policy, async () => "test-token", fetchImpl) };
}
const read = (fixture) => fixture.github.checks({ repo: "owner/project", ref: "main" });

test("only complete success evidence on one unchanged SHA is green, never a merge grant", async () => {
  const f = fixture({ statuses: [legacy(9)] });
  const result = await read(f);
  assert.equal(result.allPassed, true);
  assert.equal(result.complete, true);
  assert.equal(result.sha, sha);
  assert.equal(result.requiredChecksVerified, false);
  assert.match(result.summary, /Required branch checks have not been verified/);
  assert.equal(f.calls.filter((call) => call.url.pathname.endsWith("/commits/main")).length, 2);
  assert.ok(f.calls.filter((call) => call.url.search).every((call) => call.url.pathname.includes(sha)));
});

test("queued, running, waiting, null, skipped, neutral and unknown conclusions cannot be green", async () => {
  for (const overrides of [
    { status: "queued", conclusion: null }, { status: "in_progress", conclusion: null },
    { status: "waiting", conclusion: "success" }, { status: "completed", conclusion: null },
    ...["skipped", "neutral", "failure", "timed_out", "cancelled", "action_required", "stale", "new-value"].map((conclusion) => ({ conclusion })),
  ]) assert.equal((await read(fixture({ runs: [run(1, overrides)] }))).allPassed, false, JSON.stringify(overrides));
});

test("no checks, missing fields and wrong SHA evidence cannot be green", async () => {
  for (const f of [fixture({ runs: [] }), fixture({ runs: [run(1, { head_sha: moved })] }),
    fixture({ checkPage: () => ({ check_runs: [run(1)] }) }),
    fixture({ statusPage: () => ({ sha: moved, total_count: 0, statuses: [] }) }),
    fixture({ runs: [run(1, { id: undefined })] }), fixture({ change: true })]) {
    assert.equal((await read(f)).allPassed, false);
  }
});

test("all pages include a failing check after the old first thirty and after the first hundred", async () => {
  const runs = Array.from({ length: 205 }, (_, i) => run(i + 1));
  runs[204].conclusion = "failure";
  const f = fixture({ runs });
  const result = await read(f);
  assert.equal(result.complete, true);
  assert.equal(result.checks.length, 205);
  assert.equal(result.allPassed, false);
  assert.match(result.summary, /check-205/);
  assert.deepEqual(f.calls.filter((call) => call.url.pathname.endsWith("check-runs")).map((call) => call.url.searchParams.get("page")), ["1", "2", "3"]);
});

test("pending and failed legacy statuses on later pages block success", async () => {
  for (const state of ["pending", "failure", "error", "unknown"]) {
    const statuses = Array.from({ length: 101 }, (_, i) => legacy(i + 1));
    statuses[100].state = state;
    const result = await read(fixture({ statuses }));
    assert.equal(result.complete, true);
    assert.equal(result.allPassed, false, state);
  }
});

test("changing totals, repeated pages and pagination limits report incomplete evidence", async () => {
  const hundred = Array.from({ length: 100 }, (_, i) => run(i + 1));
  const cases = [
    (page) => ({ total_count: page === 1 ? 101 : 102, check_runs: page === 1 ? hundred : [run(101)] }),
    () => ({ total_count: 200, check_runs: hundred }),
    () => ({ total_count: 2, check_runs: [run(1)] }),
    (page) => ({ total_count: 1001, check_runs: Array.from({ length: 100 }, (_, i) => run((page - 1) * 100 + i + 1)) }),
  ];
  for (const checkPage of cases) {
    const f = fixture({ checkPage });
    const result = await read(f);
    assert.equal(result.complete, false);
    assert.equal(result.allPassed, false);
    assert.ok(f.calls.filter((call) => call.url.pathname.endsWith("check-runs")).length <= 10);
  }
});

test("authenticated errors and network refusal never become a passing result", async () => {
  const denied = new GitHubAccess({}, { assertAllowed: async () => { throw new Error("blocked"); } }, async () => "test-token",
    async () => { throw new Error("must not fetch"); });
  await assert.rejects(denied.checks({ repo: "owner/project", ref: "main" }), /blocked/);
  for (const code of [401, 403, 404]) {
    const github = new GitHubAccess({}, { assertAllowed: async () => {} }, async () => "test-token",
      async () => new Response(JSON.stringify({ message: "test-token" }), { status: code }));
    await assert.rejects(github.checks({ repo: "owner/project", ref: "main" }), (error) => !error.message.includes("test-token"));
  }
});
