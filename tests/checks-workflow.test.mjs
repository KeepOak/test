import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

const read = async (name) => YAML.parse(await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));
const workflow = await read("checks.yml");
const fast = await read("pr-fast.yml");

test("the whole suite runs on every pull request and keeps every integration-trunk result", () => {
  assert.equal(workflow.concurrency.group, "checks-${{ github.ref }}");
  assert.equal(workflow.concurrency["cancel-in-progress"],
    "${{ github.ref != 'refs/heads/main' && github.ref != 'refs/heads/mac/cross-platform' }}");
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.ok(workflow.on.push.branches.includes("mac/**"), "release and beta gates read push runs on mac/cross-platform");
  assert.equal(workflow.on.schedule[0].cron, "17 3 * * *");
});

test("the suite ends in one required job, and nothing in it can hold a run past fifteen minutes", () => {
  assert.deepEqual(workflow.jobs.verify.needs, ["test"]);
  assert.equal(workflow.jobs.verify.name, "verify-suite");
  assert.equal(workflow.jobs.verify.if, "always()");
  assert.ok(workflow.jobs.test["timeout-minutes"] <= 15);
  const run = workflow.jobs.test.steps.find((step) => /run-tests\.mjs/.test(step.run ?? ""));
  assert.ok(Number(run.env.BRANCH_TEST_FILE_TIMEOUT) > 0, "a file that never exits is ended and named");
});

test("the downloads and the phone apps are built for a release tag or by hand, never for a pull request or a landing", async () => {
  assert.equal(workflow.jobs.package, undefined);
  for (const name of ["package.yml", "mobile.yml"]) {
    const release = await read(name);
    assert.deepEqual(Object.keys(release.on).sort(), ["push", "workflow_dispatch"], name);
    assert.equal(release.on.push.branches, undefined, `${name} runs for tags only`);
    assert.ok(release.on.push.tags.length > 0, name);
  }
});

test("the fast pull-request gate has one job, a hard five-minute ceiling, and leaves broad changes to the suite", () => {
  assert.deepEqual(Object.keys(fast.jobs), ["verify-fast"]);
  assert.equal(fast.jobs["verify-fast"]["timeout-minutes"], 5);
  assert.ok(Object.hasOwn(fast.on, "pull_request"));
  assert.equal(fast.concurrency["cancel-in-progress"], true);
  const serialized = JSON.stringify(fast.jobs["verify-fast"]);
  assert.match(serialized, /select-affected-tests\.mjs/);
  assert.match(serialized, /npm ci/);
  assert.doesNotMatch(serialized, /actions\/workflows\/checks\.yml\/runs/, "the fast gate never waits on the suite");
  const broad = fast.jobs["verify-fast"].steps.find((step) => /full-required/.test(step.if ?? ""));
  assert.doesNotMatch(broad.run, /exit 1/);
});
