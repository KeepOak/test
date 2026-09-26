import { createHash, randomBytes } from "node:crypto";
import { lockdownActive, onLockdownChange } from "../lockdown.js";
import { readPeers, type TailscaleStatus } from "../remote/tailscale.js";
import type { Store } from "../store.js";
import { MdnsBrowser, type OpenMdnsSocket } from "./dns-sd.js";
import type { ProbeHello, SendOffer } from "./hello.js";

/**
 * find-computers: "Found nearby" in Pair another computer. While that dialog is open this computer looks:
 *
 *   on the owner's Tailscale network: `tailscale status --json` (the safe runner in src/remote/tailscale.ts) lists
 *     the online peers, and each is asked hello on the node port; only the ones that answer as Branch are listed;
 *   on the local network: a DNS-SD question for `_branch-node._tcp`, answered only by computers waiting to pair.
 *
 * It stops when the window says the dialog closed, when nobody has read the list for `idleMs`, and under Lockdown,
 * which also refuses starting. The list never leaves the owner (the routes are the owner's alone, src/devices/api.ts).
 * Finding grants nothing: picking a computer only hands it the current invitation's link (never the number), and
 * the normal pairing follows, with the six digits typed there, the check code and the owner's "Let it in".
 */
export interface FindParts {
  status: TailscaleStatus;
  probe: ProbeHello;
  send: SendOffer;
  openMdns: OpenMdnsSocket;
  /** The node port other Branch computers answer hello and offers on (src/devices/hello.ts). */
  port: number;
  now?: () => number;
}
export interface FoundComputer { id: string; name: string; platform: string | null; version: string | null; via: "tailnet" | "network" }
export interface FindView { looking: boolean; found: FoundComputer[]; tailnet: string | null; network: string | null }
interface Entry extends FoundComputer { address: string; port: number }

export const findLockdownWords = "Lockdown is on, so this computer does not look for other computers. Turn Lockdown off first.";
const idleMs = 30_000;
const refreshMs = 5_000;
const probeAtOnce = 6;

export class ComputerFinder {
  private looking = false;
  private browser: MdnsBrowser | null = null;
  private tailnet: Entry[] = [];
  private tailnetNote: string | null = null;
  private networkNote: string | null = null;
  private refreshedAt = 0;
  private refreshing: Promise<void> | null = null;
  private idle: NodeJS.Timeout | null = null;
  private readonly salt = randomBytes(16).toString("hex");
  private readonly stopListening: () => void;
  constructor(private readonly parts: FindParts, private readonly store: Store, private readonly owner: string) {
    this.stopListening = onLockdownChange((s, o, on) => { if (on && s === store && o === owner) this.stop(); });
  }
  private now(): number { return (this.parts.now ?? Date.now)(); }
  private id(via: string, address: string, port: number): string {
    return createHash("sha256").update(`${this.salt}|${via}|${address}|${port}`).digest("hex").slice(0, 16);
  }

  async start(): Promise<FindView> {
    if (lockdownActive(this.store, this.owner)) throw Object.assign(new Error(findLockdownWords), { status: 409 });
    if (!this.looking) {
      this.looking = true;
      this.refreshedAt = 0;
      const browser = new MdnsBrowser(this.parts.openMdns, this.parts.now ?? Date.now);
      this.browser = browser;
      await browser.start().catch((error: unknown) => {
        this.networkNote = error instanceof Error ? error.message : String(error);
        if (this.browser === browser) this.browser = null;
      });
    }
    return this.list();
  }

  stop(): FindView {
    this.looking = false;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    this.browser?.stop();
    this.browser = null;
    this.tailnet = [];
    this.tailnetNote = this.networkNote = null;
    return this.view();
  }

  /** The list as it stands; reading it keeps the looking going and refreshes the Tailscale part now and then. */
  async list(): Promise<FindView> {
    if (!this.looking) return this.view();
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), idleMs);
    this.idle.unref?.();
    if (this.now() - this.refreshedAt >= refreshMs) {
      this.refreshedAt = this.now();
      this.refreshing ??= this.refreshTailnet().finally(() => { this.refreshing = null; });
    }
    if (this.refreshing && this.tailnet.length === 0) await this.refreshing;
    return this.view();
  }

  private async refreshTailnet(): Promise<void> {
    const printed = await this.parts.status();
    if (!this.looking) return;
    let peers: ReturnType<typeof readPeers> = [];
    try { peers = printed ? readPeers(printed) : []; } catch { peers = []; } // an answer Branch cannot read lists nobody
    this.tailnetNote = printed ? null : "Tailscale is not installed or not signed in on this computer.";
    const found: Entry[] = [];
    for (let at = 0; at < peers.length; at += probeAtOnce) {
      const answers = await Promise.all(peers.slice(at, at + probeAtOnce).map((peer) => this.parts.probe(peer.address, this.parts.port)));
      answers.forEach((hello, i) => {
        const peer = peers[at + i]!;
        if (hello) found.push({ id: this.id("tailnet", peer.address, this.parts.port), name: hello.name, platform: hello.platform,
          version: hello.version, via: "tailnet", address: peer.address, port: this.parts.port });
      });
    }
    if (this.looking) this.tailnet = found;
  }

  private entries(): Entry[] {
    const tailnet = this.tailnet;
    const local = (this.browser?.found() ?? [])
      .filter((item) => !tailnet.some((peer) => peer.address === item.address))
      .map((item): Entry => ({ id: this.id("network", item.address, item.port), name: item.name, platform: null, version: null,
        via: "network", address: item.address, port: item.port }));
    return [...tailnet, ...local];
  }
  private view(): FindView {
    return { looking: this.looking, found: this.entries().map(({ address: _a, port: _p, ...shown }) => shown),
      tailnet: this.tailnetNote, network: this.networkNote };
  }

  /** Hands the found computer `id` the invitation's link and this computer's name. Never the number. */
  async offer(id: unknown, link: string, name: string): Promise<{ offered: true; name: string }> {
    if (lockdownActive(this.store, this.owner)) throw Object.assign(new Error(findLockdownWords), { status: 409 });
    const entry = typeof id === "string" ? this.entries().find((item) => item.id === id) : undefined;
    if (!entry) throw Object.assign(new Error("That computer is no longer in the list. Wait for it to show again."), { status: 404 });
    await this.parts.send(entry.address, entry.port, { link, name });
    return { offered: true, name: entry.name };
  }

  close(): void { this.stop(); this.stopListening(); }
}

/** Parts that look nowhere: a Branch made without `findComputers` (every test) lists nothing and sends nothing. */
export const findNowhere: FindParts = {
  status: async () => null,
  probe: async () => null,
  send: async () => { throw new Error("This Branch does not look for other computers."); },
  openMdns: async () => { throw new Error("This Branch does not look on the local network."); },
  port: 0,
};
