import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { discardTemp } from "./temp-dir.mjs";
import { approvedExactHead, betaAssets, betaPlan, fastProof, latestTrustedChecks,
  latestTrustedFast, latestTrustedSuite, publishBeta, stampBetaVersion } from "../scripts/beta-release.mjs";

// The repository the script under test takes as its own: the one it runs in when that is one of Branch's two
// names (after the move to KeepOak, Actions sets KeepOak), otherwise the name it had before the move.
const names = ["KeepOak/Branch-Agent", "stabrea/Branch-Agent"];
const repo = names.includes(process.env.GITHUB_REPOSITORY ?? "") ? process.env.GITHUB_REPOSITORY : "stabrea/Branch-Agent";
const sha = "a".repeat(40), head = "b".repeat(40);
const checks = (id, conclusion = "success", overrides = {}) => ({
  id, run_attempt: 1, path: ".github/workflows/checks.yml", event: "push",
  head_branch: "mac/cross-platform", head_sha: sha, status: "completed", conclusion,
  repository: { full_name: repo }, head_repository: { full_name: repo }, html_url: `https://github.test/checks/${id}`,
  ...overrides,
});
const fast = (id, conclusion = "success", overrides = {}) => ({
  id, run_attempt: 1, path: ".github/workflows/pr-fast.yml", event: "pull_request", head_sha: head,
  head_branch: "feature",
  status: "completed", conclusion, repository: { full_name: repo }, head_repository: { full_name: repo },
  pull_requests: [{ number: 42 }], html_url: `https://github.test/fast/${id}`, ...overrides,
});
const suite = (id, conclusion = "success", overrides = {}) => ({
  ...fast(id, conclusion), path: ".github/workflows/checks.yml", html_url: `https://github.test/suite/${id}`, ...overrides,
});
const pull = { number: 42, merged_at: "2026-09-23T00:00:00Z", merge_commit_sha: sha,
  base: { ref: "mac/cross-platform", repo: { full_name: repo } },
  head: { sha: head, ref: "feature", repo: { full_name: repo } }, user: { login: "author" } };
const approval = { id: 1, state: "APPROVED", commit_id: head, user: { login: "reviewer" },
  author_association: "COLLABORATOR" };
const appApproval = { ...approval, user: { login: "keepoak-branch-reviewer[bot]", id: 332788682, type: "Bot" },
  author_association: "NONE" };

test("beta publishing uses standard public runners and one-day temporary artifacts", async () => {
  const workflow = await readFile(new URL("../.github/workflows/beta.yml", import.meta.url), "utf8");
  assert.match(workflow, /os: \[windows-latest, macos-latest, ubuntu-latest\]/);
  assert.deepEqual([...workflow.matchAll(/^    runs-on: (.+)$/gm)].map((match) => match[1]),
    ["ubuntu-latest", "${{ matrix.os }}", "ubuntu-latest"]);
  assert.match(workflow, /retention-days: 1/);
  assert.doesNotMatch(workflow, /retention-days: [2-9]/);
});

test("only the exact installed reviewer App bot can approve a fast beta", () => {
  assert.equal(approvedExactHead([appApproval], pull), true);
  assert.equal(approvedExactHead([{ ...appApproval, user: { ...appApproval.user, id: 123 } }], pull), false);
  assert.equal(approvedExactHead([{ ...appApproval, user: { ...appApproval.user, type: "User" } }], pull), false);
  assert.equal(approvedExactHead([{ ...appApproval, user: { ...appApproval.user, login: "other[bot]" } }], pull), false);
  assert.equal(approvedExactHead([{ ...appApproval, commit_id: sha }], pull), false);
  assert.equal(approvedExactHead([appApproval, { ...approval, id: 2, state: "CHANGES_REQUESTED" }], pull), false,
    "a different trusted reviewer's unresolved objection vetoes approval");
});

test("beta version is strictly after the current stable patch and monotonic per workflow run", () => {
  assert.deepEqual(betaPlan("0.19.1", 17), { version: "0.19.2-beta.17", tag: "v0.19.2-beta.17" });
  assert.deepEqual(betaPlan("0.19.2", 18), { version: "0.19.3-beta.18", tag: "v0.19.3-beta.18" });
  for (const value of ["0.19.2-beta.1", "01.2.3", "0.19.1+local"]) assert.throws(() => betaPlan(value, 1));
  assert.throws(() => betaPlan("0.19.1", 0));
});

