import { z } from "zod";
import { scrubSecrets } from "../locker.js";
import type { NetworkPolicy } from "../network-policy.js";
import type { ToolRegistry } from "../registry.js";
import type { TrackerIssue } from "./issue-context.js";

/**
 * GitLab, to match what Branch does with GitHub: the issues and merge requests on a project, one of
 * each with what people wrote under it, how its pipelines went and its releases; and, each behind the
 * owner's yes, raising an issue, writing a comment, opening a merge request (a draft when Branch opens
 * it by itself) and making a project. The key is a personal access token kept in the owner's locker
 * (Settings › Advanced › GitLab, src/gitlab-connection.ts); it travels in the header, never in a web
 * address, and is scrubbed out of everything reported back.
 */
export const GitLabConfigSchema = z.object({
  apiBase: z.string().url().default("https://gitlab.com/api/v4"),
  tokenSecret: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).default("GITLAB_TOKEN"),
  timeoutMs: z.number().int().min(1000).max(60000).default(20000),
  maxBytes: z.number().int().min(4096).max(1048576).default(262144),
}).strict();
export type GitLabConfig = z.infer<typeof GitLabConfigSchema>;
/** A project is written the way GitLab writes it: group/name, or group/subgroup/name. */
export const projectPath = z.string().regex(/^[A-Za-z0-9._-]{1,60}(?:\/[A-Za-z0-9._-]{1,60}){1,4}$/, "Write the project as group/name");

export class GitLabAccess {
  private readonly config: GitLabConfig;
  constructor(input: unknown, private readonly policy: NetworkPolicy, private readonly token: () => Promise<string>,
    private readonly fetchImpl: typeof fetch = globalThis.fetch, private readonly userAgent = "BranchAgent") {
    this.config = GitLabConfigSchema.parse(input);
  }
  get tokenSecret(): string { return this.config.tokenSecret; }
  /** bucket-18 (A0174): the server this key belongs to, so an issue address elsewhere is not fetched with it. */
  get host(): string { return new URL(this.config.apiBase).host.toLowerCase(); }

