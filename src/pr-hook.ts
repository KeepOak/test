import { z } from "zod";
import { FeatureModeSchema } from "./feature-switches.js";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { runOrigin, startedWithShortLivedKey } from "./key-context.js";
import { issueLinksIn } from "./integrations/issue-context.js";
import type { ToolContext } from "./contracts.js";
import type { GitRunOptions, GitOutcome } from "./integrations/git-run.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { ToolRegistry } from "./registry.js";
import type { Store } from "./store.js";
import type { WorkspaceFiles } from "./files.js";
import { WalkRules } from "./walk-rules.js"; // mac7/walk-rules
import { pullRequestPinned, pushRefusal, pushRepositoryRefusal, selfDevelopmentBase, selfDevelopmentBaseWords } from "./self-development-contract.js"; // Q12
import { githubRepositoryOf } from "./github-address.js";
import { queueSourcePublication, resumeSourcePublication } from "./self-development-publication-hook.js";
import type { PublicationEntry } from "./self-development-publication.js";
export { githubRepositoryOf };

// The branch a pull request asks to join, for the saved setting and the tool alike. A tool's pattern
// is sent to the model, and the ChatGPT endpoint refuses the whole request when one holds a lookahead
// (see `branchName` in integrations/git-tools.ts). So the pattern says what each character may be,
// with no dash first, and "no .." is a check beside it.
const baseBranch = z.string().regex(/^[A-Za-z0-9._/][A-Za-z0-9._/-]{0,99}$/)
  .refine((value) => !value.includes(".."), "No .. in a branch name");

/**
 * Opening a pull request from a task's changes (A0300, after SWE-agent's "open PR" hook).
 *
 * The owner's three-way switch, off by default:
 * - off: nothing happens and `github.pull_request_from_changes` refuses;
 * - when-needed: the tool works when the assistant (or the owner) calls it; nothing happens by itself;
 * - on: as well, a task that finishes well and changed files puts exactly those files on a new line
 *   of work called `branch/<task>`, sends it to GitHub and opens a draft pull request.
 *
 * What it never does:
 * - send to the shared branch: the line of work is always a new `branch/…` one, and the base, the
 *   remote's default branch and names such as main, master, develop, trunk or release/* are refused;
 * - act for a short-lived key (`branch token create`): a script's key may not send work anywhere;
 * - put a key anywhere: Git sends with this computer's own sign-in (an address carrying a password
 *   is refused), and GitHub is reached through the saved GitHub tools, whose token is read from the
 *   locker at the moment of the call; the address is checked against the network rules first;
 * - fail quietly: every attempt that stops is written to the task's log with the reason.
 */
export const PullRequestHookSettingsSchema = z.object({
  mode: FeatureModeSchema.default("off"),
  remote: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{0,39}$/).default("origin"),
  /** The branch the pull request asks to join; the remote's own default when not given. */
  base: baseBranch.optional(),
}).strict();
export type PullRequestHookSettings = z.infer<typeof PullRequestHookSettingsSchema>;
const KEY = "pull-request-hook";

export function pullRequestHookSettings(store: Pick<Store, "get">, owner: string): PullRequestHookSettings {
  const saved = PullRequestHookSettingsSchema.safeParse(store.get("settings", owner, KEY)?.data ?? {});
  return saved.success ? saved.data : PullRequestHookSettingsSchema.parse({});
}
export function savePullRequestHookSettings(store: Pick<Store, "get" | "save">, owner: string, input: unknown): PullRequestHookSettings {
  if (startedWithShortLivedKey()) throw new Error("A short-lived key cannot change how work is sent to GitHub. Do that in the app window.");
  const value = PullRequestHookSettingsSchema.parse({ ...pullRequestHookSettings(store, owner), ...(input as object) });
  store.save("settings", owner, KEY, value);
  return value;
}

