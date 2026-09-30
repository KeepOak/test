// A push to redesign/window after the merge queue lands a group: the queue's own run (event merge_group) already ran
// the whole suite on every system on the very commit that lands, so the push run reuses that result instead of running
// the suite a second time. Only a completed, successful Checks run of this repository whose commit has exactly this
// tree counts (the same commit, or another with the same tree); anything else, or any failure to read, runs the whole
// suite. The push run itself still ends green or red, so promote and the Beta updater (src/desktop/dev-build.ts
// newestGreen, which reads the newest successful Checks push run on redesign/window) find the same commit as before.
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKFLOW_PATH = ".github/workflows/checks.yml";

/** Whether `run` is a finished, green merge-queue Checks run of `repo`. */
export function trustedGroupRun(run, repo) {
  return run?.path === WORKFLOW_PATH && run.event === "merge_group" && run.status === "completed"
    && run.conclusion === "success" && run.repository?.full_name === repo && run.head_repository?.full_name === repo
    && Number.isSafeInteger(run.id) && run.id > 0 && /^[0-9a-f]{40}$/.test(run.head_sha ?? "");
}

/**
 * The merge-queue run whose result this push can reuse: newest first, the same commit, else a commit with the same
 * tree (`treeOf(sha)` answers a commit's tree, or null when unknown). Null when there is none.
 */
export async function reusableRun(runs, { sha, tree, repo, treeOf }) {
  const trusted = runs.filter((run) => trustedGroupRun(run, repo)).sort((a, b) => b.id - a.id);
  const same = trusted.find((run) => run.head_sha === sha);
  if (same) return same;
  if (!tree) return null;
  for (const run of trusted) if (await treeOf(run.head_sha) === tree) return run;
  return null;
}

function github(token, repo) {
  return async (path) => {
    const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
    if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
    return response.json();
  };
}

async function main() {
  const sha = process.argv.slice(2).find((value) => value.startsWith("--sha="))?.slice(6) ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`Not a commit: ${sha}`);
  const repo = process.env.GITHUB_REPOSITORY;
  const api = github(process.env.GH_TOKEN, repo);
  const treeOf = async (commit) => (await api(`git/commits/${commit}`))?.tree?.sha ?? null;
  const list = (query) => api(`actions/workflows/checks.yml/runs?event=merge_group&per_page=10${query}`)
    .then((body) => body?.workflow_runs ?? []);
  // The queue merges once verify-suite passes, which can be seconds before the run itself is marked completed.
  let own = await list(`&head_sha=${sha}`);
  for (let wait = 0; wait < 8 && own.some((run) => run.status !== "completed"); wait += 1) {
    await new Promise((done) => setTimeout(done, 15_000));
    own = await list(`&head_sha=${sha}`);
  }
  const runs = [...own, ...await list("&status=success")];
  const run = await reusableRun(runs, { sha, tree: await treeOf(sha), repo, treeOf });
  if (!run) return console.log(`No green merge-queue run has the tree of ${sha}; the whole suite runs.`);
  console.log(`::notice title=Whole suite already passed::Merge-queue run ${run.id} (${run.html_url}) passed the whole suite on this exact tree; it is not run again.`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run.id}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // Nothing found, or nothing readable: the whole suite runs, as it always did.
    console.log(`::warning title=Merge-queue result not reused::${error.message}`);
  });
}
