/**
 * The trusted repository pair for Branch Agent updates.
 *
 * During the transfer from stabrea/Branch-Agent to KeepOak/Branch-Agent,
 * both repos must be trusted for provenance because:
 * - After transfer, KeepOak serves releases built before the move with stabrea attestations.
 * - Existing installations updating before the move need to accept KeepOak attestations.
 *
 * The order matters: lookups try KeepOak first, fall back to stabrea on 404.
 * Trust is NOT dependent on which repo answered: both repos' workflow identities are accepted.
 */
export const TRUSTED_REPOS = ["KeepOak/Branch-Agent", "stabrea/Branch-Agent"] as const;
export type TrustedRepo = (typeof TRUSTED_REPOS)[number];

/** The primary repo for lookups (tried first, falls back to the other on 404). */
export const primaryRepo = TRUSTED_REPOS[0];

/** The fallback repo for lookups (tried when primary returns 404). */
export const fallbackRepo = TRUSTED_REPOS[1];

/** Whether a repo name is one of the trusted pair. Exact case-sensitive match. */
export function isTrustedRepo(repo: string): repo is TrustedRepo {
  return TRUSTED_REPOS.includes(repo as TrustedRepo);
}

/**
 * A repository name as Branch compares it for its own source: lower case, with the old stabrea/Branch-Agent read as
 * KeepOak/Branch-Agent, which GitHub redirects it to. Any other repository (a fork, say) is only lower-cased.
 */
/** The name to ask GitHub for: the old stabrea/Branch-Agent is asked for as KeepOak/Branch-Agent (Branch refuses redirects). */
export function officialRepo(repo: string): string {
  return canonicalRepo(repo) === primaryRepo.toLowerCase() ? primaryRepo : repo;
}

export function canonicalRepo(repo: string): string {
  const lower = repo.toLowerCase();
  return TRUSTED_REPOS.some((trusted) => trusted.toLowerCase() === lower) ? primaryRepo.toLowerCase() : lower;
}
