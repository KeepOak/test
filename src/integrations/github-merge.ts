import { createHash } from "node:crypto";
import type { GitHubChecks } from "./github-checks.js";

type Ref = { sha?: string; ref?: string; repo?: { full_name?: string } };
type Row = {
  number?: number; state?: string; draft?: boolean; merged?: boolean; mergeable?: boolean | null; mergeable_state?: string;
  head?: Ref; base?: Ref; protected?: boolean; protection?: { enabled?: boolean }; commit?: { sha?: string }; sha?: string;
  required_status_checks?: { checks?: unknown; contexts?: unknown } | null;
  required_pull_request_reviews?: { required_approving_review_count?: number } | null;
  type?: string; parameters?: { required_status_checks?: unknown; required_approving_review_count?: number; require_code_owner_review?: boolean;
    require_last_push_approval?: boolean; required_review_thread_resolution?: boolean };
  status?: string; behind_by?: number; base_commit?: { sha?: string };
  node_id?: string; total_count?: number; workflow_runs?: unknown;
};
type Request = (method: string, path: string, body?: unknown) => Promise<unknown>;
export type MergePin = { repo: string; number: number; headSha: string; baseSha: string; base: string; head: string };
type RequiredCheck = { context: string; appId: number | null };
type WorkflowRun = { id: number; name: string; status: string; conclusion: string };
export type MergeEvidence = MergePin & { checks: GitHubChecks; requiredChecksVerified: true; required: RequiredCheck[]; workflows: WorkflowRun[]; rulesHash: string;
  /** The base only takes changes through GitHub's merge queue: a checked pull request is enqueued, never merged directly. */
  mergeQueue: boolean };
/** A direct merge GitHub confirmed, or a place in the base's merge queue (the queue merges it after its own checks). */
export type MergeResult = { merged: true; sha: string } | { merged: false; queued: true; state: string; position: number | null };
/**
 * Which pull requests a gate may pass: `self` is Branch's own source change (a `branch/...` head; the
 * contract checks the base), `any` is an ordinary project's pull request (github.merge_pull_request).
 */
export type MergeLine = "self" | "any";
const fail = (reason: string): never => { throw new Error(`Branch cannot merge this change: ${reason}`); };
/** Still running or not yet known: waiting may make it pass; it never counts as passed. */
export class ChecksPending extends Error { override name = "ChecksPending"; }
const pending = (reason: string): never => { throw new ChecksPending(`Not ready to merge yet: ${reason}`); };
const sameRepo = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const sha = /^[a-f0-9]{40}$/;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** GitHub's own answer on whether the pull request could merge; the checks themselves are judged below, not from this. */
const mergeableStates = new Set(["clean", "unstable", "has_hooks"]);
/**
 * "blocked" is GitHub's word while a required check has not passed yet as well as for a rule nobody met. The checks
 * are judged below (running is pending, failed refuses) and the rules are read from the base itself, so it is not a
 * refusal on its own: it is let through here, and a base still "blocked" once every check passed is pending.
 */
const blockedForNow = "blocked";

function pullPin(row: Row, repo: string, number: number, draft = false, line: MergeLine = "self"): MergePin {
  if (row.number !== number || row.state !== "open" || row.draft !== draft || row.merged !== false)
    fail(draft ? "the pull request is not an open draft at the reviewed commit." : "the pull request is not open and ready. Finish its draft first.");
  if (!draft && (row.mergeable === null || row.mergeable === undefined || row.mergeable_state === "unknown"))
    pending("GitHub is still working out whether the pull request can merge.");
  if (!draft && (row.mergeable !== true || !(mergeableStates.has(row.mergeable_state ?? "") || row.mergeable_state === blockedForNow)))
    fail(`GitHub says the pull request cannot merge as it is (${String(row.mergeable_state ?? "unknown")}): conflicts, a stale base or a rule it has not met.`);
  if (!sameRepo(row.base?.repo?.full_name, repo) || !sameRepo(row.head?.repo?.full_name, repo))
    fail("the pull request crosses repositories. Review and merge fork changes on GitHub instead.");
  const head = line === "self" ? /^branch\/[A-Za-z0-9._-]{1,60}$/ : /^[A-Za-z0-9._/-]{1,200}$/;
  if (!sha.test(row.head?.sha ?? "") || !sha.test(row.base?.sha ?? "")
    || typeof row.base?.ref !== "string" || !head.test(row.head?.ref ?? "")) return fail("GitHub did not identify the exact source branch and commits.");
  return { repo, number, headSha: row.head!.sha!, baseSha: row.base!.sha!, base: row.base!.ref!, head: row.head!.ref! };
}

