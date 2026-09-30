import { readGitHubChecks } from "./integrations/github-checks.js";

type Row = Record<string, unknown>;
type Request = (method: string, path: string) => Promise<unknown>;
const shaPattern = /^[a-f0-9]{40}$/;

/** Observed CI only. Does not verify required branch rules or authorize any mutation.
 * Contracts: docs.github.com/en/rest/checks/runs and /en/rest/actions/workflow-runs.
 */
export async function readCiQueue(request: Request, repo: string) {
  const pulls = await request("GET", `repos/${repo}/pulls?state=open&per_page=100`) as Row[];
  if (!Array.isArray(pulls) || pulls.length >= 100) throw new Error("The open pull-request list is incomplete. Narrow the repository on GitHub.");
  const rows = [];
  for (const pull of pulls) {
    const head = pull.head as Row | undefined;
    if (!Number.isSafeInteger(pull.number) || !shaPattern.test(String(head?.sha ?? ""))) throw new Error("GitHub did not identify the pull-request head.");
    const number = pull.number as number, headSha = head!.sha as string;
    const checks = await readGitHubChecks(request, { repo, ref: headSha });
    const workflows = await readWorkflows(request, repo, headSha);
    const current = await request("GET", `repos/${repo}/pulls/${number}`) as Row;
    const exactHead = (current.head as Row | undefined)?.sha === headSha && checks.sha === headSha;
    const complete = exactHead && checks.complete && workflows.complete;
    const latest = workflows.rows;
    const state = !complete ? "unknown" : latest.some((run) => run.status !== "completed") || checks.checks.some((run) => run.status !== "completed") ? "pending"
      : checks.allPassed && latest.every((run) => run.conclusion === "success") ? "observed-passed" : "not-passed";
    rows.push({ number, title: String(pull.title ?? "").slice(0, 200), headSha, exactHead, complete, state,
      draft: pull.draft === true, labels: Array.isArray(pull.labels) ? pull.labels.map((label) => String((label as Row).name ?? "")) : [],
      checks: checks.checks, workflows: latest });
  }
  return { repository: repo, observedAt: new Date().toISOString(), requiredChecksVerified: false as const, rows };
}

async function readWorkflows(request: Request, repo: string, head: string) {
  const rows: Row[] = [], ids = new Set<number>();
  let total: number | undefined;
  for (let page = 1; page <= 10; page++) {
    const result = await request("GET", `repos/${repo}/actions/runs?head_sha=${head}&per_page=100&page=${page}`) as Row;
    const batch = result.workflow_runs, count = result.total_count;
    if (!Array.isArray(batch) || !Number.isSafeInteger(count) || Number(count) < 0 || batch.length > 100 || total !== undefined && total !== count)
      return { rows: [], complete: false };
    total = count as number;
    for (const run of batch as Row[]) {
      if (!run || typeof run !== "object" || run.head_sha !== head || !Number.isSafeInteger(run.id) || ids.has(run.id as number)
        || !Number.isSafeInteger(run.workflow_id) || !Number.isSafeInteger(run.run_number) || !Number.isSafeInteger(run.run_attempt)
        || Number(run.run_attempt) < 1 || typeof run.event !== "string") return { rows: [], complete: false };
      ids.add(run.id as number); rows.push(run);
    }
    if (rows.length === total) return { rows: newestWorkflows(rows), complete: true };
    if (rows.length > total || batch.length < 100) break;
  }
  return { rows: [], complete: false };
}

function newestWorkflows(rows: Row[]) {
  const latest = new Map<string, Row>();
  for (const row of rows) {
    const key = `${String(row.workflow_id)}:${String(row.event)}`;
    const old = latest.get(key);
    if (!old || Number(row.run_number) > Number(old.run_number)
      || row.run_number === old.run_number && Number(row.run_attempt) > Number(old.run_attempt)) latest.set(key, row);
  }
  return [...latest.values()].map((row) => ({ id: row.id, name: String(row.name ?? "").slice(0, 120), headSha: row.head_sha,
    attempt: row.run_attempt, event: row.event,
    pullRequests: Array.isArray(row.pull_requests) ? row.pull_requests.map((pull) => (pull as Row).number).filter(Number.isSafeInteger) : [],
    status: String(row.status ?? ""), conclusion: String(row.conclusion ?? "") }));
}
