import type { Store } from "./store.js";

export function ensureSourceArrivals(store: Store): void {
  store.sqlite.exec(`CREATE TABLE IF NOT EXISTS self_development_arrivals(
    owner TEXT NOT NULL, worktree TEXT NOT NULL, sha TEXT NOT NULL, at TEXT NOT NULL,
    PRIMARY KEY(owner,worktree,sha));
    CREATE TRIGGER IF NOT EXISTS self_development_arrivals_no_update BEFORE UPDATE ON self_development_arrivals
    BEGIN SELECT RAISE(ABORT, 'Source merge receipts cannot be changed'); END;
    CREATE TRIGGER IF NOT EXISTS self_development_arrivals_no_delete BEFORE DELETE ON self_development_arrivals
    BEGIN SELECT RAISE(ABORT, 'Source merge receipts cannot be removed'); END;
    CREATE TABLE IF NOT EXISTS self_development_arrival_identities(
      owner TEXT NOT NULL, worktree TEXT NOT NULL, repository TEXT NOT NULL, number INTEGER NOT NULL,
      reviewed_head TEXT NOT NULL, merge_sha TEXT NOT NULL, at TEXT NOT NULL,
      PRIMARY KEY(owner,worktree,repository,number,reviewed_head,merge_sha));
    CREATE TRIGGER IF NOT EXISTS self_development_arrival_identities_no_update BEFORE UPDATE ON self_development_arrival_identities
    BEGIN SELECT RAISE(ABORT, 'Source merge identities cannot be changed'); END;
    CREATE TRIGGER IF NOT EXISTS self_development_arrival_identities_no_delete BEFORE DELETE ON self_development_arrival_identities
    BEGIN SELECT RAISE(ABORT, 'Source merge identities cannot be removed'); END;`);
}

export interface SourceMergeIdentity { repository: string; number: number; reviewedHead: string }
/** Called only after GitHub confirmed a protected, reviewed merge. */
export function recordSourceArrival(store: Store, owner: string, worktree: string, sha: string,
  identity?: SourceMergeIdentity): void {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("The merged change has no valid commit identity");
  if (identity && (!/^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(identity.repository)
    || !Number.isSafeInteger(identity.number) || identity.number <= 0 || !/^[0-9a-f]{40}$/.test(identity.reviewedHead)))
    throw new Error("The confirmed source merge has no exact PR identity");
  ensureSourceArrivals(store);
  const at = new Date().toISOString();
  store.sqlite.exec("SAVEPOINT source_arrival_identity");
  try {
    store.sqlite.prepare("INSERT OR IGNORE INTO self_development_arrivals VALUES(?,?,?,?)").run(owner, worktree, sha, at);
    if (identity) store.sqlite.prepare("INSERT OR IGNORE INTO self_development_arrival_identities VALUES(?,?,?,?,?,?,?)")
      .run(owner, worktree, identity.repository.toLowerCase(), identity.number, identity.reviewedHead, sha, at);
    store.sqlite.exec("RELEASE source_arrival_identity");
  } catch (error) {
    store.sqlite.exec("ROLLBACK TO source_arrival_identity; RELEASE source_arrival_identity");
    throw error;
  }
}

export function sourceArrived(store: Store, owner: string, worktree: string, approvedAt: string, running: string | null, ancestors: readonly string[] = []): boolean {
  if (!running) return false;
  ensureSourceArrivals(store);
  const history = new Set([running, ...ancestors.slice(0, 2000)]);
  return store.sqlite.prepare("SELECT sha FROM self_development_arrivals WHERE owner=? AND worktree=? AND at>=?")
    .all(owner, worktree, approvedAt).some(row => history.has(String(row.sha)));
}

/** Legacy worktree-only receipts cannot establish which PR or reviewed head arrived. */
export function confirmedSourceMerge(store: Store, owner: string, worktree: string, repository: string, number: number):
  { reviewedHead: string; mergeSha: string; at: string } | null {
  ensureSourceArrivals(store);
  const row = store.sqlite.prepare(`SELECT reviewed_head,merge_sha,at FROM self_development_arrival_identities
    WHERE owner=? AND worktree=? AND repository=? AND number=? ORDER BY at DESC LIMIT 1`)
    .get(owner, worktree, repository.toLowerCase(), number);
  return row ? { reviewedHead: String(row.reviewed_head), mergeSha: String(row.merge_sha), at: String(row.at) } : null;
}