type PullRequestGit = (options: GitRunOptions, signal: AbortSignal) => Promise<GitOutcome>;
export interface PullRequestDeps {
  store: Store;
  owner: string;
  files: WorkspaceFiles;
  git: PullRequestGit;
  policy: NetworkPolicy;
  registry: ToolRegistry;
  /** Runs a registered tool as the owner (the saved GitHub tools); the runtime's executeTool. */
  /** `runId` is the task whose own call got here; without one it is the hook working by itself. */
  runTool: (name: string, args: unknown, runId?: string) => Promise<unknown>;
  /**
   * Integration review: the tool gate's answer for opening the pull request, asked before Git is
   * touched, so a refusal never leaves a pushed branch behind. A sentence refuses; null lets it go.
   */
  preflight?: (name: string, args: unknown, runId?: string) => string | null;
  /** Integration review: Branch's own guard (src/never-break/protected.ts); a reason when a path may not be read. */
  guard?: (path: string) => string | null;
  /**
   * selfdev: opens a draft pull request from Branch's own source with this computer's own GitHub sign-in (`gh`), when
   * Branch has no saved GitHub connection. Used only after the owner's yes to that very step; `gh` reads its sign-in
   * itself, so the token never passes through Branch, the model or a log.
   */
  openWithComputerGh?: ((opening: ComputerPullRequest, signal: AbortSignal) => Promise<unknown>) | undefined;
  /** Read-only reconciliation, using the same identity as the saved publication. */
  findPublication?: ((entry: PublicationEntry, signal: AbortSignal) => Promise<unknown | null>) | undefined;
}
export interface ComputerPullRequest { repo: string; title: string; body: string; base: string; head: string }
export interface OpenedPullRequest { repository: string; branch: string; base: string; files: string[]; pullRequest: unknown; publication?: PublicationEntry }
interface PullRequestInput {
  name: string;
  title: string;
  summary: string;
  paths: string[] | null;
  signal: AbortSignal;
  runId?: string | undefined;
  /** Q12: the finished task the hook sends work for, named in the record only (the hook still works as itself). */
  auditRunId?: string | undefined;
  targetRepository?: string | undefined;
  base?: string | undefined;
  /** selfdev: the hook sending a finished task's work by itself, with nobody asked (`watchFinishedTasks`). */
  byItself?: boolean | undefined;
}

const connectFirst = "Connect GitHub first: GitHub is not set up with a saved token.";
const protectedName = /^(main|master|develop|development|trunk|production|prod|staging|gh-pages)$|^release(s)?(\/|$)|^hotfix(es)?(\/|$)/i;
/** The one rule for where work may be sent: a fresh `branch/…` line that is not the base or the default. */
export function assertSafeHead(head: string, base: string, defaultBranch: string | null): void {
  if (!/^branch\/[A-Za-z0-9._-]{1,60}$/.test(head)) throw new Error(`"${head}" is not a line of work Branch made, so nothing was sent.`);
  if (head === base || head === defaultBranch || protectedName.test(head) || protectedName.test(head.slice("branch/".length)))
    throw new Error(`"${head}" is a shared branch, so nothing was sent.`);
  if (head.includes("..") || head.endsWith(".lock")) throw new Error(`"${head}" is not a usable branch name.`);
}


async function gitText(deps: PullRequestDeps, cwd: string, args: string[], signal: AbortSignal, timeoutMs = 30000, raw = false): Promise<string> {
  const outcome = await deps.git({ cwd, args, timeoutMs }, signal);
  if (outcome.status !== "completed") throw new Error(`Git stopped: ${(outcome.stderr || outcome.stdout).trim().split("\n")[0]?.slice(0, 200) ?? "no reason given"}`);
  return raw ? outcome.stdout : outcome.stdout.trim();
}

/** Where the work would go: the repository, the base and the remote's default branch. */
async function destination(deps: PullRequestDeps, cwd: string, settings: PullRequestHookSettings, input: PullRequestInput) {
  // Every address a push goes to (a remote may have several, and a push address of its own).
  const addresses = (await gitText(deps, cwd, ["remote", "get-url", "--push", "--all", settings.remote], input.signal)).split("\n").map((line) => line.trim()).filter(Boolean);
  if (!addresses.length) throw new Error("The remote has no address.");
  const found = addresses.map(githubRepositoryOf);
  const { repo: pushRepo, https } = found[0]!;
  if (found.some((each) => each.repo.toLowerCase() !== pushRepo.toLowerCase())) throw new Error("The remote sends to more than one repository, so nothing was sent.");
  let networkFailure: Error | null = null;
  const check = async (url: URL, what: string) => {
    try { await deps.policy.assertAllowed(url, what); }
    catch (error) {
      if (!deps.findPublication || !(error instanceof Error) || !/could not be resolved|EAI_AGAIN|ENOTFOUND|ETIMEDOUT/.test(error.message)) throw error;
      networkFailure = error;
    }
  };
  await check(https, "GitHub repository");
  const target = input.targetRepository ? githubRepositoryOf(`https://github.com/${input.targetRepository}.git`) : null;
  if (target) await check(target.https, "pull request target repository");
  const headRef = await gitText(deps, cwd, ["symbolic-ref", "--quiet", `refs/remotes/${settings.remote}/HEAD`], input.signal).catch(() => "");
  const defaultBranch = headRef ? headRef.replace(`refs/remotes/${settings.remote}/`, "") : null;
  const repo = target?.repo ?? pushRepo;
  const pushOwner = pushRepo.split("/")[0]!;
  return { repo, pushRepo, pushAddress: addresses[0]!, networkFailure, pullHeadOwner: repo.toLowerCase() === pushRepo.toLowerCase() ? null : pushOwner,
    base: input.base ?? settings.base ?? defaultBranch ?? "main", defaultBranch };
}

