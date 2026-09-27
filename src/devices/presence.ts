import { lockdownActive, onLockdownChange } from "../lockdown.js";
import { makeSameUser, readStatus, type SameUser, type TailscaleStatus } from "../remote/tailscale.js";
import type { Store } from "../store.js";
import { NodeDoor, type Hello, type OfferHandler } from "./hello.js";

/**
 * find-computers: Branch answering "who are you?" on the owner's Tailscale network, so Pair another computer on the
 * owner's other computers can list it. Never on by default: the node door opens on this computer's Tailscale address
 * (never the local network, never every address) only while `wanted()` says so, which is while the owner is looking
 * (Pair another computer's network tab open here) or while this computer waits to be found. It closes when those stop,
 * by the same idle and stop rules, and under Lockdown; turning Lockdown off opens nothing by itself.
 *
 * It answers only this computer and nodes Tailscale lists as the same Tailscale user's (their UserID, from Tailscale's
 * own status), never a device someone else shared in, and says only the name. An offer that reaches it is passed on
 * only while this computer waits to pair.
 *
 * Only `branch start` and the desktop app hand in the real parts; a Branch made in a test answers nothing anywhere.
 */
export interface PresenceDeps {
  store: Store; owner: string;
  status: TailscaleStatus;
  hello: () => Hello;
  offer: () => OfferHandler | null;
  /** Whether the door should be open now: looking, or waiting to be found. */
  wanted: () => boolean;
  port: number;
  /** Where the door binds for a Tailscale address; the address itself unless a test maps it to loopback. */
  listenHost?: (address: string) => string;
  /** Whether an asking address is the same Tailscale user's; read from `status` when left out. */
  sameUser?: SameUser;
}
export interface PresenceView { open: boolean; address: string | null; message: string | null }

export class NodePresence {
  private readonly door: NodeDoor;
  private view: PresenceView = { open: false, address: null, message: null };
  private readonly stopListening: () => void;
  /** Every open and shut runs after the one before it, so the last word (wanted or not) is the one that holds. */
  private queue: Promise<void> = Promise.resolve();
  /** Bumped by every shut, so an open still asking Tailscale when a shut lands opens nothing. */
  private generation = 0;
  private closed = false;
  constructor(private readonly deps: PresenceDeps) {
    this.door = new NodeDoor({ hello: deps.hello, offer: deps.offer, sameUser: deps.sameUser ?? makeSameUser(deps.status) });
    this.stopListening = onLockdownChange((store, owner) => {
      if (store === deps.store && owner === deps.owner) void this.sync();
    });
  }

  status(): PresenceView { return { ...this.view }; }
  private want(): boolean { return !this.closed && this.deps.wanted() && !lockdownActive(this.deps.store, this.deps.owner); }

  /** Opens the door when it is wanted and closes it when it is not; the step runs after any still under way. */
  sync(): Promise<void> {
    if (!this.want()) this.generation++; // an open still asking Tailscale gives up at once
    const step = this.queue.then(() => (this.want() ? this.open() : this.shut(!this.closed && lockdownActive(this.deps.store, this.deps.owner) ? "Lockdown is on." : null)));
    this.queue = step.catch(() => undefined);
    return step;
  }

  private async open(): Promise<void> {
    if (this.door.listening) return;
    const generation = this.generation;
    const printed = await this.deps.status();
    if (generation !== this.generation || !this.want()) return;
    let address: string | null = null;
    try { address = printed ? readStatus(printed).address : null; } catch { address = null; } // not an answer Branch reads: nothing opens
    if (!address) { this.view = { open: false, address: null, message: "Tailscale is not signed in on this computer." }; return; }
    try {
      await this.door.open(this.deps.listenHost?.(address) ?? address, this.deps.port, true);
      if (generation !== this.generation) return; // shut while it opened: the door closed itself again
      this.view = { open: true, address, message: null };
      if (!this.want()) await this.shut(null); // looking stopped or Lockdown came on while it opened
    } catch (error) {
      this.view = { open: false, address, message: error instanceof Error ? error.message : String(error) };
    }
  }
  private async shut(message: string | null): Promise<void> {
    this.generation++;
    await this.door.close();
    this.view = { open: false, address: null, message };
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopListening();
    await this.sync();
  }
}