test("newest trusted exact Checks run governs, even when an older run passed", () => {
  const response = { workflow_runs: [checks(11, "success"), checks(12, "failure")] };
  assert.deepEqual(latestTrustedChecks(response, sha), { run: response.workflow_runs[1], state: "rejected" });
  assert.equal(latestTrustedChecks({ workflow_runs: [checks(15, "success", { head_repository: { full_name: "fork/repo" } })] }, sha).state, "missing");
  assert.equal(latestTrustedChecks({ workflow_runs: [checks(15, "success", { head_branch: "other" })] }, sha).state, "missing");
  assert.equal(latestTrustedChecks({ workflow_runs: [checks(15, null, { status: "in_progress" })] }, sha).state, "pending");
});

test("fast proof requires exact merged PR, independent exact-head approval and latest green fast run", async () => {
  const base = "c".repeat(40);
  let reviews = [approval], runs = [fast(8), fast(9)], behindBy = 0;
  let mergeParents = [{ sha: base }, { sha: head }];
  let mergeTree = "d".repeat(40), headTree = mergeTree;
  let reviewedSha = head;
  let rollupRun = null;
  let suites = [suite(20)];
  const gh = async (args) => {
    const path = args[3] ?? args[1];
    if (path.includes("/checks.yml/runs")) return JSON.stringify({ workflow_runs: suites });
    if (path.includes(`/commits/${sha}/pulls`)) return JSON.stringify([pull]);
    if (path === `repos/${repo}/commits/${sha}`) return JSON.stringify({ sha, parents: mergeParents, commit: { tree: { sha: mergeTree } } });
    if (path === `repos/${repo}/commits/${head}`) return JSON.stringify({ sha: reviewedSha, commit: { tree: { sha: headTree } } });
    if (path === `repos/${repo}/compare/${base}...${head}`)
      return JSON.stringify({ behind_by: behindBy });
    if (path.includes("/reviews")) return JSON.stringify(reviews);
    if (path.includes("/pr-fast.yml/runs")) return JSON.stringify({ workflow_runs: runs });
    if (args[0] === "pr" && args[1] === "checks") return JSON.stringify([{ name: "verify-fast",
      state: "SUCCESS", workflow: "PR Fast Checks", link: `https://github.test/actions/runs/${rollupRun ?? runs.at(-1).id}/job/5` }]);
    throw new Error(`Unexpected API: ${args.join(" ")}`);
  };
  const proof = await fastProof(sha, repo, gh);
  assert.deepEqual({ kind: proof.kind, id: proof.run.id, pullHead: proof.pullHead },
    { kind: "reviewed-fast", id: 9, pullHead: head });
  mergeTree = "e".repeat(40);
  assert.equal(await fastProof(sha, repo, gh), null, "merge must contain exactly the reviewed head's files");
  mergeTree = headTree;
  for (const missing of [undefined, "not-a-tree"]) {
    headTree = missing;
    assert.equal(await fastProof(sha, repo, gh), null, "missing or invalid reviewed tree fails closed");
  }
  headTree = mergeTree;
  const validTree = mergeTree;
  mergeTree = headTree = undefined;
  assert.equal(await fastProof(sha, repo, gh), null, "two absent trees cannot establish reviewed-tree equality");
  mergeTree = headTree = validTree;
  reviewedSha = "f".repeat(40);
  assert.equal(await fastProof(sha, repo, gh), null, "a response for another commit cannot lend its matching tree");
  reviewedSha = head;
  assert.equal((await fastProof(sha, repo, gh)).kind, "reviewed-fast", "restored valid identity still accepts");
  rollupRun = 1;
  assert.equal(await fastProof(sha, repo, gh), null, "PR check rollup must bind to this exact accepted run");
  rollupRun = null;
  suites = [];
  assert.equal(await fastProof(sha, repo, gh), null, "a broad change the fast gate left to the whole suite needs that suite's run");
  suites = [suite(20), suite(21, "failure")];
  assert.equal(await fastProof(sha, repo, gh), null, "the newest whole-suite run for the head must have passed");
  suites = [suite(22, null, { status: "in_progress" })];
  assert.equal(await fastProof(sha, repo, gh), null, "a whole-suite run still going is not a pass");
  suites = [suite(23, "success", { head_repository: { full_name: "fork/repo" } })];
  assert.equal(await fastProof(sha, repo, gh), null, "a fork's run cannot stand in for this repository's");
  suites = [suite(24, "success", { event: "workflow_dispatch" })];
  assert.equal(await fastProof(sha, repo, gh), null, "only the pull request's own run counts here");
  suites = [suite(25)];
  assert.equal((await fastProof(sha, repo, gh)).kind, "reviewed-fast", "a passing whole-suite run restores acceptance");
  assert.equal(latestTrustedSuite({ workflow_runs: [suite(26, "success", { head_branch: "other" })] }, head, repo, "feature"), null);
  runs = [fast(8), fast(10, "failure")];
  assert.equal(await fastProof(sha, repo, gh), null, "newer failure vetoes older success");
  runs = [fast(11)];
  reviews = [{ ...approval, commit_id: "c".repeat(40) }];
  assert.equal(await fastProof(sha, repo, gh), null, "old-head approval cannot authorize new head");
  reviews = [{ ...approval, user: { login: "author" } }];
  assert.equal(await fastProof(sha, repo, gh), null, "author cannot review own PR");
  for (const association of ["NONE", "CONTRIBUTOR"]) {
    reviews = [{ ...approval, author_association: association }];
    assert.equal(await fastProof(sha, repo, gh), null,
      `${association} review cannot authorize the fast release`);
  }
  reviews = [approval, { ...approval, id: 2, state: "CHANGES_REQUESTED" }];
  assert.equal(await fastProof(sha, repo, gh), null, "later requested changes revoke approval");
  reviews = [approval];
  behindBy = 1;
  assert.equal(await fastProof(sha, repo, gh), null,
    "a stale PR head cannot authorize its untested merge commit");
  behindBy = 0;
  mergeParents = [{ sha: base }, { sha: "d".repeat(40) }];
  assert.equal(await fastProof(sha, repo, gh), null,
    "a different merged head cannot borrow this PR's approval and fast gate");
  mergeParents = [{ sha: base }];
  assert.equal(await fastProof(sha, repo, gh), null,
    "a squash commit without a linked reviewed head uses exhaustive acceptance");
  assert.equal(approvedExactHead([approval], pull), true);
  assert.equal(latestTrustedFast({ workflow_runs: [fast(2, "success", { head_repository: { full_name: "fork/repo" } })] }, head, repo, "feature"), null);
});

