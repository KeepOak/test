import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";
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

test("only v0.0.0-rehearsal.<n> is a rehearsal, and a rehearsal skips nothing but the integration gate and signing", () => {
  for (const tag of ["v0.0.0-rehearsal.1", "v0.0.0-rehearsal.42"]) assert.equal(isRehearsalTag(tag), true, tag);
  for (const tag of ["v0.0.0-rehearsal.0", "v0.0.0-rehearsal.01", "v0.19.3", "v0.19.4-beta.1", "v0.0.1-rehearsal.1",
    "v0.0.0-rehearsal.1.2", "v0.0.0-rehearsal", "0.0.0-rehearsal.1", "v0.0.0-rehearsal.1\n"])
    assert.equal(isRehearsalTag(tag), false, JSON.stringify(tag));
  const workflow = readFileSync(new URL("../.github/workflows/package.yml", import.meta.url), "utf8");
  const skipped = [...workflow.matchAll(/steps\.kind\.outputs\.kind != 'rehearsal'/g)].length;
  assert.equal(skipped, 2, "the lineage check and the exact-commit CI check are the only steps a rehearsal skips");
  assert.match(workflow, /node scripts\/release-lineage\.mjs --stamp-rehearsal "\$TAG"/, "a rehearsal's downloads carry its own version");
});

test("no signing key reaches a rehearsal, and Windows signing runs for a version tag push only", () => {
  const { jobs } = parse(readFileSync(new URL("../.github/workflows/package.yml", import.meta.url), "utf8"));
  const notRehearsal = "needs.release-gate.outputs.rehearsal != 'true' && ";
  const gated = {
    android: ["HAS_ANDROID_KEY"],
    build: ["HAS_WINDOWS_SIGNING", "HAS_ANY_WINDOWS_SIGNING", "HAS_APPLE_CERTIFICATE", "HAS_NOTARY_KEY",
      "HAS_MAC_SIGNING_CERTIFICATE", "HAS_APPLE_SIGNING_IDENTITY", "MAC_SIGNING_REQUIRED", "HAS_ANY_MAC_SIGNING_SECRET"],
  };
  for (const [job, names] of Object.entries(gated))
    for (const name of names) {
      const expression = jobs[job].env[name];
      const start = name.includes("WINDOWS") ? "${{ github.event_name == 'push' && " + notRehearsal : "${{ " + notRehearsal;
      assert.ok(expression.startsWith(start), `${job}.${name} must start with ${start}: ${expression}`);
      // Everything after the gate is one term or one parenthesised group, so the gate covers all of it.
      const rest = expression.slice(start.length, -" }}".length);
      assert.ok(!/\|\|/.test(rest) || /^\([^()]*\)$/.test(rest), `${job}.${name} has an ungated alternative: ${expression}`);
    }
  // The keys themselves live in the "release" environment, opened to a final version tag only; every job
  // that names a signing secret asks for it, and only for a v-tag without a prerelease part.
  const releaseOnly = "${{ startsWith(github.ref, 'refs/tags/v') && !contains(github.ref_name, '-') && 'release' || '' }}";
  for (const [job, spec] of Object.entries(jobs))
    if (/secrets\.(ANDROID_|APPLE_|MAC_SIGNING_|SIGNPATH_)/.test(JSON.stringify(spec)))
      assert.equal(spec.environment, releaseOnly, `${job} names a signing secret outside the release environment`);
    else assert.equal(spec.environment, undefined, `${job} needs no signing environment`);
  const build = jobs.build.steps.find((entry) => entry.name === "Build the download").env;
  assert.equal(build.APPLE_SIGNING_IDENTITY, "${{ env.HAS_APPLE_SIGNING_IDENTITY == 'true' && secrets.APPLE_SIGNING_IDENTITY || '' }}");
  assert.equal(build.MAC_SIGNING_SHA1, "${{ env.HAS_MAC_SIGNING_CERTIFICATE == 'true' && secrets.MAC_SIGNING_SHA1 || '' }}");
  // Every step that holds a signing secret runs only behind one of the gated values above.
  for (const [job, { steps }] of Object.entries(jobs))
    for (const entry of steps ?? []) {
      const secrets = JSON.stringify({ env: entry.env, with: entry.with }).match(/secrets\.(ANDROID_KEYSTORE|APPLE_CERTIFICATE|APPLE_API_KEY_P8|MAC_SIGNING_P12|SIGNPATH)\w*/g);
      if (secrets) assert.match(String(entry.if), /env\.HAS_(ANDROID_KEY|APPLE_CERTIFICATE|NOTARY_KEY|MAC_SIGNING_CERTIFICATE|WINDOWS_SIGNING) == 'true'/, `${job}: ${entry.name ?? entry.run}`);
    }
});

test("the desktop downloads are packaged only for a release tag or by hand, never on a branch push or pull request", () => {
  const folder = new URL("../.github/workflows/", import.meta.url);
  const packaging = /package-desktop\.mjs|package:desktop|package-installers\.mjs/;
  let seen = 0;
  for (const name of readdirSync(folder).filter((file) => file.endsWith(".yml"))) {
    const text = readFileSync(new URL(name, folder), "utf8");
    if (!packaging.test(text)) continue;
    seen++;
    const on = parse(text).on;
    const events = Object.keys(on ?? {});
    assert.deepEqual(events.filter((event) => !["push", "workflow_dispatch"].includes(event)), [], `${name} packages on ${events}`);
    if (on.push) assert.deepEqual(Object.keys(on.push), ["tags"], `${name} packages on a branch push`);
  }
  assert.ok(seen >= 2, "package.yml and beta.yml are both checked");
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
