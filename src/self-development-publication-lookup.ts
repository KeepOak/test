export interface PublicationLookup { repo: string; pushRepo: string; branch: string; base: string; sha: string }
export function publicationLookupPath(input: PublicationLookup): string {
  const query = new URLSearchParams({ state: "all", head: `${input.pushRepo.split("/")[0]}:${input.branch}`, base: input.base, per_page: "100" });
  return `repos/${input.repo}/pulls?${query}`;
}
/** Fail closed on mismatched or incomplete lookup results; a failed lookup never means no PR. */
export function matchingPublication(input: PublicationLookup, value: unknown): { number: number; address: string; state: string; headSha: string } | null {
  if (!Array.isArray(value) || value.length >= 100) throw new Error("Publication lookup was incomplete.");
  const candidates = value as { number?: unknown; html_url?: unknown; state?: unknown;
    head?: { sha?: string; ref?: string; repo?: { full_name?: string } }; base?: { ref?: string; repo?: { full_name?: string } } }[];
  const matching = candidates.filter((pr) => pr.head?.ref === input.branch && pr.base?.ref === input.base
    && pr.head?.repo?.full_name?.toLowerCase() === input.pushRepo.toLowerCase()
    && pr.base?.repo?.full_name?.toLowerCase() === input.repo.toLowerCase());
  if (matching.length > 1 || matching.some((pr) => pr.head?.sha !== input.sha))
    throw new Error("Publication rejected: the existing pull request has a different head or is ambiguous.");
  const pr = matching[0];
  if (!pr) {
    if (candidates.length) throw new Error("Publication lookup did not prove the pinned repository and head.");
    return null;
  }
  if (typeof pr.number !== "number" || typeof pr.html_url !== "string" || !pr.html_url.startsWith(`https://github.com/${input.repo}/pull/`))
    throw new Error("Publication lookup returned an invalid pull request.");
  return { number: pr.number, address: pr.html_url, state: String(pr.state ?? ""), headSha: input.sha };
}

/** Normalizes only the PR identity supplied by GitHub or the computer's gh opening receipt. */
export function publicationReference(repository: string, value: unknown): { number: number; address: string | null } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pr = value as { number?: unknown; address?: unknown; url?: unknown; html_url?: unknown };
  let number = pr.number, address: string | null = null;
  const link = pr.address ?? pr.url ?? pr.html_url;
  if (typeof link === "string") {
    try {
      const url = new URL(link), found = /^\/([^/]+\/[^/]+)\/pull\/(\d+)\/?$/.exec(url.pathname);
      if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password || url.port
        || !found || found[1]!.toLowerCase() !== repository.toLowerCase()) return null;
      const linked = Number(found[2]);
      if (number !== undefined && number !== linked) return null;
      number = linked; url.search = ""; url.hash = ""; address = url.href;
    } catch { return null; }
  }
  return Number.isSafeInteger(number) && Number(number) > 0 ? { number: Number(number), address } : null;
}
