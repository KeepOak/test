import { networkInterfaces } from "node:os";
import { isTailnetAddress } from "../remote/tailscale.js";
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
 * at a time; another is refused until this one is used or the wait ends.
 */
export const findableMs = 10 * 60_000;

export interface PendingOffer { link: string; hub: string; name: string; from: string; at: string }
export interface FindableDeps {
  hello: () => Hello;
  /** The display name advertised on the local network. */
  name: string;
  port: number;
  openMdns: OpenMdnsSocket;
  /** Where the door opens while waiting; this computer's private local addresses when left out. */
  addresses?: () => string[];
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
  const privateLine = host === "localhost" || /^127\.\d+\.\d+\.\d+$/.test(host) || isTailnetAddress(host) || host.endsWith(".ts.net");
  if (new URL(hub).protocol !== "http:" || !privateLine)
    throw new Error("Only an invitation from Branch on your Tailscale network can be offered to this computer.");
  return { link, hub, name, from, at: new Date().toISOString() };
}

export class Findable {
  private readonly door: NodeDoor;
  private advertiser: MdnsAdvertiser | null = null;
  private held: PendingOffer | null = null;
  private timer: NodeJS.Timeout | null = null;
  private until: number | null = null;
  constructor(private readonly deps: FindableDeps) {
    this.door = new NodeDoor({ hello: deps.hello, offer: () => (this.waiting ? (body, from) => this.take(body, from) : null) });
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
    const ms = this.deps.timeoutMs ?? findableMs;
    this.until = Date.now() + ms;
    this.timer = setTimeout(() => { void this.stop().then(() => this.deps.onEnd?.("timeout")); }, ms);
    this.timer.unref?.();
    const problems: string[] = [];
    for (const address of (this.deps.addresses ?? localAddresses)()) {
      try { await this.door.open(address, this.deps.port); } catch (error) { problems.push(`${address}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    const advertiser = new MdnsAdvertiser(this.deps.openMdns, this.deps.name, this.deps.port);
    try {
      await advertiser.start();
      this.advertiser = advertiser;
    } catch (error) { problems.push(`local network: ${error instanceof Error ? error.message : String(error)}`); }
    return problems;
  }

  /** Hands over the held offer for its number and stops being found: no more advertising, the door closed. */
  async use(): Promise<PendingOffer> {
    const offer = this.held;
    if (!offer) throw new Error("No computer has offered an invitation yet. Pick this computer in Pair another computer over there first.");
    await this.stop();
    return offer;
  }

  async stop(): Promise<void> {
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