/**
 * Commits the named files on a new `branch/<name>` line, sends it, and opens a draft pull request.
 * Every refusal is thrown with a plain reason; the caller records it.
 */
export async function pullRequestFromChanges(deps: PullRequestDeps, input: PullRequestInput): Promise<OpenedPullRequest> {
  if (startedWithShortLivedKey() || (input.runId && runOrigin(deps.store, input.runId).shortLivedKey))
    throw new Error("A short-lived key cannot send work to GitHub. Do that in the app window.");
  const settings = pullRequestHookSettings(deps.store, deps.owner);
  if (settings.mode === "off") throw new Error("Opening pull requests from changes is switched off. Turn it on in Settings → Developer → Pull requests from changes.");
  const saved = deps.registry.names().includes("github.open_pull_request");
  if (!saved && !deps.openWithComputerGh) throw new Error(connectFirst);
  const cwd = await deps.files.checked(".", true);
  const where = await destination(deps, cwd, settings, input);
  const head = `branch/${input.name}`;
  assertSafeHead(head, where.base, where.defaultBranch);
  if (deps.findPublication && !input.byItself) {
    const publication = await resumeSourcePublication(deps, { cwd, branch: head, repository: where.repo,
      base: where.base, title: input.title, summary: input.summary, signal: input.signal });
    if (publication) return { repository: publication.repository, branch: publication.branch, base: publication.base,
      files: publication.files, pullRequest: publication.pullRequest ?? null, publication };
  }
  const paths = input.paths ?? (await changedPaths(deps, cwd, input.signal));
  const visible = await sendablePaths(deps, cwd, paths);
  if (!visible.length) throw new Error("There are no changed files that may be sent.");
  const opening = {
    repo: where.repo, title: input.title.slice(0, 200), body: input.summary.slice(0, 8000),
    base: where.base, head: where.pullHeadOwner ? `${where.pullHeadOwner}:${head}` : head,
    changes: visible.slice(0, 20), draft: true as const,
    ...issueArgument(input.summary),
  };
  // Q12: a push from Branch's own source is held to its contract here, where it happens, whoever asked for it.
  const { refusal: heldBack, walked, repositories } = await pushRefusal({ store: deps.store, owner: deps.owner, workspace: deps.files.root, git: deps.git,
    folder: cwd, runId: input.runId ?? input.auditRunId, signal: input.signal });
  if (heldBack) throw new Error(heldBack);
  // DNS may be down while the owner prepares a local source commit. Its queued attempt must pass
  // the complete network check before any push. Ordinary publication still refuses immediately.
  if (where.networkFailure && !walked) throw where.networkFailure;
  // A change to Branch itself goes out only as the owner's own step, asked about (`sourceSendHold`), never by the
  // hook when a task finishes, and only as a proposal to the line Beta builds.
  if (walked && input.byItself) throw new Error("A change to Branch itself is sent only when you say yes to that step, never by itself when a task finishes.");
  if (walked && !selfDevelopmentBase(where.base)) throw new Error(`A change to Branch itself is proposed only to ${selfDevelopmentBaseWords}, so nothing was sent.`);
  // selfdev: without a saved connection, only a change to Branch itself, asked about, may use the computer's own sign-in.
  if (!saved && (!walked || input.byItself)) throw new Error(connectFirst);
  // The repository it opens in must be one written with the contract when the worktree was made.
  const pinned = walked ? pullRequestPinned(opening, repositories) : null;
  if (pinned) throw new Error(pinned);
  // And the push itself goes only to the repository origin pushed to when the worktree was made.
  const pushedTo = walked ? pushRepositoryRefusal(repositories, settings.remote, [where.pushRepo]) : null;
  if (pushedTo) throw new Error(pushedTo);
  // The same gate the direct tool gets, asked after the contract has had its say (so its own refusal is the one shown)
  // but still before anything is pushed: `github.open_pull_request` is now held too, so a standing allow never opens a
  // pull request from Branch's own source without the owner's yes to that step (self-development-contract.ts heldSends).
  const refusal = deps.preflight?.("github.open_pull_request", opening, input.runId);
  if (refusal) throw new Error(refusal);
  // In Branch's own source the new line starts at the commit the contract walked, wherever HEAD is by now.
  await gitText(deps, cwd, ["switch", "--create", head, ...(walked ? [walked] : [])], input.signal);
  // Names are taken literally (a "*" is a file called "*"), and only the named files are committed,
  // whatever else happened to be staged already.
  await gitText(deps, cwd, ["--literal-pathspecs", "add", "--", ...visible], input.signal);
  await gitText(deps, cwd, ["--literal-pathspecs", "commit", "--only", "--message", input.title.slice(0, 200), "--", ...visible], input.signal);
  if (walked && deps.findPublication) {
    const made = await commitNamed(deps, cwd, `refs/heads/${head}^{commit}`, input.signal);
    if (!made || !(await onlyNamedOnWalked(deps, cwd, made, walked, visible, input.signal)))
      throw new Error(`"${head}" is not just one new commit on the checked work, so nothing was sent.`);
    const publication = await queueSourcePublication(deps, { cwd, workspace: deps.files.root, remote: settings.remote,
      pushRepo: where.pushRepo, pushAddress: where.pushAddress, repository: where.repo, branch: head, base: where.base, sha: made, walked,
      files: visible, opening, runId: input.runId, receiptRunId: input.runId ?? input.auditRunId, adapter: saved ? "saved" : "computer" }, input.signal);
    return { repository: where.repo, branch: head, base: where.base, files: visible, pullRequest: publication.pullRequest ?? null, publication };
  }
  // An explicit refspec: exactly this new line, to a branch of the same name, never anything else.
  if (walked) await sendOnWalked(deps, cwd, settings.remote, head, walked, visible, input.signal);
  else await gitText(deps, cwd, ["push", "--set-upstream", settings.remote, `refs/heads/${head}:refs/heads/${head}`], input.signal, 180000);
  const pullRequest = saved ? await deps.runTool("github.open_pull_request", opening, input.runId)
    : await deps.openWithComputerGh!({ repo: opening.repo, title: opening.title, body: opening.body, base: opening.base, head: opening.head }, input.signal);
  return { repository: where.repo, branch: head, base: where.base, files: visible, pullRequest };
}

