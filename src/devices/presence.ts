import { lockdownActive, onLockdownChange } from "../lockdown.js";
import { readStatus, type TailscaleStatus } from "../remote/tailscale.js";
import type { Store } from "../store.js";
import { NodeDoor, type Hello, type OfferHandler } from "./hello.js";

/**
 * find-computers: Branch answering "who are you?" on the owner's Tailscale network, so Pair another computer on the
 * owner's other computers can list it. While Branch runs and Tailscale is signed in, the node door opens on this
 * computer's Tailscale address only (never the local network, never every address) and says the name, the system
 * and the version, nothing more. An offer that reaches it is passed on only while this computer waits to pair.
 * Lockdown closes it, and turning Lockdown off opens it again.
 *
 * Only `branch start` switches this on (src/cli.ts); a Branch made in a test answers nothing on any network.
 */
export interface PresenceDeps {
  store: Store; owner: string;
  status: TailscaleStatus;
  hello: () => Hello;
  offer: () => OfferHandler | null;
  port: number;
  /** Where the door binds for a Tailscale address; the address itself unless a test maps it to loopback. */
  listenHost?: (address: string) => string;
}
export interface PresenceView { open: boolean; address: string | null; message: string | null }

export class NodePresence {
  private readonly door: NodeDoor;
  private view: PresenceView = { open: false, address: null, message: null };
  private readonly stopListening: () => void;
  private busy: Promise<void> | null = null;
  constructor(private readonly deps: PresenceDeps) {
    this.door = new NodeDoor({ hello: deps.hello, offer: deps.offer });
    this.stopListening = onLockdownChange((store, owner, on) => {
      if (store !== deps.store || owner !== deps.owner) return;
      if (on) void this.shut("Lockdown is on.");
      else void this.start();
    });
  }

  status(): PresenceView { return { ...this.view }; }

  /** Asks Tailscale for this computer's address and opens the door there; nothing opens without one. */
  start(): Promise<void> {
    this.busy ??= this.open().finally(() => { this.busy = null; });
    return this.busy;
  }
  private async open(): Promise<void> {
    if (this.door.listening || lockdownActive(this.deps.store, this.deps.owner)) return;
    const printed = await this.deps.status();
    let address: string | null = null;
    try { address = printed ? readStatus(printed).address : null; } catch { address = null; } // not an answer Branch reads: nothing opens
    if (!address) { this.view = { open: false, address: null, message: "Tailscale is not signed in on this computer." }; return; }
    if (lockdownActive(this.deps.store, this.deps.owner)) return;
    try {
      await this.door.open(this.deps.listenHost?.(address) ?? address, this.deps.port);
      this.view = { open: true, address, message: null };
      // Lockdown switched on while the door was opening: it closes again at once.
      if (lockdownActive(this.deps.store, this.deps.owner)) await this.shut("Lockdown is on.");
    } catch (error) {
      this.view = { open: false, address, message: error instanceof Error ? error.message : String(error) };
    }
  }
  private async shut(message: string | null): Promise<void> {
    await this.door.close();
    this.view = { open: false, address: null, message };
  }

  async close(): Promise<void> { this.stopListening(); await this.shut(null); }
}
