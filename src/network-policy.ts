import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { z } from "zod";
import { pinTaken, pinnedFetch, pinnedTo, platformFetch, proxyCarries, type Pin, type PinnedInit } from "./pinned-fetch.js";

/**
 * One network policy for everything the assistant reaches over HTTP: web reading, the browser and
 * MCP servers. Host rules match a host or its subdomains; path rules are "host/prefix" entries so a
 * single API path can be allowed or blocked without opening the whole site. Private and local
 * addresses are refused unless the owner allows them.
 *
 * A fake-IP proxy (Clash, Mihomo, Surge's enhanced mode, Stash, sing-box's fakeip) answers every name
 * with an address in 198.18.0.0/15, the range kept for network testing, and does the real lookup
 * itself. `fakeIpProxy` lets such an answer through and nothing more: only an answer wholly in that
 * range counts, since the proxy answers from nothing else, and an address written out in it, this
 * computer, the home network and every other private range stay refused. It is left out
 * of the settings unless the owner writes it, so a file Branch never touched stays readable by an
 * older Branch.
 */
const hostRule = z.string().min(1).max(253);
const pathRule = z.string().min(3).max(500).regex(/^[^/\s]+\/.*$/, "Path rules look like host/prefix, for example api.github.com/repos/");
export const NetworkPolicySchema = z.object({
  allowPrivateAddresses: z.boolean().default(false),
  /** Lets a name whose looked-up answer is wholly in 198.18.0.0/15 through, for a fake-IP proxy. Off when left out. */
  fakeIpProxy: z.boolean().optional(),
  allowedHosts: z.array(hostRule).max(200).optional(),
  blockedHosts: z.array(hostRule).max(200).default([]),
  /** When present, only addresses matching one of these host/prefix rules are reachable. */
  allowedPaths: z.array(pathRule).max(200).optional(),
  blockedPaths: z.array(pathRule).max(200).default([]),
});
export type NetworkPolicyConfig = z.infer<typeof NetworkPolicySchema>;

/** IPv4 ranges that are this computer, a private or shared network, link-local, protocol assignments, benchmarking, multicast or reserved. */
const privateV4Ranges = new BlockList();
for (const [base, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3],
] as const) privateV4Ranges.addSubnet(base, bits, "ipv4");

/** IPv6 ranges that are private in their own right: unspecified, unique local, link-local, site-local, multicast, local NAT64. */
const privateV6Ranges = new BlockList();
for (const [base, bits] of [
  ["::", 128], ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8], ["64:ff9b:1::", 48],
] as const) privateV6Ranges.addSubnet(base, bits, "ipv6");

/** The sixteen bytes of an IPv6 address that `isIP` already accepted; a trailing dotted IPv4 is allowed. */
function v6Bytes(ip: string): number[] {
  let text = ip.replace(/%.*$/, "").toLowerCase();
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = text.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = text.split("::") as [string, string | undefined];
  const words = (part: string | undefined) => (part ? part.split(":").map((w) => parseInt(w, 16)) : []);
  const front = words(head), back = words(tail);
  const all = tail === undefined ? front : [...front, ...Array<number>(8 - front.length - back.length).fill(0), ...back];
  return all.flatMap((w) => [w >> 8, w & 0xff]);
}

const zero = (bytes: number[]) => bytes.every((b) => b === 0);
const v4At = (bytes: number[], at: number, mask = 0) => bytes.slice(at, at + 4).map((b) => b ^ mask).join(".");

/**
 * The IPv4 addresses an IPv6 address carries, each of which decides where it really goes:
 * mapped ::ffff:0:0/96, translated ::ffff:0:0:0/96, compatible ::/96, NAT64 64:ff9b::/96,
 * 6to4 2002::/16, and Teredo 2001::/32 (its server, and its client stored inverted).
 */
function embeddedV4(bytes: number[]): string[] {
  const head = bytes.slice(0, 12), word = (i: number) => (bytes[i]! << 8) | bytes[i + 1]!;
  if (zero(head.slice(0, 10)) && word(10) === 0xffff) return [v4At(bytes, 12)];
  if (zero(head.slice(0, 8)) && word(8) === 0xffff && word(10) === 0) return [v4At(bytes, 12)];
  if (zero(head)) return [v4At(bytes, 12)];
  if (word(0) === 0x64 && word(2) === 0xff9b && zero(head.slice(4))) return [v4At(bytes, 12)];
  if (word(0) === 0x2002) return [v4At(bytes, 2)];
  if (word(0) === 0x2001 && word(2) === 0) return [v4At(bytes, 4), v4At(bytes, 12, 0xff)];
  return [];
}

