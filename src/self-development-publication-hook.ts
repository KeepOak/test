import { ContractBook, contractHash, pullRequestPinned, pushRefusal, pushRepositoryRefusal, workspacePath } from "./self-development-contract.js";
import { assertSafeHead, githubRepositoryOf, pullRequestHookSettings, type PullRequestDeps } from "./pr-hook.js";
import { PublicationQueue, type PublicationEntry, type PublicationIntent } from "./self-development-publication.js";
import { runOrigin, startedWithShortLivedKey } from "./key-context.js";

async function git(deps: PullRequestDeps, entry: PublicationIntent, args: string[], signal: AbortSignal): Promise<string> {
  const result = await deps.git({ cwd: entry.cwd, args, timeoutMs: 180_000 }, signal);
  if (result.status !== "completed" || result.truncated) throw new Error(`Git publication ${result.status}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
function contract(deps: PullRequestDeps, entry: Pick<PublicationIntent, "workspace" | "cwd">) {
  const path = workspacePath(entry.workspace, "", entry.cwd);
  const found = path && new ContractBook(deps.store.sqlite).current(deps.owner, path);
  if (!found) throw new Error("The publication source contract is no longer available.");
  return found;
}
async function validate(deps: PullRequestDeps, entry: PublicationEntry, signal: AbortSignal): Promise<void> {
  if (startedWithShortLivedKey() || (entry.runId && runOrigin(deps.store, entry.runId).shortLivedKey))
    throw new Error("A short-lived key has no publication permission.");
  const settings = pullRequestHookSettings(deps.store, deps.owner);
  if (settings.mode === "off" || settings.remote !== entry.remote) throw new Error("Publication settings changed or switched off.");
  if (deps.files.root !== entry.workspace || deps.files.base !== entry.cwd || contractHash(contract(deps, entry)) !== entry.contractHash)
    throw new Error("The publication source contract changed.");
  const checked = await pushRefusal({ store: deps.store, owner: deps.owner, workspace: entry.workspace, git: deps.git,
    folder: entry.cwd, runId: entry.runId, signal });
  if (checked.refusal || checked.walked !== entry.sha) throw new Error(checked.refusal ?? "The publication source HEAD changed.");
  if (await git(deps, entry, ["rev-parse", "--verify", `refs/heads/${entry.branch}^{commit}`], signal) !== entry.sha)
    throw new Error("The publication source branch changed.");
  assertSafeHead(entry.branch, entry.base, null);
  const addresses = (await git(deps, entry, ["remote", "get-url", "--push", "--all", entry.remote], signal)).split("\n");
  const repos = addresses.map((address) => githubRepositoryOf(address).repo);
  if (!repos.length || addresses.some((address) => address !== entry.pushAddress) || repos.some((repo) => repo.toLowerCase() !== entry.pushRepo.toLowerCase()))
    throw new Error("The publication destination changed.");
  await deps.policy.assertAllowed(new URL(`https://github.com/${entry.pushRepo}`), "GitHub publication");
  await deps.policy.assertAllowed(new URL(`https://github.com/${entry.repository}`), "GitHub pull request");
  const refusal = pushRepositoryRefusal(checked.repositories, entry.remote, repos)
    ?? pullRequestPinned(entry.opening, checked.repositories)
    ?? deps.preflight?.("github.open_pull_request", entry.opening, entry.runId);
  if (refusal) throw new Error(refusal);
  if (entry.adapter === "saved" && !deps.registry.names().includes("github.open_pull_request"))
    throw new Error("The saved GitHub connection was removed.");
}
export function sourcePublicationQueue(deps: PullRequestDeps): PublicationQueue {
  return new PublicationQueue(deps.store.sqlite, deps.owner, {
    validate: (entry, signal) => validate(deps, entry, signal),
    remote: async (entry, signal) => {
      const output = await git(deps, entry, ["ls-remote", "--heads", entry.pushAddress, `refs/heads/${entry.branch}`], signal);
      if (!output) return null;
      const lines = output.split("\n");
      if (lines.length !== 1 || !lines[0]!.endsWith(`\trefs/heads/${entry.branch}`)) throw new Error("Unexpected remote branch response.");
      return lines[0]!.split("\t")[0]!;
    },
    // An empty expected ref makes this create-only: even an ancestor created after ls-remote
    // cannot be overwritten. It never permits replacing an existing remote branch.
    push: async (entry, signal) => { await git(deps, entry, ["push", `--force-with-lease=refs/heads/${entry.branch}:`,
      entry.pushAddress, `${entry.sha}:refs/heads/${entry.branch}`], signal); },
    find: async (entry, signal) => {
      if (!deps.findPublication) throw new Error("Publication reconciliation is unavailable.");
      return deps.findPublication(entry, signal);
    },
    open: (entry, signal) => entry.adapter === "saved"
      ? deps.runTool("github.open_pull_request", entry.opening, entry.runId)
      : deps.openWithComputerGh!(entry.opening, signal),
  });
}
export async function queueSourcePublication(deps: PullRequestDeps, intent: Omit<PublicationIntent, "contractHash">,
  signal: AbortSignal): Promise<PublicationEntry> {
  const queue = sourcePublicationQueue(deps);
  const entry = queue.enqueue({ ...intent, contractHash: contractHash(contract(deps, intent)) });
  return (await queue.attempt(entry.id, signal))!;
}
/** A repeated authorized request resumes the saved proposal instead of making another commit. */
export async function resumeSourcePublication(deps: PullRequestDeps, input: { cwd: string; branch: string; repository: string;
  base: string; title: string; summary: string; signal: AbortSignal }): Promise<PublicationEntry | null> {
  const queue = sourcePublicationQueue(deps), entry = queue.forBranch(input.cwd, input.branch);
  if (!entry) return null;
  if (entry.repository !== input.repository || entry.base !== input.base || entry.opening.title !== input.title.slice(0, 200)
    || entry.opening.body !== input.summary.slice(0, 8000)) throw new Error("This branch already has a saved publication with different details.");
  return queue.attempt(entry.id, input.signal);
}
/** Resume durable intents at startup and periodically. Stop aborts and awaits any active attempt. */
export function startSourcePublications(deps: PullRequestDeps): () => Promise<void> {
  const queue = sourcePublicationQueue(deps), stop = new AbortController();
  let active: Promise<void> | null = null;
  const tick = () => { if (!active) active = queue.drain(stop.signal).catch(() => undefined).finally(() => { active = null; }); };
  const timer = setInterval(tick, 15_000); timer.unref(); tick();
  return async () => { clearInterval(timer); stop.abort(); await active; };
}
