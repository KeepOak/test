/**
 * Soft leases on accounts, so helpers working side by side spread over a connection's accounts instead of all landing
 * on the one the conversation uses. Adapted from Hermes Agent (MIT, Copyright (c) 2025 Nous Research; see
 * THIRD_PARTY_NOTICES.md): agent/credential_pool.py `acquire_lease` / `release_lease` with
 * DEFAULT_MAX_CONCURRENT_PER_CREDENTIAL = 1, and tools/delegate_tool_child_run.py `_lease_child_credential`, which
 * leases one credential per child for as long as the child runs. Written again for Branch.
 *
 * A lease never blocks: when every account already holds its share of jobs, the least-leased one is still handed out.
 */
export const defaultJobsPerAccount = 1;

export class AccountLeases {
  private readonly held = new Map<string, number>();

  /** How many jobs hold this account now. */
  count(pool: string, account: string): number {
    return this.held.get(key(pool, account)) ?? 0;
  }

  /**
   * Picks from `ready` (already in the list's order, the conversation's own first): the first account with room for
   * another job (fewer than `perAccount`), so with the default of one each helper takes a free account, and a higher
   * figure keeps more helpers on the conversation's account (and its prompt cache) before the next is used. When none
   * has room, the least-leased of all, ties to the earlier one, as Hermes' acquire_lease does. Returns the pick and its
   * release.
   */
  acquire(pool: string, ready: readonly string[], perAccount = defaultJobsPerAccount): { account: string; release: () => void } | null {
    if (!ready.length) return null;
    const room = ready.find((account) => this.count(pool, account) < Math.max(1, perAccount));
    const account = room ?? ready.reduce((best, one) => (this.count(pool, one) < this.count(pool, best) ? one : best));
    return { account, release: this.hold(pool, account) };
  }

  /** Leases one named account; the release gives it back once, however often it is called. */
  hold(pool: string, account: string): () => void {
    const at = key(pool, account);
    this.held.set(at, (this.held.get(at) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.held.get(at) ?? 1) - 1;
      if (left > 0) this.held.set(at, left); else this.held.delete(at);
    };
  }
}

const key = (pool: string, account: string): string => `${pool}\u0000${account}`;