function privateV6(ip: string): boolean {
  if (privateV6Ranges.check(ip.replace(/%.*$/, ""), "ipv6")) return true;
  return embeddedV4(v6Bytes(ip)).some((v4) => privateV4Ranges.check(v4, "ipv4"));
}
/** Anything that is not a plain IPv4 or IPv6 address (octal, hex, a single number) is refused too. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  return kind === 4 ? privateV4Ranges.check(ip, "ipv4") : kind === 6 ? privateV6(ip) : true;
}

/**
 * QA Q003: an address written out on the owner's own network (10/8, 172.16/12, 192.168/16, fc00::/7), never a name,
 * a link-local, shared or testing range, or an IPv4-mapped form. Only a model server the owner configures is ever let
 * through on this (src/local-connection-policy.ts); the policy below refuses these addresses to every tool and agent.
 */
const ownNetworkRanges = new BlockList();
ownNetworkRanges.addSubnet("10.0.0.0", 8, "ipv4");
ownNetworkRanges.addSubnet("172.16.0.0", 12, "ipv4");
ownNetworkRanges.addSubnet("192.168.0.0", 16, "ipv4");
ownNetworkRanges.addSubnet("fc00::", 7, "ipv6");
/** fd00:ec2::/32: where a cloud computer is told its own details and keys over IPv6. Never a model server at home. */
const cloudDetailsV6 = new BlockList();
cloudDetailsV6.addSubnet("fd00:ec2::", 32, "ipv6");
export function onOwnNetwork(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const kind = isIP(host);
  if (kind === 4) return ownNetworkRanges.check(host, "ipv4");
  return kind === 6 && !host.startsWith("::ffff:") && ownNetworkRanges.check(host, "ipv6") && !cloudDetailsV6.check(host, "ipv6");
}

/** 198.18.0.0/15, where a fake-IP proxy's answers live. Only a plain IPv4 answer counts. */
const fakeIpRange = new BlockList();
fakeIpRange.addSubnet("198.18.0.0", 15, "ipv4");
export const fakeIpRangeText = "198.18.0.0/15";
export const isFakeIpAddress = (ip: string): boolean => isIP(ip) === 4 && fakeIpRange.check(ip, "ipv4");

/**
 * The addresses a name server gave back for one name that may not be reached. A fake-IP proxy answers
 * only from its own pool, so with `fakeIpProxy` on the answer is let through only when every address
 * in it is a plain IPv4 one in 198.18.0.0/15. An answer that mixes the range with anything else is not
 * the proxy's, and each of its addresses is judged exactly as `isPrivateAddress` judges it, the range
 * included. Never call this for an address that was written out: that one is judged by
 * `isPrivateAddress` alone.
 */
export function refusedAnswers(addresses: readonly string[], fakeIpProxy: boolean): string[] {
  if (fakeIpProxy && addresses.length > 0 && addresses.every(isFakeIpAddress)) return [];
  return addresses.filter(isPrivateAddress);
}
const hostMatches = (host: string, pattern: string) => host === pattern.toLowerCase() || host.endsWith("." + pattern.toLowerCase());
/** "host/prefix" matches when the host rule matches and the path starts with the prefix. */
export function pathRuleMatches(host: string, pathname: string, rule: string): boolean {
  const slash = rule.indexOf("/");
  const ruleHost = rule.slice(0, slash).replace(/^\*\./, ""), prefix = rule.slice(slash);
  return hostMatches(host, ruleHost) && pathname.startsWith(prefix);
}

/**
 * A live connection is checked as the ordinary web address it stands for: `wss://` is `https://`
 * and `ws://` is `http://`, same host, same path, same query. Nothing about the allowed list, the
 * blocked list, the refusal of addresses carrying a password or the refusal of private addresses is
 * written twice, so a rule the owner set for the web holds for a socket by construction.
 */
export function httpTwin(target: URL): URL {
  const twin = new URL(target.href);
  twin.protocol = target.protocol === "wss:" ? "https:" : "http:";
  return twin;
}

