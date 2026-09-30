import type { WorkspaceFiles } from "../files.js";
import type { ToolRegistry } from "../registry.js";
import type { Store } from "../store.js";
import { DeviceBook, type DeviceMode } from "./book.js";
import { onLockdownChange } from "../lockdown.js"; // mac7/lockdown-fix
import { deviceTools } from "./capabilities.js";
import { DeviceHub, type HubOptions } from "./hub.js";
import { DeviceJoin, type JoinDeps } from "./join.js"; // phase2/shell
import { registerDeviceTools, type ComputerRule } from "./tools.js";
import { resetCompanionSwitches } from "./companion-grants.js";
import { hostname } from "node:os";
import { ComputerFinder, findNowhere, type FindParts } from "./find.js"; // find-computers
import { NodePresence } from "./presence.js";
import type { Hello } from "./hello.js";

/**
 * mac7/nodes: "Devices" — the owner's other computers and phones lending Branch a few abilities
 * each (see docs/configuration.md, "Devices"). `createBranch` makes one; the server hands it
 * `/api/devices` and the device socket. The whole feature ships off, and so does every capability
 * of every device.
 */
export interface DevicesDeps {
  store: Store; owner: string; registry: ToolRegistry; files: WorkspaceFiles; hub?: HubOptions;
  /** phase2/shell: where this computer keeps its key when it is lent to another Branch (src/devices/join.ts). */
  join?: Omit<JoinDeps, "store" | "owner" | "find">;
  /**
   * find-computers: the parts that reach the network to find the owner's other computers, and to be found. Only
   * `branch start` hands in the real ones (src/cli.ts); left out, nothing looks, listens or advertises anywhere.
   */
  find?: DeviceNetwork;
}
export interface DeviceNetwork extends FindParts {
  /** The name said in hello and advertised while waiting to be found; this computer's host name when left out. */
  name?: string;
  /**
   * Opens the node door on this computer's Tailscale address, only while looking or waiting to be found
   * (src/devices/presence.ts).
   */
  presence?: boolean;
  /** Where the node door binds for an address (tests map Tailscale addresses to loopback). */
  listenHost?: (address: string) => string;
  /** Where the door opens while waiting to be found; this computer's private local addresses when left out. */
  addresses?: () => string[];
}

export class Devices {
  readonly book: DeviceBook;
  readonly hub: DeviceHub;
  /** phase2/shell: this computer lent to another Branch; absent where no data folder was given. */
  readonly joining: DeviceJoin | null;
  constructor(private readonly deps: DevicesDeps) {
    this.book = new DeviceBook(deps.store, deps.owner);
    resetCompanionSwitches(deps.store, this.book);
    this.hub = new DeviceHub(this.book, deps.hub);
    const network = deps.find;
    // find-computers: the Tailscale door follows looking and waiting to be found, and is shut otherwise.
    const follow = (): void => { void this.presence?.sync(); };
    this.finder = new ComputerFinder(network ?? findNowhere, deps.store, deps.owner, follow);
    this.joining = deps.join ? new DeviceJoin({ store: deps.store, owner: deps.owner, ...deps.join, onFindChange: follow,
      ...(network ? { find: { hello: () => this.hello(), name: this.hello().name, port: network.port, openMdns: network.openMdns,
        ...(network.addresses ? { addresses: network.addresses } : {}) } } : {}),
      ...(network?.idleMs ? { findIdleMs: network.idleMs } : {}) }) : null;
    this.presence = network?.presence ? new NodePresence({ store: deps.store, owner: deps.owner, status: network.status,
      hello: () => this.hello(), offer: () => this.joining?.offerHandler() ?? null, port: network.port,
      wanted: () => this.finder.active || this.joining?.finding === true,
      ...(network.listenHost ? { listenHost: network.listenHost } : {}) }) : null;
    this.sync();
    // mac7/lockdown-fix (integration review): Lockdown closes every device's socket straight away.
    this.stopListening = onLockdownChange((store, owner, on) => {
      if (on && store === deps.store && owner === deps.owner) this.hub.disconnectAll("Lockdown is on.");
    });
  }
  private readonly stopListening: () => void;
  /** find-computers: "Found nearby" in Pair another computer. */
  readonly finder: ComputerFinder;
  /** find-computers: the node door on the Tailscale address while Branch runs; null unless `branch start` asked for it. */
  readonly presence: NodePresence | null;
  /** find-computers: what this computer says when asked who it is: its name, nothing more. */
  hello(): Hello {
    return { branch: "hello", name: (this.deps.find?.name ?? hostname()).slice(0, 80) || "Branch" };
  }
  /** P17-D §9: the computers each Trunk may use, set by createBranch once the Trunks exist. */
  computerRule: ComputerRule | null = null;
  ownerChatRun: ((runId: string) => boolean) | null = null;

  /** The tools are in the catalog exactly while the feature is not off. */
  private sync(): void {
    for (const name of deviceTools) this.deps.registry.unregister(name);
    if (this.book.savedMode() !== "off") // mac7/lockdown-fix: Lockdown is refused at use, not by unregistering
      registerDeviceTools(this.deps.registry, { store: this.deps.store, owner: this.deps.owner, book: this.book, hub: this.hub, files: this.deps.files,
        rule: () => this.computerRule, ownerChatRun: (id) => this.ownerChatRun?.(id) === true });
  }

  setMode(input: unknown): DeviceMode {
    const mode = this.book.setMode(input);
    this.sync();
    if (mode === "off") this.hub.disconnectAll();
    return mode;
  }

  /** Resolves once the Tailscale door is shut too, so nothing is left listening after a close. */
  close(): Promise<void> {
    resetCompanionSwitches(this.deps.store, this.book);
    this.stopListening(); this.hub.close(); this.joining?.close(); this.finder.close();
    return this.presence?.close() ?? Promise.resolve();
  }
}
