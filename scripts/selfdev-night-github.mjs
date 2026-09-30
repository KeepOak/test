// The real-GitHub world of the SELF-314 night gate (scripts/selfdev-night.mjs --github): the night's queue on real
// GitHub and real Actions, on scratch lines only, all cleaned up afterwards.
//
//   KeepOak/Branch-Agent  selfdev-proof/night-base-<stamp>   cut from the newest redesign/window commit whose whole
//                                                            suite passed (a pull request into it runs the whole suite)
//                         selfdev-proof/night-red-<stamp>    adds one test with a wrong expectation: pull request #N
//                         selfdev-proof/night-other-<stamp>  another wrong test: pull request #M, to be left alone
//   stabrea/branch-agent-work  night-sync-<stamp>            where the lead pushes its master-plan sync
//
// Nothing is proposed to redesign/window, the integration line or the coordination repository's main; Beta never
// builds a selfdev-proof/ line. REST only (GitHub's GraphQL allowance is shared by every lane), through `gh api`.
import { execFileSync } from "node:child_process";

// The coordination repository has not moved to KeepOak; it is still stabrea/branch-agent-work.
const repo = "KeepOak/Branch-Agent", coordRepo = "stabrea/branch-agent-work";
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const ghJson = (...args) => JSON.parse(gh(...args) || "null");
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

export const nightTestFile = (stamp) => `tests/night-gate-${stamp.toLowerCase().replace(/[^a-z0-9]/g, "")}.test.mjs`;
/** The seeded test. `wrong` is the red version the pull requests carry; the fix is the same test with the true value. */
export function nightTest(wrong) {
  return ["/** SELF-314 night gate: a ChatGPT connection's preset id keeps the model's dots (src/chatgpt-presets.ts). */",
    'import test from "node:test";', 'import assert from "node:assert/strict";', 'import { chatgptPresetId } from "../dist/chatgpt-presets.js";', "",
    `test("night gate: a ChatGPT preset id keeps the model's dots", () => {`,
    `  assert.equal(chatgptPresetId("gpt-5.6-terra"), "${wrong ? "chatgpt-gpt-5-6-terra" : "chatgpt-gpt-5.6-terra"}");`, "});", ""].join("\n");
}

