import { setTimeout as wait } from "node:timers/promises";
import { z } from "zod";
import { matchingPublication, publicationLookupPath, type PublicationLookup } from "../self-development-publication-lookup.js";
import { scrubSecrets } from "../locker.js";
import { applyContentPolicy, detectInjection } from "../content-guard.js";
import type { NetworkPolicy } from "../network-policy.js";
import type { TrackerIssue } from "./issue-context.js";
import { readGitHubChecks, type GitHubChecks } from "./github-checks.js";
import { readCiQueue } from "../self-development-ci.js";
import { ChecksPending, mergeEvidence, mergeOrEnqueue, markReadyForReview, queueStanding, type MergeEvidence, type MergeLine, type MergePin, type MergeResult } from "./github-merge.js";

/**
 * A small, direct connection to GitHub for the few things people actually ask for: make me a
 * repository, open a pull request, show me the open issues, raise an issue. It uses a personal
 * access token the owner pastes into their secrets; the token only ever travels in the request
 * header, is never written into a web address, and is scrubbed out of anything reported back.
 */
export const GitHubConfigSchema = z.object({
  apiBase: z.string().url().default("https://api.github.com"),
  /** Name of the secret in the owner's project locker that holds the personal access token. */
  tokenSecret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).default("GITHUB_TOKEN"),
  timeoutMs: z.number().int().min(1000).max(60000).default(20000),
  maxBytes: z.number().int().min(4096).max(1048576).default(262144),
  /** How often github.wait_for_checks looks again while checks are still running. */
  checksPollSeconds: z.number().int().min(1).max(120).default(15),
}).strict();
export type GitHubConfig = z.infer<typeof GitHubConfigSchema>;
export type TokenSource = () => Promise<string>;

/**
 * GitHub allows neither "." nor ".." as an owner or a repository name, so both are refused, while a
 * name that only contains or starts with a dot (".github") still passes. It is a check beside the
 * pattern, not a lookahead in it, because a tool's pattern cannot hold one (see git-tools.ts).
 */
const isDotName = (part: string): boolean => part === "." || part === "..";
export const repositoryName = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, "Repository names use letters, digits, dots, dashes and underscores")
  .refine((value) => !isDotName(value), "A repository name cannot be . or ..");
export const repositoryPath = z.string().regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/, "Write the repository as owner/name")
  .refine((value) => !value.split("/").some(isDotName), "The owner and the name cannot be . or ..");

export class GitHubAccess {
  private readonly config: GitHubConfig;
  constructor(input: unknown, private readonly policy: NetworkPolicy, private readonly token: TokenSource,
    private readonly fetchImpl: typeof fetch = globalThis.fetch, private readonly userAgent = "BranchAgent") {
    this.config = GitHubConfigSchema.parse(input);
  }
  get tokenSecret(): string { return this.config.tokenSecret; }
  async findPublication(input: PublicationLookup, signal: AbortSignal): Promise<unknown | null> {
    return matchingPublication(input, await this.request("GET", publicationLookupPath(input), undefined, undefined, signal));
  }

  /** Owner-triggered read, through the existing authenticated network policy. */
  async ciQueue(repo: string, selected: number[] = []): Promise<Awaited<ReturnType<typeof readCiQueue>>> {
    return readCiQueue((method, path) => this.request(method, path), repositoryPath.parse(repo), selected);
  }

