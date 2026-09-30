import type { Store } from "./store.js";

export function ensureSourceArrivals(store: Store): void {
  store.sqlite.exec(`CREATE TABLE IF NOT EXISTS self_development_arrivals(
    owner TEXT NOT NULL, worktree TEXT NOT NULL, sha TEXT NOT NULL, at TEXT NOT NULL,
    PRIMARY KEY(owner,worktree,sha));
    CREATE TRIGGER IF NOT EXISTS self_development_arrivals_no_update BEFORE UPDATE ON self_development_arrivals
    BEGIN SELECT RAISE(ABORT, 'Source merge receipts cannot be changed'); END;
    CREATE TRIGGER IF NOT EXISTS self_development_arrivals_no_delete BEFORE DELETE ON self_development_arrivals
    BEGIN SELECT RAISE(ABORT, 'Source merge receipts cannot be removed'); END;`);
}

/** Called only after GitHub confirmed a protected, reviewed merge. */
export function recordSourceArrival(store: Store, owner: string, worktree: string, sha: string): void {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("The merged change has no valid commit identity");
  ensureSourceArrivals(store);
  store.sqlite.prepare("INSERT OR IGNORE INTO self_development_arrivals VALUES(?,?,?,?)")
    .run(owner, worktree, sha, new Date().toISOString());
}

export function sourceArrived(store: Store, owner: string, worktree: string, approvedAt: string, running: string | null, ancestors: readonly string[] = []): boolean {
  if (!running) return false;
  ensureSourceArrivals(store);
  const history = new Set([running, ...ancestors.slice(0, 2000)]);
  return store.sqlite.prepare("SELECT sha FROM self_development_arrivals WHERE owner=? AND worktree=? AND at>=?")
    .all(owner, worktree, approvedAt).some(row => history.has(String(row.sha)));
}
