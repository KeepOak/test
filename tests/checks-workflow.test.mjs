import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

const read = async (name) => YAML.parse(await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));
const workflow = await read("checks.yml");
const fast = await read("pr-fast.yml");

/* A pull request's newer run cancels its older one; nothing else is ever cancelled or replaced. A group shared by the
   pushes to one branch let each merge into redesign/window cancel the run before it (no base run finished, so promote
   never ran), and GitHub drops all but the newest pending run of a group even without cancel-in-progress. */
test("the whole suite runs on every pull request and keeps every integration-trunk result", () => {
  assert.equal(workflow.concurrency.group,
    "${{ github.event_name == 'pull_request' && format('checks-pr-{0}', github.event.pull_request.number) || format('checks-run-{0}', github.run_id) }}");
  assert.equal(workflow.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
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

/* Every merge reaches the owner: a green push to redesign/window moves mac/cross-platform to that commit, fast-forward
   only, never forced and never as a merge. Mutations: drop `needs: [verify]` (an untested commit would go across), add
   `--force` or drop the ancestor check (mac/cross-platform could be rewritten) → this test goes red. */
test("a green push to redesign/window fast-forwards mac/cross-platform, and nothing else moves it", () => {
  const promote = workflow.jobs.promote;
  assert.deepEqual(promote.needs, ["verify"], "only after the whole suite passed");
  assert.match(promote.if, /github\.event_name == 'push'/);
  assert.match(promote.if, /github\.ref == 'refs\/heads\/redesign\/window'/);
  assert.deepEqual(promote.permissions, { contents: "write" }, "the one job that may write");
  assert.ok(promote["timeout-minutes"] <= 3);
  assert.ok(workflow.on.push.branches.includes("redesign/**"), "a push to redesign/window runs the suite");
  const script = promote.steps.map((step) => step.run ?? "").join("\n");
  assert.match(script, /merge-base --is-ancestor origin\/mac\/cross-platform "\$SHA"/, "refuses what is not a fast-forward");
  assert.match(script, /git push origin "\$SHA:refs\/heads\/mac\/cross-platform"/);
  assert.doesNotMatch(script, /--force|\s-f\s|\+\$SHA|git merge\s/, "never forced, never a merge commit");
  assert.equal(promote.env?.SHA ?? promote.steps.find((step) => step.env?.SHA).env.SHA, "${{ github.sha }}", "the commit this run tested");
  // Only the promote job asks for more than reading.
  for (const [name, job] of Object.entries(workflow.jobs)) if (name !== "promote") assert.equal(job.permissions, undefined, name);
  assert.deepEqual(workflow.permissions, { contents: "read" });
});