  /** One REST call: the network policy decides whether the address may be reached at all. */
  private async request(method: string, path: string, body?: unknown, beforeSend?: () => void, signal?: AbortSignal): Promise<unknown> {
    const token = await this.token();
    const url = new URL(path.replace(/^\//, ""), this.config.apiBase.replace(/\/?$/, "/"));
    await this.policy.assertAllowed(url, "GitHub address");
    beforeSend?.();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method, redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]) : AbortSignal.timeout(this.config.timeoutMs),
        headers: {
          authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
          "user-agent": this.userAgent, "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      // A redirect is refused on purpose (the address must be the one asked for); anything else never reached GitHub.
      const why = error instanceof Error ? `${error.message}${error.cause instanceof Error ? `: ${error.cause.message}` : ""}` : String(error);
      if (/redirect/i.test(why)) throw error;
      throw new GitHubUnreachable(`GitHub could not be reached just now (${why.slice(0, 160)}).`);
    }
    const text = scrubSecrets((await response.text()).slice(0, this.config.maxBytes), { [this.config.tokenSecret]: token });
    if (!response.ok) throw Object.assign(response.status >= 500 ? new GitHubUnreachable(explainGitHub(response.status, text))
      : new Error(explainGitHub(response.status, text)), { status: response.status });
    return text ? JSON.parse(text) : {};
  }

