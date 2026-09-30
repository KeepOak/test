import { lstat, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import type { ToolContext } from "./contracts.js";
import { githubRepositoryOf } from "./pr-hook.js";
import { runOrigin, startedWithShortLivedKey } from "./key-context.js";
import type { GitOutcome, GitRunOptions } from "./integrations/git-run.js";
import { explainGit } from "./integrations/git-run.js";
import type { NetworkPolicy } from "./network-policy.js";
import type { Projects } from "./projects.js";
import type { ToolRegistry } from "./registry.js";
import { audit } from "./audit.js";
import type { Store } from "./store.js";
import { ContractTermsSchema, selfDevelopmentBase, selfDevelopmentBaseWords, selfDevelopmentLine, selfDevelopmentLockdownRefusal, sourceFolder, widenToolName, type ContractBook, type ContractTerms, type SelfDevelopmentContract } from "./self-development-contract.js";
import { lockdownActive } from "./lockdown.js";
import { canonicalRepo, primaryRepo } from "./desktop/repo-pair.js";

/** Branch's own repository; the old stabrea/Branch-Agent name is read as this one (src/desktop/repo-pair.ts). */
export const branchRepository = primaryRepo;
const isBranchRepository = (repo: string): boolean => canonicalRepo(repo) === canonicalRepo(branchRepository);
const nameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/, "Use lowercase letters, digits and dashes");
/**
 * A change to Branch itself starts from, and is proposed back to, one line only: the line Beta builds
 * (src/desktop/dev-build.ts `betaLine`). Nothing reaches the running app except as a merged change there.
 */
const baseSchema = z.string().refine(selfDevelopmentBase, `A change to Branch itself starts from ${selfDevelopmentBaseWords}, and is proposed back to it.`);
const repositorySchema = z.string().url().default(`https://github.com/${branchRepository}.git`);

export interface SelfDevelopmentDeps {
  workspace: string;
  owner: string;
  projects: Projects;
  registry: ToolRegistry;
  policy: NetworkPolicy;
  git: (options: GitRunOptions, signal: AbortSignal) => Promise<GitOutcome>;
  exists?: (path: string) => Promise<boolean>;
  /** Q12: where each worktree's contract is written before anything in it changes. */
  contracts: ContractBook;
  /** Q12: the audit record, where each widening is written. */
  store: Store;
  /** A direct, persisted local-owner Full Access choice in this very conversation. */
  fullAccessOwner?: (context: ToolContext) => string | null;
  /** selfdev: the task is the owner's own turn through their designated default Trunk (src/runtime.ts `ownersDefaultTurn`). */
  ownersDefaultTurn?: (context: ToolContext) => boolean;
}

const present = (path: string): Promise<boolean> => lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return false;
  throw error;
});

async function run(deps: SelfDevelopmentDeps, cwd: string, args: string[], signal: AbortSignal, timeoutMs = 60_000): Promise<string> {
  const outcome = await deps.git({ cwd, args, timeoutMs }, signal);
  if (outcome.status !== "completed") throw new Error(explainGit(outcome));
  return outcome.stdout.trim();
}

function repositoryAddress(input: string): { repo: string; url: URL } {
  const parsed = githubRepositoryOf(input);
  if (parsed.repo.split("/")[1]?.toLowerCase() !== "branch-agent")
    throw new Error("Use the official Branch-Agent repository or your own GitHub fork of it.");
  // Rebuild from the repository name so credentials or other URL parts supplied by a caller can
  // never survive into the clone command. Do not replace this with input sanitising.
  const repo = isBranchRepository(parsed.repo) ? branchRepository : parsed.repo;
  return { repo, url: new URL(`https://github.com/${repo}.git`) };
}

function sourceChangeFolder(workspace: string, name: string): string {
  return join(workspace, sourceFolder, ".branch-worktrees", `self-${name}`);
}

/** Local serialization has no on-disk reservation to survive a crash. Across processes, exclusive
 * publication elects the clone; Git's own ref/config/worktree locks reject conflicting mutations. */
