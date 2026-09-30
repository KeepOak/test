import { z } from "zod";
import { posix } from "node:path";
import type { ToolContext, ToolTarget } from "../contracts.js";
import type { ToolRegistry } from "../registry.js";
import type { GitTools } from "./git.js";
import { repositoryName, repositoryPath, type GitHubAccess } from "./github.js";
import { pullRequestTemplate } from "./issue-context.js";
import { referenceToLink } from "./issue-tools.js";

/**
 * The version-control tools, in three groups so the owner can allow them separately: reading
 * (`git.read`), changing this computer's copy (`git.write`) and talking to a server
 * (`git.remote`, which is switched off until the owner turns it on). GitHub lives behind
 * `github.manage` and needs a saved token.
 */
const folder = z.string().min(1).max(200).regex(/^[^\\:\0-][^\\:\0]*$/, "Use a folder inside your workspace").default(".");
// A tool's `pattern` is checked by the ChatGPT endpoint against the RE2 subset, which has no
// lookahead. One lookahead anywhere refuses the whole request and takes every other tool in that
// round with it: a task that merely said "git" failed in three seconds, having run nothing. These
// say the same thing without one, the way `folder` above already does; what a lookahead expressed
// about the whole value (no "..", no ".lock" ending) is now a check beside the pattern.
const branchName = z.string().min(1).max(100).regex(/^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/, "Use letters, digits, dots, dashes and slashes")
  .refine((value) => !value.includes(".."), "No .. in a branch name")
  .refine((value) => !value.endsWith(".lock"), "A branch name cannot end with .lock");
const pullRequestHead = z.string().min(1).max(201).regex(/^[A-Za-z0-9._/:-]+$/, "Use a branch, or owner:branch for a fork")
  .refine((value) => !value.includes("..") && !value.endsWith(".lock") && (value.match(/:/g)?.length ?? 0) <= 1,
    "Use a branch, or owner:branch for a fork");
const revisionRange = z.string().min(1).max(200).regex(/^[A-Za-z0-9._/@^~][A-Za-z0-9._/@^~-]*(\.{2,3}[A-Za-z0-9._/@^~-]+)?$/, "Use a commit, a branch, or a range such as main..mine");
const filePath = z.string().min(1).max(500).regex(/^[^\\:\0-][^\\:\0]*$/, "Use a path inside the folder");
const copyName = z.string().min(1).max(40).regex(/^[a-z0-9][a-z0-9._-]*$/, "Use lowercase letters, digits, dots, dashes and underscores").refine((v) => !v.includes(".."), "No .. in a name");
const remoteName = z.string().min(1).max(40).regex(/^[A-Za-z][A-Za-z0-9._-]*$/, "Use a remote name such as origin").default("origin");
const title = z.string().trim().min(1).max(200);

/**
 * mac7/multi-target: the repository folder a git tool works in, and any file it names inside it, so a
 * folder rule ("never anything under finance", a read-only folder) covers the repository too.
 */
function inFolder(kind: ToolTarget["kind"]) {
  return (args: { folder: string; path?: string | undefined; paths?: string[] | undefined }): ToolTarget[] => {
    const named = [args.path, ...(args.paths ?? [])].filter((one): one is string => !!one);
    // Integration: with no file named, the tool reaches the whole working copy (a diff shows every
    // changed line, a commit saves every change), so a rule about a folder inside it counts too.
    return [
      { kind, path: args.folder, ...(named.length ? {} : { folder: true }) },
      ...named.map((one) => ({ kind, path: posix.join(args.folder, one) })),
    ];
  };
}

/** Reading and changing the copy of the repository on this computer. */
export function registerGit(registry: ToolRegistry, git: GitTools): void {
  registry.register({
    name: "git.status", permission: "git.read",
    description: "Show what has changed in a repository folder since the last saved version, which line of work is active, and whether it is ahead of or behind the shared copy.",
    parameters: z.object({ folder }).strict(),
    targets: inFolder("read"),
    execute: (input, context: ToolContext) => git.status(input.folder, context.signal),
  });
  registry.register({
    name: "git.diff", permission: "git.read",
    description: "Show the actual changed lines, either in the working folder or between two points such as main..mine. The text is capped; files hidden by .branchignore are left out.",
    parameters: z.object({ folder, range: revisionRange.optional(), staged: z.boolean().default(false) }).strict()
      .refine((input) => !(input.staged && input.range), "Ask either for what is staged or for a range, not both"),
    targets: inFolder("read"),
    execute: (input, context: ToolContext) => git.diff(input, context.signal),
  });
  registry.register({
    name: "git.log", permission: "git.read",
    description: "List recent saved versions of a repository folder, newest first, with who saved each one and its summary line.",
    parameters: z.object({ folder, limit: z.number().int().min(1).max(100).default(20), path: filePath.optional() }).strict(),
    targets: inFolder("read"),
    execute: (input, context: ToolContext) => git.log(input, context.signal),
  });
  registry.register({
    name: "git.branch", permission: "git.write",
    description: "List the separate lines of work in a repository, start a new one, or switch to an existing one.",
    parameters: z.object({ folder, action: z.enum(["list", "create", "switch"]).default("list"), name: branchName.optional() }).strict(),
    targets: inFolder("write"),
    execute: (input, context: ToolContext) => git.branch(input, context.signal),
  });
  registry.register({
    name: "git.commit", permission: "git.write",
    description: "Save a version of the changed files with a short message describing them. Saves everything that changed unless you name paths. It refuses when nothing has changed and never rewrites an earlier saved version.",
    parameters: z.object({ folder, message: z.string().trim().min(1).max(2000), paths: z.array(filePath).max(50).optional() }).strict(),
    targets: inFolder("write"),
    execute: (input, context: ToolContext) => git.commit(input, context.signal),
  });
  registerWorktrees(registry, git);
  registerPlanBranches(registry, git);
}