test("stamp changes only package identity and refuses a mismatched lockfile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "branch-beta-stamp-"));
  t.after(() => discardTemp(root));
  const manifest = { name: "branch-agent", version: "0.19.1", private: true };
  const lock = { name: "branch-agent", version: "0.19.1", packages: { "": { version: "0.19.1" } } };
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  await writeFile(join(root, "package-lock.json"), JSON.stringify(lock));
  await stampBetaVersion(root, "0.19.2-beta.5");
  assert.equal(JSON.parse(await readFile(join(root, "package.json"))).version, "0.19.2-beta.5");
  assert.equal(JSON.parse(await readFile(join(root, "package-lock.json"))).packages[""].version, "0.19.2-beta.5");
  const broken = JSON.parse(await readFile(join(root, "package-lock.json")));
  broken.packages[""].version = "0.19.1";
  await writeFile(join(root, "package-lock.json"), JSON.stringify(broken));
  await assert.rejects(() => stampBetaVersion(root, "0.19.2-beta.6"), /disagree/);
});

async function files(t) {
  const directory = await mkdtemp(join(tmpdir(), "branch-beta-assets-"));
  t.after(() => discardTemp(directory));
  for (const name of ["Branch-Agent-windows-x64.zip", "Branch-Agent-macos-arm64.zip",
    "Branch-Agent-macos-x64.zip", "Branch-Agent-linux-x64.tar.gz"]) {
    const bytes = Buffer.from(name);
    await writeFile(join(directory, name), bytes);
    await writeFile(join(directory, `${name}.sha256`), `${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`);
  }
  return directory;
}

test("publisher refuses incomplete checksums before any GitHub mutation", async (t) => {
  const directory = await files(t);
  await writeFile(join(directory, "Branch-Agent-windows-x64.zip.sha256"), "wrong");
  let calls = 0;
  await assert.rejects(() => publishBeta({ tag: "v0.19.2-beta.9", sha,
    proof: { kind: "exhaustive", run: checks(7) }, directory, workflowUrl: "https://github.test/run", gh: async () => { calls++; } }), /Checksum/);
  assert.equal(calls, 0);
});

