type Request = (method: string, path: string) => Promise<unknown>;
type Row = Record<string, unknown>;
type Page = { total_count?: unknown; check_runs?: unknown; statuses?: unknown; sha?: unknown };
export type GitHubCheck = { id: number; source: "check" | "status"; appId: number | null; name: string; status: string; result: string; address: string };
export type GitHubChecks = {
  repository: string; ref: string; sha: string; checks: GitHubCheck[]; complete: boolean;
  allPassed: boolean; requiredChecksVerified: false; summary: string;
};
const pageSize = 100;
const maxPages = 10;
const shaPattern = /^[a-f0-9]{40}$/;

async function commit(request: Request, repo: string, ref: string): Promise<string> {
  const answer = await request("GET", `repos/${repo}/commits/${encodeURIComponent(ref)}`) as Row;
  if (typeof answer.sha !== "string" || !shaPattern.test(answer.sha)) throw new Error("GitHub did not identify the exact commit.");
  return answer.sha;
}

/** Missing, changing, repeated, truncated or oversized pages never establish success. */
async function pages(request: Request, path: string, key: "check_runs" | "statuses", sha: string): Promise<{ rows: Row[]; complete: boolean }> {
  const rows: Row[] = [];
  const ids = new Set<unknown>();
  let total: number | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const answer = await request("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=${pageSize}&page=${page}`) as Page;
    const count = answer.total_count;
    const batch = answer[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0 || !Array.isArray(batch)
      || batch.length > pageSize || (total !== undefined && count !== total)
      || (key === "statuses" && answer.sha !== sha)) return { rows, complete: false };
    total = count as number;
    for (const row of batch) {
      if (!row || typeof row !== "object" || !Number.isSafeInteger(row.id) || ids.has(row.id)
        || (key === "check_runs" && row.head_sha !== sha)) return { rows, complete: false };
      ids.add(row.id); rows.push(row as Row);
    }
    if (rows.length === total) return { rows, complete: true };
    if (rows.length > total || batch.length < pageSize) return { rows, complete: false };
  }
  return { rows, complete: false };
}

function check(row: Row): GitHubCheck {
  const app = row.app as Row | undefined;
  return { id: row.id as number, source: "check", appId: Number.isSafeInteger(app?.id) ? app!.id as number : null,
    name: String(row.name ?? "").slice(0, 120), status: String(row.status ?? ""),
    result: String(row.conclusion ?? "still going"), address: String(row.details_url ?? "") };
}
function status(row: Row): GitHubCheck {
  const state = String(row.state ?? "");
  return { id: row.id as number, source: "status", appId: null,
    name: String(row.context ?? "").slice(0, 120), status: state === "pending" ? "in_progress" : "completed",
    result: state, address: String(row.target_url ?? "") };
}

/** This is evidence for observed checks, not permission to merge or proof of required rules. */
export async function readGitHubChecks(request: Request, input: { repo: string; ref: string }): Promise<GitHubChecks> {
  const sha = await commit(request, input.repo, input.ref);
  const prefix = `repos/${input.repo}/commits/${sha}`;
  const runs = await pages(request, `${prefix}/check-runs?filter=latest`, "check_runs", sha);
  const statuses = await pages(request, `${prefix}/status`, "statuses", sha);
  const checks = [...runs.rows.map(check), ...statuses.rows.map(status)];
  const unchanged = sha === await commit(request, input.repo, input.ref);
  const complete = runs.complete && statuses.complete && unchanged;
  const failed = checks.filter((item) => item.status !== "completed" || item.result !== "success");
  const allPassed = complete && checks.length > 0 && failed.length === 0;
  const summary = !complete ? "The check evidence is incomplete or the reference changed. Do not merge from this result."
    : !checks.length ? "No checks have run on this yet."
    : failed.length ? `${failed.length} of ${checks.length} checks did not pass: ${failed.map((item) => item.name).join(", ").slice(0, 200)}`
    : `All ${checks.length} observed checks passed. Required branch checks have not been verified.`;
  return { repository: input.repo, ref: input.ref, sha, checks, complete, allPassed, requiredChecksVerified: false, summary };
}