/**
 * What is written down about one live connection. Only the host and the path are kept: a key can
 * travel in the query string — Gemini asks for it there — so the whole address never is.
 */
export interface SocketRecord {
  host: string;
  pathname: string;
  /** Plain words for the record: "a live voice conversation". */
  what: string;
  runId: string | null;
}
export type SocketOutcome = "opened" | "refused" | "closed";
/** Told about every live connection, so the app can write a span and a line in the record. */
export type SocketWatcher = (record: SocketRecord, outcome: SocketOutcome, reason: string) => void;

export interface ConnectOptions {
  /** Sent on the opening request; never written down anywhere. */
  headers?: Record<string, string>;
  what?: string;
  runId?: string | null;
  /** Asked once the address is allowed, just before dialling: false means the caller has ended or locked since. */
  proceed?: () => boolean;
}

/**
 * Node's own WebSocket takes request headers, which the browser's cannot; the browser type
 * definition Branch is compiled against does not say so, so it is named once here rather than
 * cast at the call site. Checked against a local server before it was relied on.
 */
const NodeWebSocket = WebSocket as unknown as new (
  url: URL | string,
  init: { headers: Record<string, string> },
) => WebSocket;

export class NetworkPolicy {
  private config: NetworkPolicyConfig;
  /** How many live connections may be open at once, so nothing can quietly open hundreds. */
  maxSockets = 8;
  /** Replaced by the app so every connection leaves a span and a line in the record. */
  watchSockets: SocketWatcher = () => undefined;
  private readonly sockets = new Set<{ socket: WebSocket; runId: string | null }>();
  constructor(
    input: unknown = {},
    private readonly resolve: (host: string) => Promise<string[]> = defaultResolve,
    /** Where a judged address is really dialled. Only tests change it, so a local server can stand in for a site. */
    private readonly dial: (address: string) => string = (address) => address,
  ) {
    this.config = NetworkPolicySchema.parse(input);
  }
  configure(input: unknown): NetworkPolicyConfig { this.lookups.clear(); return (this.config = NetworkPolicySchema.parse(input)); }
  /**
   * The browser checks every request a page makes, pictures and scripts included, so one page can ask about the same
   * site dozens of times at once. Those checks share one lookup per site for a few seconds (`lookupTtlMs`); a lookup
   * still in flight is shared too. Only the browser's checks use it, and each of them connects to exactly the addresses
   * it judged (src/integrations/browser-pin-proxy.ts), so a cached answer can never send a page somewhere unjudged.
   * The host and path rules are read afresh on every check; only the looked-up addresses are kept.
   */
  private readonly lookups = new Map<string, { until: number; answer: Promise<string[]> }>();
  static readonly lookupTtlMs = 15_000;
  static readonly lookupsKept = 256;
  private cachedResolve(host: string): Promise<string[]> {
    const now = Date.now(), had = this.lookups.get(host);
    if (had && had.until > now) return had.answer;
    const answer = this.resolve(host).catch((): string[] => []);
    const entry = { until: now + NetworkPolicy.lookupTtlMs, answer };
    this.lookups.delete(host);
    this.lookups.set(host, entry);
    while (this.lookups.size > NetworkPolicy.lookupsKept) this.lookups.delete(this.lookups.keys().next().value!);
    // A name that could not be found is asked again next time rather than kept.
    void answer.then((found) => { if (!found.length && this.lookups.get(host) === entry) this.lookups.delete(host); });
    return answer;
  }
  /**
   * The browser's check (src/integrations/browser.ts, any-website mode): the same judgement as `assertAllowed`, with the
   * site's lookup shared for a few seconds, returning the addresses judged so the connection can be held to them, or
   * null when it is reached as written (an address written out, or private addresses allowed). `scope: "host"` leaves
   * out the path rules, for a tunnel that only ever says which site and port it goes to; the page's own request was
   * already held to them.
   */
  async allowedAddresses(target: URL, what = "address", scope: "address" | "host" = "address"): Promise<string[] | null> {
    return this.judge(target, what, { cached: true, hostOnly: scope === "host" });
  }
  /** Where a judged address is really dialled; only tests change it. */
  dialAddress(address: string): string { return this.dial(address); }
  settings(): NetworkPolicyConfig { return this.config; }
  /** mac7/r17-g: the emergency stop's own check, set by the app; it can only refuse. */
  emergencyStop: (target: URL) => void = () => undefined;
  /** Throws a plain reason when an address may not be reached; call it for every hop of every request. */
  async assertAllowed(target: URL, what = "address"): Promise<void> {
    await this.judge(target, what);
  }
  /**
   * The check itself. For a site's name it also returns the addresses the one lookup gave back, each
   * of which it judged, so the connection can be held to exactly those. It returns null when there is
   * nothing to hold a connection to: an address written out is reached as written, and with private
   * addresses allowed no answer a name gives is refused while the host and path rules go by the name.
   */
  private async judge(target: URL, what: string, options: { cached?: boolean; hostOnly?: boolean } = {}): Promise<string[] | null> {
    this.emergencyStop(target); // mac7/r17-g
    if (!["http:", "https:"].includes(target.protocol)) throw new Error(`Only http and https ${what}es can be reached`);
    if (target.username || target.password) throw new Error("Addresses with embedded credentials are refused");
    const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase(), pathname = target.pathname || "/";
    if (this.config.blockedHosts.some((p) => hostMatches(host, p))) throw new Error(`${host} is on the blocked list`);
    if (this.config.allowedHosts && !this.config.allowedHosts.some((p) => hostMatches(host, p))) throw new Error(`${host} is not on the allowed list`);
    if (!options.hostOnly && this.config.blockedPaths.some((rule) => pathRuleMatches(host, pathname, rule))) throw new Error(`${host}${pathname} is on the blocked list`);
    if (!options.hostOnly && this.config.allowedPaths && !this.config.allowedPaths.some((rule) => pathRuleMatches(host, pathname, rule))) throw new Error(`${host}${pathname} is not on the allowed list`);
    if (this.config.allowPrivateAddresses) return null;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))
      throw new Error(`${host} points at this computer or a private network, which the assistant may not reach`);
    const literal = isIP(host) !== 0;
    const addresses = literal ? [host] : await (options.cached ? this.cachedResolve(host) : this.resolve(host));
    if (!addresses.length) throw new Error(`${host} could not be resolved`);
    const refused = literal ? addresses.filter(isPrivateAddress) : refusedAnswers(addresses, this.config.fakeIpProxy === true);
    if (refused.length) throw new Error(refusedReason(host, addresses, refused, literal));
    return literal ? null : addresses;
  }
  /**
   * A fetch that checks the policy on every call, for clients (MCP, browser) that make their own
   * requests. A site's name is looked up once, by the check, and the request connects only to the
   * addresses the check judged, keeping the site's name for the secure handshake, its certificate
   * check and the Host line (src/pinned-fetch.ts). A request a proxy carries (the owner's, or one Node
   * was started with) goes to the proxy by name after the same check, since the proxy does its own
   * lookup. A redirect is never followed by itself: the caller asks again, and the new address is
   * checked and held the same way. A checked request whose fetch does not hand its addresses on to
   * the sender that holds it to them is refused, whatever that fetch did: an answer it gave is let
   * go, and a failure of its own is kept as the refusal's cause.
   */
  guard(base: typeof fetch): typeof fetch {
    const policy = this;
    return async function guarded(input: string | URL | Request, init?: RequestInit) {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (init?.redirect === "follow")
        throw new Error("A checked request does not follow a redirect by itself: each new address is checked first, so follow it by asking again");
      const judged = await policy.judge(url, "address");
      const next: RequestInit = { ...init, redirect: init?.redirect ?? "error" };
      if (!judged || proxyCarries(url)) return base(input, next);
      const pin: Pin = { host: url.hostname, addresses: judged, dial: policy.dial };
      const held: PinnedInit = { ...next, [pinnedTo]: pin };
      let answer: Response;
      try {
        answer = await (base === platformFetch ? pinnedFetch : base)(input, held);
      } catch (error) {
        if (pinTaken(pin)) throw error;
        throw new Error(unkeptReason(url), { cause: error });
      }
      if (pinTaken(pin)) return answer;
      letGo(answer);
      throw new Error(unkeptReason(url));
    } as typeof fetch;
  }
  /**
   * Opens a connection that stays open, under the same rules as every other address. The check
   * happens first and it waits for an answer, so a refused address never has a single byte sent to
   * it. What comes back is Node's own WebSocket, already counted and closed by the app's own Lock,
   * end of task and shutdown.
   */
  async connect(target: string | URL, options: ConnectOptions = {}): Promise<WebSocket> {
    const url = new URL(typeof target === "string" ? target : target.href);
    const record: SocketRecord = {
      host: url.hostname.replace(/^\[|\]$/g, "").toLowerCase(), pathname: url.pathname || "/",
      what: options.what ?? "a live connection", runId: options.runId ?? null,
    };
    try {
      if (!["ws:", "wss:"].includes(url.protocol)) throw new Error("Only ws and wss addresses can be connected to");
      await this.assertAllowed(httpTwin(url));
      if (this.sockets.size >= this.maxSockets)
        throw new Error(`Branch already has ${this.maxSockets} live connections open, which is as many as it will hold at once`);
      if (options.proceed && !options.proceed()) throw new Error("The connection was stopped before it opened");
    } catch (e) {
      this.watchSockets(record, "refused", e instanceof Error ? e.message : String(e));
      throw e;
    }
    const socket = new NodeWebSocket(url, { headers: options.headers ?? {} });
    socket.binaryType = "arraybuffer";
    const entry = { socket, runId: record.runId };
    this.sockets.add(entry);
    socket.addEventListener("close", () => {
      this.sockets.delete(entry);
      this.watchSockets(record, "closed", "");
    });
    this.watchSockets(record, "opened", "");
    return socket;
  }
  /** How many live connections are open right now. */
  openSockets(): number { return this.sockets.size; }
  /**
   * Closes live connections: all of them when Branch locks or closes, or just one task's when that
   * task ends. Returns how many were closed, for the record.
   */
  closeSockets(filter: { runId?: string } = {}): number {
    let closed = 0;
    for (const entry of [...this.sockets]) {
      if (filter.runId !== undefined && entry.runId !== filter.runId) continue;
      this.sockets.delete(entry);
      closed += 1;
      try { entry.socket.close(1000, "Branch closed this connection"); } catch { /* already gone */ }
    }
    return closed;
  }
}
/**
 * Why an address is refused. 198.18.0.0/15 is named when every refused address is in it, and the
 * fake-IP proxy setting only when every address the name gave back is: that is the one case the
 * setting would change. A refused address outside the range is named instead.
 */