/**
 * Parallel copies, one tool per thing you might want to do, because "add", "list" and "remove"
 * behind one name is a step the model has to work out rather than read. Copies live only in
 * .branch-worktrees inside the workspace, so an experiment never spreads elsewhere.
 */
function registerWorktrees(registry: ToolRegistry, git: GitTools): void {
  registry.register({
    name: "git.worktree_add", permission: "git.write",
    description: "Make a parallel copy of the repository for an experiment, in .branch-worktrees.",
    parameters: z.object({ folder, name: copyName, branch: branchName.optional() }).strict(),
    target: (args) => `parallel copy ${args.name}`,
    targets: inFolder("write"),
    execute: (input, context: ToolContext) => git.worktree({ ...input, action: "add" }, context.signal),
  });
  registry.register({
    name: "git.worktree_list", permission: "git.read",
    description: "The parallel copies of a repository that exist right now.",
    parameters: z.object({ folder }).strict(),
    targets: inFolder("read"),
    execute: (input, context: ToolContext) => git.worktree({ ...input, action: "list" }, context.signal),
  });
  registry.register({
    name: "git.worktree_remove", permission: "git.write",
    description: "Remove a parallel copy of the repository and everything left in it.",
    parameters: z.object({ folder, name: copyName }).strict(),
    target: (args) => `remove parallel copy ${args.name}`,
    targets: inFolder("write"),
    execute: (input, context: ToolContext) => git.worktree({ ...input, action: "remove" }, context.signal),
  });
}

/**
 * Plan branches: try something risky in a parallel copy, look at exactly what it changed, and only
 * then bring it back. These sit with plans and procedures rather than with everyday version
 * control, because that is what they are for — and because the everyday version-control box should
 * not grow every time a way of trying something is added to it.
 */
function registerPlanBranches(registry: ToolRegistry, git: GitTools): void {
  registry.register({
    name: "plans.try", permission: "git.write",
    description: "Try a plan in a parallel copy of the repository, on a line of work named after it.",
    parameters: z.object({ folder, name: copyName, from: branchName.optional() }).strict(),
    target: (args) => `try "${args.name}" in a parallel copy`,
    targets: inFolder("write"),
    execute: (input, context: ToolContext) => git.planStart(input, context.signal),
  });
  registry.register({
    name: "plans.diff", permission: "git.read",
    description: "What trying a plan changed, compared with where it started. Read this before merging.",
    parameters: z.object({ folder, name: copyName, against: branchName.optional() }).strict(),
    targets: inFolder("read"),
    execute: (input, context: ToolContext) => git.planDiff(input, context.signal),
  });
  registry.register({
    name: "plans.merge", permission: "git.write",
    description: "Bring a plan's work back onto the line of work you are on and put the copy away.",
    parameters: z.object({ folder, name: copyName, message: z.string().trim().max(200).optional(), remove: z.boolean().default(true) }).strict(),
    target: (args) => `merge "${args.name}" back into the current line of work`,
    targets: inFolder("write"),
    execute: (input, context: ToolContext) => git.planMerge(input, context.signal),
  });
}