  private async request(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<unknown> {
    const token = await this.token();
    const url = new URL(path.replace(/^\//, ""), this.config.apiBase.replace(/\/?$/, "/"));
    await this.policy.assertAllowed(url, "GitLab address");
    const response = await this.fetchImpl(url, {
      method, redirect: "error", signal: AbortSignal.timeout(this.config.timeoutMs),
      headers: { "private-token": token, accept: "application/json", "user-agent": this.userAgent,
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = scrubSecrets((await response.text()).slice(0, this.config.maxBytes), { [this.config.tokenSecret]: token });
    if (!response.ok) throw new Error(explainGitLab(response.status, text));
    return text ? JSON.parse(text) : [];
  }
  private id(project: string): string { return encodeURIComponent(project); }

  async issues(input: { project: string; state: "opened" | "closed" | "all"; limit: number }): Promise<unknown> {
    const list = (await this.request(`projects/${this.id(input.project)}/issues?state=${input.state}&per_page=${input.limit}`)) as Record<string, unknown>[];
    return {
      project: input.project,
      issues: (Array.isArray(list) ? list : []).slice(0, input.limit).map((issue) => ({
        number: issue.iid, title: String(issue.title ?? "").slice(0, 200),
        state: issue.state, address: issue.web_url, at: issue.created_at,
      })),
    };
  }
  async releases(input: { project: string; limit: number }): Promise<unknown> {
    const list = (await this.request(`projects/${this.id(input.project)}/releases?per_page=${input.limit}`)) as Record<string, unknown>[];
    return {
      project: input.project,
      releases: (Array.isArray(list) ? list : []).slice(0, input.limit).map((release) => ({
        tag: String(release.tag_name ?? ""), name: String(release.name ?? "").slice(0, 200),
        at: String(release.released_at ?? ""), notes: String(release.description ?? "").slice(0, 2000),
      })),
    };
  }
  /** One issue with comments, in the shape every tracker answers in. */
  async getIssue(input: { project: string; number: number }): Promise<TrackerIssue> {
    const issue = (await this.request(`projects/${this.id(input.project)}/issues/${input.number}`)) as Record<string, unknown>;
    const comments = (await this.request(`projects/${this.id(input.project)}/issues/${input.number}/notes?per_page=20`)) as Record<string, unknown>[];
    return {
      tracker: "gitlab",
      reference: `${input.project}#${input.number}`,
      title: String(issue.title ?? "").slice(0, 300),
      body: String(issue.description ?? "").slice(0, 20000),
      state: String(issue.state ?? ""),
      address: String(issue.web_url ?? ""),
      comments: (Array.isArray(comments) ? comments : []).slice(0, 20).map((comment) => ({
        author: String((comment.author as { name?: unknown } | undefined)?.name ?? "someone"),
        at: String(comment.created_at ?? ""),
        body: String(comment.body ?? "").slice(0, 4000),
      })),
    };
  }
  /** How the automatic checks went on a branch or a commit, newest first. */
  async pipelines(input: { project: string; ref?: string | undefined; limit: number }): Promise<unknown> {
    const query = new URLSearchParams({ per_page: String(input.limit), ...(input.ref ? { ref: input.ref } : {}) });
    const list = (await this.request(`projects/${this.id(input.project)}/pipelines?${query}`)) as Record<string, unknown>[];
    const runs = (Array.isArray(list) ? list : []).slice(0, input.limit).map((run) => ({
      id: run.id, ref: String(run.ref ?? ""), result: String(run.status ?? ""), address: String(run.web_url ?? ""), at: String(run.updated_at ?? ""),
    }));
    return {
      project: input.project, pipelines: runs,
      summary: !runs.length ? "No pipelines have run on this yet."
        : `The most recent one ${runs[0]!.result === "success" ? "passed" : `came back "${runs[0]!.result}"`}.`,
    };
  }
  /** Who the saved token belongs to: checked once when it is saved, so a wrong one is never kept. */
  async whoami(): Promise<{ username: string; name: string }> {
    const me = (await this.request("user")) as Record<string, unknown>;
    return { username: String(me.username ?? ""), name: String(me.name ?? "").slice(0, 200) };
  }
  async mergeRequests(input: { project: string; state: "opened" | "closed" | "merged" | "all"; limit: number }): Promise<unknown> {
    const list = (await this.request(`projects/${this.id(input.project)}/merge_requests?state=${input.state}&per_page=${input.limit}`)) as Record<string, unknown>[];
    return {
      project: input.project,
      mergeRequests: (Array.isArray(list) ? list : []).slice(0, input.limit).map((mr) => ({
        number: mr.iid, title: String(mr.title ?? "").slice(0, 200), state: mr.state, draft: Boolean(mr.draft),
        from: String(mr.source_branch ?? ""), into: String(mr.target_branch ?? ""), address: mr.web_url,
      })),
    };
  }
  /** One merge request with what people wrote under it and how its latest pipeline went. */
  async mergeRequest(input: { project: string; number: number }): Promise<unknown> {
    const base = `projects/${this.id(input.project)}/merge_requests/${input.number}`;
    const mr = (await this.request(base)) as Record<string, unknown>;
    const notes = (await this.request(`${base}/notes?per_page=20&sort=asc`)) as Record<string, unknown>[];
    const pipeline = (mr.head_pipeline ?? mr.pipeline) as Record<string, unknown> | null | undefined;
    return {
      project: input.project, number: mr.iid, title: String(mr.title ?? "").slice(0, 300),
      body: String(mr.description ?? "").slice(0, 20000), state: String(mr.state ?? ""), draft: Boolean(mr.draft),
      from: String(mr.source_branch ?? ""), into: String(mr.target_branch ?? ""), address: String(mr.web_url ?? ""),
      pipeline: pipeline ? String(pipeline.status ?? "") : "none yet",
      comments: (Array.isArray(notes) ? notes : []).filter((note) => !note.system).slice(0, 20).map((note) => ({
        author: String((note.author as { name?: unknown } | undefined)?.name ?? "someone"),
        at: String(note.created_at ?? ""), body: String(note.body ?? "").slice(0, 4000),
      })),
    };
  }
  async createIssue(input: { project: string; title: string; body?: string | undefined }): Promise<unknown> {
    const made = (await this.request(`projects/${this.id(input.project)}/issues`, "POST", { title: input.title, description: input.body ?? "" })) as Record<string, unknown>;
    return { project: input.project, number: made.iid, title: made.title, address: made.web_url };
  }
  /** A comment under an issue or a merge request. */
  async comment(input: { project: string; on: "issue" | "merge_request"; number: number; body: string }): Promise<unknown> {
    const kind = input.on === "issue" ? "issues" : "merge_requests";
    const note = (await this.request(`projects/${this.id(input.project)}/${kind}/${input.number}/notes`, "POST", { body: input.body.slice(0, 8000) })) as Record<string, unknown>;
    return { project: input.project, on: input.on, number: input.number, added: Boolean(note.id) };
  }
  async openMergeRequest(input: { project: string; title: string; body?: string | undefined; from: string; into: string; draft?: boolean | undefined }): Promise<unknown> {
    // As with GitHub (A0300): one Branch opens by itself is a draft until a person says otherwise.
    const title = input.draft && !/^draft:/i.test(input.title) ? `Draft: ${input.title}` : input.title;
    const made = (await this.request(`projects/${this.id(input.project)}/merge_requests`, "POST",
      { title, description: input.body ?? "", source_branch: input.from, target_branch: input.into })) as Record<string, unknown>;
    return { project: input.project, number: made.iid, title: made.title, draft: Boolean(made.draft), address: made.web_url, state: made.state };
  }
  /** A new project under the owner's account, private unless they say otherwise. */
  async createProject(input: { name: string; description?: string | undefined; private: boolean }): Promise<unknown> {
    const made = (await this.request("projects", "POST", { name: input.name, description: input.description ?? "",
      visibility: input.private ? "private" : "public", initialize_with_readme: true })) as Record<string, unknown>;
    return { project: made.path_with_namespace, address: made.web_url, private: made.visibility === "private", defaultBranch: made.default_branch };
  }
}

/** GitLab's HTTP answers in words the owner can act on. */
export function explainGitLab(status: number, text: string): string {
  const detail = (/"message"\s*:\s*"([^"]{0,200})"/.exec(text)?.[1] ?? "").trim();
  if (status === 401) return "GitLab did not accept the token. Save a new personal access token in your secrets.";
  if (status === 403) return `GitLab refused this${detail ? `: ${detail}` : ""}. The token may be missing permission.`;
  if (status === 404) return "GitLab could not find that project, or the token cannot see it.";
  if (status === 400 || status === 409 || status === 422) return `GitLab would not accept those details${detail ? `: ${detail}` : ""}.`;
  if (status >= 500) return "GitLab is having trouble right now. Try again shortly.";
  return `GitLab answered ${status}${detail ? `: ${detail}` : ""}.`;
}

const branch = z.string().regex(/^[A-Za-z0-9._\/-]{1,200}$/, "Write a branch name");
const title = z.string().trim().min(1).max(250);
const number = z.number().int().min(1);
const projectName = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/, "Project names use letters, digits, dots, dashes and underscores");

/** The tools that only look (`gitlab.read`). */
function registerGitLabReads(registry: ToolRegistry, gitlab: (owner: string) => GitLabAccess): void {
  registry.register({
    name: "gitlab.issues", permission: "gitlab.read", group: "git",
    target: (args) => String(args.project),
    description: "List the issues on a GitLab project, newest first.",
    parameters: z.object({
      project: projectPath, state: z.enum(["opened", "closed", "all"]).default("opened"),
      limit: z.number().int().min(1).max(50).default(20),
    }).strict(),
    execute: (input, context) => gitlab(context.owner).issues(input),
  });
  registry.register({
    name: "gitlab.issue", permission: "gitlab.read", group: "git",
    target: (args) => String(args.project),
    description: "One GitLab issue in full, with what people wrote under it.",
    parameters: z.object({ project: projectPath, number }).strict(),
    execute: (input, context) => gitlab(context.owner).getIssue(input),
  });
  registry.register({
    name: "gitlab.merge_requests", permission: "gitlab.read", group: "git",
    target: (args) => String(args.project),
    description: "List the merge requests on a GitLab project, newest first, with the branch each would bring in.",
    parameters: z.object({
      project: projectPath, state: z.enum(["opened", "closed", "merged", "all"]).default("opened"),
      limit: z.number().int().min(1).max(50).default(20),
    }).strict(),
    execute: (input, context) => gitlab(context.owner).mergeRequests(input),
  });
  registry.register({
    name: "gitlab.merge_request", permission: "gitlab.read", group: "git",
    target: (args) => String(args.project),
    description: "One GitLab merge request in full: its description, what people wrote under it and how its pipeline went.",
    parameters: z.object({ project: projectPath, number }).strict(),
    execute: (input, context) => gitlab(context.owner).mergeRequest(input),
  });
  registry.register({
    name: "gitlab.releases", permission: "gitlab.read", group: "git",
    target: (args) => String(args.project),
    description: "The published releases of a GitLab project, newest first.",
    parameters: z.object({ project: projectPath, limit: z.number().int().min(1).max(30).default(10) }).strict(),
    execute: (input, context) => gitlab(context.owner).releases(input),
  });
  registry.register({
    name: "gitlab.pipelines", permission: "gitlab.read", group: "git",
    target: (args) => String(args.project),
    description: "How the automatic checks went on a GitLab project, for a branch or for all of it.",
    parameters: z.object({
      project: projectPath, ref: z.string().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(30).default(10),
    }).strict(),
    execute: (input, context) => gitlab(context.owner).pipelines(input),
  });
}

/** The tools that change something on GitLab (`gitlab.manage`): each asks the owner first. */
function registerGitLabWrites(registry: ToolRegistry, gitlab: (owner: string) => GitLabAccess): void {
  registry.register({
    name: "gitlab.create_issue", permission: "gitlab.manage", group: "git",
    target: (args) => String(args.project),
    description: "Raise an issue on a GitLab project.",
    parameters: z.object({ project: projectPath, title, body: z.string().max(8000).optional() }).strict(),
    execute: (input, context) => gitlab(context.owner).createIssue(input),
  });
  registry.register({
    name: "gitlab.comment", permission: "gitlab.manage", group: "git",
    target: (args) => String(args.project),
    description: "Write a comment under a GitLab issue or merge request.",
    parameters: z.object({ project: projectPath, on: z.enum(["issue", "merge_request"]), number, body: z.string().trim().min(1).max(8000) }).strict(),
    execute: (input, context) => gitlab(context.owner).comment(input),
  });
  registry.register({
    name: "gitlab.open_merge_request", permission: "gitlab.manage", group: "git",
    target: (args) => String(args.project),
    description: "Open a merge request on GitLab so someone can review one branch of work before it joins another. Set draft when it isn't ready to merge.",
    parameters: z.object({ project: projectPath, title, body: z.string().max(8000).optional(), from: branch, into: branch, draft: z.boolean().optional() }).strict(),
    execute: (input, context) => gitlab(context.owner).openMergeRequest(input),
  });
  registry.register({
    name: "gitlab.create_project", permission: "gitlab.manage", group: "git",
    target: (args) => String(args.name),
    description: "Make a project on GitLab under the owner's account. It is private unless you say otherwise.",
    parameters: z.object({ name: projectName, description: z.string().max(350).optional(), private: z.boolean().default(true) }).strict(),
    execute: (input, context) => gitlab(context.owner).createProject(input),
  });
}

/** Every GitLab tool. `gitlab` gives the connection for the owner at the moment of a call (src/gitlab-connection.ts). */
export function registerGitLab(registry: ToolRegistry, gitlab: (owner: string) => GitLabAccess): void {
  registerGitLabReads(registry, gitlab);
  registerGitLabWrites(registry, gitlab);
}