function refusedReason(host: string, addresses: readonly string[], refused: readonly string[], literal: boolean): string {
  const other = refused.find((address) => !isFakeIpAddress(address));
  if (other !== undefined)
    return literal ? `${host} is a private or local address, which the assistant may not reach`
      : `${host} resolves to ${other}, a private or local address, which the assistant may not reach`;
  const address = refused[0]!;
  if (literal)
    return `${host} is a private or local address in ${fakeIpRangeText}, the range kept for network testing. ` +
      "The assistant may not reach an address written out in that range; only a site's name can lead there, through a fake-IP proxy.";
  if (!addresses.every(isFakeIpAddress))
    return `${host} resolves to ${address}, a private or local address in ${fakeIpRangeText}, alongside addresses outside it. ` +
      "A fake-IP proxy answers only from that range, so this answer is not one of its and the assistant may not reach it.";
  return `${host} resolves to ${address}, a private or local address in ${fakeIpRangeText}, the range kept for network testing. ` +
    "A fake-IP proxy (such as Clash, Mihomo, Surge, Stash or sing-box) answers every name with an address there. " +
    'If you use one, switch on the fake-IP proxy setting ("fakeIpProxy": true in the web section of the launch settings file); the proxy then does the resolving.';
}
/**
 * Why a checked request is refused when its fetch did not keep to the addresses its check judged.
 * Only the site is named, never the path or the query, where a key can travel.
 */
function unkeptReason(url: URL): string {
  return `A checked request to ${url.host} is refused: its fetch did not keep to the checked addresses`;
}
/** Lets go of a refused answer's body, so nothing is left holding its connection open. */
function letGo(answer: Response | undefined): void {
  try { void answer?.body?.cancel().catch(() => undefined); } catch { /* an answer with nothing to let go of */ }
}
async function defaultResolve(host: string): Promise<string[]> {
  return (await lookup(host, { all: true }).catch(() => [])).map((entry) => entry.address);
}
