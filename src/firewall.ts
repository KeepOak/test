import type { NetworkPolicyConfig } from "./network-policy.js";

/**
 * What can reach outside this computer, said in sentences rather than in lists of rules. The rules
 * themselves are in `src/network-policy.ts` and have been enforced for a long time; what was
 * missing was anywhere for the owner to read them back. This is that place, and it is deliberately
 * only a reading of the rules: nothing here decides anything, so the card cannot say one thing
 * while the app does another.
 */
export interface FirewallView {
  /** One sentence per thing that could reach out, in the order they matter to the owner. */
  sentences: string[];
  /** The website names the browser may open at all, straight from the browser settings. */
  browserOrigins: string[];
  /** Whether anything at all is limited; false means "everything on the internet is reachable". */
  limited: boolean;
}

export interface FirewallInput {
  policy: NetworkPolicyConfig;
  /** The origins the browser is allowed to open, from the browser settings. */
  browserOrigins?: readonly string[];
  /** The browser may open any website the rules above allow, rather than a list. */
  browserAnyWebsite?: boolean;
  /** Whether running small scripts may reach the internet at all. */
  scriptsMayReachInternet?: boolean;
  /** Whether host commands are pointed at a dead address. */
  commandsMayReachInternet?: boolean;
}

const list = (values: readonly string[]): string =>
  values.length === 1 ? values[0]! : values.slice(0, -1).join(", ") + " and " + values.at(-1);

/** The card the owner reads: what may go out, and what may not. */
export function firewallView(input: FirewallInput): FirewallView {
  const { policy } = input;
  const sentences: string[] = [];
  if (policy.allowedHosts?.length)
    sentences.push(`Branch may only reach ${list(policy.allowedHosts)}, and nowhere else on the internet.`);
  else sentences.push("Branch may reach any website on the internet, except the ones you have blocked.");
  if (policy.blockedHosts.length)
    sentences.push(`Branch may never reach ${list(policy.blockedHosts)}.`);
  if (policy.allowedPaths?.length)
    sentences.push(`Only these parts of a site are reachable: ${list(policy.allowedPaths)}.`);
  if (policy.blockedPaths.length)
    sentences.push(`These parts of a site are never reachable: ${list(policy.blockedPaths)}.`);
  sentences.push(policy.allowPrivateAddresses
    ? "Branch may reach other computers on your home network, and this computer itself."
    : "Branch cannot reach other computers on your home network, or this computer itself.");
  if (policy.fakeIpProxy === true)
    sentences.push("Branch trusts a fake-IP proxy: a site whose name looks up to an address in 198.18.0.0/15 is let through, " +
      "and the proxy then does the resolving, so Branch cannot see where that site really is.");
  const origins = [...(input.browserOrigins ?? [])];
  sentences.push(input.browserAnyWebsite
    ? "The browser may open any website the rules above let Branch reach, and every picture, script and request a page makes is held to the same rules."
    : origins.length
      ? `The browser may visit ${list(origins)}. Any other address is refused before the page opens.`
      : "The browser has no websites set up, so it cannot open any.");
  sentences.push(input.scriptsMayReachInternet
    ? "Scripts can reach the internet."
    : "Scripts cannot reach the internet: they are pointed at an address that goes nowhere.");
  sentences.push(input.commandsMayReachInternet
    ? "Commands on this computer can reach the internet."
    : "Commands on this computer cannot reach the internet: they are pointed at an address that goes nowhere.");
  return { sentences, browserOrigins: origins,
    limited: !!(policy.allowedHosts?.length || policy.blockedHosts.length || policy.allowedPaths?.length
      || policy.blockedPaths.length || !policy.allowPrivateAddresses) };
}

export interface FirewallTest {
  address: string;
  allowed: boolean;
  /** Plain words: why it is allowed, or the exact reason it is not. */
  reason: string;
  /** Whether the browser would also open it, when it is a browser address. */
  browserWouldOpen: boolean;
}

/**
 * The test button. It asks the same check every real request asks — nothing is fetched, so
 * pressing it cannot reach the address it is asked about. A name that has to be looked up is
 * looked up, because that is part of the check: an address that resolves to this computer is
 * refused, and the owner should see that here rather than discover it later.
 */
export async function testFirewall(
  check: (target: URL) => Promise<void>, address: string, browserOrigins: readonly string[] = [], browserAnyWebsite = false,
): Promise<FirewallTest> {
  let url: URL;
  try { url = new URL(address); }
  catch { return { address, allowed: false, reason: "That is not a web address. They start with https://", browserWouldOpen: false }; }
  const browserWouldOpen = browserAnyWebsite || browserOrigins.includes(url.origin);
  try {
    await check(url);
    return { address: url.href, allowed: true,
      reason: browserWouldOpen || !browserOrigins.length
        ? "Branch can reach this."
        : `Branch can reach this, but the browser cannot open it: ${url.origin} is not on the browser's list.`,
      browserWouldOpen };
  } catch (error) {
    return { address: url.href, allowed: false,
      reason: error instanceof Error ? error.message : String(error), browserWouldOpen };
  }
}