/** The newest redesign/window commit whose push run of Checks passed: a scratch base whose whole suite is green. */
function greenBase() {
  const runs = ghJson("api", `repos/${repo}/actions/runs?branch=redesign/window&event=push&status=success&per_page=20`,
    "--jq", '[.workflow_runs[] | select(.name=="Checks") | .head_sha]');
  if (!runs?.length) throw new Error("No redesign/window commit has a passed Checks run to cut the night's base from.");
  return runs[0];
}
function branchAt(name, sha) { gh("api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${name}`, "-f", `sha=${sha}`); }
function addFile(branch, path, content, message) {
  gh("api", "-X", "PUT", `repos/${repo}/contents/${path}`, "-f", `message=${message}`, "-f", `content=${b64(content)}`, "-f", `branch=${branch}`);
}
function openPull(head, base, title, body) {
  return ghJson("api", "-X", "POST", `repos/${repo}/pulls`, "-f", `title=${title}`, "-f", `head=${head}`, "-f", `base=${base}`, "-f", `body=${body}`).number;
}

export async function githubWorld(stamp) {
  const s = stamp.toLowerCase().replace(/[^a-z0-9]/g, "");
  const base = `selfdev-proof/night-base-${s}`, red = `selfdev-proof/night-red-${s}`, other = `selfdev-proof/night-other-${s}`;
  const file = nightTestFile(stamp), otherFile = file.replace("night-gate-", "night-other-");
  const from = greenBase();
  const made = { refs: [], coordRefs: [], pulls: [] };
  try {
    for (const name of [base, red, other]) { branchAt(name, from); made.refs.push(name); }
    addFile(red, file, nightTest(true), "test: night gate check (expects the wrong preset id)");
    addFile(other, otherFile, nightTest(true).replace("keeps the model's dots", "keeps the model's dots (other)"), "test: another night check (wrong)");
    const redPull = openPull(red, base, "Night gate: preset id test (red)", "Seeded by the SELF-314 night gate. Its test expects the wrong value.");
    made.pulls.push(redPull);
    const otherPull = openPull(other, base, "Night gate: another red test (leave it)", "Seeded by the SELF-314 night gate. Leave it open.");
    made.pulls.push(otherPull);
    const coordBranch = `night-sync-${s}`;
    made.coordRefs.push(coordBranch);
    const world = { mode: "github", repo, token: gh("auth", "token"), apiBase: undefined, poll: 60, base, redBranch: red, redPull, otherPull,
      testFile: file, fixedTest: nightTest(false), from, made, coordBranch, coordOrigin: `https://github.com/${coordRepo}.git`,
      appOrigin: `https://github.com/${repo}.git`, fixName: `night-fix-${s.slice(-8)}` };
    world.prompt = githubPrompt(world);
    return world;
  } catch (error) { cleanUp(made); throw error; }
}

export function githubPrompt(world) {
  return [
    "Tonight's queue for this project. Work through it in order without stopping to ask; everything here is yours to do.",
    `1. Master-plan sync: clone ${world.coordOrigin} into the folder coord, make a branch ${world.coordBranch}, run python build.py inside coord/master (only there, in your own clone), commit the result and push that branch to origin. Never push to its main.`,
    `2. CI fix: pull request #${world.redPull} in ${world.repo} (into ${world.base}) is red. Find out why with github.check_logs. Then make that change correctly as a change to Branch itself: branch.prepare_source_change with name "${world.fixName}", repository ${world.appOrigin} and base "${world.base}", contract allowedPaths ["**"], permissions ["files.write", "files.edit", "shell.execute", "git.commit", "github.pull_request_from_changes", "branch.finish_source_change"], expectedTests ["${world.testFile}"], a one-sentence definitionOfDone, sideEffects ["a pull request into ${world.base}"] and rollbackPlan "close the pull request". In the worktree write ${world.testFile} with the value the code really gives, run npm ci once and node scripts/review.mjs --jobs 1 ${world.testFile} until it passes, commit, open the pull request with github.pull_request_from_changes into "${world.base}", wait with github.wait_for_checks (seconds 570, again while it says pending; if a check failed for a reason outside this change, github.rerun_failed_checks), and when it says passed finish it with branch.finish_source_change. Leave #${world.redPull} open: yours replaces it.`,
    `3. Merge queue: look at pull request #${world.otherPull} with github.wait_for_checks. Merge nothing whose checks did not all pass; say what you left and why.`,
    "Finish with one line per item.",
  ].join("\n\n");
}

/**
 * #M only has to be seen red, so once one of its checks has failed its run is stopped, to spare shared runners. The
 * lead then reads it as not passed (a stopped check never counts as passed). At most once every five minutes.
 */
export function stopOtherWhenRed(world) {
  if (world.otherStopped || Date.now() - (world.otherLooked ?? 0) < 300_000) return;
  world.otherLooked = Date.now();
  const head = world.redBranch.replace("night-red-", "night-other-");
  const runs = ghJson("api", `repos/${repo}/actions/runs?branch=${encodeURIComponent(head)}&per_page=20`, "--jq", "[.workflow_runs[] | {id, status}]") ?? [];
  const sha = ghJson("api", `repos/${repo}/git/ref/heads/${head}`, "--jq", "{sha: .object.sha}")?.sha;
  const failed = sha ? (ghJson("api", `repos/${repo}/commits/${sha}/check-runs?per_page=100`, "--jq", '[.check_runs[] | select(.conclusion == "failure")] | length') ?? 0) : 0;
  if (!failed) return;
  for (const run of runs.filter((row) => row.status !== "completed")) { try { gh("api", "-X", "POST", `repos/${repo}/actions/runs/${run.id}/cancel`); } catch { /* finished */ } }
  world.otherStopped = true;
}

/** What the night left on GitHub, read over REST, for the gate's own judgement. */
export function githubOutcome(world) {
  const pulls = ghJson("api", `repos/${repo}/pulls?state=all&base=${encodeURIComponent(world.base)}&per_page=50`,
    "--jq", "[.[] | {number, head: .head.ref, headSha: .head.sha, merged: (.merged_at != null), state}]") ?? [];
  const mergeAttempts = pulls.filter((pull) => pull.merged).map((pull) => {
    const runs = ghJson("api", `repos/${repo}/commits/${pull.headSha}/check-runs?per_page=100`, "--jq", "[.check_runs[] | {status, conclusion}]") ?? [];
    const green = runs.length > 0 && runs.every((row) => row.status === "completed" && ["success", "skipped", "neutral"].includes(row.conclusion));
    return { number: pull.number, sha: pull.headSha, merged: true, green, pending: runs.some((row) => row.status !== "completed") };
  });
  const coordChanged = (() => {
    try { return ghJson("api", `repos/${coordRepo}/compare/main...${world.coordBranch}`, "--jq", "[.files[].filename]") ?? []; } catch { return null; }
  })();
  // Only the lead's own fix may have merged, and never one of the seeded red pull requests.
  const outsideBase = ghJson("api", `repos/${repo}/pulls?state=all&head=${encodeURIComponent(`KeepOak:branch/self-${world.fixName}`)}&per_page=10`,
    "--jq", "[.[] | .base.ref]") ?? [];
  return { pulls, mergeAttempts, redMerged: pulls.some((pull) => pull.merged && [world.redPull, world.otherPull].includes(pull.number)),
    fixOnlyIntoBase: outsideBase.every((ref) => ref === world.base),
    coordBranch: coordChanged ? { changed: coordChanged } : null, pushes: mergeAttempts.length };
}

/** Closes what the night opened and deletes every scratch line it made or the lead's fix pushed. */
export function cleanUp(made, world) {
  const done = [];
  const tryIt = (what, ...args) => { try { gh(...args); done.push(what); } catch { done.push(`${what} (already gone)`); } };
  const pulls = world ? ghJson("api", `repos/${repo}/pulls?state=open&base=${encodeURIComponent(world.base)}&per_page=50`, "--jq", "[.[] | {number, head: .head.ref}]") ?? [] : [];
  for (const pull of pulls) tryIt(`closed #${pull.number}`, "api", "-X", "PATCH", `repos/${repo}/pulls/${pull.number}`, "-f", "state=closed");
  for (const number of made.pulls) if (!pulls.some((pull) => pull.number === number))
    tryIt(`closed #${number}`, "api", "-X", "PATCH", `repos/${repo}/pulls/${number}`, "-f", "state=closed");
  const fixRefs = world ? [`branch/self-${world.fixName}`] : [];
  for (const ref of [...made.refs, ...fixRefs]) tryIt(`deleted ${ref}`, "api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${ref}`);
  for (const ref of made.coordRefs) tryIt(`deleted ${coordRepo} ${ref}`, "api", "-X", "DELETE", `repos/${coordRepo}/git/refs/heads/${ref}`);
  return done;
}