/** The one commit `revision` names now, read once, or "" when it names none. */
const commitNamed = (deps: PullRequestDeps, cwd: string, revision: string, signal: AbortSignal): Promise<string> =>
  gitText(deps, cwd, ["rev-parse", "--verify", "--quiet", revision], signal).catch(() => "");

/**
 * From Branch's own source: sends the commit just made on `head`, read once from that branch, and only
 * when it is one commit, right on the commit the contract walked, changing nothing but the named
 * files, so nothing that moves `head` or HEAD meanwhile changes what goes out. A push that names a
 * commit sets no upstream, so the new line is told where it went afterwards, as `push --set-upstream`
 * did (a failure there leaves the push as it is).
 */
async function sendOnWalked(deps: PullRequestDeps, cwd: string, remote: string, head: string, walked: string, named: readonly string[], signal: AbortSignal): Promise<void> {
  const made = await commitNamed(deps, cwd, `refs/heads/${head}^{commit}`, signal);
  if (!made || !(await onlyNamedOnWalked(deps, cwd, made, walked, named, signal)))
    throw new Error(`"${head}" is not just one new commit on the checked work (something else changed the repository meanwhile), so nothing was sent.`);
  await gitText(deps, cwd, ["push", remote, `${made}:refs/heads/${head}`], signal, 180000);
  await deps.git({ cwd, args: ["branch", `--set-upstream-to=refs/remotes/${remote}/${head}`, head], timeoutMs: 30000 }, signal);
}