/** Sending and receiving work; registered only when the owner has switched remote access on. */
export function registerGitRemote(registry: ToolRegistry, git: GitTools): void {
  registry.register({
    name: "git.clone", permission: "git.remote",
    description: "Clone a repository: bring it onto this computer for the first time, into a new workspace folder, from its https:// address or a repository folder path. Optionally pick the branch to check out.",
    parameters: z.object({ url: z.string().trim().min(1).max(1000), folder: filePath, branch: branchName.optional() }).strict(),
    target: (args) => `clone ${String(args.url)} into ${String(args.folder)}`,
    execute: (input, context: ToolContext) => git.clone(input, context.signal),
  });
  registry.register({
    name: "git.push", permission: "git.remote",
    description: "Send saved versions from this computer to the shared server. Sending to the branch everyone shares (main or master) stops and asks you first.",
    parameters: z.object({ folder, remote: remoteName, branch: branchName.optional(), confirmed: z.boolean().default(false) }).strict(),
    targets: inFolder("write"),
    execute: (input, context: ToolContext) => git.push(input, context.signal, { ref: context.sendsRef, commit: context.sendsCommit }),
  });
  registry.register({
    name: "git.pull", permission: "git.remote",
    description: "Bring down work from the shared server, only when it can be added cleanly on top of yours.",
    parameters: z.object({ folder, remote: remoteName, branch: branchName.optional() }).strict(),
    targets: inFolder("write"),
    execute: (input, context: ToolContext) => git.pull(input, context.signal),
  });
}

/**
 * Opening a pull request. When the task names the issue it settles, the description is written
 * from the shared template so the issue is linked and closes itself when the work is merged; the
 * issue is read first, so its title goes in the description and a wrong reference is caught here
 * rather than after the pull request exists.
 */
async function openPullRequest(
  github: GitHubAccess,
  input: { repo: string; title: string; body?: string | undefined; base: string; head: string; issue?: string | undefined; changes?: string[] | undefined; draft?: boolean | undefined },
): Promise<unknown> {
  const { issue: reference, changes, ...rest } = input;
  if (!reference) return github.openPullRequest(rest);
  const link = referenceToLink(reference);
  if (link.tracker !== "github") throw new Error("A GitHub pull request can only close a GitHub issue; mention a Linear issue in the description instead");
  const issue = await github.getIssue({ repo: link.repo, number: link.number });
  const body = pullRequestTemplate({ issue, summary: input.body ?? input.title, ...(changes ? { changes } : {}) });
  return github.openPullRequest({ ...rest, body });
}

/**
 * Reading how a project on GitHub is doing, and putting a folder on GitHub for the first time.
 * Publishing creates the repository and then sends the work with the Git sign-in this computer
 * already has: no token is written into the repository's settings, and the person is asked first.
 * The token is the owner's personal access token, or an installation token from the owner's own
 * GitHub App when that is switched on (src/integrations/github-app.ts, bucket 18).
 */
const githubConnections = new WeakMap<ToolRegistry, GitHubAccess>();
/** The owner review screen uses the currently offered, authenticated connection, never a model tool. */
export function ownerGitHubConnection(registry: ToolRegistry): GitHubAccess {
  const github = githubConnections.get(registry);
  if (!github || !registry.names().includes("github.checks")) throw new Error("Connect GitHub in Settings before reviewing a merge.");
  return github;
}
/** The saved connection a queued publication reconciles through: the one the GitHub tools use, while they are offered. */
export function githubAccessForPublication(registry: ToolRegistry): GitHubAccess | null {
  return registry.names().includes("github.open_pull_request") ? githubConnections.get(registry) ?? null : null;
}
export function registerGitHubProject(registry: ToolRegistry, github: GitHubAccess, git?: GitTools): void {
  githubConnections.set(registry, github);
  registry.register({
    name: "github.issues", permission: "github.manage",
    description: "List the issues on a GitHub repository, newest first, saying which of them are really pull requests.",
    parameters: z.object({ repo: repositoryPath, state: z.enum(["open", "closed", "all"]).default("open"), limit: z.number().int().min(1).max(50).default(20) }).strict(),
    execute: (input) => github.listIssues(input),
  });
  registry.register({
    name: "github.checks", permission: "github.manage",
    description: "Whether the automatic checks passed on a branch or a saved version, and which ones did not.",
    parameters: z.object({ repo: repositoryPath, ref: revisionRange }).strict(),
    execute: (input) => github.checks(input),
  });
  registry.register({
    name: "github.wait_for_checks", permission: "github.manage",
    description: "Wait for every check on a pull request's exact latest commit to finish, then say passed, failed, still pending or merged. Queued, running or not-yet-reported checks never count as passed, and a pull request in GitHub's merge queue is pending until the queue merges it. Call again while it says pending; merge only after it says passed.",
    parameters: z.object({ repo: repositoryPath, number: z.number().int().positive(),
      /** How long to wait in this call, up to ten minutes: CI and a merge queue can each take half an hour. */
      seconds: z.number().int().min(0).max(600).default(300) }).strict(),
    // selfdev (SELF-022): it only looks, so one call may wait its ten minutes past the owner's tool time limit.
    waitsUpToMs: 630_000,
    execute: (input, context: ToolContext) => github.waitForChecks(input, context.signal),
  });
  // selfdev (SELF-306): why a check failed, and running failed jobs again.
  registry.register({
    name: "github.check_logs", permission: "github.manage",
    description: "What each failed check on a pull request's latest commit printed: the lines of its Actions log around the failures. Use it to find why CI is red before changing anything.",
    parameters: z.object({ repo: repositoryPath, number: z.number().int().positive(), lines: z.number().int().min(20).max(400).default(120) }).strict(),
    execute: (input) => github.checkLogs(input),
  });
  registry.register({
    name: "github.rerun_failed_checks", permission: "github.manage",
    description: "Run the failed jobs of a pull request's latest commit again, for a check that failed for reasons outside the change (a flaky test, a runner problem). Then wait with github.wait_for_checks.",
    parameters: z.object({ repo: repositoryPath, number: z.number().int().positive() }).strict(),
    target: (input) => `run the failed checks of ${String(input.repo)} #${String(input.number)} again`,
    execute: (input) => github.rerunFailedChecks(input),
  });
  registry.register({
    name: "github.release", permission: "github.manage",
    description: "The releases published for a GitHub repository, newest first, with their notes.",
    parameters: z.object({ repo: repositoryPath, limit: z.number().int().min(1).max(30).default(10) }).strict(),
    execute: (input) => github.releases(input),
  });
  if (git) registerPublish(registry, github, git);
}