test("publisher creates only a complete prerelease draft with exact provenance, then publishes", async (t) => {
  const directory = await files(t), calls = [];
  const run = checks(7), tag = "v0.19.2-beta.9";
  const gh = async (args) => {
    calls.push(args);
    const path = args[3] ?? args[1];
    if (path.includes("/git/ref/heads/")) return JSON.stringify({ object: { sha } });
    if (path.includes("/checks.yml/runs")) return JSON.stringify({ workflow_runs: [run] });
    if (path.endsWith("/releases")) return "[]";
    if (args[0] === "release" && args[1] === "view") return JSON.stringify({ isDraft: true, assets: [
      ...Object.keys(await betaAssets(directory)).flatMap((name) => [{ name }, { name: `${name}.sha256` }]),
      { name: "branch-beta-provenance.json" },
    ] });
    return "";
  };
  const result = await publishBeta({ tag, sha, proof: { kind: "exhaustive", run }, directory,
    workflowUrl: "https://github.test/publisher", gh });
  assert.equal(result.tag, tag);
  assert.ok(calls.find((args) => args[0] === "release" && args[1] === "create")?.includes("--prerelease"));
  assert.ok(calls.find((args) => args[0] === "release" && args[1] === "edit")?.includes("--latest=false"));
  const provenance = JSON.parse(await readFile(join(directory, "branch-beta-provenance.json")));
  assert.deepEqual({ sourceSha: provenance.sourceSha, acceptanceRunId: provenance.acceptanceRunId,
    version: provenance.version }, { sourceSha: sha, acceptanceRunId: 7, version: tag.slice(1) });
});

test("stale integration head is skipped before a tag or release is created", async (t) => {
  const directory = await files(t), calls = [];
  const result = await publishBeta({ tag: "v0.19.2-beta.9", sha,
    proof: { kind: "exhaustive", run: checks(7) }, directory, workflowUrl: "https://github.test/run",
    gh: async (args) => { calls.push(args); return JSON.stringify({ object: { sha: "c".repeat(40) } }); } });
  assert.match(result.skipped, /integration tip/i);
  assert.equal(calls.length, 1);
});

test("a red rerun after upload leaves beta as draft", async (t) => {
  const directory = await files(t), calls = [];
  let checkReads = 0;
  const gh = async (args) => {
    calls.push(args);
    const path = args[3] ?? args[1];
    if (path.includes("/git/ref/heads/")) return JSON.stringify({ object: { sha } });
    if (path.includes("/checks.yml/runs"))
      return JSON.stringify({ workflow_runs: [checks(++checkReads, checkReads === 1 ? "success" : "failure")] });
    if (path.endsWith("/releases")) return "[]";
    if (args[0] === "release" && args[1] === "view") return JSON.stringify({ isDraft: true, assets: [
      ...Object.keys(await betaAssets(directory)).flatMap((name) => [{ name }, { name: `${name}.sha256` }]),
      { name: "branch-beta-provenance.json" },
    ] });
    return "";
  };
  await assert.rejects(() => publishBeta({ tag: "v0.19.2-beta.9", sha,
    proof: { kind: "exhaustive", run: checks(1) }, directory,
    workflowUrl: "https://github.test/publisher", gh }), /changed after upload/);
  assert.equal(calls.some((args) => args[0] === "release" && args[1] === "edit"), false);
});

test("a newer beta beyond the first release-history page prevents an older publish", async (t) => {
  const directory = await files(t), calls = [];
  const gh = async (args) => {
    calls.push(args);
    const path = args[3] ?? args[1];
    if (path.includes("/git/ref/heads/")) return JSON.stringify({ object: { sha } });
    if (path.includes("/checks.yml/runs")) return JSON.stringify({ workflow_runs: [checks(7)] });
    if (path.endsWith("/releases")) return args.includes("page=1")
      ? JSON.stringify(Array.from({ length: 100 }, (_, n) => ({ tag_name: `v0.18.${n}`, prerelease: false })))
      : JSON.stringify([{ tag_name: "v0.19.2-beta.10", prerelease: true }]);
    throw new Error(`Unexpected API: ${args.join(" ")}`);
  };
  const result = await publishBeta({ tag: "v0.19.2-beta.9", sha,
    proof: { kind: "exhaustive", run: checks(7) }, directory,
    workflowUrl: "https://github.test/publisher", gh });
  assert.match(result.skipped, /not newer/i);
  assert.equal(calls.some((args) => args[0] === "release"), false);
});

