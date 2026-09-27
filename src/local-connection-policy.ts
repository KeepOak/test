import type { CatalogEntry } from "./provider-catalog.js";
import { type NetworkPolicy, onOwnNetwork } from "./network-policy.js";
import { assertLocalRuntimeAllowed, assertOwnerRules, localRuntimeFetch } from "./local-policy.js";

/**
 * A model server the owner points Branch at (Ollama, LM Studio, vLLM, llama.cpp, or any server that
 * speaks OpenAI's shape) usually listens on this computer or on another machine at home, which the
 * default network rules refuse, because a web page or a tool must never reach such an address. A
 * model connection is different: the owner typed or chose the address. Such a connection uses a
 * narrow allowance: exactly its own address (scheme, host and port), with every host and path rule
 * the owner wrote still applied, and redirects refused. Any other address, every web tool and every
 * agent go through the ordinary policy in full.
 *
 * The allowance is for an address written out as this computer (localhost, 127.0.0.1, [::1]) or as
 * an address on the owner's own network (10/8, 172.16/12, 192.168/16, fc00::/7), and only for a
 * catalog entry whose address is the owner's to set: a local program, or "Something else that
 * speaks OpenAI's shape". A name other than localhost is never let through, so no lookup can move
 * the connection somewhere else; link-local, shared and testing ranges get no allowance.
 */
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** True when the owner sets this entry's address: a local program, or a service by address. */
function ownerSetsAddress(entry: CatalogEntry): boolean {
  return entry.kind === "local" || (entry.extras ?? []).some((extra) => extra.key === "baseUrl");
}

export interface OwnModelOrigin {
  /** The one origin the connection may reach, e.g. `http://127.0.0.1:11434`. */
  origin: string;
  /** True on this computer, false on the owner's own network. */
  here: boolean;
}

/** The origin an owner-configured model connection talks to, when it is local or on the owner's network. */
export function ownModelOrigin(entry: CatalogEntry | undefined, baseUrl: string): OwnModelOrigin | null {
  if (!entry || !ownerSetsAddress(entry)) return null;
  const url = new URL(baseUrl);
  if (url.username || url.password) return null;
  if (loopbackHosts.has(url.hostname)) return { origin: url.origin, here: true };
  return onOwnNetwork(url.hostname) ? { origin: url.origin, here: false } : null;
}

export type ConnectionCheck = (target: URL, what?: string) => Promise<void>;

/** The owner's rules for one address on their own network, Lockdown included. */
function assertOwnNetworkAllowed(policy: NetworkPolicy, target: URL): void {
  policy.emergencyStop(target);
  assertOwnerRules(policy, target);
}

/** The policy check for one connection: the owner's rules, with only its own address let through. */
export function connectionCheck(policy: NetworkPolicy, entry: CatalogEntry | undefined, baseUrl: string): ConnectionCheck {
  const own = ownModelOrigin(entry, baseUrl);
  return async (target, what) => {
    if (own === null || target.origin !== own.origin) return policy.assertAllowed(target, what);
    if (own.here) return assertLocalRuntimeAllowed(policy, target);
    return assertOwnNetworkAllowed(policy, target);
  };
}

/** The fetch one catalog connection makes its calls through. */
export function connectionFetch(
  policy: NetworkPolicy, entry: CatalogEntry, baseUrl: string, base: typeof globalThis.fetch,
): typeof globalThis.fetch {
  const own = ownModelOrigin(entry, baseUrl);
  if (own === null) return policy.guard(base);
  if (own.here) return localRuntimeFetch(policy, base, own.origin);
  return async function ownNetwork(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== own.origin) throw new Error(`${url.host} is not the address of this model's program`);
    assertOwnNetworkAllowed(policy, url);
    return base(input, { ...init, redirect: "error" });
  } as typeof fetch;
}
