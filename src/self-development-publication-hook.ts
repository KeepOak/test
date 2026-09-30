import { ContractBook, contractHash, pullRequestPinned, pushRefusal, pushRepositoryRefusal, workspacePath } from "./self-development-contract.js";
import { assertSafeHead, githubRepositoryOf, pullRequestHookSettings, type PullRequestDeps } from "./pr-hook.js";
import { PublicationQueue, type PublicationEntry, type PublicationIntent } from "./self-development-publication.js";
import { publicationReference } from "./self-development-publication-lookup.js";
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
/** Persist only bounded publication identities, never proposal text or provider failure output. */
function recordPublication(deps: PullRequestDeps, entry: PublicationEntry): void {
  const runId = entry.receiptRunId ?? entry.runId;
  if (!runId || deps.store.run(runId)?.owner !== deps.owner) return;
  const data = { publicationId: entry.id, repository: entry.repository, branch: entry.branch, base: entry.base,
    sha: entry.sha, files: entry.files.length, state: entry.state, phase: entry.phase, attempts: entry.attempts };
  const seen = deps.store.sqlite.prepare(`SELECT 1 FROM events WHERE run_id=? AND kind='pull_request.publication'
    AND json_extract(data,'$.publicationId')=? AND json_extract(data,'$.state')=?
    AND json_extract(data,'$.phase')=? AND json_extract(data,'$.attempts')=? LIMIT 1`)
    .get(runId, entry.id, entry.state, entry.phase, entry.attempts);
  if (!seen) deps.store.event(runId, "pull_request.publication", data);
  if (entry.state !== "published" || !entry.pullRequest || typeof entry.pullRequest !== "object") return;
  const reference = publicationReference(entry.repository, entry.pullRequest);
  if (!reference) return;
  const { number, address } = reference;
  // Compatible with the task-to-PR receipt seam; an already recorded real opening remains intact.
  const opened = deps.store.sqlite.prepare(`SELECT 1 FROM events WHERE run_id=? AND kind='pull_request.opened'
    AND lower(json_extract(data,'$.repository'))=lower(?) AND json_extract(data,'$.number')=? LIMIT 1`)
    .get(runId, entry.repository, Number(number));
  if (!opened) deps.store.event(runId, "pull_request.opened", { ...data, number: Number(number), address });
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
  }, Date.now, (entry) => recordPublication(deps, entry));
}
export async function queueSourcePublication(deps: PullRequestDeps, intent: Omit<PublicationIntent, "contractHash">,
  signal: AbortSignal): Promise<PublicationEntry> {
  const queue = sourcePublicationQueue(deps);
  const entry = queue.enqueue({ ...intent, contractHash: contractHash(contract(deps, intent)) });
  return (await queue.attempt(entry.id, signal))!;
}
/** A repeated authorized request resumes the saved proposal instead of making another commit. */
export interface PublicationRevision { previousSha: string; sha: string; pullRequest: unknown }
export interface ResumedPublication { publication: PublicationEntry; revision?: PublicationRevision }
export async function resumeSourcePublication(deps: PullRequestDeps, input: { cwd: string; branch: string; repository: string;
  base: string; title: string; summary: string; runId?: string | undefined; signal: AbortSignal }): Promise<ResumedPublication | null> {
  const queue = sourcePublicationQueue(deps), entry = queue.forBranch(input.cwd, input.branch);
  if (!entry) return null;
  if (entry.repository !== input.repository || entry.base !== input.base || entry.opening.title !== input.title.slice(0, 200)
    || entry.opening.body !== input.summary.slice(0, 8000)) throw new Error("This branch already has a saved publication with different details.");
  if (entry.state !== "published") {
    const publication = await queue.attempt(entry.id, input.signal);
    return publication ? { publication } : null;
  }
  const sha = await git(deps, entry, ["rev-parse", "--verify", "HEAD^{commit}"], input.signal);
  if (sha === entry.sha) return { publication: entry };
  if (!/^[0-9a-f]{40}$/.test(sha) || await git(deps, entry, ["symbolic-ref", "--short", "HEAD"], input.signal) !== entry.branch
    || await git(deps, entry, ["status", "--porcelain=v1"], input.signal))
    throw new Error("The revised publication needs its own clean checked-out branch at an exact commit.");
  // Read-only reconciliation after the normal guarded commit/push tools. Original publication pins remain immutable.
  await git(deps, entry, ["merge-base", "--is-ancestor", entry.sha, sha], input.signal);
  const revised = { ...entry, sha };
  await validate(deps, revised, input.signal);
  const output = await git(deps, revised, ["ls-remote", "--heads", entry.pushAddress, `refs/heads/${entry.branch}`], input.signal);
  if (output !== `${sha}\trefs/heads/${entry.branch}`)
    throw new Error("The revised local commit is not the exact remote branch head. No current PR receipt was returned.");
  const pullRequest = await deps.findPublication!(revised, input.signal);
  input.signal.throwIfAborted();
  const original = publicationReference(entry.repository, entry.pullRequest);
  const found = publicationReference(entry.repository, pullRequest);
  const live = pullRequest as { state?: unknown; headSha?: unknown } | null;
  if (!original || !found || found.number !== original.number || live?.state !== "open" || live.headSha !== sha)
    throw new Error("The existing open pull request at the revised head could not be proved.");
  // Recheck local identity after the remote reads; a moved or dirty source cannot be reported as current.
  if (await git(deps, revised, ["rev-parse", "--verify", "HEAD^{commit}"], input.signal) !== sha
    || await git(deps, revised, ["symbolic-ref", "--short", "HEAD"], input.signal) !== entry.branch
    || await git(deps, revised, ["status", "--porcelain=v1"], input.signal))
    throw new Error("The revised source changed during publication reconciliation.");
  const data = { publicationId: entry.id, repository: entry.repository, branch: entry.branch, base: entry.base,
    previousSha: entry.sha, sha, number: found.number, address: found.address };
  for (const runId of new Set([entry.receiptRunId ?? entry.runId, input.runId])) {
    if (!runId || deps.store.run(runId)?.owner !== deps.owner) continue;
    const seen = deps.store.sqlite.prepare(`SELECT 1 FROM events WHERE run_id=? AND kind='pull_request.revised'
      AND json_extract(data,'$.publicationId')=? AND json_extract(data,'$.sha')=? LIMIT 1`).get(runId, entry.id, sha);
    if (!seen) deps.store.event(runId, "pull_request.revised", data);
  }
  return { publication: entry, revision: { previousSha: entry.sha, sha, pullRequest } };
}
/** Resume durable intents at startup and periodically. Stop aborts and awaits any active attempt. */
export function startSourcePublications(deps: PullRequestDeps): () => Promise<void> {
  const queue = sourcePublicationQueue(deps), stop = new AbortController();
  let active: Promise<void> | null = null;
  const tick = () => { if (!active) active = queue.drain(stop.signal).catch(() => undefined).finally(() => { active = null; }); };
  const timer = setInterval(tick, 15_000); timer.unref(); tick();
  return async () => { clearInterval(timer); stop.abort(); await active; };
}