test("a final stable release supersedes the candidate beta", async (t) => {
  const directory = await files(t), calls = [];
  const gh = async (args) => {
    calls.push(args);
    const path = args[3] ?? args[1];
    if (path.includes("/git/ref/heads/")) return JSON.stringify({ object: { sha } });
    if (path.includes("/checks.yml/runs")) return JSON.stringify({ workflow_runs: [checks(7)] });
    if (path.endsWith("/releases")) return JSON.stringify([{ tag_name: "v0.19.2", draft: false, prerelease: false }]);
    throw new Error(`Unexpected API: ${args.join(" ")}`);
  };
  const result = await publishBeta({ tag: "v0.19.2-beta.9", sha,
    proof: { kind: "exhaustive", run: checks(7) }, directory,
    workflowUrl: "https://github.test/publisher", gh });
  assert.match(result.skipped, /stable version/i);
  assert.equal(calls.some((args) => args[0] === "release"), false);
});

test("an incomplete draft for the same tag is reported, never silently skipped", async (t) => {
  const directory = await files(t);
  const gh = async (args) => {
    const path = args[3] ?? args[1];
    if (path.includes("/git/ref/heads/")) return JSON.stringify({ object: { sha } });
    if (path.includes("/checks.yml/runs")) return JSON.stringify({ workflow_runs: [checks(7)] });
    if (path.endsWith("/releases")) return JSON.stringify([{ tag_name: "v0.19.2-beta.9", draft: true, prerelease: true }]);
    throw new Error(`Unexpected API: ${args.join(" ")}`);
  };
  await assert.rejects(() => publishBeta({ tag: "v0.19.2-beta.9", sha,
    proof: { kind: "exhaustive", run: checks(7) }, directory,
    workflowUrl: "https://github.test/publisher", gh }), /already has a release/);
});

/**
 * After the move Actions runs this script with GITHUB_REPOSITORY=KeepOak/Branch-Agent. Each name is loaded in a
 * process of its own, since the script reads it once when it loads: its own name's checks are accepted and the
 * other name's are not, and a name that is neither falls back to the one it moved from.
 */
test("Beta takes its checks from the repository it runs in, under either of Branch's names", () => {
  const probe = `
    const { latestTrustedChecks } = await import(${JSON.stringify(new URL("../scripts/beta-release.mjs", import.meta.url).href)});
    const sha = "a".repeat(40);
    const run = (name) => ({ id: 7, run_attempt: 1, path: ".github/workflows/checks.yml", event: "push",
      head_branch: "mac/cross-platform", head_sha: sha, status: "completed", conclusion: "success",
      repository: { full_name: name }, head_repository: { full_name: name } });
    const state = (name) => { try { return latestTrustedChecks({ workflow_runs: [run(name)] }, sha, name).state; } catch (e) { return e.message; } };
    const own = (name) => latestTrustedChecks({ workflow_runs: [run(name)] }, sha).state;
    console.log(JSON.stringify({ keepoak: state("KeepOak/Branch-Agent"), stabrea: state("stabrea/Branch-Agent"),
      ownKeepoak: own("KeepOak/Branch-Agent"), ownStabrea: own("stabrea/Branch-Agent") }));`;
  const as = (value) => {
    const env = { ...process.env };
    if (value === undefined) delete env.GITHUB_REPOSITORY; else env.GITHUB_REPOSITORY = value;
    const out = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { env, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout.trim().split("\n").at(-1));
  };
  const refused = "Invalid beta source identity.";
  assert.deepEqual(as("KeepOak/Branch-Agent"), { keepoak: "accepted", stabrea: refused, ownKeepoak: "accepted", ownStabrea: "missing" });
  assert.deepEqual(as("stabrea/Branch-Agent"), { keepoak: refused, stabrea: "accepted", ownKeepoak: "missing", ownStabrea: "accepted" });
  for (const other of [undefined, "someone/Branch-Agent", "keepoak/branch-agent"])
    assert.deepEqual(as(other), { keepoak: refused, stabrea: "accepted", ownKeepoak: "missing", ownStabrea: "accepted" }, String(other));
});
