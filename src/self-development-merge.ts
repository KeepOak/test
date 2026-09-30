import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { audit } from "./audit.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { currentTaskRun } from "./task-scope.js";
import { lockdownActive } from "./lockdown.js";
import { contractHash, preparedByTask, selfDevelopmentBase, selfDevelopmentLockdownRefusal } from "./self-development-contract.js";
import { boundedDiff } from "./self-development-diff.js";
import { cleanHead, SelfDevelopmentEvidence, sourceGit } from "./self-development-evidence.js";
import type { SelfDevelopmentDeps } from "./self-development.js";
import { ownerGitHubConnection } from "./integrations/git-tools.js";
import { ChecksPending } from "./integrations/github-merge.js";
import { queuedNote, repositoryPath } from "./integrations/github.js";
import { HttpError } from "./server-http.js";
import { wslProbe, wslReadiness } from "./integrations/wsl-held.js";
import { currentCaller } from "./caller.js";
import { canonicalRepo, officialRepo } from "./desktop/repo-pair.js";
import { throughPairedDoor } from "./people/context.js";
import type { ToolContext } from "./contracts.js";
import { recordSourceArrival } from "./self-development-arrival.js";

const ReviewSchema = z.object({ worktree: z.string().regex(/^branch-agent-source\/\.branch-worktrees\/self-[a-z0-9][a-z0-9-]{0,23}$/),
  // The old stabrea/Branch-Agent name is asked for as KeepOak/Branch-Agent: GitHub only redirects it, and Branch refuses redirects.
  repo: repositoryPath.transform(officialRepo), number: z.number().int().positive() }).strict();
const GrantSchema = z.object({ id: z.string().uuid() }).strict();
type ReviewInput = z.infer<typeof ReviewSchema>;
const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Snapshot = Awaited<ReturnType<SelfDevelopmentMerges["snapshot"]>>;
type Grant = { input: ReviewInput; snapshot: Snapshot; hash: string; approved: boolean; expires: number };
type IndependentReview = { runId: string; passed: boolean; findings: string[] };
type Reviewer = (snapshot: Snapshot, context: ToolContext) => Promise<IndependentReview>;

