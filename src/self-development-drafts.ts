import { resolve } from "node:path";
import { z } from "zod";
import { currentCaller } from "./caller.js";
import { inWorktree } from "./coding/worktrees.js";
import { startedWithShortLivedKey } from "./key-context.js";
import { lockdownActive } from "./lockdown.js";
import { currentPerson } from "./people/context.js";
import { assertSafeHead, githubRepositoryOf, pullRequestHookSettings, sendablePaths, type PullRequestDeps } from "./pr-hook.js";
import { contractHash, pushRefusal, selfDevelopmentLine } from "./self-development-contract.js";
import { boundedDiff } from "./self-development-diff.js";
import { queueSourcePublication } from "./self-development-publication-hook.js";
import type { PublicationEntry, PublicationIntent } from "./self-development-publication.js";
import type { SourceChangeRequests } from "./self-development-requests.js";
import type { SelfDevelopmentDeps } from "./self-development.js";
import { HttpError } from "./server-http.js";
import { currentTaskRun } from "./task-scope.js";

const sha = z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/);
const IdentitySchema = z.object({
  revision: z.number().int().positive(), contractHash: z.string().regex(/^[a-f0-9]{64}$/),
  sourceSha: sha, head: sha, tree: sha,
  branch: z.string().regex(/^branch\/[A-Za-z0-9._-]{1,60}$/),
  repository: z.string().regex(/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/),
  base: z.string().min(1).max(100), remote: z.string().min(1).max(40),
}).strict();
export const PublishSourceDraftSchema = z.object({
  review: IdentitySchema, title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(8000), consent: z.literal(true),
}).strict();
interface DraftDeps {
  source: SelfDevelopmentDeps; requests: SourceChangeRequests; publication: PullRequestDeps;
  locked: () => boolean;
  audit: <T>(label: string, work: (runId: string, signal: AbortSignal) => Promise<T>) => Promise<T>;
}

/** The Inbox approves the real source contract and publishes the exact committed proposal. */
export class SourceRequestDrafts {
  private readonly publishing = new Set<string>();
  constructor(private readonly deps: DraftDeps) {}

  private owner(): void {
    const { source } = this.deps;
    source.store.profiles.requireOwner("Publishing a reviewed change to Branch itself");
    if (startedWithShortLivedKey() || currentPerson() || currentTaskRun())
      throw new Error("Only the owner at this window may publish this reviewed change.");
    if (this.deps.locked() || lockdownActive(source.store, source.owner))
      throw new Error("Unlock Branch and turn off Lockdown before publishing a source change.");
  }

  /** Rechecked for every background retry too; a saved click cannot authorize another request. */
  authorize(entry: PublicationEntry): void {
    if (!entry.review) return;
    this.owner();
    const { contract } = this.deps.requests.prepared(entry.review.requestId);
    if (contractHash(contract) !== entry.contractHash || contract.revision !== entry.review.revision
      || contract.sourceSha !== entry.review.sourceSha
      || resolve(this.deps.source.workspace, contract.worktreePath) !== entry.cwd)
      throw new Error("The reviewed request or source contract changed. Review it again.");
  }

  private async git(cwd: string, args: string[], signal: AbortSignal, raw = false): Promise<string> {
    this.owner(); signal.throwIfAborted();
    const result = await this.deps.publication.git({ cwd, args, timeoutMs: 30_000, maxOutputBytes: 262_144 }, signal);
    this.owner(); signal.throwIfAborted();
    if (result.status !== "completed" || result.truncated) throw new Error("The complete source identity could not be read.");
    return raw ? result.stdout : result.stdout.trim();
  }

  /** Include files later removed again: the entire committed history leaves the computer. */
  private async files(cwd: string, from: string, to: string, signal: AbortSignal): Promise<string[]> {
    const log = await this.git(cwd, ["log", "--no-renames", "-m", "--name-status", "-z", "--format=", `${from}..${to}`], signal, true);
    const tokens = log.split("\0"), files: string[] = [];
    for (let at = 0; at < tokens.length; at += 2) {
      const status = tokens[at]!;
      if (!status && at === tokens.length - 1) break;
      if (!/^\n*[ADMRTUXB][0-9]*$/.test(status) || !tokens[at + 1]) throw new Error("The complete committed file list could not be read.");
      files.push(tokens[at + 1]!);
    }
    return [...new Set(files)];
  }

  private async snapshot(id: string, signal: AbortSignal) {
    this.owner();
    const { request, contract } = this.deps.requests.prepared(id);
    const cwd = resolve(this.deps.source.workspace, contract.worktreePath);
    const settings = pullRequestHookSettings(this.deps.source.store, this.deps.source.owner);
    if (settings.mode === "off") throw new Error("Turn on Pull requests from changes in Settings before publishing.");
    const branch = await this.git(cwd, ["symbolic-ref", "--short", "HEAD"], signal);
    assertSafeHead(branch, selfDevelopmentLine, null);
    const head = await this.git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
    const tree = await this.git(cwd, ["rev-parse", "--verify", `${head}^{tree}`], signal);
    if (await this.git(cwd, ["status", "--porcelain=v1", "--untracked-files=all"], signal))
      throw new Error("Commit the edits before reviewing a draft. Uncommitted files are never published here.");
    const addresses = (await this.git(cwd, ["remote", "get-url", "--push", "--all", settings.remote], signal)).split("\n");
    const push = addresses.map(githubRepositoryOf);
    if (!push.length || addresses.some((address) => address !== addresses[0])) throw new Error("The remote has more than one push address.");
    const repository = contract.sendRepositories?.at(-1);
    if (!repository) throw new Error("This contract has no pinned pull-request repository.");
    const review = IdentitySchema.parse({ revision: contract.revision, contractHash: contractHash(contract), sourceSha: contract.sourceSha,
      head, tree, branch, repository, base: selfDevelopmentLine, remote: settings.remote });
    if (review.head === review.sourceSha) throw new Error("There are no committed changes to publish.");
    if (contractHash(this.deps.requests.prepared(id).contract) !== review.contractHash)
      throw new Error("The source contract changed while it was read. Review it again.");
    return { request, contract, cwd, review, pushRepo: push[0]!.repo, pushAddress: addresses[0]! };
  }

