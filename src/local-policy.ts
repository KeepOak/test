import type { NetworkPolicy } from "./network-policy.js";
import { pathRuleMatches } from "./network-policy.js";
import { assertOnThisComputer } from "./local-models.js";

/**
 * The owner's network rules for the models that run on this computer.
 *
 * The ordinary policy refuses every address on this computer unless "Allow private addresses" is
 * switched on, because a web page must never be able to reach a local service. A model runtime
 * the owner chose to use is different: it is the whole point of the feature. So a local-model call
 * goes through every rule the owner wrote (allowed and blocked hosts, allowed and blocked paths),
 * exactly as a web call does — blocking 127.0.0.1 or one path still stops it — and only the blanket
 * refusal of local addresses is skipped. Before any of that, the address must really be on this
 * computer; nothing else is ever reachable through here.
 */
const hostMatches = (host: string, pattern: string): boolean =>
  host === pattern.toLowerCase() || host.endsWith("." + pattern.toLowerCase());

export function assertLocalRuntimeAllowed(policy: Pick<NetworkPolicy, "settings"> | null, target: URL): void {
  assertOnThisComputer(target.origin);
  assertOwnerRules(policy, target);
}

/** Every host and path rule the owner wrote, without the blanket refusal of local addresses. */
export function assertOwnerRules(policy: Pick<NetworkPolicy, "settings"> | null, target: URL): void {
  if (!policy) return;
  const rules = policy.settings();
  const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const path = target.pathname || "/";
  if (rules.blockedHosts.some((rule) => hostMatches(host, rule))) throw new Error(`${host} is on the blocked list`);
  if (rules.allowedHosts && !rules.allowedHosts.some((rule) => hostMatches(host, rule)))
    throw new Error(`${host} is not on the allowed list, so the model on this computer cannot be reached`);
  if (rules.blockedPaths.some((rule) => pathRuleMatches(host, path, rule))) throw new Error(`${host}${path} is on the blocked list`);
  if (rules.allowedPaths && !rules.allowedPaths.some((rule) => pathRuleMatches(host, path, rule)))
    throw new Error(`${host}${path} is not on the allowed list`);
}

/**
 * A fetch for one local runtime: every call is checked first, and redirects are never followed.
 *
 * Integration review: the skipped local refusal is pinned to the one address the runtime answers
 * on (`expected`, e.g. `http://127.0.0.1:11434`, or a function when Branch picked the port), so
 * this fetch can never reach Branch itself, another local service or another port. A function
 * that answers null means the runtime is not running under Branch, and nothing is sent.
 */
export function localRuntimeFetch(
  policy: Pick<NetworkPolicy, "settings"> | null, base: typeof fetch, expected: string | (() => string | null),
): typeof fetch {
  return async function guardedLocal(input: string | URL | Request, init?: RequestInit) {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const origin = typeof expected === "function" ? expected() : expected;
    if (!origin) throw new Error("That model's program is not running under Branch. Set the model up again to start it.");
    if (url.origin !== new URL(origin).origin) throw new Error(`${url.host} is not the address of this model's program`);
    assertLocalRuntimeAllowed(policy, url);
    return base(input, { ...init, redirect: "error" });
  } as typeof fetch;
}

/**
 * A fetch for the model libraries on the internet (Hugging Face, Ollama's registry). These are
 * ordinary outside addresses, so the ordinary policy applies in full. Without a policy (a test, or
 * a caller that has none) nothing outside is reached at all.
 */
export function libraryFetch(policy: Pick<NetworkPolicy, "guard"> | null, base: typeof fetch = globalThis.fetch): typeof fetch {
  if (policy) return policy.guard(base);
  return (async () => { throw new Error("Branch has no network rules in this launch, so it will not reach the internet"); }) as typeof fetch;
}