function requiredChecks(entries: unknown, appKey: string): RequiredCheck[] {
  if (entries === undefined || entries === null) return [];
  if (!Array.isArray(entries)) return fail("required check names and their originating apps are unavailable.");
  return entries.map((input: unknown) => {
    const entry = input as Record<string, unknown>;
    if (typeof entry?.context !== "string" || !entry.context || entry.context.length > 120) fail("a required check name is unavailable or unsupported.");
    const id = entry[appKey];
    if (id !== null && id !== undefined && id !== -1 && (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) fail("a required check's originating app is unknown.");
    return { context: entry.context as string, appId: id === null || id === undefined || id === -1 ? null : id as number };
  });
}

async function activeRules(request: Request, repo: string, base: string): Promise<Row[]> {
  const result: Row[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await request("GET", `repos/${repo}/rules/branches/${encodeURIComponent(base)}?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length > 100) return fail("active branch rules could not be read completely.");
    result.push(...batch as Row[]);
    if (batch.length < 100) return result;
  }
  return fail("there are more active branch rules than Branch can verify. Review on GitHub.");
}

/** What a merge-queue entry is pinned to: the pull request and its exact head, not a base the queue moves on. */
const headOf = (pin: MergePin): Omit<MergePin, "baseSha"> => ({ repo: pin.repo, number: pin.number, headSha: pin.headSha, base: pin.base, head: pin.head });

/** Rules that only guard the branch itself (deleting it, forcing it, creating it) never stand between a checked merge and GitHub. */
const branchOnlyRules = new Set(["deletion", "non_fast_forward", "creation", "required_signatures"]);

/**
 * What the base asks for, read from classic protection and active rulesets. Branch verifies each required
 * check itself below, so nothing here relies on GitHub enforcing rules for administrators. A rule Branch
 * cannot satisfy by checking (an approving review, linear history) is left to GitHub. A merge queue is
 * joined, pinned to the checked head, rather than gone around (`mergeOrEnqueue`).
 */
async function baseRules(request: Request, repo: string, pin: MergePin, branch: Row): Promise<{ required: RequiredCheck[]; hash: string; mergeQueue: boolean }> {
  const required: RequiredCheck[] = [];
  let mergeQueue = false;
  let protection: Row | null = null;
  // A base guarded only by rulesets is "protected" too, but has no classic protection to read (GitHub answers 404,
  // "Branch not protected"); the branch itself says whether classic protection is on.
  if (branch.protected === true && branch.protection?.enabled !== false) {
    protection = await request("GET", `repos/${repo}/branches/${encodeURIComponent(pin.base)}/protection`) as Row;
    if ((protection.required_pull_request_reviews?.required_approving_review_count ?? 0) > 0)
      fail("the base needs an approving review. Approve it on GitHub, then Branch can merge the checked commit.");
    const classic = requiredChecks(protection.required_status_checks?.checks, "app_id");
    const contexts = protection.required_status_checks?.contexts ?? [];
    if (!Array.isArray(contexts) || contexts.some((name) => typeof name !== "string")) fail("the base's required check names cannot be read.");
    for (const name of contexts as string[]) if (!classic.some((check) => check.context === name)) classic.push({ context: name, appId: null });
    required.push(...classic);
  }
  const rules = await activeRules(request, repo, pin.base);
  for (const rule of rules) {
    if (rule.type === "required_status_checks") required.push(...requiredChecks(rule.parameters?.required_status_checks, "integration_id"));
    // A pull-request rule that asks for no person's approval is met by any pull request; one that asks for a code owner,
    // a fresh approval after the last push or resolved threads needs a person, so it is said now rather than waited on.
    else if (rule.type === "pull_request" && (rule.parameters?.required_approving_review_count ?? 0) === 0
      && !rule.parameters?.require_code_owner_review && !rule.parameters?.require_last_push_approval && !rule.parameters?.required_review_thread_resolution) continue;
    // The queue runs the base's checks again on the merged result and merges only if they pass: Branch enqueues the checked head.
    else if (rule.type === "merge_queue") mergeQueue = true;
    else if (!branchOnlyRules.has(String(rule.type))) fail(`the active ${String(rule.type)} rule needs review on GitHub; Branch will not go around it.`);
  }
  return { required, hash: hash({ protection, rules }), mergeQueue };
}

/** The Actions runs for this exact commit, newest attempt of each workflow: a run that exists but has not finished is still pending. */
async function workflowRuns(request: Request, repo: string, head: string): Promise<WorkflowRun[]> {
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; page <= 5; page++) {
    const answer = await request("GET", `repos/${repo}/actions/runs?head_sha=${head}&per_page=100&page=${page}`) as Row;
    const batch = answer.workflow_runs, total = answer.total_count;
    if (!Number.isSafeInteger(total) || !Array.isArray(batch) || batch.length > 100) return fail("the workflow runs for this commit could not be read completely.");
    rows.push(...batch as Record<string, unknown>[]);
    if (rows.length > (total as number)) return fail("the workflow runs for this commit changed while they were read.");
    if (rows.length === total) break;
    if (batch.length < 100 || page === 5) return fail("the workflow runs for this commit could not be read completely.");
  }
  const latest = new Map<string, Record<string, unknown>>();
  const order = (row: Record<string, unknown>): number => Number(row.run_number ?? 0) * 1000 + Number(row.run_attempt ?? 0);
  for (const row of rows) {
    if (row.head_sha !== head || !Number.isSafeInteger(row.id)) fail("a workflow run does not belong to the exact commit.");
    const key = `${String(row.workflow_id ?? row.name)}:${String(row.event ?? "")}`;
    const kept = latest.get(key);
    if (!kept || order(row) > order(kept)) latest.set(key, row);
  }
  return [...latest.values()].map((row) => ({ id: row.id as number, name: String(row.name ?? "").slice(0, 120),
    status: String(row.status ?? ""), conclusion: String(row.conclusion ?? "") }));
}

/** Passed, skipped or neutral is fine for any check, required or not (GitHub counts them so). Anything unfinished is pending, never passed. */
const finished = new Set(["success", "skipped", "neutral"]);
function judgeChecks(result: GitHubChecks, required: RequiredCheck[], workflows: WorkflowRun[], pin: MergePin): void {
  if (result.sha !== pin.headSha) fail("the checks were read for another commit.");
  if (!result.complete) pending("the check evidence for this exact commit is still incomplete.");
  const failed = [...result.checks.filter((item) => item.status === "completed" && !finished.has(item.result)).map((item) => `${item.name} (${item.result})`),
    ...workflows.filter((run) => run.status === "completed" && !finished.has(run.conclusion)).map((run) => `${run.name} (${run.conclusion})`)];
  if (failed.length) fail(`checks did not pass on the exact commit: ${failed.join(", ").slice(0, 300)}.`);
  const running = [...result.checks.filter((item) => item.status !== "completed").map((item) => item.name),
    ...workflows.filter((run) => run.status !== "completed").map((run) => run.name)];
  if (running.length) pending(`checks are still running on the exact commit: ${running.join(", ").slice(0, 300)}.`);
  for (const need of required) {
    // A check of that name from another app is not the required one: it is still awaited, never passed.
    const matched = result.checks.filter((item) => item.name === need.context && (need.appId === null || item.source === "check" && item.appId === need.appId));
    // As GitHub counts a required check: passed, skipped or neutral is met; anything else did not pass.
    if (matched.some((item) => !finished.has(item.result))) fail(`required check ${need.context} did not pass.`);
    if (!matched.length) pending(`required check ${need.context} has not reported on this exact commit yet.`);
  }
  if (!result.checks.some((item) => item.result === "success")) pending("no check has passed on this exact commit yet.");
}

/**
 * Every check and workflow run on the exact head finished and passed (or was skipped), every check the base
 * requires passed from its configured app, the head contains the exact base, and nothing moved while it
 * was read. Throws ChecksPending while something is still running; throws a refusal for anything else.
 */
export async function mergeEvidence(request: Request, checks: (input: { repo: string; ref: string }) => Promise<GitHubChecks>, repo: string, number: number,
  draft = false, line: MergeLine = "self"): Promise<MergeEvidence> {
  const pin = pullPin(await request("GET", `repos/${repo}/pulls/${number}`) as Row, repo, number, draft, line);
  const base = `repos/${repo}/branches/${encodeURIComponent(pin.base)}`;
  const branch = await request("GET", base) as Row;
  if (!sha.test(branch.commit?.sha ?? "")) fail("the base branch cannot be verified.");
  const rules = await baseRules(request, repo, pin, branch);
  // A merge queue tests the head merged onto the newest base itself before anything lands, so on a busy base another
  // change landing meanwhile is not a reason to refuse; without a queue the tested head must sit on the exact base.
  if (!rules.mergeQueue && branch.commit?.sha !== pin.baseSha) fail("the base branch moved or cannot be verified. Update the pull request and wait for its checks again.");
  const result = await checks({ repo, ref: pin.headSha });
  const workflows = await workflowRuns(request, repo, pin.headSha);
  judgeChecks(result, rules.required, workflows, pin);
  const comparison = rules.mergeQueue ? null : await request("GET", `repos/${repo}/compare/${pin.baseSha}...${pin.headSha}`) as Row;
  if (comparison && (!["ahead", "identical"].includes(comparison.status ?? "") || comparison.behind_by !== 0
    || comparison.base_commit?.sha !== pin.baseSha)) fail("the tested head does not contain the exact base commit. Update the pull request and wait for its checks again.");
  const latestRow = await request("GET", `repos/${repo}/pulls/${number}`) as Row;
  const latest = pullPin(latestRow, repo, number, draft, line);
  if (rules.mergeQueue ? hash(headOf(latest)) !== hash(headOf(pin)) : hash(latest) !== hash(pin) || (await request("GET", base) as Row).commit?.sha !== pin.baseSha)
    fail("the head or base moved while checks were read. Review again.");
  if (!draft && latestRow.mergeable_state === blockedForNow)
    pending("every check passed, but GitHub still says the pull request is blocked. It usually catches up within a minute; if it stays blocked, a rule Branch cannot see needs a person on GitHub.");
  return { ...pin, checks: result, requiredChecksVerified: true, required: rules.required, workflows, rulesHash: rules.hash, mergeQueue: rules.mergeQueue };
}

export async function normalMerge(request: Request, pin: MergePin): Promise<MergeResult> {
  const answer = await request("PUT", `repos/${pin.repo}/pulls/${pin.number}/merge`, { sha: pin.headSha, merge_method: "merge" }) as Row;
  if (answer.merged !== true || !sha.test(answer.sha ?? "")) fail("GitHub did not confirm a normal merge. Check the pull request before retrying.");
  return { merged: true, sha: answer.sha! };
}

// Merge queue: as `gh pr merge` does on a queue base once required checks passed (cli/cli pkg/cmd/pr/merge/merge.go), the
// pull request joins the queue rather than merging; here through GitHub's own enqueuePullRequest mutation, pinned to the
// checked head with expectedHeadOid. Mutation and field names checked against GitHub's schema on 2026-09-29.
const enqueueQuery = "mutation($id:ID!,$oid:GitObjectID!){enqueuePullRequest(input:{pullRequestId:$id,expectedHeadOid:$oid}){mergeQueueEntry{state position pullRequest{number headRefOid}}}}";
const queueStates = new Set(["QUEUED", "AWAITING_CHECKS", "MERGEABLE", "LOCKED"]);

/**
 * The checked head joins the base's merge queue. GitHub refuses the entry if the head moved (expectedHeadOid); the
 * queue then tests the merged result with the base's checks and merges it, or takes it out. Nothing merges here.
 */
export async function enqueueChecked(request: Request, pin: MergePin, graphqlUrl: string, line: MergeLine = "self"): Promise<MergeResult> {
  const row = await request("GET", `repos/${pin.repo}/pulls/${pin.number}`) as Row;
  const current = pullPin(row, pin.repo, pin.number, false, line);
  // The head is what is pinned (expectedHeadOid); the queue itself merges it onto whatever the base is by then.
  if (hash(headOf(current)) !== hash(headOf(pin))
    || typeof row.node_id !== "string" || !/^[A-Za-z0-9_=-]{4,160}$/.test(row.node_id))
    fail("the pull request or its exact head/base changed before it joined the merge queue. Review again.");
  const answer = await request("POST", graphqlUrl, { query: enqueueQuery, variables: { id: row.node_id, oid: pin.headSha } }) as {
    errors?: unknown; data?: { enqueuePullRequest?: { mergeQueueEntry?: { state?: string; position?: number; pullRequest?: { number?: number; headRefOid?: string } } } };
  };
  const entry = answer.data?.enqueuePullRequest?.mergeQueueEntry;
  if (answer.errors || !entry || entry.pullRequest?.number !== pin.number || entry.pullRequest?.headRefOid !== pin.headSha || !queueStates.has(entry.state ?? ""))
    fail("GitHub did not confirm this exact commit joined the merge queue. Check the pull request before retrying.");
  return { merged: false, queued: true, state: entry!.state!, position: Number.isSafeInteger(entry!.position) ? entry!.position! : null };
}

/** A base with a merge queue is joined; any other base gets a normal merge. Either way pinned to the checked head. */
export function mergeOrEnqueue(request: Request, evidence: MergePin & { mergeQueue?: boolean }, graphqlUrl: () => string, line: MergeLine = "self"): Promise<MergeResult> {
  return evidence.mergeQueue ? enqueueChecked(request, evidence, graphqlUrl(), line) : normalMerge(request, evidence);
}

/**
 * Where an unmerged pull request stands with the merge queue, from its REST timeline (events are in order): "queued"
 * while it is in the queue, "removed" when the queue took it out without merging and nothing was pushed since, else null.
 */
export async function queueStanding(request: Request, repo: string, number: number): Promise<"queued" | "removed" | null> {
  const events: string[] = [];
  for (let page = 1; ; page++) {
    const batch = await request("GET", `repos/${repo}/issues/${number}/timeline?per_page=100&page=${page}`);
    if (!Array.isArray(batch) || batch.length > 100) return fail("the pull request's merge-queue record could not be read.");
    events.push(...batch.map((row) => String((row as Row & { event?: unknown }).event ?? "")));
    if (batch.length < 100) break;
    if (page === 10) return fail("the pull request's record is too long to read its merge-queue place. Look on GitHub.");
  }
  const queued = events.lastIndexOf("added_to_merge_queue"), removed = events.lastIndexOf("removed_from_merge_queue");
  const pushed = Math.max(events.lastIndexOf("committed"), events.lastIndexOf("head_ref_force_pushed"));
  if (queued > removed) return "queued";
  return removed >= 0 && removed > pushed ? "removed" : null;
}

/** The checked draft becomes ready only after an independent read-only review. The merge is checked again afterwards. */
export async function markReadyForReview(request: Request, pin: MergePin, graphqlUrl: string): Promise<void> {
  const row = await request("GET", `repos/${pin.repo}/pulls/${pin.number}`) as Row;
  const current = pullPin(row, pin.repo, pin.number, true);
  if (current.repo !== pin.repo || current.number !== pin.number || current.headSha !== pin.headSha
    || current.baseSha !== pin.baseSha || current.head !== pin.head || current.base !== pin.base
    || typeof row.node_id !== "string" || !/^[A-Za-z0-9_=-]{4,160}$/.test(row.node_id))
    fail("the draft or its exact head/base changed before ready-for-review. Review again.");
  const query = "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft headRefOid baseRefOid}}}";
  const answer = await request("POST", graphqlUrl, { query, variables: { id: row.node_id } }) as {
    errors?: unknown; data?: { markPullRequestReadyForReview?: { pullRequest?: { id?: string; isDraft?: boolean; headRefOid?: string; baseRefOid?: string } } };
  };
  const ready = answer.data?.markPullRequestReadyForReview?.pullRequest;
  if (answer.errors || ready?.id !== row.node_id || ready?.isDraft !== false || ready?.headRefOid !== pin.headSha || ready?.baseRefOid !== pin.baseSha)
    fail("GitHub did not confirm this exact draft became ready. Check the pull request before retrying.");
}
