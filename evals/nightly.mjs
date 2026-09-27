/**
 * The nightly run. It fast-forwards a dedicated clean clone to origin/redesign/window, builds, runs the full suite on
 * the local model (and on a model on another machine when nightly.local.json names one), and commits the scorecards,
 * with a page putting the night's models side by side, into the private coordination repo. No part of the evals runs in a pull
 * request's checks (CI is kept to 15 minutes): this can take many minutes and needs the GPU.
 *
 * Run by hand:  node evals/nightly.mjs
 * Scheduled:    the Windows task BranchEvalsNightly (03:30 daily) runs evals/run-nightly.cmd in the runner clone, which
 *               runs this file, and evals/nightly-stub.cjs if this fails before writing anything. See evals/README.md,
 *               "Installing the nightly run".
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sideBySideMarkdown } from "./lib/report.mjs";
import { openTunnel } from "./lib/tunnel.mjs";

const RUNNER = process.env.EVAL_RUNNER_DIR ?? "C:/Users/bishi/Code/branch-evals-runner";
const COORD = process.env.EVAL_COORD_DIR ?? "C:/Users/bishi/Code/branch-agent-work-coord";
const MODEL = process.env.EVAL_MODEL ?? "ollama:qwen2.5:7b";
const evalsResults = join(COORD, "evals");
const date = new Date().toISOString().slice(0, 10);

function run(cmd, args, cwd, { quiet = false, env = {} } = {}) {
  // npm is npm.cmd on Windows, which Node starts only through a shell; every argument here is a fixed literal.
  const shell = cmd === "npm" && process.platform === "win32";
  const r = shell ? spawnSync([cmd, ...args].join(" "), { cwd, env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true, shell })
    : spawnSync(cmd, args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true });
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
  git(["add", "evals"], COORD);
  const status = git(["status", "--porcelain", "evals"], COORD).stdout ?? "";
  if (!status.trim()) { process.stdout.write("nothing to commit\n"); return; }
  // Commit first (only evals/, never what another agent left staged), then catch up: a pull before the commit refused
  // to rebase over the scorecard the run had just written, so a push racing another agent's would leave it only local.
  git(["commit", "-m", message, "--", "evals"], COORD);
  git(["pull", "--rebase"], COORD); // other agents write to this repo; never force-push
  const push = git(["push"], COORD);
  if (push.status !== 0) process.stderr.write("push failed; the scorecard is committed locally in the coord repo\n");
}

async function main() {
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
  const smoke = run("node", ["--test", "--test-concurrency=1", "evals/smoke.test.mjs", "evals/nightly.test.mjs"], RUNNER);
  if (smoke.status !== 0) { writeStub("the harness tests (evals/smoke.test.mjs, evals/nightly.test.mjs) failed on redesign/window; see the runner output"); commitAndPush(`evals(${date}): harness smoke failed`); process.exit(1); }

  // 5. The full suite on each model, each into its own folder (its own page, with a trend against its previous night),
  //    then one page for the night with every model side by side.
  const cards = [], links = [];
  for (const model of nightModels()) {
    const { card, label } = await runModel(model);
    cards.push(card);
    links.push(`[${label}](${folderOf(model.name)}/${date}.md)`);
  }
  if (!cards.some((card) => !card.missing)) { writeStub(`no model's suite wrote a scorecard (${cards.map((c) => `${c.model.label}: ${c.missing}`).join("; ")})`); process.exitCode = 1; }
  else {
    writeFileSync(join(evalsResults, `${date}.md`), sideBySideMarkdown(date, cards, links));
    writeFileSync(join(evalsResults, `${date}.json`), JSON.stringify({ kind: "branch-evals-night", version: 1, date, cards }, null, 2));
  }
  commitAndPush(`evals(${date}): nightly scorecard on ${cards.map((c) => c.model.label).join(" and ")}`);
}

/* The models of a night: the one on this computer (EVAL_MODEL), plus a model on another machine when the runner's
   nightly.local.json (or EVAL_NIGHTLY_CONFIG) names one under "remote" (evals/README.md, "A model on another machine"). */
function nightModels() {
  const models = [{ name: MODEL }];
  const file = process.env.EVAL_NIGHTLY_CONFIG ?? join(RUNNER, "nightly.local.json");
  const remote = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).remote : null;
  if (remote?.model) models.push({ name: remote.model, remote });
  return models;
}
const folderOf = (name) => name.replace(/[^a-z0-9.]+/gi, "-").toLowerCase();

/* One model's suite. A remote model is reached through an SSH forward that is open only while its suite runs. */
async function runModel(model) {
  const out = join(evalsResults, folderOf(model.name));
  mkdirSync(out, { recursive: true });
  let tunnel = null, env = {};
  if (model.remote) {
    try { tunnel = await openTunnel(model.remote); env = { EVAL_OLLAMA_URL: tunnel.url }; }
    catch (error) { return missing(model, `could not reach ${model.remote.sshHost}: ${error.message}`); }
  }
  try {
    const outcome = run("node", ["evals/run.mjs", "--model", model.name, "--out", out], RUNNER, { env });
    const file = join(out, `${date}.json`);
    if (!existsSync(file)) return missing(model, `the run wrote no scorecard (exit ${outcome.status})`);
    const card = JSON.parse(readFileSync(file, "utf8"));
    return { card, label: card.model.label };
  } finally {
    await tunnel?.close();
  }
}
function missing(model, why) {
  process.stdout.write(`${model.name}: did not run: ${why}\n`);
  return { card: { model: { id: model.name, label: model.name }, missing: why }, label: model.name };
}

main().catch((error) => { writeStub(`the launcher threw: ${String(error).slice(0, 200)}`); try { commitAndPush(`evals(${date}): launcher error`); } catch { /* offline */ } process.exit(1); });