const sourcePreparations = new Map<string, Promise<void>>();
async function withSourcePreparation<T>(workspace: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const key = await realpath(workspace);
  const previous = sourcePreparations.get(key) ?? Promise.resolve();
  let release!: () => void;
  const finished = new Promise<void>((done) => { release = done; });
  sourcePreparations.set(key, finished);
  try {
    await previous;
    signal.throwIfAborted();
    return await work();
  } finally {
    release();
    if (sourcePreparations.get(key) === finished) sourcePreparations.delete(key);
  }
}

/** Publish a complete attempt-owned clone with an exclusive directory link. Neither a winner nor
 * a pre-existing checkout is replaced. The published clone stays at its original physical path. */
async function cloneSource(deps: SelfDevelopmentDeps, repository: { repo: string; url: URL }, source: string, signal: AbortSignal): Promise<void> {
  const staging = await mkdtemp(join(deps.workspace, `${sourceFolder}.preparing-`));
  let published = false;
  try {
    await run(deps, staging, ["clone", "--origin", "origin", repository.url.href, sourceFolder], signal, 1_800_000);
    signal.throwIfAborted();
    const clone = join(staging, sourceFolder);
    await exactSourceRoot(deps, clone, signal);
    try {
      await symlink(resolve(clone), source, process.platform === "win32" ? "junction" : "dir");
      published = true;
    } catch (error) {
      // A competing winner (or any existing path) is inspected by ensureSource, never removed.
      if (!(await present(source)))
        throw new Error(`Could not publish ${sourceFolder}: this platform refused its directory link (${(error as NodeJS.ErrnoException).code ?? "unknown error"}). Nothing was installed or replaced. Allow directory links and retry, or have the owner provide a complete checkout at ${source}.`);
    }
  } finally {
    // A crash can leave an unused attempt directory, but never a lock or a half-published source.
    if (!published) await rm(staging, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function exactSourceRoot(deps: SelfDevelopmentDeps, source: string, signal: AbortSignal): Promise<void> {
  const physical = await realpath(source);
  const inside = relative(await realpath(deps.workspace), physical);
  if (inside === ".." || inside.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(inside))
    throw new Error(`${source} points outside the workspace; it was preserved and will not be used for source preparation.`);
  const top = await run(deps, source, ["rev-parse", "--show-toplevel"], signal);
  if (!top || await realpath(resolve(top)) !== await realpath(source))
    throw new Error(`${source} is not the exact root of its own Git checkout; it was preserved.`);
}

async function ensureSource(deps: SelfDevelopmentDeps, repository: { repo: string; url: URL }, signal: AbortSignal): Promise<string> {
  const source = join(deps.workspace, sourceFolder);
  const exists = deps.exists ?? present;
  await deps.policy.assertAllowed(repository.url, "Branch Agent source repository");
  if (!(await exists(source))) await cloneSource(deps, repository, source, signal);
  await exactSourceRoot(deps, source, signal);
  if (await emptyCheckout(deps, source, signal))
    throw new Error(`The existing ${sourceFolder} has no commit and was preserved. The owner must recover or move that incomplete checkout before retrying; preparing a change never removes it.`);
  const address = await run(deps, source, ["remote", "get-url", "origin"], signal);
  const origin = repositoryAddress(address);
  if (origin.repo.toLowerCase() !== repository.repo.toLowerCase())
    throw new Error(`The existing ${sourceFolder} belongs to ${origin.repo}, not ${repository.repo}.`);
  // A checkout cloned before the move to KeepOak still names stabrea/Branch-Agent: it is pointed at the new name, so
  // pushes and pull requests go straight there rather than through GitHub's redirect.
  if (githubRepositoryOf(address).repo !== origin.repo) await run(deps, source, ["remote", "set-url", "origin", origin.url.href], signal);
  return source;
}

/**
 * Detect an unborn checkout with no worktree made from it. It is preserved for recovery, never deleted
 * just because Git cannot resolve HEAD. Any other answer leaves the existing checkout in use.
 */
async function emptyCheckout(deps: SelfDevelopmentDeps, source: string, signal: AbortSignal): Promise<boolean> {
  if (await (deps.exists ?? present)(join(source, ".branch-worktrees"))) return false;
  const head = await deps.git({ cwd: source, args: ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], timeoutMs: 60_000 }, signal);
  if (head.status !== "failed" || head.stdout.trim()) return false;
  const inside = await deps.git({ cwd: source, args: ["rev-parse", "--is-inside-work-tree"], timeoutMs: 60_000 }, signal);
  return inside.status === "completed" && inside.stdout.trim() === "true";
}

async function ensureUpstream(deps: SelfDevelopmentDeps, source: string, fork: boolean, signal: AbortSignal): Promise<string> {
  if (!fork) return "origin";
  const official = `https://github.com/${branchRepository}.git`;
  const current = await run(deps, source, ["remote", "get-url", "upstream"], signal).catch(() => "");
  if (current && !isBranchRepository(githubRepositoryOf(current).repo))
    throw new Error(`The existing upstream remote is ${githubRepositoryOf(current).repo}, not ${branchRepository}.`);
  if (!current) await run(deps, source, ["remote", "add", "upstream", official], signal);
  return "upstream";
}

function projectInstructions(name: string, base: string): string {
  return [
    "You are modifying Branch Agent itself inside an isolated Git worktree.",
    "Never edit the installed application, its private data, credentials, or the protected source checkout.",
    "Keep the requested change scoped, preserve the Branch Grown Up design direction, and do not remove provider support or legal notices.",
    "Every change is held to the contract written when this worktree was prepared: only its allowed paths, only its listed tools.",
    `A refused call means the contract does not cover it; ask the owner and use ${widenToolName} rather than working around it.`,
    `Commands run only through shell.execute, with cwd set to a folder under branch-agent-source/.branch-worktrees/self-${name} that the contract's allowed paths cover whole, behind the OS sandbox; its writes stay in that folder.`,
    "Run node scripts/review.mjs with the focused test files for the change, then inspect git.diff before offering the result.",
    "For an owner-reviewed merge, first commit all scoped edits, then run node scripts/review.mjs --jobs 1 followed by the contract's exact expectedTests list through shell.execute in this worktree. Only a successful review on a clean, unchanged commit records merge test evidence. Finish this task before the owner opens its review in Inbox; unrelated tasks can continue.",
    "On Windows these commands run inside WSL; when one says WSL is not ready (no Node.js or no bubblewrap there), tell the owner plainly what is missing and offer to set it up, and set it up only after the owner's yes.",
    `When the owner asks for a pull request, use github.pull_request_from_changes with name ${name}, targetRepository ${branchRepository}, and base ${base}.`,
    "The pull-request summary must include a Why merge this section in plain words, and the test evidence: each command run and its pass and fail counts.",
    "Open it as a draft, and never send to a shared line or change a repository's settings or branch protection.",
    "To finish it, wait with github.wait_for_checks until every check on the exact commit has passed (pending is never passed; when one fails, read why with github.check_logs, fix it and push again, or run a flaky one again with github.rerun_failed_checks), then call branch.finish_source_change with this worktree, the repository and the pull request number: in the owner's selected Full Access it gets an independent read-only review and merges the checked commit; otherwise the owner reviews and merges it in Inbox. Include branch.finish_source_change in the contract's permissions for that. Beta builds a merged change and tries it on a copy of the owner's data before it swaps in.",
  ].join(" ");
}

/**
 * Q12: the contract for this worktree, written before the worktree is made. The source commit is
 * read here, from what was fetched, and the worktree is then made at exactly that commit. A retry
 * with the same terms reuses the written contract; different terms need the owner's widening.
 */
async function bindContract(
  deps: SelfDevelopmentDeps, at: { source: string; folder: string; ref: string; remote: string; runId: string; terms: ContractTerms; existing: boolean },
  signal: AbortSignal,
): Promise<SelfDevelopmentContract> {
  const written = deps.contracts.current(deps.owner, at.folder);
  if (written) {
    const { allowedPaths, permissions, expectedTests, definitionOfDone, sideEffects, rollbackPlan } = written;
    if (JSON.stringify({ allowedPaths, permissions, expectedTests, definitionOfDone, sideEffects, rollbackPlan }) !== JSON.stringify(at.terms))
      throw new Error(`${at.folder} already has a contract (revision ${written.revision}). Different terms need ${widenToolName} and the owner's yes.`);
    if (written.sendRepositories?.length) return written;
    // Written before Branch kept where changes may go: read that from origin now, by the same rules as a
    // new worktree, and write it as the next revision, so the change keeps its name and its worktree.
    const pinned = deps.contracts.pin(deps.owner, at.folder, { taskRunId: at.runId, sendRepositories: await proposedTo(deps, at.source, at.remote, signal),
      approvedBy: deps.owner });
    audit(deps.store, deps.owner, { action: "self_development.contract", actor: deps.owner, subject: `${at.folder} revision ${pinned.revision}`.slice(0, 300),
      reason: `Where its changes may go: ${pinned.sendRepositories?.join(", ") ?? ""}`.slice(0, 500),
      runId: at.runId ? at.runId.slice(0, 64) : null, outcome: "pinned" });
    return pinned;
  }
  // A worktree made before contracts existed is bound to the commit it is on now.
  const sha = await run(deps, at.existing ? join(deps.workspace, at.folder) : at.source, ["rev-parse", "--verify", `${at.existing ? "HEAD" : at.ref}^{commit}`], signal);
  const sendRepositories = await proposedTo(deps, at.source, at.remote, signal);
  const contract = deps.contracts.create(deps.owner, { taskRunId: at.runId, sourceSha: sha, worktreePath: at.folder, terms: at.terms, sendRepositories });
  audit(deps.store, deps.owner, { action: "self_development.contract", actor: deps.owner, subject: `${at.folder} revision 1`.slice(0, 300),
    reason: `Paths ${at.terms.allowedPaths.join(", ")}; tools ${at.terms.permissions.join(", ")}`.slice(0, 500),
    runId: at.runId ? at.runId.slice(0, 64) : null, outcome: "written" });
  return contract;
}

/**
 * Where a pull request from this worktree may be opened, read once from the source checkout's own
 * remotes as the worktree is made and written with its contract: the repository `origin` pushes to
 * (every push address must name the same one) and, for a fork, the upstream it was made from.
 * Nothing named later, by the model or a changed remote, can add another.
 */
async function proposedTo(deps: SelfDevelopmentDeps, source: string, remote: string, signal: AbortSignal): Promise<string[]> {
  const pushes = (await run(deps, source, ["remote", "get-url", "--push", "--all", "origin"], signal)).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const origins = [...new Set(pushes.map((address) => canonicalRepo(githubRepositoryOf(address).repo)))];
  if (origins.length !== 1) throw new Error("The source checkout's origin does not push to exactly one GitHub repository, so no worktree was made.");
  if (remote !== "upstream") return origins;
  const upstream = canonicalRepo(githubRepositoryOf(await run(deps, source, ["remote", "get-url", "upstream"], signal)).repo);
  return [...new Set([...origins, upstream])];
}

export async function prepareBranchSourceChange(
  deps: SelfDevelopmentDeps,
  input: { name: string; repository: string; base: string; contract: ContractTerms },
  signal: AbortSignal,
  runId = "",
): Promise<Record<string, unknown>> {
  const terms = ContractTermsSchema.parse(input.contract);
  const repository = repositoryAddress(input.repository);
  return withSourcePreparation(deps.workspace, signal, async () => {
    const pendingFolder = `${sourceFolder}/.branch-worktrees/self-${input.name}`;
    // Q12: the source commit is only known after the fetch, so before anything is cloned, fetched or
    // added, the proposed contract is written down as pending, with where it comes from.
    if (!deps.contracts.current(deps.owner, pendingFolder))
      audit(deps.store, deps.owner, { action: "self_development.contract", actor: deps.owner, subject: `${pendingFolder} (pending)`,
        reason: `From ${repository.repo} at ${input.base}. Paths ${terms.allowedPaths.join(", ")}; tools ${terms.permissions.join(", ")}`.slice(0, 500),
        runId: runId ? runId.slice(0, 64) : null, outcome: "pending" });
    const source = await ensureSource(deps, repository, signal);
    const remote = await ensureUpstream(deps, source, !isBranchRepository(repository.repo), signal);
    await run(deps, source, ["fetch", remote, input.base], signal, 900_000);
    const copyName = `self-${input.name}`, branch = `branch/self-${input.name}`;
    const folder = `${sourceFolder}/.branch-worktrees/${copyName}`;
    const exists = deps.exists ?? present;
    const existing = await exists(sourceChangeFolder(deps.workspace, input.name));
    const contract = await bindContract(deps, { source, folder, ref: `${remote}/${input.base}`, remote, runId, terms, existing }, signal);
    if (!existing)
      await run(deps, source, ["worktree", "add", "-b", branch, `.branch-worktrees/${copyName}`, contract.sourceSha], signal, 600_000);
    const projectId = `branch-agent-${input.name}`;
    const instructions = projectInstructions(input.name, input.base);
    deps.projects.save(deps.owner, { id: projectId, name: `Branch Agent: ${input.name}`, instructions,
      modelPreset: null, repository: branchRepository, folder, profile: null, knowledgeBases: [], branch: "" });
    deps.projects.setActive(deps.owner, { active: projectId });
    return { project: projectId, folder, branch, base: `${remote}/${input.base}`, pushRepository: repository.repo,
      pullRequestTarget: branchRepository, ready: true, instructions, contract,
      note: "Work only in this isolated copy. The running app and its data are unchanged. Every change is held to the contract above. Tests and owner review come before a draft pull request." };
  });
}

const toolName = "branch.prepare_source_change";
/**
 * What preparing a change takes: the tool's parameters, and the owner's yes to a chat's request to
 * change Branch (src/self-development-requests.ts), so both hold the same fields and limits.
 */
export const PrepareSourceChangeSchema = z.object({
  name: nameSchema, repository: repositorySchema, base: baseSchema.default(selfDevelopmentLine), contract: ContractTermsSchema,
}).strict();
const contractDescription = "contract: the terms this change is held to, written down before anything changes: allowedPaths (globs inside the worktree, such as src/ui/** or tests/button.test.mjs), permissions (every tool name that may change something, such as files.write, git.commit, github.pull_request_from_changes, branch.finish_source_change), expectedTests, definitionOfDone, sideEffects and rollbackPlan.";

/** Only the owner, in the Branch app, may start or widen a change to Branch itself. */
/**
 * Only the owner, in the app. Q187: judged by the task's own record too, as `startedFromChat` does, not only by the
 * context a tool call carries: a helper a chat's task set going carries its own context, but its record leads back
 * to the chat (src/key-context.ts, `runOrigin`).
 */
export function ownerOnly(context: ToolContext, store: Store, defaultTurn?: (context: ToolContext) => boolean,
  doing = "prepare Branch Agent source changes"): void {
  const origin = context.runId ? runOrigin(store, context.runId) : null;
  // A household person's task records source "owner" too, so it is told apart by whose it is (NAS c7bbf84), and
  // the window must be on the owner's profile, as `ownerWorkOnly` and `Runtime.ownersOwnTask` ask.
  // NAS 9993ab7: a Trunk's turn records the owner's source too, so it is refused by its context, as remove-branch,
  // the one-button install and the password book already do.
  // selfdev: the owner's designated default Trunk is their own assistant, so its turn is the owner's; any other Trunk is refused.
  if (startedWithShortLivedKey() || (context.source && context.source !== "owner") || !store.profiles.isOwner() || context.trunk
    || (context.trunkKeys && defaultTurn?.(context) !== true)
    || (origin && (origin.source !== "owner" || origin.shortLivedKey || origin.keyIds.length > 0 || origin.personProfileId || origin.lentTo)))
    throw new Error(`Only the owner in the Branch app can ${doing}.`);
  if (lockdownActive(store, context.owner)) throw new Error(selfDevelopmentLockdownRefusal);
}

function registerSelfDevelopment(deps: SelfDevelopmentDeps): void {
  deps.registry.register({
    name: toolName,
    permission: "git.remote",
    description: `Prepare a protected, isolated source worktree for changing Branch Agent itself. Use this before requests such as removing a Branch button. It can use the official repository or the owner's GitHub fork, never edits the installed app, and does not open or merge a pull request. ${contractDescription}`,
    parameters: PrepareSourceChangeSchema,
    target: (args) => sourceChangeFolder(deps.workspace, String(args.name)),
    execute: (input, context: ToolContext) => {
      ownerOnly(context, deps.store, deps.ownersDefaultTurn);
      return prepareBranchSourceChange(deps, input, context.signal, context.runId ?? "");
    },
  });
  registerWidening(deps);
}

/**
 * Q12: a wider (or otherwise changed) contract, as a new revision. A direct owner's
 * selected Full Access authorizes it; otherwise each widening needs a fresh explicit
 * answer. The old revisions stay readable, and the widening is written in the audit record.
 */
const widenTarget = (name: string): string => `the self-development contract of self-${name}`;

/**
 * Q12: a direct local owner may select Full Access for this conversation. Otherwise the
 * newest "allowed" answer to this exact question must follow the prior revision.
 */
function widenedBy(deps: SelfDevelopmentDeps, context: ToolContext, name: string, after: string): string {
  const selected = deps.fullAccessOwner?.(context);
  if (selected) return selected; // the saved mode is authorization, not a fabricated approval.decided answer
  const session = context.runId ? deps.store.run(context.runId)?.sessionId : undefined;
  const subject = `${widenToolName} on ${widenTarget(name)}`;
  const answer = session ? deps.store.audit.list(deps.owner, { action: "approval.decided", from: after, limit: 200 })
    .find((entry) => entry.subject === subject && entry.outcome === "allowed" && !!entry.runId && deps.store.run(entry.runId)?.sessionId === session) : undefined;
  if (!answer) throw new Error("Nobody has said yes to widening this contract in this conversation since it was last written, so it was not widened.");
  return `${answer.actor}${answer.source !== answer.origin ? ` (answered on ${answer.source})` : ""}`;
}

function registerWidening(deps: SelfDevelopmentDeps): void {
  deps.registry.register({
    name: widenToolName,
    permission: "git.remote",
    description: "Widen the contract of a Branch Agent self-development worktree: more allowed paths, more tools, or changed tests, done, side effects or rollback. Outside the owner's selected Full Access, each change asks the owner. Give only the terms that change and the reason.",
    parameters: z.object({ name: nameSchema, reason: z.string().trim().min(1).max(500), changes: ContractTermsSchema.partial().strict() }).strict(),
    // Named without the source folder's path: Branch's never-break check reads "branch-agent" in a
    // changing call's target as Branch's own service and would refuse the question before it is put.
    target: (args) => widenTarget(String(args.name)),
    execute: async (input, context: ToolContext) => {
      ownerOnly(context, deps.store, deps.ownersDefaultTurn);
      const folder = `${sourceFolder}/.branch-worktrees/self-${input.name}`;
      const current = deps.contracts.current(deps.owner, folder);
      if (!current) throw new Error(`${folder} has no contract to widen.`);
      const approvedBy = widenedBy(deps, context, input.name, current.createdAt);
      const contract = deps.contracts.widen(deps.owner, folder, { taskRunId: context.runId ?? "", terms: input.changes, approvedBy, reason: input.reason });
      audit(deps.store, deps.owner, { action: "self_development.contract", actor: approvedBy.slice(0, 120), subject: `${folder} revision ${contract.revision}`,
        reason: input.reason.slice(0, 500), runId: context.runId ? context.runId.slice(0, 64) : null, outcome: "widened" });
      return { contract, previousRevision: contract.revision - 1 };
    },
  });
}

/** The setup tools appear only while sending Git work to a remote is switched on. */
export function offerSelfDevelopment(deps: SelfDevelopmentDeps): () => void {
  const sync = () => {
    const remote = deps.registry.names().includes("git.push");
    const offered = deps.registry.names().includes(toolName);
    if (remote && !offered) registerSelfDevelopment(deps);
    if (!remote && offered) { deps.registry.unregister(toolName); deps.registry.unregister(widenToolName); }
  };
  sync();
  return deps.registry.onToolsChanged(sync);
}