function registerPublish(registry: ToolRegistry, github: GitHubAccess, git: GitTools): void {
  registry.register({
    name: "github.publish_repo", permission: "github.manage",
    description: "Put a folder on GitHub for the first time: make the repository (private unless you say otherwise) and send the work there. The person is asked before anything leaves this computer.",
    parameters: z.object({
      folder, name: repositoryName, description: z.string().max(350).optional(),
      private: z.boolean().default(true), branch: branchName.optional(), remote: remoteName,
    }).strict(),
    target: (args) => `publish ${args.folder} to GitHub as ${args.name} (${args.private === false ? "public" : "private"}), sending it to the remote "${args.remote ?? "origin"}"`,
    targets: inFolder("write"),
    execute: async (input, context: ToolContext) => {
      const created = (await github.createRepo(input)) as { repository?: string; address?: string; private?: boolean };
      const url = `https://github.com/${String(created.repository ?? input.name)}.git`;
      const sent = await git.publish({ folder: input.folder, url, remote: input.remote, branch: input.branch }, context.signal,
        { ref: context.sendsRef, commit: context.sendsCommit });
      return { ...created, ...sent };
    },
  });
}

/** GitHub; registered only when the owner has set it up with a saved token. */
export function registerGitHub(registry: ToolRegistry, github: GitHubAccess, git?: GitTools): void {
  registerGitHubProject(registry, github, git);
  registry.register({
    name: "github.create_repo", permission: "github.manage",
    description: "Create a repository on GitHub under the owner's account. It is private unless you say otherwise.",
    parameters: z.object({ name: repositoryName, description: z.string().max(350).optional(), private: z.boolean().default(true) }).strict(),
    execute: (input) => github.createRepo(input),
  });
  registry.register({
    name: "github.open_pull_request", permission: "github.manage",
    description: "Open a pull request on GitHub so someone can review one line of work before it joins the shared branch. Name the issue it settles and the description is written from a template that links it, so the issue closes when the work is merged.",
    parameters: z.object({
      repo: repositoryPath, title, body: z.string().max(8000).optional(), base: branchName, head: pullRequestHead,
      /** The issue this settles: its web address, owner/name#12, or a Linear reference such as ENG-214. */
      issue: z.string().trim().min(1).max(500).optional(),
      /** One line per thing that changed, for the template's list. */
      changes: z.array(z.string().max(300)).max(20).optional(),
      /** bucket-18 (A0300): open it as a draft. */
      draft: z.boolean().optional(),
    }).strict(),
    execute: (input) => openPullRequest(github, input),
  });
  registry.register({
    name: "github.merge_pull_request", permission: "github.manage",
    description: "Merge a pull request, only when every check on its exact latest commit has finished and passed (run github.wait_for_checks first). The merge is pinned to that commit. When the base merges only through GitHub's merge queue, the commit joins the queue instead; wait with github.wait_for_checks until it says merged. A change to Branch itself is finished with branch.finish_source_change instead.",
    parameters: z.object({ repo: repositoryPath, number: z.number().int().positive() }).strict(),
    target: (args) => `merge pull request #${String(args.number)} on ${String(args.repo)} into its base`,
    execute: (input) => github.mergeChecked(input.repo, input.number),
  });
  // Listing issues is `github.issues`, registered above: there is one tool for it, not two.
  registry.register({
    name: "github.create_issue", permission: "github.manage",
    description: "Raise an issue on a GitHub repository.",
    parameters: z.object({ repo: repositoryPath, title, body: z.string().max(8000).optional() }).strict(),
    execute: (input) => github.createIssue(input),
  });
}