/**
 * Whether `made` has exactly one parent, `walked`, and changes nothing against it but the `named`
 * files. Both answers are read once each, from the commit itself, never from a branch.
 */
async function onlyNamedOnWalked(deps: PullRequestDeps, cwd: string, made: string, walked: string, named: readonly string[], signal: AbortSignal): Promise<boolean> {
  // The commit, then each of its parents: exactly two names means exactly one parent. (Both reads end
  // with "--", so a commit is never taken for a file of the same name.)
  const line = await gitText(deps, cwd, ["rev-list", "--parents", "--max-count=1", made, "--"], signal).catch(() => "");
  const [self, ...parents] = line.split(" ");
  if (self !== made || parents.length !== 1 || parents[0] !== walked) return false;
  // Every name as Git keeps it: no rename pairing, no quoting, and a submodule's pointer listed whatever its settings say.
  const listed = await deps.git({ cwd, args: ["diff-tree", "-r", "--name-only", "--no-commit-id", "--no-renames", "--ignore-submodules=none", "-z", walked, made, "--"],
    timeoutMs: 30000, maxOutputBytes: 1_048_576 }, signal);
  if (listed.status !== "completed" || listed.truncated) return false;
  // A name may be written with "." folders ("./src/a.ts"); Git keeps it without them.
  const allowed = new Set(named.map((path) => path.split("/").filter((part) => part !== ".").join("/")));
  return listed.stdout.split("\0").filter(Boolean).every((path) => allowed.has(path));
}

const issueArgument = (text: string): { issue?: string } => {
  const link = issueLinksIn(text, 1).find((each) => each.tracker === "github");
  return link && link.tracker === "github" ? { issue: `${link.repo}#${link.number}` } : {};
};

/**
 * Integration review: the files that may leave this computer. Each goes through the same checks as the
 * assistant's own file tools (inside the workspace, no secret-looking name, no link, nothing
 * `.branchignore` hides) and Branch's own guard; a folder is never sent whole.
 */
async function sendablePaths(deps: PullRequestDeps, cwd: string, paths: readonly string[]): Promise<string[]> {
  const kept: string[] = [];
  // mac7/walk-rules: nothing the owner's rules keep the assistant out of leaves this computer.
  const rules = new WalkRules(deps.files.walkRules({ source: "owner" }));
  for (const path of paths) {
    if (!path || path.endsWith("/") || !rules.file(path)) continue;
    const allowed = await deps.files.checked(path).then(() => true, () => false);
    if (!allowed || (await deps.files.hidden(path, false)) || deps.guard?.(path)) continue;
    const info = await lstat(join(cwd, path)).catch(() => null);
    if (info && !info.isFile()) continue;
    kept.push(path);
  }
  return kept;
}

async function changedPaths(deps: PullRequestDeps, cwd: string, signal: AbortSignal): Promise<string[]> {
  // Untrimmed: each line starts with two status letters, the first often a space.
  const text = await gitText(deps, cwd, ["status", "--porcelain=v1"], signal, 30000, true);
  return text.split("\n").filter(Boolean).map((line) => line.slice(3).split(" -> ").at(-1)!).filter((path) => !path.startsWith('"')).slice(0, 200);
}

/** The files this task changed, from its own log. */
function filesChangedBy(store: Store, runId: string): string[] {
  const paths = store.events(runId).filter((event) => event.kind === "file.changed")
    .map((event) => String((event.data as { path?: unknown }).path ?? "")).filter(Boolean);
  return [...new Set(paths)].slice(0, 200);
}

/** Writes to the task's log; a log that is already closed (the app shutting down) is not worth a crash. */
function note(deps: PullRequestDeps, runId: string, kind: string, data: Record<string, unknown>): void {
  try { deps.store.event(runId, kind, data); } catch { /* the app is closing */ }
}

/** Why a finished task's work is not sent by itself; null when it may be. Read from the task's own record. */
function skipReason(store: Store, runId: string): string | null {
  const origin = runOrigin(store, runId);
  if (startedWithShortLivedKey() || origin.shortLivedKey) return "The task was started with a short-lived key, so its work was not sent to GitHub.";
  if (origin.parentRunId) return "A specialist's part of a task is sent with the task it belongs to, not on its own.";
  if (origin.source !== "owner") return `The task was started by ${origin.source === "schedule" ? "a schedule" : origin.source === "trigger" ? "a trigger" : origin.source === "channel" ? "a chat message" : "another program"}, not by you, so its work was not sent to GitHub.`;
  if (origin.permissions && !origin.permissions.includes("github.manage")) return "The task was not allowed to publish (a message from a chat app, for one), so its work was not sent to GitHub.";
  return null;
}