  async createRepo(input: { name: string; description?: string | undefined; private: boolean }): Promise<unknown> {
    const body = { name: input.name, description: input.description ?? "", private: input.private, auto_init: true };
    const created = (await this.request("POST", "user/repos", body)) as Record<string, unknown>;
    return { repository: created.full_name, address: created.html_url, private: created.private, defaultBranch: created.default_branch };
  }
  async openPullRequest(input: { repo: string; title: string; body?: string | undefined; base: string; head: string; draft?: boolean | undefined }): Promise<unknown> {
    // bucket-18 (A0300): a pull request Branch opens by itself is a draft until a person says otherwise.
    const payload = { title: input.title, body: input.body ?? "", base: input.base, head: input.head, ...(input.draft ? { draft: true } : {}) };
    const opened = (await this.request("POST", `repos/${input.repo}/pulls`, payload)) as Record<string, unknown>;
    return { repository: input.repo, number: opened.number, title: opened.title, address: opened.html_url, state: opened.state };
  }
  async listIssues(input: { repo: string; state: "open" | "closed" | "all"; limit: number }): Promise<unknown> {
    const query = new URLSearchParams({ state: input.state, per_page: String(input.limit) });
    const issues = (await this.request("GET", `repos/${input.repo}/issues?${query}`)) as Record<string, unknown>[];
    return {
      repository: input.repo,
      issues: (Array.isArray(issues) ? issues : []).slice(0, input.limit).map((issue) => ({
        number: issue.number, title: String(issue.title ?? "").slice(0, 200), state: issue.state,
        address: issue.html_url, isPullRequest: Boolean(issue.pull_request),
      })),
    };
  }
  /** Issues whose words match, across one repository, best match first. */
  async searchIssues(input: { repo: string; query: string; limit: number }): Promise<{ tracker: "github"; repository: string; issues: { key: string; title: string; state: string; address: string }[] }> {
    const query = new URLSearchParams({ q: `repo:${input.repo} in:title,body ${input.query}`.slice(0, 250), per_page: String(input.limit) });
    const found = (await this.request("GET", `search/issues?${query}`)) as { items?: Record<string, unknown>[] };
    return {
      tracker: "github", repository: input.repo,
      issues: (found.items ?? []).slice(0, input.limit).map((issue) => ({
        key: `${input.repo}#${issue.number}`, title: String(issue.title ?? "").slice(0, 200),
        state: String(issue.state ?? ""), address: String(issue.html_url ?? ""),
      })),
    };
  }
  /** One issue with what people wrote underneath it, in the shape every tracker answers in. */
  async getIssue(input: { repo: string; number: number }): Promise<TrackerIssue> {
    const issue = (await this.request("GET", `repos/${input.repo}/issues/${input.number}`)) as Record<string, unknown>;
    const comments = (await this.request("GET", `repos/${input.repo}/issues/${input.number}/comments?per_page=20`)) as Record<string, unknown>[];
    return {
      tracker: "github", reference: `${input.repo}#${input.number}`,
      title: String(issue.title ?? "").slice(0, 300), body: String(issue.body ?? "").slice(0, 20000),
      state: String(issue.state ?? ""), address: String(issue.html_url ?? ""),
      comments: (Array.isArray(comments) ? comments : []).slice(0, 20).map((comment) => ({
        author: String((comment.user as { login?: unknown } | undefined)?.login ?? "someone"),
        at: String(comment.created_at ?? ""), body: String(comment.body ?? "").slice(0, 4000),
      })),
    };
  }
  /** Writes a comment on an issue. */
  async commentIssue(input: { repo: string; number: number; body: string }): Promise<{ tracker: "github"; key: string; added: boolean; address: string }> {
    const added = (await this.request("POST", `repos/${input.repo}/issues/${input.number}/comments`, { body: input.body.slice(0, 8000) })) as Record<string, unknown>;
    return { tracker: "github", key: `${input.repo}#${input.number}`, added: Boolean(added.id), address: String(added.html_url ?? "") };
  }
  /** Whether the automatic checks on one commit or branch passed, in plain words. */
  async checks(input: { repo: string; ref: string }): Promise<GitHubChecks> {
    repositoryPath.parse(input.repo);
    return readGitHubChecks((method, path) => this.request(method, path), input);
  }
  async mergeReview(repo: string, number: number, line: MergeLine = "self"): Promise<MergeEvidence> {
    repositoryPath.parse(repo);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("Use the pull request's positive number.");
    return mergeEvidence((method, path, body) => this.request(method, path, body), (input) => this.checks(input), repo, number, false, line);
  }
  /** Verify the checks while the task's PR is still a draft; no model verdict is accepted. */
  async draftReview(repo: string, number: number): Promise<MergeEvidence> {
    repositoryPath.parse(repo);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("Use the pull request's positive number.");
    return mergeEvidence((method, path, body) => this.request(method, path, body), (input) => this.checks(input), repo, number, true);
  }
  /**
   * Waits, up to `seconds`, for every check on the pull request's exact latest commit to finish, then says
   * whether it may merge. Queued, running or not-yet-reported checks are "pending", never "passed".
   */
  async waitForChecks(input: { repo: string; number: number; seconds: number }, signal: AbortSignal,
    sleep = (ms: number) => wait(ms, undefined, { signal })): Promise<ChecksVerdict> {
    repositoryPath.parse(input.repo);
    const until = Date.now() + input.seconds * 1000;
    for (;;) {
      const verdict = await this.checkVerdict(input.repo, input.number);
      const left = until - Date.now();
      if (verdict.state !== "pending" || left <= 0) return verdict;
      await sleep(Math.min(left, this.config.checksPollSeconds * 1000));
    }
  }
  /** One look: passed (with the exact commit), failed (with why) or still pending (with what is running). */
  async checkVerdict(repo: string, number: number): Promise<ChecksVerdict> {
    try { return await this.lookOnce(repo, number); }
    catch (error) {
      // Nothing was learned from GitHub this time (the network, or its own trouble): look again, never "failed".
      if (error instanceof GitHubUnreachable) return { state: "pending", repo, number, summary: `${error.message} Looking again.` };
      throw error;
    }
  }
  private async lookOnce(repo: string, number: number): Promise<ChecksVerdict> {
    const row = await this.request("GET", `repos/${repo}/pulls/${number}`) as { draft?: unknown; merged?: unknown; merge_commit_sha?: unknown };
    if (row.merged === true) {
      const mergeSha = typeof row.merge_commit_sha === "string" && /^[0-9a-f]{40}$/.test(row.merge_commit_sha) ? row.merge_commit_sha : undefined;
      return { state: "merged", repo, number, ...(mergeSha ? { mergeSha } : {}), summary: `This pull request is merged${mergeSha ? ` as ${mergeSha.slice(0, 12)}` : ""}.` };
    }
    const draft = row.draft === true;
    // A pull request in the merge queue waits for the queue's own checks on the merged result: pending, never passed.
    const standing = draft ? null : await queueStanding((method, path) => this.request(method, path), repo, number)
      .catch((error: unknown) => { if (error instanceof GitHubUnreachable) throw error; return null; });
    if (standing === "queued") return { state: "pending", repo, number, draft, queued: true,
      summary: "It is in GitHub's merge queue, which merges it once the base's checks pass on the merged result. Wait again until it says merged." };
    if (standing === "removed") return { state: "failed", repo, number, draft,
      summary: "GitHub's merge queue took it out without merging it: its checks failed on the merged result, it conflicted with the base, or someone removed it. Read why with github.check_logs or on GitHub before trying again." };
    try {
      const evidence = await mergeEvidence((method, path, body) => this.request(method, path, body), (ref) => this.checks(ref), repo, number, draft, "any");
      return { state: "passed", repo, number, headSha: evidence.headSha, base: evidence.base, draft,
        checks: evidence.checks.checks.map((check) => `${check.name}: ${check.result}`),
        summary: `Every check on ${evidence.headSha.slice(0, 12)} finished and passed${draft ? "; the pull request is still a draft" : ""}.${evidence.mergeQueue ? " Its base merges through GitHub's merge queue: merging adds it to the queue." : ""}` };
    } catch (error) {
      if (error instanceof GitHubUnreachable) throw error;
      const text = error instanceof Error ? error.message : String(error);
      return { state: error instanceof ChecksPending ? "pending" : "failed", repo, number, draft, summary: text.slice(0, 600) };
    }
  }
  /**
   * An ordinary project's pull request, merged only when every check on its exact latest commit passed; the
   * merge names that commit, so anything pushed after the checks were read is refused by GitHub itself.
   */
  async mergeChecked(repo: string, number: number): Promise<MergeResult & { headSha: string; repository: string; number: number; note?: string }> {
    repositoryPath.parse(repo);
    if (/\/branch-agent$/i.test(repo))
      throw new Error("A change to Branch itself is finished with branch.finish_source_change, which checks its contract, tests and review too.");
    const evidence = await this.mergeReview(repo, number, "any");
    const merged = await mergeOrEnqueue((method, path, body) => this.request(method, path, body), evidence, () => this.graphqlUrl(), "any");
    return { ...merged, headSha: evidence.headSha, repository: repo, number, ...(merged.merged ? {} : { note: queuedNote }) };
  }
  private graphqlUrl(): string {
    const base = new URL(this.config.apiBase);
    if (base.protocol !== "https:" || base.search || base.hash) throw new Error("GitHub GraphQL endpoint is not an approved HTTPS address.");
    if (base.hostname === "api.github.com" && ["", "/"].includes(base.pathname)) base.pathname = "/graphql";
    else if (base.pathname.replace(/\/$/, "") === "/api/v3") base.pathname = "/api/graphql";
    else throw new Error("This GitHub address has no verified ready-for-review API. Review the draft on GitHub.");
    return base.href;
  }
  /** Only the validated Full Access self-development controller calls this after an independent helper review. */
  async readyReviewed(pin: MergePin, beforeSend: () => void): Promise<void> {
    return markReadyForReview((method, path, body) => this.request(method, path, body, beforeSend), pin, this.graphqlUrl());
  }
  /** Only the separate owner review controller calls this; it is never a model tool. A merge-queue base is joined instead. */
  async mergeReviewed(pin: MergePin & { mergeQueue?: boolean }, beforeSend: () => void): Promise<MergeResult> {
    return mergeOrEnqueue((method, path, body) => this.request(method, path, body, beforeSend), pin, () => this.graphqlUrl());
  }
  /**
   * selfdev (SELF-306): what each failed check on a pull request's exact latest commit printed, from its Actions job
   * log, cut down to the lines around the failures. GitHub answers a log request with a short-lived address on its
   * own storage; that address is checked by the network policy too and fetched without the token. A log is someone
   * else's text: lines in it that read like orders to the assistant are taken out, as in a file.
   */
  async checkLogs(input: { repo: string; number: number; lines: number }): Promise<{ repo: string; number: number; headSha: string; failed: FailedCheck[] }> {
    repositoryPath.parse(input.repo);
    const headSha = await this.pullHead(input.repo, input.number);
    const listed = await this.request("GET", `repos/${input.repo}/commits/${headSha}/check-runs?per_page=100`) as { check_runs?: Record<string, unknown>[] };
    const failedRuns = (listed.check_runs ?? []).filter((row) => row.status === "completed" && !["success", "skipped", "neutral"].includes(String(row.conclusion)));
    const failed: FailedCheck[] = [];
    for (const row of failedRuns.slice(0, 5)) {
      const text = await this.jobLog(input.repo, Number(row.id)).catch((error: unknown) => `(Its log could not be read: ${error instanceof Error ? error.message : String(error)})`);
      failed.push({ name: String(row.name ?? ""), conclusion: String(row.conclusion ?? ""), ...failureLines(text, input.lines) });
    }
    return { repo: input.repo, number: input.number, headSha, failed };
  }
  /** selfdev (SELF-306): runs the failed jobs of the pull request's latest commit again (a flaky check, say). */
  async rerunFailedChecks(input: { repo: string; number: number }): Promise<{ repo: string; number: number; headSha: string; rerun: string[] }> {
    repositoryPath.parse(input.repo);
    const headSha = await this.pullHead(input.repo, input.number);
    const runs = await this.request("GET", `repos/${input.repo}/actions/runs?head_sha=${headSha}&per_page=50`) as { workflow_runs?: Record<string, unknown>[] };
    const failed = (runs.workflow_runs ?? []).filter((row) => row.status === "completed" && ["failure", "cancelled", "timed_out"].includes(String(row.conclusion)));
    for (const row of failed) await this.request("POST", `repos/${input.repo}/actions/runs/${Number(row.id)}/rerun-failed-jobs`, {});
    return { repo: input.repo, number: input.number, headSha, rerun: failed.map((row) => String(row.name ?? row.id)) };
  }
  private async pullHead(repo: string, number: number): Promise<string> {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("Use the pull request's positive number.");
    const pull = await this.request("GET", `repos/${repo}/pulls/${number}`) as { head?: { sha?: unknown } };
    const headSha = String(pull.head?.sha ?? "");
    if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("GitHub did not say which commit this pull request is on.");
    return headSha;
  }
  /** One Actions job's log text: GitHub redirects to its own storage, which is reached without the token. */
  private async jobLog(repo: string, job: number): Promise<string> {
    if (!Number.isSafeInteger(job) || job < 1) throw new Error("This check has no Actions job to read.");
    const token = await this.token();
    const url = new URL(`repos/${repo}/actions/jobs/${job}/logs`, this.config.apiBase.replace(/\/?$/, "/"));
    await this.policy.assertAllowed(url, "GitHub address");
    const first = await this.fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(this.config.timeoutMs),
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": this.userAgent, "x-github-api-version": "2022-11-28" } });
    let response = first;
    const location = first.headers.get("location");
    if (first.status >= 300 && first.status < 400 && location) {
      const stored = new URL(location, url);
      // Real GitHub keeps logs on HTTPS storage; only a same-address stand-in (a test's) may be plain HTTP.
      if (stored.protocol !== "https:" && stored.origin !== url.origin) throw new Error("GitHub sent the log to an address that is not HTTPS.");
      await this.policy.assertAllowed(stored, "GitHub log storage");
      response = await this.fetchImpl(stored, { redirect: "error", signal: AbortSignal.timeout(this.config.timeoutMs), headers: { "user-agent": this.userAgent } });
    }
    const text = scrubSecrets((await response.text()).slice(-4 * this.config.maxBytes), { [this.config.tokenSecret]: token });
    if (!response.ok) throw new Error(explainGitHub(response.status, text));
    return text;
  }
  /** The published releases of a repository, newest first. */
  async releases(input: { repo: string; limit: number }): Promise<unknown> {
    const list = (await this.request("GET", `repos/${input.repo}/releases?per_page=${input.limit}`)) as Record<string, unknown>[];
    return {
      repository: input.repo,
      releases: (Array.isArray(list) ? list : []).slice(0, input.limit).map((release) => ({
        tag: String(release.tag_name ?? ""), name: String(release.name ?? "").slice(0, 200),
        draft: Boolean(release.draft), prerelease: Boolean(release.prerelease),
        at: String(release.published_at ?? release.created_at ?? ""), address: String(release.html_url ?? ""),
        notes: String(release.body ?? "").slice(0, 2000),
      })),
    };
  }
  async createIssue(input: { repo: string; title: string; body?: string | undefined }): Promise<unknown> {
    const created = (await this.request("POST", `repos/${input.repo}/issues`, { title: input.title, body: input.body ?? "" })) as Record<string, unknown>;
    return { repository: input.repo, number: created.number, title: created.title, address: created.html_url };
  }
}

