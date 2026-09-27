import { z } from "zod";
import { scrubSecrets } from "../locker.js";
import type { NetworkPolicy } from "../network-policy.js";
import type { TrackerIssue } from "./issue-context.js";
import { readGitHubChecks, type GitHubChecks } from "./github-checks.js";

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

  /** One REST call: the network policy decides whether the address may be reached at all. */
  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await this.token();
    const url = new URL(path.replace(/^\//, ""), this.config.apiBase.replace(/\/?$/, "/"));
    await this.policy.assertAllowed(url, "GitHub address");
    const response = await this.fetchImpl(url, {
      method, redirect: "error", signal: AbortSignal.timeout(this.config.timeoutMs),
      headers: {
        authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
        "user-agent": this.userAgent, "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = scrubSecrets((await response.text()).slice(0, this.config.maxBytes), { [this.config.tokenSecret]: token });
    if (!response.ok) throw new Error(explainGitHub(response.status, text));
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