/** One owner review, one approval, one normal merge. No task or chat can create or consume a grant. */
export class SelfDevelopmentMerges {
  readonly evidence: SelfDevelopmentEvidence;
  private readonly grants = new Map<string, Grant>();
  private readonly finishing = new Set<string>();
  constructor(private readonly deps: SelfDevelopmentDeps, private readonly locked: () => boolean,
    private readonly reviewer?: Reviewer, private readonly fullAccessOwner?: (context: ToolContext) => string | null) {
    this.evidence = new SelfDevelopmentEvidence(deps);
  }
  private ownerHere(): void {
    this.deps.store.profiles.requireOwner("Reviewing and merging Branch's own source");
    if (currentCaller()?.throughDoor || throughPairedDoor()) throw new HttpError(403, "Review and merge Branch's code in the app on this computer.");
    if (startedWithShortLivedKey() || currentTaskRun()) throw new HttpError(403, "Only the owner in this app can review and merge Branch's code; tasks and keys cannot.");
    if (this.locked()) throw new HttpError(423, "Unlock Branch before reviewing its code.");
    if (lockdownActive(this.deps.store, this.deps.owner)) throw new HttpError(403, selfDevelopmentLockdownRefusal);
  }
  private sourceIdle(worktree: string, exceptRunId?: string): void {
    const projects = this.deps.projects.list(this.deps.owner);
    const active = this.deps.store.activeRuns(this.deps.owner).find((run) => run.id !== exceptRunId && projects.some((project) => project.id === run.project
      && project.folder.replace(/\\/g, "/").replace(/\/$/, "") === worktree));
    if (active) throw new Error(`Task ${active.id} is still ${active.status} in ${worktree}. Finish or stop that task before reviewing and merging this change.`);
  }
  list(): unknown {
    this.ownerHere();
    const rows = this.deps.store.sqlite.prepare("SELECT DISTINCT worktree FROM self_development_contracts WHERE owner=? ORDER BY worktree").all(this.deps.owner);
    return { changes: rows.map((row) => this.deps.contracts.current(this.deps.owner, String(row.worktree))).filter(Boolean).map((contract) => ({
      worktree: contract!.worktreePath, revision: contract!.revision, tests: contract!.expectedTests,
      repositories: contract!.sendRepositories ?? [], evidence: this.evidence.get(contract!.worktreePath),
    })) };
  }
  async runner(): Promise<unknown> {
    this.ownerHere();
    if (!this.deps.registry.names().includes("shell.execute")) return { available: false, problem: "Enable commands and an approved Node alias in Settings before running the contract's tests.", tested: false };
    if (process.platform !== "win32") return { available: null, problem: "The contract's command gate checks the configured OS sandbox when the test command runs.", tested: false };
    const problem = await wslReadiness(wslProbe);
    this.ownerHere();
    return { available: problem === null, problem, tested: false,
      note: "This checks the existing WSL Node and bubblewrap runner. Project dependencies and the contract's actual tests still have to pass; nothing was installed." };
  }
  async snapshot(input: ReviewInput, authorize: () => void = () => this.ownerHere(), exceptRunId?: string, draft = false): Promise<{
    contractHash: string; definition: string; rollback: string; diff: Awaited<ReturnType<typeof boundedDiff>>;
    scope: { revision: number; sourceSha: string; allowedPaths: string[]; permissions: string[]; sideEffects: string[] };
    tests: NonNullable<ReturnType<SelfDevelopmentEvidence["get"]>>; github: Awaited<ReturnType<ReturnType<typeof ownerGitHubConnection>["mergeReview"]>>;
  }> {
    authorize();
    this.sourceIdle(input.worktree, exceptRunId);
    const contract = this.deps.contracts.current(this.deps.owner, input.worktree);
    if (!contract || !contract.sendRepositories?.some((allowed) => canonicalRepo(allowed) === canonicalRepo(input.repo))) throw new Error("The contract does not allow that repository.");
    const signal = AbortSignal.timeout(120_000);
    const head = await cleanHead(this.deps, contract, signal);
    const tests = this.evidence.get(input.worktree);
    if (!tests || tests.sha !== head || tests.contractHash !== contractHash(contract))
      throw new Error("Run the contract's exact node scripts/review.mjs --jobs 1 test list on the committed worktree through Branch's confined command tool first.");
    const branch = await sourceGit(this.deps, input.worktree, ["symbolic-ref", "--short", "HEAD"], signal);
    const diff = await boundedDiff(this.deps, contract, signal);
    if (diff.truncated || diff.outside.length || diff.untracked.length || !diff.files.length) throw new Error("The complete change is not available inside the contract. Review it manually.");
    const github = await (draft ? ownerGitHubConnection(this.deps.registry).draftReview(input.repo, input.number)
      : ownerGitHubConnection(this.deps.registry).mergeReview(input.repo, input.number));
    authorize();
    if (!selfDevelopmentBase(github.base) || github.headSha !== head || github.head !== branch) throw new Error("The pull request does not match this contract's branch, tested head and base line.");
    if (await cleanHead(this.deps, contract, signal) !== head || this.deps.contracts.current(this.deps.owner, input.worktree)?.revision !== contract.revision)
      throw new Error("The source or contract changed during review. Start again.");
    authorize();
    this.sourceIdle(input.worktree, exceptRunId);
    return { contractHash: contractHash(contract), definition: contract.definitionOfDone, rollback: contract.rollbackPlan,
      scope: { revision: contract.revision, sourceSha: contract.sourceSha, allowedPaths: contract.allowedPaths, permissions: contract.permissions, sideEffects: contract.sideEffects }, diff, tests, github };
  }
  async review(input: unknown): Promise<unknown> {
    this.ownerHere();
    const parsed = ReviewSchema.parse(input), snapshot = await this.snapshot(parsed);
    this.ownerHere();
    for (const [id, grant] of this.grants) if (grant.expires <= Date.now()) this.grants.delete(id);
    if (this.grants.size >= 20) throw new Error("Finish or reopen existing reviews before starting more.");
    const id = randomUUID();
    this.grants.set(id, { input: parsed, snapshot, hash: fingerprint(snapshot), approved: false, expires: Date.now() + 600_000 });
    return { id, approved: false, ...snapshot };
  }
  approve(input: unknown): unknown {
    this.ownerHere();
    const id = GrantSchema.parse(input).id, grant = this.grant(id);
    grant.approved = true;
    this.record(grant, "approved");
    return { id, approved: true, headSha: grant.snapshot.github.headSha, baseSha: grant.snapshot.github.baseSha };
  }
  async merge(input: unknown): Promise<unknown> {
    this.ownerHere();
    const id = GrantSchema.parse(input).id, grant = this.grant(id);
    if (!grant.approved) throw new Error("Read the change and explicitly approve this exact commit before merging.");
    this.grants.delete(id); // One attempt, including errors or racing duplicate clicks.
    const snapshot = await this.snapshot(grant.input);
    this.ownerHere();
    if (Date.now() >= grant.expires || fingerprint(snapshot) !== grant.hash) throw new Error("The reviewed contract, diff, tests, head, base or checks changed. Review again.");
    const github = ownerGitHubConnection(this.deps.registry);
    const result = await github.mergeReviewed(snapshot.github, () => {
      this.ownerHere();
      this.sourceIdle(grant.input.worktree);
      if (Date.now() >= grant.expires || ownerGitHubConnection(this.deps.registry) !== github)
        throw new Error("The review expired or GitHub connection changed before the merge was sent. Review again.");
    });
    this.record(grant, result.merged ? "merged" : "queued");
    if (result.merged) recordSourceArrival(this.deps.store, this.deps.owner, grant.input.worktree, result.sha,
      { repository: grant.input.repo, number: grant.input.number, reviewedHead: snapshot.github.headSha });
    return { ...result, repository: grant.input.repo, number: grant.input.number, reviewedHead: snapshot.github.headSha };
  }
  private autoOwner(input: ReviewInput, context: ToolContext): string {
    const actor = this.fullAccessOwner?.(context);
    if (!actor || context.runId !== currentTaskRun() || context.owner !== this.deps.owner || this.locked()
      || lockdownActive(this.deps.store, this.deps.owner))
      throw new HttpError(403, "Automatic finish needs this owner's current local Full Access task, unlocked and outside Lockdown.");
    const run = this.deps.store.run(context.runId);
    const project = this.deps.projects.list(this.deps.owner).find((row) => row.id === run?.project);
    // selfdev: the task that prepared this change keeps its conversation's project, and finishes its own change.
    const prepared = preparedByTask(this.deps.store, this.deps.contracts, this.deps.owner, input.worktree, context.runId);
    if (!run || run.status !== "running" || (!prepared && project?.folder.replace(/\\/g, "/").replace(/\/$/, "") !== input.worktree))
      throw new HttpError(403, "The active owner task must be working in this exact source worktree.");
    return actor;
  }
  private autoGate(input: ReviewInput, context: ToolContext): () => void {
    return () => { this.autoOwner(input, context); this.sourceIdle(input.worktree, context.runId); };
  }
  private async checkedSnapshot(input: ReviewInput, context: ToolContext, draft: boolean): Promise<Snapshot> {
    const gate = this.autoGate(input, context);
    const snapshot = await this.snapshot(input, gate, context.runId, draft);
    if (!snapshot.scope.permissions.includes("branch.finish_source_change"))
      throw new Error("This contract does not allow automatic finish. Widen it before trying again.");
    gate();
    return snapshot;
  }
  /** Full Access can finish its own tested draft, but the verdict comes from a separate read-only task. */
  async autoFinish(value: unknown, context: ToolContext): Promise<unknown> {
    const input = ReviewSchema.parse(value), gate = this.autoGate(input, context);
    gate();
    if (!this.reviewer) throw new Error("Independent source review is unavailable.");
    const key = `${input.repo.toLowerCase()}#${input.number}`;
    if (this.finishing.has(key)) throw new Error("This pull request is already being reviewed for finish.");
    this.finishing.add(key);
    try { return await this.finishOnce(input, context, gate); }
    finally { this.finishing.delete(key); }
  }
  private async finishOnce(input: ReviewInput, context: ToolContext, gate: () => void): Promise<unknown> {
    const before = await this.checkedSnapshot(input, context, true);
    const github = ownerGitHubConnection(this.deps.registry);
    const reviewer = this.reviewer!;
    const result = await reviewer(before, context);
    gate();
    if (!result.passed || result.findings.length || !this.deps.store.run(result.runId)
      || this.deps.store.run(result.runId)?.status !== "completed")
      throw new Error("The separate read-only review did not pass; the draft remains for owner review.");
    const refreshed = await this.checkedSnapshot(input, context, true);
    if (fingerprint(refreshed) !== fingerprint(before) || ownerGitHubConnection(this.deps.registry) !== github)
      throw new Error("The reviewed contract, diff, tests, head, base or checks changed. Review again.");
    await github.readyReviewed(refreshed.github, gate);
    gate();
    const ready = await this.afterReady(input, context);
    if (fingerprint(ready) !== fingerprint(before) || ownerGitHubConnection(this.deps.registry) !== github)
      throw new Error("The pull request changed after becoming ready. Review it in GitHub; no merge was sent.");
    const actor = this.autoOwner(input, context);
    const merged = await github.mergeReviewed(ready.github, () => {
      gate();
      if (ownerGitHubConnection(this.deps.registry) !== github) throw new Error("The GitHub connection changed before merge.");
    });
    if (merged.merged) recordSourceArrival(this.deps.store, this.deps.owner, input.worktree, merged.sha,
      { repository: input.repo, number: input.number, reviewedHead: ready.github.headSha });
    audit(this.deps.store, this.deps.owner, { action: "self_development.merge", actor,
      subject: `${input.repo}#${input.number} ${ready.github.headSha}`, runId: context.runId,
      reason: `Independent read-only task ${result.runId} passed; exact tested protected commit ${merged.merged ? "merged normally" : "joined the base's merge queue"}.`,
      source: "owner", outcome: merged.merged ? "merged" : "queued" });
    return { ...merged, repository: input.repo, number: input.number, reviewedHead: ready.github.headSha, reviewerRunId: result.runId,
      ...(merged.merged ? {} : { note: queuedNote }) };
  }
  /**
   * GitHub works out a newly ready pull request's mergeability again; that wait is pending, never passed. Up to two
   * minutes: a merge-queue base can say "blocked" for a while after the draft turns ready.
   */
  private async afterReady(input: ReviewInput, context: ToolContext): Promise<Snapshot> {
    for (let attempt = 1; ; attempt++) {
      try { return await this.checkedSnapshot(input, context, false); }
      catch (error) {
        if (!(error instanceof ChecksPending) || attempt >= 40) throw error;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }
  private grant(id: string): Grant {
    const grant = this.grants.get(id);
    if (!grant || grant.expires <= Date.now()) { this.grants.delete(id); throw new Error("That review expired or was already used. Review again."); }
    return grant;
  }
  private record(grant: Grant, outcome: "approved" | "merged" | "queued"): void {
    audit(this.deps.store, this.deps.owner, { action: "self_development.merge", actor: this.deps.owner,
      subject: `${grant.input.repo}#${grant.input.number} ${grant.snapshot.github.headSha}`,
      reason: outcome === "queued" ? "Owner sent this exact reviewed commit to the base's merge queue in the app" : `Owner ${outcome} this exact reviewed commit in the app`, source: "owner", outcome });
  }
}
export const handlesSourceMergePath = (path: string): boolean => path === "/api/self-development/merge"
  || path === "/api/self-development/merge/runner" || path === "/api/self-development/merge/review" || path === "/api/self-development/merge/approve" || path === "/api/self-development/merge/finish";
export async function sourceMergeApi(merges: SelfDevelopmentMerges, method: string, path: string, body: () => Promise<unknown>): Promise<unknown> {
  if (path === "/api/self-development/merge" || path === "/api/self-development/merge/runner") {
    if (method !== "GET") throw new HttpError(405, "Use GET here.");
    return path.endsWith("/runner") ? merges.runner() : merges.list();
  }
  if (method !== "POST") throw new HttpError(405, "Use POST here.");
  if (path === "/api/self-development/merge/review") return merges.review(await body());
  if (path === "/api/self-development/merge/approve") return merges.approve(await body());
  return merges.merge(await body());
}