/** "On": after a task that finished well and changed files, send those files and open a pull request. */
export function watchFinishedTasks(deps: PullRequestDeps, track: (work: () => Promise<unknown>) => void = (work) => void work()): () => void {
  return deps.store.onEvent((runId, kind, data) => {
    if (kind !== "run.finished" || data.status !== "completed") return;
    if (pullRequestHookSettings(deps.store, deps.owner).mode !== "on") return;
    const run = deps.store.run(runId);
    // A save from the window's editor or a single tool pressed by hand is not a task.
    if (run?.prompt.startsWith("Manual action:")) return;
    const paths = filesChangedBy(deps.store, runId);
    if (!paths.length) return;
    const skipped = skipReason(deps.store, runId);
    if (skipped) { note(deps, runId, "pull_request.skipped", { reason: skipped }); return; }
    const prompt = run?.prompt ?? "";
    const title = `Branch: ${prompt.split("\n")[0]!.trim().slice(0, 150) || "changes from a task"}`;
    const summary = `${prompt.trim().slice(0, 4000)}\n\nOpened by Branch when task ${runId.slice(0, 8)} finished.`;
    track(() => pullRequestFromChanges(deps, { name: `task-${runId.slice(0, 8)}`, title, summary, paths, auditRunId: runId, byItself: true, signal: AbortSignal.timeout(300000) })
      .then((opened) => {
        // Durable source publications record their exact eventual PR through the queue observer.
        // A waiting or blocked intent is not an opened pull request.
        if (!opened.publication) note(deps, runId, "pull_request.opened", {
          repository: opened.repository, branch: opened.branch, base: opened.base, files: opened.files.length });
      })
      .catch((error: unknown) => note(deps, runId, "pull_request.failed", { reason: error instanceof Error ? error.message.slice(0, 500) : "unknown" })));
  });
}

const toolName = "github.pull_request_from_changes";
/**
 * The tool is only offered while GitHub is set up (while `github.open_pull_request` exists), so a
 * computer without GitHub never grows a GitHub permission. Returns a function that stops watching.
 */
export function offerPullRequestFromChanges(deps: PullRequestDeps): () => void {
  const sync = () => {
    const names = deps.registry.names();
    // selfdev: also while Git work may be sent (what Branch working on its own source needs), for the computer's own `gh` sign-in.
    const github = names.includes("github.open_pull_request") || (!!deps.openWithComputerGh && names.includes("git.push"));
    const offered = deps.registry.names().includes(toolName);
    if (github && !offered) registerPullRequestFromChanges(deps);
    if (!github && offered) deps.registry.unregister(toolName);
  };
  sync();
  return deps.registry.onToolsChanged(sync);
}

export function registerPullRequestFromChanges(deps: PullRequestDeps): void {
  deps.registry.register({
    name: toolName, permission: "github.manage",
    description: "Put the files that changed on a new line of work (branch/<name>), send it to GitHub with this computer's own Git sign-in, and open a draft pull request. It never sends to a shared branch. Name an issue in the summary to link it.",
    parameters: z.object({
      name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,50}$/, "Use lowercase letters, digits, dots, dashes and underscores"),
      title: z.string().trim().min(1).max(200),
      summary: z.string().trim().min(1).max(8000),
      // No dash first, and no backslash, colon or NUL: the git tools' own file path pattern.
      paths: z.array(z.string().min(1).max(500).regex(/^[^\\:\0-][^\\:\0]*$/)).max(200).optional(),
      targetRepository: z.string().regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/).optional(),
      base: baseBranch.optional(),
    }).strict(),
    target: (args) => `send changes to GitHub on branch/${String((args as { name?: unknown }).name ?? "")} and open a pull request`,
    execute: async (args, context: ToolContext) => {
      try {
        return await pullRequestFromChanges(deps, { ...args, paths: args.paths ?? null, signal: context.signal, ...(context.runId ? { runId: context.runId } : {}) });
      } catch (error) {
        if (context.runId) deps.store.event(context.runId, "pull_request.failed", { reason: error instanceof Error ? error.message.slice(0, 500) : "unknown" });
        throw error;
      }
    },
  });
}
