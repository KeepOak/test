import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import YAML from "yaml";

const read = async (name) => YAML.parse(await readFile(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8"));
const workflow = await read("checks.yml");

/* A pull request's newer run cancels its older one. Pushes to a branch share one group per branch (never main or a
   release branch, each of whose runs is kept) and are never cancelled
   in progress: the running base run finishes and promote follows it, and a newer merge replaces only the pending run,
   so a merge storm runs the whole suite once per batch. Everything else has a group of its own. */
test("the whole suite runs on every pull request and once per batch of merges into redesign/window", () => {
  assert.equal(workflow.concurrency.group,
    "${{ github.event_name == 'pull_request' && format('checks-pr-{0}', github.event.pull_request.number) || github.event_name == 'push' && github.ref != 'refs/heads/main' && !startsWith(github.ref, 'refs/heads/release/') && format('checks-base-{0}', github.ref) || format('checks-run-{0}', github.run_id) }}");
  assert.equal(workflow.concurrency["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  assert.equal(workflow.jobs.promote.concurrency["cancel-in-progress"], false);
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.ok(workflow.on.push.branches.includes("mac/**"), "release and beta gates read push runs on mac/cross-platform");
  assert.equal(workflow.on.schedule[0].cron, "17 3 * * *");
});

/* verify-suite is red unless the plan ran and every planned share passed; on a push there is no plan, so the whole
   suite ran, since promote follows it. Mutations: drop `test "$PLAN" = success` (a crashed plan skips every share and
   would pass), let a push run a plan (promote could follow a partial run) → this test goes red. */
test("the suite ends in one required job, and nothing in it can hold a run past fifteen minutes", () => {
  assert.deepEqual(workflow.jobs.verify.needs, ["plan", "reuse", "test", "local-voice"]);
  // RES-709: the real, offline speech proof is part of what green means, inside the same ceiling.
  assert.ok(workflow.jobs["local-voice"]["timeout-minutes"] <= 15);
  assert.match(JSON.stringify(workflow.jobs["local-voice"].steps), /BRANCH_REQUIRE_WHISPER/);
  assert.match(workflow.jobs.verify.steps.map((step) => step.run ?? "").join("\n"), /test "\$VOICE" = success/);
  // Off a pull request (merge queue, pushes, nightly) voice is always required; on one, only when the plan asked.
  assert.deepEqual(workflow.jobs["local-voice"].needs, ["plan", "reuse"]);
  assert.equal(workflow.jobs["local-voice"].if,
    "${{ !cancelled() && needs.reuse.outputs.run == '' && (needs.plan.result == 'skipped' || (needs.plan.result == 'success' && needs.plan.outputs.voice == 'true')) }}");
  assert.equal(workflow.jobs.plan.outputs.voice, "${{ steps.plan.outputs.voice }}");
  assert.match(workflow.jobs.verify.steps.map((step) => step.run ?? "").join("\n"),
    /if \[ "\$VOICE_PLANNED" = true \]; then\n\s*test "\$VOICE" = success[^\n]*\n\s*else\n\s*test "\$VOICE" = skipped/);
  assert.equal(workflow.jobs.verify.name, "verify-suite");
  // A cancelled run (replaced by a newer push, or waiting for a CI slot) stays cancelled rather than red.
  assert.equal(workflow.jobs.verify.if, "${{ !cancelled() }}");
  const verify = workflow.jobs.verify.steps.map((step) => step.run ?? "").join("\n");
  assert.match(verify, /if \[ "\$EVENT" = pull_request \]; then test "\$PLAN" = success; else test "\$PLAN" = skipped; MODE=full; VOICE_PLANNED=true; fi/);
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
  // Compiled code is shared by every process of a share, and no share installs the browser's system packages.
  assert.equal(run.env.NODE_COMPILE_CACHE, "${{ runner.temp }}/node-compile-cache");
  const install = workflow.jobs.test.steps.find((step) => /playwright install/.test(step.run ?? ""));
  assert.doesNotMatch(install.run, /--with-deps/);
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
  // Only the promote job may write to the repository. The queue's two jobs may cancel and rerun runs and label pull
  // requests, and nothing else; stale-group may only cancel its own merge-queue run; the test shares read.
  const queue = { contents: "read", actions: "write", "pull-requests": "write" };
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === "promote") continue;
    const expected = ["plan", "verify"].includes(name) ? queue : name === "stale-group" ? { contents: "read", actions: "write" }
      : name === "reuse" ? { contents: "read", actions: "read" } : undefined;
    assert.deepEqual(job.permissions, expected, name);
  }
  assert.deepEqual(workflow.permissions, { contents: "read" });
});

/* The queue: a pull-request run asks for a slot before it plans anything, and waits by cancelling itself (never by
   holding a runner); every run that finishes hands its slot on, even when a share failed. */
test("pull-request runs take a CI slot first, and every finished run hands its slot on", () => {
  const plan = workflow.jobs.plan.steps;
  const slot = plan.findIndex((step) => step.id === "slot");
  assert.ok(slot >= 0 && slot < plan.findIndex((step) => step.id === "plan"), "the slot is taken before planning");
  assert.match(plan[slot].run, /ci-queue\.mjs admit --run="\$RUN" --actor="\$ACTOR" --pr="\$PR"/);
  assert.equal(plan.find((step) => step.id === "plan").if, "steps.slot.outputs.held != 'true'");
  assert.equal(plan[slot].env.ACTOR, "${{ github.triggering_actor }}", "who started this attempt: the queue, or a person");
  const hand = workflow.jobs.verify.steps.find((step) => /ci-queue\.mjs restart/.test(step.run ?? ""));
  assert.equal(hand.if, "always()", "a failed share still hands its slot on");
  assert.equal(workflow.jobs.plan.if, "github.event_name == 'pull_request'", "a push to redesign/window is never held");
});

/* The build starts from the newest earlier build: only what changed is compiled, outputs whose source is gone are
   removed first (scripts/prune-dist.mjs), and the folders the copy steps fill are never taken from the cache. */
test("each share builds on the newest earlier build, and never trusts it as done", () => {
  const steps = workflow.jobs.test.steps;
  const build = steps.findIndex((step) => step.run === "npm run build");
  const cache = steps[build - 1];
  assert.match(cache.uses ?? "", /^actions\/cache@/);
  assert.deepEqual(cache.with.path.trim().split("\n"), ["dist", "!dist/handbook", "!dist/bundled-add-ons", "!dist/data", ".build-cache"]);
  assert.match(cache.with.key, /hashFiles\('src\/\*\*', 'tsconfig\.json', 'package-lock\.json', 'scripts\/build-ts\.mjs', 'scripts\/prune-dist\.mjs'\)/);
  assert.ok(cache.with.key.startsWith(cache.with["restore-keys"]), "the fallback is any earlier build of this system and Node");
  assert.match(readFileSync(new URL("../scripts/build-ts.mjs", import.meta.url), "utf8"), /pruneDist\(dist, src\)/, "orphans go first");
});

/* The one required check (branch protection on redesign/window: verify-suite, which the merge queue reads too) must be
   produced on both a pull request and a merge-queue group, and a merge-queue group or a push never waits on the
   pull-request queue: it has no plan job, so it is never held. Mutations: filter verify by event, drop merge_group,
   or let plan run on merge_group → red. */
test("verify-suite is produced for pull requests and merge-queue groups, and the merge queue is never held", () => {
  assert.ok(Object.hasOwn(workflow.on, "merge_group"));
  assert.ok(Object.hasOwn(workflow.on, "pull_request"));
  assert.equal(workflow.jobs.verify.name, "verify-suite");
  assert.doesNotMatch(workflow.jobs.verify.if, /event_name/);
  assert.equal(workflow.jobs.plan.if, "github.event_name == 'pull_request'");
  // Without a plan (merge queue, push) the test job falls back to the whole suite on every system.
  const fallback = workflow.jobs.test.strategy.matrix;
  assert.match(fallback, /"lane":"linux","os":"ubuntu-latest","shard":8,"total":8/);
  assert.match(fallback, /"lane":"windows","os":"windows-latest","shard":2,"total":2/);
  assert.match(fallback, /"lane":"macos"/);
});

/* A merge-queue group whose ref the queue deleted (a group ahead failed, so it was rebuilt on a new ref) cancels its
   own run instead of holding runners for a result nobody reads. Mutations: cancel on any API error, put the job in
   verify-suite's needs, or run it outside the merge queue → red. */
test("a merge-queue run whose group was dropped cancels itself, and only on a 404", () => {
  const job = workflow.jobs["stale-group"];
  assert.equal(job.if, "github.event_name == 'merge_group'");
  assert.equal(job.needs, undefined, "starts beside the shares, not after them");
  assert.ok(!workflow.jobs.verify.needs.includes("stale-group"));
  assert.ok(job["timeout-minutes"] <= 2);
  const script = job.steps.map((step) => step.run ?? "").join("\n");
  assert.match(script, /git\/ref\/\$\{GITHUB_REF#refs\/\}/);
  assert.match(script, /elif printf '%s' "\$out" \| grep -q "HTTP 404"; then\n\s*echo[^\n]*\n\s*gh run cancel "\$RUN"/);
  assert.equal(job.steps[0].env.RUN, "${{ github.run_id }}", "its own run, never another");
});

/* A landing ran the whole suite twice: in the merge queue, then again on the push of the same commit. The push reuses
   the queue's green result for the same tree, and only on a push to redesign/window; anything else runs the suite.
   Mutations: skip the shares without a reused run, reuse on a pull request or merge-queue run, or let verify-suite
   pass a reused push whose shares ran or failed → red. */
test("a push to redesign/window reuses the merge queue's whole-suite result for the same tree, and nothing else does", () => {
  const reuse = workflow.jobs.reuse;
  assert.equal(reuse.if, "github.event_name == 'push' && github.ref == 'refs/heads/redesign/window'");
  assert.match(reuse.steps.at(-1).run, /ci-reuse\.mjs --sha="\$SHA"/);
  assert.equal(reuse.steps.at(-1).env.SHA, "${{ github.sha }}");
  assert.equal(reuse.outputs.run, "${{ steps.find.outputs.run }}");
  assert.deepEqual(workflow.jobs.test.needs, ["plan", "reuse"]);
  assert.match(workflow.jobs.test.if, /^\$\{\{ !cancelled\(\) && needs\.reuse\.outputs\.run == '' && /);
  const verify = workflow.jobs.verify.steps.map((step) => step.run ?? "").join("\n");
  assert.equal(workflow.jobs.verify.steps[0].env.REUSED, "${{ needs.reuse.outputs.run }}");
  assert.match(verify, /if \[ -n "\$REUSED" \]; then\n\s*test "\$EVENT" = push\n\s*MODE=reused\n\s*VOICE_PLANNED=false/);
  assert.match(verify, /if \[ "\$MODE" = reused \]; then\n\s*test "\$TEST" = skipped/);
  // promote still follows verify-suite's own success on that push run, so the updater's newest green push is unchanged.
  assert.deepEqual(workflow.jobs.promote.needs, ["verify"]);
});
