/**
 * The nightly run. It fast-forwards a dedicated clean clone to origin/redesign/window, builds, runs the full suite on
 * the local model, and commits the scorecard into the private coordination repo. No part of the evals runs in a pull
 * request's checks (CI is kept to 15 minutes): this can take many minutes and needs the GPU.
 *
 * Run by hand:  node evals/nightly.mjs
 * Scheduled:    the Windows task BranchEvalsNightly (03:30 daily) runs evals/run-nightly.cmd in the runner clone, which
 *               runs this file, and evals/nightly-stub.cjs if this fails before writing anything. See evals/README.md,
 *               "Installing the nightly run".
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER = process.env.EVAL_RUNNER_DIR ?? "C:/Users/bishi/Code/branch-evals-runner";
const COORD = process.env.EVAL_COORD_DIR ?? "C:/Users/bishi/Code/branch-agent-work-coord";
const MODEL = process.env.EVAL_MODEL ?? "ollama:qwen2.5:7b";
const evalsResults = join(COORD, "evals");
const date = new Date().toISOString().slice(0, 10);

function run(cmd, args, cwd, { quiet = false } = {}) {
  // npm is npm.cmd on Windows, which Node starts only through a shell; every argument here is a fixed literal.
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", windowsHide: true, shell: cmd === "npm" && process.platform === "win32" });
  if (!quiet) process.stdout.write(`$ ${cmd} ${args.join(" ")}\n${(r.stdout ?? "").slice(-800)}${r.stderr ? "\n" + r.stderr.slice(-800) : ""}\n`);
  return r;
}

function git(args, cwd) { return run("git", args, cwd); }

/** A plain line into coord/evals/<date>.md when the suite itself could not run, so a silent night is never mistaken
 *  for a green one. Committed and pushed just like a real scorecard. */
function writeStub(reason) {
  mkdirSync(evalsResults, { recursive: true });
  writeFileSync(join(evalsResults, `${date}.md`), `# Branch evals — ${date}\n\n**Did not run:** ${reason}\n`);
}

function commitAndPush(message) {
  git(["pull", "--rebase"], COORD); // other agents write to this repo; never force-push
  git(["add", "evals"], COORD);
  const status = git(["status", "--porcelain", "evals"], COORD).stdout ?? "";
  if (!status.trim()) { process.stdout.write("nothing to commit\n"); return; }
  git(["commit", "-m", message], COORD);
  const push = git(["push"], COORD);
  if (push.status !== 0) process.stderr.write("push failed; the scorecard is committed locally in the coord repo\n");
}

function main() {
  if (!existsSync(RUNNER)) { process.stderr.write(`runner clone missing at ${RUNNER}; see evals/README.md\n`); process.exit(2); }

  // 1. Fast-forward the clean clone to the integration branch. Fetch, then a ff-only merge so a diverged clone fails
  //    loudly rather than running stale or rewriting anything.
  git(["fetch", "origin", "redesign/window"], RUNNER);
  git(["checkout", "redesign/window"], RUNNER);
  const ff = git(["merge", "--ff-only", "origin/redesign/window"], RUNNER);
  if (ff.status !== 0) { writeStub("the runner clone could not fast-forward to origin/redesign/window (diverged); left for a human"); commitAndPush(`evals(${date}): could not fast-forward`); process.exit(1); }

  // 2. The suite lives in evals/. Until this PR merges, redesign/window has no evals/ — say so and stop, rather than
  //    a mysterious empty night.
  if (!existsSync(join(RUNNER, "evals", "run.mjs"))) { writeStub("evals/ is not on redesign/window yet (this PR has not merged)"); commitAndPush(`evals(${date}): suite not merged yet`); process.exit(1); }

  // 3. Build (install only when the lockfile moved).
  const ci = git(["diff", "--quiet", "HEAD@{1}", "HEAD", "--", "package-lock.json"], RUNNER);
  if (ci.status !== 0 || !existsSync(join(RUNNER, "node_modules"))) run("npm", ["ci"], RUNNER);
  const build = run("npm", ["run", "build"], RUNNER);
  if (build.status !== 0) { writeStub("the build failed on redesign/window; see the runner clone's output"); commitAndPush(`evals(${date}): build failed`); process.exit(1); }

  // 4. The harness's own smoke test first (evals/smoke.test.mjs, a scripted stand-in, seconds): a broken harness is said
  //    as such rather than scored as a night of model failures.
  const smoke = run("node", ["--test", "--test-concurrency=1", "evals/smoke.test.mjs"], RUNNER);
  if (smoke.status !== 0) { writeStub("the harness smoke test (evals/smoke.test.mjs) failed on redesign/window; see the runner output"); commitAndPush(`evals(${date}): harness smoke failed`); process.exit(1); }

  // 5. Run the full suite; the scorecard (JSON + MD, with a trend against the previous night) lands in the coord repo.
  const outcome = run("node", ["evals/run.mjs", "--model", MODEL, "--out", evalsResults], RUNNER);
  if (!existsSync(join(evalsResults, `${date}.md`))) { writeStub(`the run wrote no scorecard (exit ${outcome.status}); see the runner output`); process.exitCode = 1; }
  commitAndPush(`evals(${date}): nightly scorecard on ${MODEL}`);
}

try { main(); } catch (error) { writeStub(`the launcher threw: ${String(error).slice(0, 200)}`); try { commitAndPush(`evals(${date}): launcher error`); } catch { /* offline */ } process.exit(1); }
void fileURLToPath;
