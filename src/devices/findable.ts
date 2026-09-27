import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { isTailnetAddress, type SameUser } from "../remote/tailscale.js";
import { MdnsAdvertiser, isPrivateAddress, type OpenMdnsSocket } from "./dns-sd.js";
import { NodeDoor, OfferSchema, type Hello } from "./hello.js";
import { parsePairLink } from "./node/client.js";

/**
 * find-computers: this computer waiting to be found by the owner's Branch on another computer, for a while.
 *
 * While it waits it opens the node door (src/devices/hello.ts) on the addresses it is given, one by one, and
 * advertises `_branch-node._tcp` on the local network with its display name and that port (src/devices/dns-sd.ts).
 * It stops, with a goodbye, when the number for an offer is typed, when it is stopped (Stop, Leave, Lockdown), or
 * after `findableMs`. Nothing is advertised at any other time.
 *
 * An offer is only ever a link to another Branch on this computer's own Tailscale network (or loopback), with that
 * computer's name. It is held, never acted on: the person here types the six-digit number shown over there, and
 * the normal pairing follows (the check code, and the owner's "Let it in" on the other computer). One offer is held
 * at a time, shown here with the offering computer's name and the address it came from; another is refused (never
 * swapped in) until this one is used, refused here, or the wait ends. On a Tailscale door only the same Tailscale
 * user's nodes are heard at all (src/devices/hello.ts).
 */
export const findableMs = 10 * 60_000;

export interface PendingOffer {
  /** Names this offer, so the number typed answers the one that was shown and no other. */
  id: string;
  link: string; hub: string; name: string; from: string; at: string;
}
export interface FindableDeps {
  hello: () => Hello;
  /** The display name advertised on the local network. */
  name: string;
  port: number;
  openMdns: OpenMdnsSocket;
  /** Whether an address asking on a Tailscale door is the same Tailscale user's (src/remote/tailscale.ts). */
  sameUser?: SameUser;
  /** Where the door opens while waiting; this computer's private local addresses when left out. */
  addresses?: () => string[];
  /** Where the door binds for an address (tests map a Tailscale address to loopback; it still answers as a Tailscale door). */
  listenHost?: (address: string) => string;
  timeoutMs?: number;
  /** Told when the wait ends by itself (the time ran out). */
  onEnd?: (why: "timeout") => void;
}

/** This computer's private local IPv4 addresses, Tailscale's left out (its door is opened apart). */
export function localAddresses(): string[] {
  return Object.values(networkInterfaces()).flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal && isPrivateAddress(entry.address) && !isTailnetAddress(entry.address))
    .map((entry) => entry!.address);
}

/** An offer's link must lead to Branch on this computer's Tailscale network or this computer, over plain http there. */
export function readOffer(body: unknown, from: string): PendingOffer {
  const { link, name } = OfferSchema.parse(body);
  const { hub } = parsePairLink(link);
  const host = new URL(hub).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const loopbackHost = host === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(host);
  // A loopback link names this very computer, so only a sender on this computer may offer one.
  const loopbackSender = /^(127\.\d+\.\d+\.\d+|::1)$/.test(from.replace(/^::ffff:/, ""));
  const privateLine = (loopbackHost && loopbackSender) || isTailnetAddress(host) || host.endsWith(".ts.net");
  if (new URL(hub).protocol !== "http:" || !privateLine)
    throw new Error("Only an invitation from Branch on your Tailscale network can be offered to this computer.");
  return { id: randomBytes(8).toString("hex"), link, hub, name, from, at: new Date().toISOString() };
}

export class Findable {
  private readonly door: NodeDoor;
  private advertiser: MdnsAdvertiser | null = null;
  private held: PendingOffer | null = null;
  private timer: NodeJS.Timeout | null = null;
  private until: number | null = null;
  /** Bumped by stop(), so a start still opening doors or the socket stops opening them and keeps nothing. */
  private run = 0;
  constructor(private readonly deps: FindableDeps) {
    this.door = new NodeDoor({ hello: deps.hello, offer: () => (this.waiting ? (body, from) => this.take(body, from) : null),
      ...(deps.sameUser ? { sameUser: deps.sameUser } : {}) });
  }

  get waiting(): boolean { return this.until !== null; }
  offer(): PendingOffer | null { return this.held; }
  endsAt(): string | null { return this.until ? new Date(this.until).toISOString() : null; }

  /** What the node door does with an offer while this computer waits (also reached through another door). */
  take(body: unknown, from: string): { held: true } {
    if (!this.waiting) throw new Error("This computer is not waiting to pair.");
    if (this.held) throw new Error("This computer already has an invitation waiting for its number.");
    this.held = readOffer(body, from);
    return { held: true };
  }

  /** Opens the door on each address and starts advertising; a door that cannot open is said, not hidden. */
  async start(): Promise<string[]> {
    await this.stop();
    const run = this.run;
    const ms = this.deps.timeoutMs ?? findableMs;
    this.until = Date.now() + ms;
    this.timer = setTimeout(() => { void this.stop().then(() => this.deps.onEnd?.("timeout")); }, ms);
    this.timer.unref?.();
    const problems: string[] = [];
    for (const address of (this.deps.addresses ?? localAddresses)()) {
      if (run !== this.run) return problems;
      try { await this.door.open(this.deps.listenHost?.(address) ?? address, this.deps.port, isTailnetAddress(address)); } catch (error) { problems.push(`${address}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (run !== this.run) return problems;
    // Held before it starts, so a stop while its socket opens reaches it and the socket closes unused.
    const advertiser = new MdnsAdvertiser(this.deps.openMdns, this.deps.name, this.deps.port);
    this.advertiser = advertiser;
    try {
      await advertiser.start();
    } catch (error) {
      if (this.advertiser === advertiser) this.advertiser = null;
      problems.push(`local network: ${error instanceof Error ? error.message : String(error)}`);
    }
    return problems;
  }

  /** The person here says no to the offer shown: it is dropped, and this computer keeps waiting for another. */
  refuse(id?: string): void {
    if (!this.held || (id !== undefined && id !== this.held.id)) throw new Error("That invitation is no longer the one shown here.");
    this.held = null;
  }

  /** Hands over the held offer `id` for its number and stops being found: no more advertising, the door closed. */
  async use(id?: string): Promise<PendingOffer> {
    const offer = this.held;
    if (!offer) throw new Error("No computer has offered an invitation yet. Pick this computer in Pair another computer over there first.");
    if (id !== undefined && id !== offer.id) throw new Error("That invitation is no longer the one shown here.");
    await this.stop();
    return offer;
  }

  async stop(): Promise<void> {
    this.run++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.until = null;
    this.held = null;
    this.advertiser?.stop();
    this.advertiser = null;
    await this.door.close();
  }
  get advertising(): boolean { return this.advertiser?.advertising === true; }
}
