import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { audit } from "./audit.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { currentTaskRun } from "./task-scope.js";
import { lockdownActive } from "./lockdown.js";
import { contractHash, selfDevelopmentLine, selfDevelopmentLockdownRefusal } from "./self-development-contract.js";
import { boundedDiff } from "./self-development-diff.js";
import { cleanHead, SelfDevelopmentEvidence, sourceGit } from "./self-development-evidence.js";
import type { SelfDevelopmentDeps } from "./self-development.js";
import { ownerGitHubConnection } from "./integrations/git-tools.js";
import { repositoryPath } from "./integrations/github.js";
import { HttpError } from "./server-http.js";
import { wslProbe, wslReadiness } from "./integrations/wsl-held.js";
import { currentCaller } from "./caller.js";
import { throughPairedDoor } from "./people/context.js";

const ReviewSchema = z.object({ worktree: z.string().regex(/^branch-agent-source\/\.branch-worktrees\/self-[a-z0-9][a-z0-9-]{0,23}$/),
  repo: repositoryPath, number: z.number().int().positive() }).strict();
const GrantSchema = z.object({ id: z.string().uuid() }).strict();
type ReviewInput = z.infer<typeof ReviewSchema>;
const fingerprint = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Snapshot = Awaited<ReturnType<SelfDevelopmentMerges["snapshot"]>>;
type Grant = { input: ReviewInput; snapshot: Snapshot; hash: string; approved: boolean; expires: number };

/** One owner review, one approval, one normal merge. No task or chat can create or consume a grant. */
export class SelfDevelopmentMerges {
  readonly evidence: SelfDevelopmentEvidence;
  private readonly grants = new Map<string, Grant>();
  constructor(private readonly deps: SelfDevelopmentDeps, private readonly locked: () => boolean) {
    this.evidence = new SelfDevelopmentEvidence(deps);
  }
  private ownerHere(): void {
    this.deps.store.profiles.requireOwner("Reviewing and merging Branch's own source");
    if (currentCaller()?.throughDoor || throughPairedDoor()) throw new HttpError(403, "Review and merge Branch's code in the app on this computer.");
    if (startedWithShortLivedKey() || currentTaskRun()) throw new HttpError(403, "Only the owner in this app can review and merge Branch's code; tasks and keys cannot.");
    if (this.locked()) throw new HttpError(423, "Unlock Branch before reviewing its code.");
    if (lockdownActive(this.deps.store, this.deps.owner)) throw new HttpError(403, selfDevelopmentLockdownRefusal);
  }
  private sourceIdle(worktree: string): void {
    const projects = this.deps.projects.list(this.deps.owner);
    const active = this.deps.store.activeRuns(this.deps.owner).find((run) => projects.some((project) => project.id === run.project
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
  async snapshot(input: ReviewInput): Promise<{
    contractHash: string; definition: string; rollback: string; diff: Awaited<ReturnType<typeof boundedDiff>>;
    scope: { revision: number; sourceSha: string; allowedPaths: string[]; permissions: string[]; sideEffects: string[] };
    tests: NonNullable<ReturnType<SelfDevelopmentEvidence["get"]>>; github: Awaited<ReturnType<ReturnType<typeof ownerGitHubConnection>["mergeReview"]>>;
  }> {
    this.ownerHere();
    this.sourceIdle(input.worktree);
    const contract = this.deps.contracts.current(this.deps.owner, input.worktree);
    if (!contract || !contract.sendRepositories?.includes(input.repo.toLowerCase())) throw new Error("The contract does not allow that repository.");
    const signal = AbortSignal.timeout(120_000);
    const head = await cleanHead(this.deps, contract, signal);
    const tests = this.evidence.get(input.worktree);
    if (!tests || tests.sha !== head || tests.contractHash !== contractHash(contract))
      throw new Error("Run the contract's exact node scripts/review.mjs --jobs 1 test list on the committed worktree through Branch's confined command tool first.");
    const branch = await sourceGit(this.deps, input.worktree, ["symbolic-ref", "--short", "HEAD"], signal);
    const diff = await boundedDiff(this.deps, contract, signal);
    if (diff.truncated || diff.outside.length || diff.untracked.length || !diff.files.length) throw new Error("The complete change is not available inside the contract. Review it manually.");
    const github = await ownerGitHubConnection(this.deps.registry).mergeReview(input.repo, input.number);
    this.ownerHere();
    if (github.base !== selfDevelopmentLine || github.headSha !== head || github.head !== branch) throw new Error("The pull request does not match this contract's branch, tested head and Beta base.");
    if (await cleanHead(this.deps, contract, signal) !== head || this.deps.contracts.current(this.deps.owner, input.worktree)?.revision !== contract.revision)
      throw new Error("The source or contract changed during review. Start again.");
    this.ownerHere();
    this.sourceIdle(input.worktree);
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
    this.record(grant, "merged");
    return { ...result, repository: grant.input.repo, number: grant.input.number, reviewedHead: snapshot.github.headSha };
  }
  private grant(id: string): Grant {
    const grant = this.grants.get(id);
    if (!grant || grant.expires <= Date.now()) { this.grants.delete(id); throw new Error("That review expired or was already used. Review again."); }
    return grant;
  }
  private record(grant: Grant, outcome: "approved" | "merged"): void {
    audit(this.deps.store, this.deps.owner, { action: "self_development.merge", actor: this.deps.owner,
      subject: `${grant.input.repo}#${grant.input.number} ${grant.snapshot.github.headSha}`, reason: `Owner ${outcome} this exact reviewed commit in the app`, source: "owner", outcome });
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
