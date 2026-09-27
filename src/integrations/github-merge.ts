import { createHash } from "node:crypto";
import type { GitHubChecks } from "./github-checks.js";

type Ref = { sha?: string; ref?: string; repo?: { full_name?: string } };
type Row = {
  number?: number; state?: string; draft?: boolean; merged?: boolean; mergeable?: boolean; mergeable_state?: string;
  head?: Ref; base?: Ref; protected?: boolean; commit?: { sha?: string }; sha?: string;
  enforce_admins?: { enabled?: boolean };
  required_status_checks?: { strict?: boolean; checks?: unknown; contexts?: unknown };
  required_pull_request_reviews?: { bypass_pull_request_allowances?: Record<string, unknown> };
  type?: string; ruleset_id?: number; ruleset_source?: string; ruleset_source_type?: string;
  id?: number; enforcement?: string; bypass_actors?: unknown;
  parameters?: { strict_required_status_checks_policy?: boolean; required_status_checks?: unknown };
  status?: string; behind_by?: number; base_commit?: { sha?: string };
  node_id?: string;
};
type Request = (method: string, path: string, body?: unknown) => Promise<unknown>;
export type MergePin = { repo: string; number: number; headSha: string; baseSha: string; base: string; head: string };
export type MergeEvidence = MergePin & { checks: GitHubChecks; requiredChecksVerified: true; required: RequiredCheck[]; rulesHash: string };
type RequiredCheck = { context: string; appId: number | null };
const fail = (reason: string): never => { throw new Error(`Branch cannot merge this change: ${reason}`); };
const sameRepo = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const sha = /^[a-f0-9]{40}$/;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function pullPin(row: Row, repo: string, number: number, draft = false): MergePin {
  if (row.number !== number || row.state !== "open" || row.draft !== draft || row.merged !== false
    || (!draft && (row.mergeable !== true || row.mergeable_state !== "clean")))
    fail(draft ? "the pull request is not an open draft at the reviewed commit." : "the pull request is not open, ready and mergeable. Finish its draft and satisfy GitHub's review rules first.");
  if (!sameRepo(row.base?.repo?.full_name, repo) || !sameRepo(row.head?.repo?.full_name, repo))
    fail("the pull request crosses repositories. Review and merge fork changes on GitHub instead.");
  if (!sha.test(row.head?.sha ?? "") || !sha.test(row.base?.sha ?? "")
    || typeof row.base?.ref !== "string" || !/^branch\/[A-Za-z0-9._-]{1,60}$/.test(row.head?.ref ?? "")) return fail("GitHub did not identify the exact source branch and commits.");
  return { repo, number, headSha: row.head!.sha!, baseSha: row.base!.sha!, base: row.base!.ref!, head: row.head!.ref! };
}