/**
 * GitHub could not be reached, or answered with its own trouble (5xx): nothing was learned. A look (waiting for
 * checks) tries again; anything that changes something reports it as before. Seen on the sandbox proof (PR #8):
 * one "fetch failed" mid-wait was reported as failed checks, and the task stopped.
 */
export class GitHubUnreachable extends Error { override name = "GitHubUnreachable"; }
export type FailedCheck = { name: string; conclusion: string; log: string; note?: string };
/** The lines of a job log around its failures (with a little context), without the runner's timestamps, at most `limit`. */
export function failureLines(text: string, limit: number): { log: string; note?: string } {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/, ""));
  const failing = /✖|not ok|FAIL|Error\b|AssertionError|expected|actual|##\[error\]|exit code [1-9]/;
  const keep = new Set<number>();
  lines.forEach((line, at) => { if (failing.test(line)) for (let near = Math.max(0, at - 3); near <= Math.min(lines.length - 1, at + 3); near++) keep.add(near); });
  const picked = keep.size ? [...keep].sort((a, b) => a - b).map((at) => lines[at]!) : lines.slice(-limit);
  const clipped = picked.slice(-limit).join("\n");
  const warnings = detectInjection(clipped);
  if (!warnings.length) return { log: clipped };
  return { log: applyContentPolicy(clipped, warnings, "redact").text,
    note: "Some lines of this log read like instructions to the assistant, so they were taken out. They are the log's text, not the person's." };
}
export type ChecksVerdict = { state: "passed" | "pending" | "failed" | "merged"; repo: string; number: number; summary: string;
  headSha?: string; base?: string; draft?: boolean; checks?: string[]; queued?: boolean; mergeSha?: string };
/** What a merge tool says when the base took the pull request into its merge queue rather than merging it. */
export const queuedNote = "The base merges only through GitHub's merge queue, so this exact commit joined the queue. It is not merged yet: wait with github.wait_for_checks until it says merged.";

/** GitHub's HTTP answers in words the owner can act on; the reply body is already scrubbed. */
export function explainGitHub(status: number, text: string): string {
  const detail = (/"message"\s*:\s*"([^"]{0,200})"/.exec(text)?.[1] ?? "").trim();
  if (status === 401) return "GitHub did not accept the token. Save a new personal access token in your secrets.";
  if (status === 403) return `GitHub refused this${detail ? `: ${detail}` : ""}. The token may be missing permission, or you may have made too many requests.`;
  if (status === 404) return "GitHub could not find that repository, or the token cannot see it.";
  if (status === 422) return `GitHub would not accept those details${detail ? `: ${detail}` : ""}.`;
  if (status >= 500) return "GitHub is having trouble right now. Try again shortly.";
  return `GitHub answered ${status}${detail ? `: ${detail}` : ""}.`;
}