  async preview(id: string, signal = AbortSignal.timeout(60_000)) {
    if (currentCaller().kind !== "owner-here") throw new HttpError(403, "Review a source draft in the owner's local window.");
    const snapshot = await this.snapshot(id, signal);
    const diff = await boundedDiff(this.deps.source, snapshot.contract, signal);
    this.owner();
    const current = await this.snapshot(id, signal);
    if (JSON.stringify(current.review) !== JSON.stringify(snapshot.review)) throw new Error("The change moved while it was read. Review it again.");
    return { request: snapshot.request, review: snapshot.review, diff, contract: snapshot.contract };
  }

  async publish(id: string, input: unknown): Promise<{ publication: PublicationEntry }> {
    if (currentCaller().kind !== "owner-here") throw new HttpError(403, "Publish a source draft from the owner's local window.");
    this.owner();
    const ask = PublishSourceDraftSchema.parse(input);
    if (this.publishing.has(id)) throw new Error("This request is already being published.");
    this.publishing.add(id);
    try {
      return await this.deps.audit("Publish reviewed Inbox source change", async (runId, signal) => {
        const snapshot = await this.snapshot(id, signal);
        if (JSON.stringify(snapshot.review) !== JSON.stringify(ask.review)) throw new Error("The reviewed change is stale. Review it again before publishing.");
        return inWorktree(snapshot.contract.worktreePath, () => this.send(id, snapshot, ask, runId, signal));
      });
    } finally { this.publishing.delete(id); }
  }

  private async send(id: string, snapshot: Awaited<ReturnType<SourceRequestDrafts["snapshot"]>>,
    ask: z.infer<typeof PublishSourceDraftSchema>, runId: string, signal: AbortSignal) {
    const { publication, source } = this.deps;
    const checked = await pushRefusal({ store: source.store, owner: source.owner, workspace: source.workspace,
      git: publication.git, folder: snapshot.cwd, runId, signal });
    this.owner();
    if (checked.refusal || checked.walked !== ask.review.head) throw new Error(checked.refusal ?? "The reviewed commit changed.");
    const files = await this.files(snapshot.cwd, ask.review.sourceSha, ask.review.head, signal);
    const allowed = await sendablePaths(publication, snapshot.cwd, files);
    this.owner();
    if (!files.length || files.length > 200 || allowed.length !== files.length)
      throw new Error("Some committed files cannot be published under the current file and privacy rules.");
    const saved = publication.registry.names().includes("github.open_pull_request");
    if (!saved && !publication.openWithComputerGh) throw new Error("Connect GitHub before publishing.");
    const opening: PublicationIntent["opening"] = { repo: ask.review.repository, title: ask.title, body: ask.summary,
      base: ask.review.base, head: snapshot.pushRepo.toLowerCase() === ask.review.repository.toLowerCase()
        ? ask.review.branch : `${snapshot.pushRepo.split("/")[0]}:${ask.review.branch}`, draft: true, changes: files.slice(0, 20) };
    const current = await this.snapshot(id, signal);
    if (JSON.stringify(current.review) !== JSON.stringify(ask.review)) throw new Error("The reviewed source changed. Review it again.");
    const entry = await queueSourcePublication(publication, { cwd: snapshot.cwd, workspace: source.workspace,
      remote: ask.review.remote, pushRepo: snapshot.pushRepo, pushAddress: snapshot.pushAddress, repository: ask.review.repository,
      branch: ask.review.branch, base: ask.review.base, sha: ask.review.head, walked: ask.review.head, files, opening,
      runId, adapter: saved ? "saved" : "computer", review: { requestId: id, revision: ask.review.revision,
        sourceSha: ask.review.sourceSha, tree: ask.review.tree } }, signal);
    this.owner();
    return { publication: entry };
  }
}

const route = /^\/api\/self-development\/requests\/([a-f0-9-]{36})\/(draft|publish)$/;
export const handlesSourceDraftPath = (path: string): boolean => route.test(path);
export async function sourceDraftApi(drafts: SourceRequestDrafts, method: string, path: string, readBody: () => Promise<unknown>): Promise<unknown> {
  const match = route.exec(path);
  if (!match) throw new HttpError(404, "Endpoint not found");
  if (match[2] === "draft" && method === "GET") return drafts.preview(match[1]!);
  if (match[2] === "publish" && method === "POST") return drafts.publish(match[1]!, await readBody());
  throw new HttpError(405, "Use GET for draft review or POST to publish it.");
}
