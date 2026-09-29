// The pull-request queue for Checks: at most `prSlots` pull-request runs hold runners at once, oldest first, and the
// pushes to redesign/window are never held. GitHub's own `concurrency:` cannot say "N at once" (a group keeps one run
// and one pending, and replaces the pending one), so the queue is kept here, over REST, at two points of every run:
//
//   admit    the `plan` job of a pull-request run. A first attempt takes a slot only when one is free and no older run
//            is waiting; otherwise the run says "Waiting for a CI slot, position k of m", labels its pull request
//            `ci-waiting` and cancels itself. A rerun (attempt 2 or later) was started by this queue and takes its slot.
//   restart  the end of verify-suite, on every run. Each free slot reruns the oldest waiting pull request: an open,
//            non-draft pull request without `hold` whose newest Checks run for its current head was cancelled (held
//            here, or parked by hand). A run cancelled because a newer push replaced it is not waiting: its head is
//            no longer the pull request's.
//
// Two to six REST calls a decision, so the queue stays inside the token's hourly allowance. A failed call never
// holds a run: the run goes ahead.
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WAITING_LABEL = "ci-waiting";

/**
 * The decision. `active`: other pull-request runs holding runners now. `waiting`: the waiting runs, oldest first.
 * `self`: this run when it is asking for a slot ({ attempt }), or null when a run is handing its slot on.
 */
export function schedule({ slots, active, waiting, self = null }) {
  let free = slots - active;
  let admitSelf = false;
  if (self && self.attempt > 1) { admitSelf = true; free -= 1; }
  const rerun = waiting.slice(0, Math.max(0, free));
  free -= rerun.length;
  if (self && self.attempt <= 1) admitSelf = free > 0;
  const behind = waiting.length - rerun.length;
  return { admitSelf, rerun, position: self && !admitSelf ? behind + 1 : null, queued: behind + (self && !admitSelf ? 1 : 0) };
}

/** Pull-request runs holding runners now (this run left out), from the newest Checks runs. */
export function activeRuns(runs, selfId) {
  return runs.filter((run) => run.event === "pull_request" && run.id !== selfId && run.status === "in_progress").length;
}

/** The waiting pull requests' runs, oldest first: see the top of this file. */
export function waitingRuns(pulls, runs, selfId) {
  const newest = new Map();
  for (const run of runs) {
    if (run.event !== "pull_request" || run.id === selfId) continue;
    const seen = newest.get(run.head_sha);
    if (!seen || run.id > seen.id) newest.set(run.head_sha, run);
  }
  const waiting = [];
  for (const pull of pulls) {
    if (pull.draft || pull.labels?.some((label) => label.name === "hold")) continue;
    const run = newest.get(pull.head?.sha);
    if (run?.status === "completed" && run.conclusion === "cancelled") waiting.push({ pr: pull.number, runId: run.id, created: run.created_at });
  }
  return waiting.sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.runId - b.runId));
}

/** The words a waiting run shows, in its annotation and summary. */
export const waitingWords = (position, queued, slots) =>
  `Waiting for a CI slot, position ${position} of ${queued}: at most ${slots} pull-request runs hold runners at once. `
  + "This run was cancelled to wait, not failed; the queue starts it again when a slot frees. Pushing again starts a new run.";

function github(token, repo) {
  return async (method, path, body) => {
    const response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok && response.status !== 404) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.status === 204 || response.status === 202 ? null : response.json().catch(() => null);
  };
}

/** Up to three pages of a listing: the newest 300 pull-request runs, and every open pull request up to 300. */
async function pages(api, path, pick = (page) => page) {
  const all = [];
  for (let page = 1; page <= 3; page += 1) {
    const items = pick(await api("GET", `${path}&per_page=100&page=${page}`)) ?? [];
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

async function state(api, selfId) {
  const [runs, pulls] = await Promise.all([
    pages(api, "actions/workflows/checks.yml/runs?event=pull_request", (page) => page?.workflow_runs),
    pages(api, "pulls?state=open"),
  ]);
  return { active: activeRuns(runs, selfId), waiting: waitingRuns(pulls, runs, selfId) };
}

async function rerun(api, waiting) {
  for (const { pr, runId } of waiting) {
    await api("POST", `actions/runs/${runId}/rerun`);
    await api("DELETE", `issues/${pr}/labels/${WAITING_LABEL}`);
    console.log(`Started pull request #${pr} again (run ${runId}).`);
  }
}

function argument(name) {
  return process.argv.slice(3).find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
}

async function main() {
  const command = process.argv[2];
  const slots = JSON.parse(readFileSync(join(root, "tests", "test-impact.json"), "utf8")).prSlots;
  const api = github(process.env.GH_TOKEN, process.env.GITHUB_REPOSITORY);
  const selfId = Number(argument("run"));
  const { active, waiting } = await state(api, selfId);
  if (command === "restart") {
    const decision = schedule({ slots, active, waiting });
    console.log(`${active} of ${slots} pull-request slots in use; ${waiting.length} waiting.`);
    return rerun(api, decision.rerun);
  }
  const pr = Number(argument("pr"));
  const decision = schedule({ slots, active, waiting, self: { attempt: Number(argument("attempt")) } });
  await rerun(api, decision.rerun);
  if (decision.admitSelf) {
    await api("DELETE", `issues/${pr}/labels/${WAITING_LABEL}`);
    console.log(`Took a CI slot: ${active + 1 + decision.rerun.length} of ${slots} in use.`);
    return;
  }
  const words = waitingWords(decision.position, decision.queued, slots);
  console.log(`::notice title=Waiting for a CI slot::${words}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${words}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "held=true\n");
  await api("POST", `issues/${pr}/labels`, { labels: [WAITING_LABEL] });
  await api("POST", `actions/runs/${selfId}/cancel`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    // A queue that cannot be read never holds a run back.
    console.log(`::warning title=CI queue unavailable::${error.message}`);
  });
}
