import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assertReleaseVersion, isRehearsalTag, trustedExactRun } from "../scripts/release-lineage.mjs";

const sha = "a".repeat(40);
const repo = "stabrea/Branch-Agent";
const good = {
  path: ".github/workflows/checks.yml", event: "push", head_branch: "mac/cross-platform",
  head_sha: sha, repository: { full_name: repo }, head_repository: { full_name: repo },
  id: 101, created_at: "2026-09-23T01:00:00Z", run_attempt: 1,
  status: "completed", conclusion: "success", html_url: "https://github.com/example/run",
};
const select = (run) => trustedExactRun({ workflow_runs: [run] }, { sha, repo });

test("Stable packaging excludes rolling Beta tags", () => {
  const workflow = readFileSync(new URL("../.github/workflows/package.yml", import.meta.url), "utf8");
  // Beta tags stay out; the one prerelease shape let back in is the rehearsal, which no updater installs.
  assert.match(workflow, /tags:\s*\['v\*', '!v\*-\*', 'v0\.0\.0-rehearsal\.\*'\]/);
  assert.throws(() => assertReleaseVersion("v0.19.2-beta.1", "0.19.2"));
});

test("only v0.0.0-rehearsal.<n> is a rehearsal, and a rehearsal skips nothing but the integration gate", () => {
  for (const tag of ["v0.0.0-rehearsal.1", "v0.0.0-rehearsal.42"]) assert.equal(isRehearsalTag(tag), true, tag);
  for (const tag of ["v0.0.0-rehearsal.0", "v0.0.0-rehearsal.01", "v0.19.3", "v0.19.4-beta.1", "v0.0.1-rehearsal.1",
    "v0.0.0-rehearsal.1.2", "v0.0.0-rehearsal", "0.0.0-rehearsal.1", "v0.0.0-rehearsal.1\n"])
    assert.equal(isRehearsalTag(tag), false, JSON.stringify(tag));
  const workflow = readFileSync(new URL("../.github/workflows/package.yml", import.meta.url), "utf8");
  const skipped = [...workflow.matchAll(/steps\.kind\.outputs\.kind != 'rehearsal'/g)].length;
  assert.equal(skipped, 2, "the lineage check and the exact-commit CI check are the only steps a rehearsal skips");
  assert.match(workflow, /node scripts\/release-lineage\.mjs --stamp-rehearsal "\$TAG"/, "a rehearsal's downloads carry its own version");
});

test("release tags match the packaged version exactly", () => {
  assert.doesNotThrow(() => assertReleaseVersion("v0.19.2", "0.19.2"));
  for (const [tag, version] of [["v0.19.2", "0.19.1"], ["v0.19.2-rc.1", "0.19.2"],
    ["v0.19.2+other", "0.19.2"], ["v00.19.2", "00.19.2"]])
    assert.throws(() => assertReleaseVersion(tag, version));
});

test("only a successful exact official integration Checks run can release", () => {
  assert.equal(select(good)?.html_url, good.html_url);
  assert.equal(select({ ...good, event: "workflow_dispatch" })?.html_url, good.html_url);
  for (const changed of [
    { path: ".github/workflows/pr-fast.yml" }, { event: "pull_request" },
    { head_branch: "feature/green" }, { head_sha: "b".repeat(40) },
    { repository: { full_name: "fork/Branch-Agent" } },
    { head_repository: { full_name: "fork/Branch-Agent" } },
    { status: "in_progress", conclusion: null }, { status: "completed", conclusion: "failure" },
  ]) assert.equal(select({ ...good, ...changed }), null, JSON.stringify(changed));
});

test("missing and stale run inventories fail closed", () => {
  assert.equal(trustedExactRun({}, { sha, repo }), null);
  assert.equal(trustedExactRun({ workflow_runs: [good] }, { sha: "b".repeat(40), repo }), null);
  assert.throws(() => trustedExactRun({}, { sha: "short", repo }));
});

test("a newer trusted red or unfinished run blocks an older green one regardless of API order", () => {
  const newer = { ...good, id: 102, created_at: "2026-09-23T02:00:00Z", conclusion: "failure" };
  for (const runs of [[good, newer], [newer, good]])
    assert.equal(trustedExactRun({ workflow_runs: runs }, { sha, repo }), null);
  assert.equal(trustedExactRun({ workflow_runs: [good, { ...newer, status: "in_progress", conclusion: null }] },
    { sha, repo }), null);
  assert.equal(trustedExactRun({ workflow_runs: [good, { ...newer, event: "pull_request" }] },
    { sha, repo })?.id, good.id, "an unrelated run cannot poison the exact trusted history");
});

test("ambiguous trusted run ordering refuses publication", () => {
  assert.equal(trustedExactRun({ workflow_runs: [good, { ...good, id: 102, created_at: "invalid" }] },
    { sha, repo }), null);
});
