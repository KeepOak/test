import type { Store } from "./store.js";
import type { PublicationEntry } from "./self-development-publication.js";
import { publicationReference } from "./self-development-publication-lookup.js";
import { workspacePath } from "./self-development-contract.js";
import { confirmedSourceMerge } from "./self-development-arrival.js";
import { ownBuild, ownBuildHistory } from "./hot-update/window-files.js";

export interface SourceRolloutReceipt {
  state: "unknown" | "merged" | "running";
  number: number | null; reviewedHead: string | null; mergeSha: string | null;
  mergeObservedAt: string | null; engineCommit: string | null; observedAt: string;
}
/** Local confirmed merge plus the active engine's stamped ancestry; no remote or health claims. */
export function sourcePublicationRollouts(store: Store, owner: string, publications: PublicationEntry[]):
  (PublicationEntry & { rollout: SourceRolloutReceipt })[] {
  // One engine observation for the whole readout; window assets never supply this identity.
  const engineCommit = ownBuild(), history = new Set(engineCommit ? [engineCommit, ...ownBuildHistory()] : []);
  const observedAt = new Date().toISOString();
  return publications.map((entry) => ({ ...entry, rollout: receiptFor(store, owner, entry, engineCommit, history, observedAt) }));
}
function receiptFor(store: Store, owner: string, publication: PublicationEntry, engineCommit: string | null,
  history: Set<string>, observedAt: string): SourceRolloutReceipt {
  const receipt: SourceRolloutReceipt = { state: "unknown", number: null, reviewedHead: null, mergeSha: null,
    mergeObservedAt: null, engineCommit, observedAt };
  if (publication.state !== "published") return receipt;
  const pr = publicationReference(publication.repository, publication.pullRequest);
  const worktree = workspacePath(publication.workspace, "", publication.cwd);
  if (!pr || !worktree) return receipt;
  receipt.number = pr.number;
  const merge = confirmedSourceMerge(store, owner, worktree, publication.repository, pr.number);
  if (!merge) return receipt;
  return { ...receipt, state: history.has(merge.mergeSha) ? "running" : "merged",
    reviewedHead: merge.reviewedHead, mergeSha: merge.mergeSha, mergeObservedAt: merge.at };
}
