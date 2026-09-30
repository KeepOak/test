// The real-GitHub half of scripts/selfdev-proof.mjs: Branch changes its own source (KeepOak/Branch-Agent) from an
// isolated engine, proposing only to a selfdev-proof/base-<stamp> scratch line made here from redesign/window. Beta
// never builds that line and nothing is proposed to redesign/window. The pull request is closed afterwards if it is
// still open; the scratch branches are left for the lead to remove.
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startEngine } from "../tests/fixtures/selfdev-harness.mjs";

const repo = "KeepOak/Branch-Agent";
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();

/** The knob the owner names for this run, and the test file that proves it. */
const request = (knob, base, name) => [
  `Branch has no setting for ${knob.what}. Add it to Branch itself as a Settings knob: ${knob.how}`,
  `Work only through branch.prepare_source_change with name "${name}", repository https://github.com/${repo}.git and base "${base}" (a scratch line; never redesign/window).`,
  `Give its contract allowedPaths ["**"] (commands run at the worktree root, and it changes at least ${knob.paths.join(", ")}), permissions ["files.write", "files.edit", "shell.execute", "git.commit", "github.pull_request_from_changes", "branch.finish_source_change"], expectedTests ["${knob.test}"], a one-sentence definitionOfDone, sideEffects ["a pull request into ${base}"] and rollbackPlan "close the pull request".`,
  "Read each file before you change it. In the worktree, run `npm ci` once, then `node scripts/review.mjs --jobs 1 " + knob.test + "` (never npm test, never node --test without a file) until every step passes, and `node scripts/check-docs.mjs` so the new setting is documented.",
  `Commit with a Conventional Commits message, then open the draft pull request with github.pull_request_from_changes with base "${base}" (its summary says why to merge it and lists each command you ran with its pass and fail counts).`,
  "Then wait with github.wait_for_checks (seconds 570) and call it again while it says pending. When it says passed, call branch.finish_source_change with the worktree, the repository and the pull request number. If a check fails, say which and stop: do not merge.",
  "Finish with the pull request number, its address and whether it merged.",
].join("\n\n");

export async function githubProof({ root, model, stamp, log, connection, roomToWork, defaultTrunkConversation, evidence, health }) {
  const base = `selfdev-proof/base-${stamp.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`, name = `proof-${stamp.slice(5, 16).toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  const knob = {
    what: "how many tokens one task may use (it is fixed at 200,000 in src/knobs/apply.ts taskBudget)",
    how: "add `maxTaskTokens` to the task limits card in src/knobs/settings.ts (whole tokens, 20,000 to 20,000,000, null meaning the built-in 200,000), have taskBudget in src/knobs/apply.ts use it, update any test that lists the limits card's fields, and document it in docs/configuration.md next to maxSteps.",
    paths: ["src/knobs/settings.ts", "src/knobs/apply.ts", "docs/configuration.md", "tests/knob-task-tokens.test.mjs"],
    test: "tests/knob-task-tokens.test.mjs",
  };

  const head = gh("api", `repos/${repo}/git/ref/heads/redesign/window`, "--jq", ".object.sha");
  gh("api", "-X", "POST", `repos/${repo}/git/refs`, "-f", `ref=refs/heads/${base}`, "-f", `sha=${head}`);
  await log({ step: "scratch-base", base, from: head });
  const token = gh("auth", "token");
  // GitHub is shared by every lane: checks are looked at once a minute, never faster.
  const engine = await startEngine(root, { token, npm: true, githubPollSeconds: 60, ...connection() });
  roomToWork(engine.app);
  const results = [], poller = setInterval(() => void health(engine, results), 5000);
  let summary;
  try {
    const sessionId = await defaultTrunkConversation(engine);
    const prompt = request(knob, base, name);
    await log({ step: "start", mode: "github", model, base, name, prompt });
    const began = Date.now();
    const started = await engine.api("run", { prompt, sessionId });
    const runId = started.body?.id;
    const run = runId ? engine.app.store.run(runId) : null;
    await health(engine, results);
    const pulls = JSON.parse(gh("api", `repos/${repo}/pulls?state=all&base=${encodeURIComponent(base)}&per_page=10`)).map((pull) => ({
      number: pull.number, url: pull.html_url, head: pull.head.ref, headSha: pull.head.sha, state: pull.state, merged: !!pull.merged_at, mergeSha: pull.merge_commit_sha }));
    summary = { mode: "github", model, base, status: run?.status ?? `http ${started.status}`, output: run?.output?.slice(0, 2000),
      elapsedSeconds: Math.round((Date.now() - began) / 1000), ...(run ? evidence(engine, runId) : {}), pulls,
      health: { checks: results.length, allOk: results.every((status) => status === 200) } };
    // REST only: GitHub's GraphQL allowance is shared by every lane.
    for (const pull of pulls) if (pull.state === "open") { gh("api", "-X", "PATCH", `repos/${repo}/pulls/${pull.number}`, "-f", "state=closed"); pull.closedAfterwards = true; }
  } finally {
    clearInterval(poller);
    await engine.close();
  }
  const merged = summary.pulls.find((pull) => pull.merged);
  const passed = summary.status === "completed" && summary.asked?.length === 0 && !!merged && summary.health.allOk;
  await log({ step: "summary", passed, ...summary });
  await writeFile(join(root, "summary.json"), JSON.stringify({ passed, ...summary }, null, 2));
  return passed;
}
