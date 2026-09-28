import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

const read = async (name) => YAML.parse(await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));
const workflow = await read("checks.yml");

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

/* verify-suite is red unless the plan ran and every planned share passed; on a push there is no plan, so the whole
   suite ran, since promote follows it. Mutations: drop `test "$PLAN" = success` (a crashed plan skips every share and
   would pass), let a push run a plan (promote could follow a partial run) → this test goes red. */
test("the suite ends in one required job, and nothing in it can hold a run past fifteen minutes", () => {
  assert.deepEqual(workflow.jobs.verify.needs, ["plan", "test", "local-voice"]);
  // RES-709: the real, offline speech proof is part of what green means, inside the same ceiling.
  assert.ok(workflow.jobs["local-voice"]["timeout-minutes"] <= 15);
  assert.match(JSON.stringify(workflow.jobs["local-voice"].steps), /BRANCH_REQUIRE_WHISPER/);
  assert.match(workflow.jobs.verify.steps.map((step) => step.run ?? "").join("\n"), /test "\$VOICE" = success/);
  assert.equal(workflow.jobs.verify.name, "verify-suite");
  assert.equal(workflow.jobs.verify.if, "always()");
  const verify = workflow.jobs.verify.steps.map((step) => step.run ?? "").join("\n");
  assert.match(verify, /if \[ "\$EVENT" = pull_request \]; then test "\$PLAN" = success; else test "\$PLAN" = skipped; MODE=full; fi/);
  assert.equal(workflow.jobs.plan.if, "github.event_name == 'pull_request'", "a push always runs the whole suite");
  assert.match(verify, /test "\$TEST" = success/);
  // One command per line: bash -e does not stop on the left side of `a && b`.
  assert.match(verify, /test "\$EVENT" = pull_request\n\s*test "\$TEST" = skipped/, "no test is skipped outside a docs-only pull request");
  assert.doesNotMatch(verify, /&&/);
  assert.match(verify, /PARTIAL/);
  assert.equal(workflow.jobs.verify.steps[0].env.PLAN, "${{ needs.plan.result }}");
  assert.ok(workflow.jobs.test["timeout-minutes"] <= 15);
  assert.ok(workflow.jobs.plan["timeout-minutes"] <= 5);
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

test("PR Fast Checks is folded into the plan job: one workflow per pull request", async () => {
  await assert.rejects(readFile(new URL("../.github/workflows/pr-fast.yml", import.meta.url)), /ENOENT/);
  const plan = workflow.jobs.plan.steps.map((step) => step.run ?? "").join("\n");
  assert.match(plan, /select-affected-tests\.mjs --event="\$EVENT" --base-ref="\$BASE_REF"/);
  assert.match(plan, /git diff --check HEAD\^1 HEAD/);
  assert.match(plan, /check-docs\.mjs/);
  assert.equal(workflow.jobs.plan.steps[0].with["fetch-depth"], 2, "the merge ref and the commit it merges onto");
  assert.match(workflow.jobs.test.if, /needs\.plan\.result == 'skipped' \|\| \(needs\.plan\.result == 'success' && needs\.plan\.outputs\.mode != 'docs'\)/);
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