function requiredChecks(entries: unknown, appKey: string): RequiredCheck[] {
  if (!Array.isArray(entries)) return fail("required check names and their originating apps are unavailable.");
  return entries.map((input: unknown) => {
    const entry = input as Record<string, unknown>;
    if (typeof entry?.context !== "string" || !entry.context || entry.context.length > 120) fail("a required check name is unavailable or unsupported.");
    const id = entry[appKey];
    if (id !== null && id !== -1 && (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) fail("a required check's originating app is unknown.");
    return { context: entry.context as string, appId: id === null || id === -1 ? null : id as number };
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

async function verifyRulesets(request: Request, repo: string, rules: Row[]): Promise<{ required: RequiredCheck[]; details: Row[] }> {
  const details: Row[] = [], required: RequiredCheck[] = [], seen = new Set<string>();
  for (const rule of rules) {
    if (rule.type !== "required_status_checks") fail(`the active ${String(rule.type)} rule needs review on GitHub; Branch will not bypass it.`);
    if (typeof rule.ruleset_id !== "number" || !Number.isSafeInteger(rule.ruleset_id) || rule.ruleset_id <= 0) fail("an active rule's source cannot be verified.");
    const source = rule.ruleset_source;
    const prefix = rule.ruleset_source_type === "Repository" && sameRepo(source, repo) ? `repos/${repo}`
      : rule.ruleset_source_type === "Organization" && typeof source === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(source) ? `orgs/${source}` : null;
    if (!prefix) fail("the active ruleset's source is unsupported.");
    const key = `${prefix}/${rule.ruleset_id}`;
    if (!seen.has(key)) {
      const detail = await request("GET", `${prefix}/rulesets/${rule.ruleset_id}`) as Row;
      if (detail.id !== rule.ruleset_id || detail.enforcement !== "active" || !Array.isArray(detail.bypass_actors)
        || detail.bypass_actors.length) fail("an active ruleset has bypass actors or its enforcement cannot be verified. Review on GitHub.");
      details.push(detail); seen.add(key);
    }
    if (rule.parameters?.strict_required_status_checks_policy !== true) return fail("active required checks do not require the latest base commit.");
    required.push(...requiredChecks(rule.parameters.required_status_checks, "integration_id"));
  }
  return { required, details };
}

/** Requires protected, up-to-date checks even for admins. Unknown protection means no merge. */
export async function mergeEvidence(request: Request, checks: (input: { repo: string; ref: string }) => Promise<GitHubChecks>, repo: string, number: number, draft = false): Promise<MergeEvidence> {
  const pin = pullPin(await request("GET", `repos/${repo}/pulls/${number}`) as Row, repo, number, draft);
  const base = `repos/${repo}/branches/${encodeURIComponent(pin.base)}`;
  const branch = await request("GET", base) as Row;
  if (branch.protected !== true || branch.commit?.sha !== pin.baseSha) fail("the protected base branch changed or cannot be verified.");
  const protection = await request("GET", `${base}/protection`) as Row;
  if (protection.enforce_admins?.enabled !== true || protection.required_status_checks?.strict !== true)
    fail("required checks are not enforced for administrators against the latest base. Keep normal merge enforcement on in GitHub.");
  const allowances = protection.required_pull_request_reviews?.bypass_pull_request_allowances;
  if (allowances && Object.values(allowances).some((list) => !Array.isArray(list) || list.length)) fail("pull-request review bypass allowances are configured.");
  const classic = requiredChecks(protection.required_status_checks?.checks, "app_id");
  const contexts = protection.required_status_checks?.contexts;
  if (!Array.isArray(contexts) || contexts.some((name) => typeof name !== "string" || !classic.some((check) => check.context === name)))
    fail("legacy required check contexts cannot be reconciled with their configured apps.");
  const rules = await activeRules(request, repo, pin.base);
  const sets = await verifyRulesets(request, repo, rules);
  const required = [...classic, ...sets.required];
  if (!required.length) fail("no required checks are configured for the base branch.");
  const result = await checks({ repo, ref: pin.headSha });
  if (!result.complete || !result.allPassed || result.sha !== pin.headSha) fail("exact-head check evidence is incomplete or not all successful.");
  for (const need of required) {
    const matched = result.checks.filter((item) => item.name === need.context && (need.appId === null || item.source === "check" && item.appId === need.appId));
    if (!matched.length || matched.some((item) => item.status !== "completed" || item.result !== "success")) fail(`required check ${need.context} from its configured app has not passed.`);
  }
  const comparison = await request("GET", `repos/${repo}/compare/${pin.baseSha}...${pin.headSha}`) as Row;
  if (!["ahead", "identical"].includes(comparison.status ?? "") || comparison.behind_by !== 0
    || comparison.base_commit?.sha !== pin.baseSha) fail("the tested head does not contain the exact reviewed base commit.");
  const latest = pullPin(await request("GET", `repos/${repo}/pulls/${number}`) as Row, repo, number, draft);
  if (hash(latest) !== hash(pin) || (await request("GET", base) as Row).commit?.sha !== pin.baseSha) fail("the head or base moved while checks were read. Review again.");
  return { ...pin, checks: result, requiredChecksVerified: true, required, rulesHash: hash({ protection, rules, details: sets.details }) };
}

export async function normalMerge(request: Request, pin: MergePin): Promise<{ merged: true; sha: string }> {
  const answer = await request("PUT", `repos/${pin.repo}/pulls/${pin.number}/merge`, { sha: pin.headSha, merge_method: "merge" }) as Row;
  if (answer.merged !== true || !sha.test(answer.sha ?? "")) fail("GitHub did not confirm a normal merge. Check the pull request before retrying.");
  return { merged: true, sha: answer.sha! };
}

/** The checked draft becomes ready only after an independent read-only review. Normal protection still gates merging. */
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
