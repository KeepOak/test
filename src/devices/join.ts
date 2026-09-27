import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { lockdownActive, onLockdownChange } from "../lockdown.js";
import type { Store } from "../store.js";
import { NodeActions } from "./node/actions.js";
import { loadIdentity, NodeClient, pairNode, pairingStopped, parsePairLink, type NodeIdentity } from "./node/client.js";
import { keyCheck } from "./protocol.js";
import type { NodeOs } from "./node/commands.js";
import { dialNode, type DialNode } from "./node/socket.js";
import { Findable, type FindableDeps, type PendingOffer } from "./findable.js"; // find-computers
import type { OfferHandler } from "./hello.js";

/**
 * phase2/shell (critique #34): lending this computer to your Branch on another computer, from the
 * window, without a terminal. It is `branch node pair` and `branch node run` (src/devices/node/)
 * run inside Branch itself: this computer answers the invitation, waits for the owner's yes over
 * there, then dials out and stays connected while Branch runs. Nothing here listens.
 *
 * Ships off: nothing is lent until the owner joins from the window. Everything this computer could
 * do starts switched off on the other side, as with any device. Its key lives in the data folder
 * (`<data>/node/identity.json`), apart from the one `branch node` keeps. Lockdown here refuses a new
 * join and closes the connection; leaving forgets the key.
 */
export type JoinState = "off" | "finding" | "waiting" | "joined" | "refused" | "failed";
export interface JoinStatus {
  state: JoinState; hub: string | null; name: string | null; connected: boolean; message: string | null;
  /** While waiting: the check code the other computer shows beside the request (src/devices/protocol.ts keyCheck). */
  check: string | null;
  /**
   * find-computers: while finding, the invitation another computer offered, never a number: its id (the number typed
   * answers this one and no other), the offering computer's name as it gave it, the address the offer came from and
   * the Branch its link leads to. The person here may refuse it before typing anything.
   */
  offer?: { id: string; hub: string; name: string; from: string } | null;
  /** find-computers: while finding, when the wait ends by itself. */
  findingUntil?: string | null;
}
const idle: JoinStatus = { state: "off", hub: null, name: null, connected: false, message: null, check: null };

export interface JoinDeps {
  store: Store;
  owner: string;
  /** Where this computer's key and pairing are kept. */
  nodeDir: string;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  actions?: NodeActions;
  dial?: DialNode;
  /** How often the other computer is asked whether the owner said yes (tests shorten it). */
  pairIntervalMs?: number;
  /** find-computers: what waiting to be found needs (the node door and the local network); absent, it is refused. */
  find?: Omit<FindableDeps, "onEnd">;
  /** find-computers: how long waiting to be found lasts after the last read of where it stands (tests shorten it). */
  findIdleMs?: number;
  /** find-computers: told whenever waiting to be found starts or ends (the Tailscale door follows it). */
  onFindChange?: () => void;
}
/** find-computers: a window that stops reading (closed, crashed) stops the wait this long after its last read. */
export const findIdleMs = 30_000;
const notPicked = "Nobody picked this computer in time. Start again to be found.";

/** find-computers: without a link, the number answers the invitation `offer` another computer offered while finding. */
export const JoinSchema = z.object({
  link: z.string().trim().min(10).max(400).optional(),
  offer: z.string().regex(/^[a-f0-9]{16}$/).optional(),
  code: z.string().trim().regex(/^\d{3}\s?\d{3}$/, "The number is six digits"),
  name: z.string().trim().min(1).max(80).optional(),
}).strict();

const recordKey = "devices-join";
const RecordSchema = z.object({ on: z.boolean().default(false) }).strict();
const lockdownWords = "Lockdown is on here, so this computer is not lent to another Branch. Turn Lockdown off first.";

export class DeviceJoin {
  private state: JoinStatus = { ...idle };
  private stopper: AbortController | null = null;
  /** Integration review: the wait for the yes, stopped by Stop, Leave or Lockdown so a late yes cannot connect. */
  private pairing: AbortController | null = null;
  private readonly os: NodeOs | null;
  private readonly stopListening: () => void;
  /** find-computers: this computer waiting to be found, while it is. */
  private findable: Findable | null = null;
  private findIdle: NodeJS.Timeout | null = null;

  constructor(private readonly deps: JoinDeps) {
    const platform = deps.platform ?? process.platform;
    this.os = platform === "darwin" || platform === "linux" || platform === "win32" ? platform : null;
    this.stopListening = onLockdownChange((store, owner, on) => {
      if (store !== deps.store || owner !== deps.owner) return;
      if (on) this.halt(lockdownWords);
      else if (this.saved() && this.state.state !== "joined") void this.resume();
    });
    if (this.saved() && !lockdownActive(deps.store, deps.owner)) void this.resume();
  }

  status(): JoinStatus {
    if (this.state.state !== "finding") return { ...this.state };
    this.keepFinding();
    const offer = this.findable?.offer();
    return { ...this.state, offer: offer ? { id: offer.id, hub: offer.hub, name: offer.name, from: offer.from } : null,
      findingUntil: this.findable?.endsAt() ?? null };
  }

  /**
   * find-computers: waits to be found by the owner's Branch on another computer, for ten minutes at most. The node
   * door opens and `_branch-node._tcp` is advertised only for that while; an offer is held until the number is typed.
   */
  async find(): Promise<JoinStatus> {
    if (lockdownActive(this.deps.store, this.deps.owner)) throw Object.assign(new Error(lockdownWords), { status: 409 });
    if (!this.os || !this.deps.find) throw Object.assign(new Error("This Branch cannot wait to be found."), { status: 409 });
    if (this.state.state === "waiting" || this.state.state === "joined")
      throw Object.assign(new Error("This computer is already joined to a Branch. Leave it first."), { status: 409 });
    this.halt(null);
    const findable = new Findable({ ...this.deps.find, onEnd: () => {
      if (this.findable !== findable) return;
      this.findable = null;
      this.state = { ...idle, message: notPicked };
      this.deps.onFindChange?.();
    } });
    this.findable = findable;
    this.state = { ...idle, state: "finding" };
    this.deps.onFindChange?.();
    const problems = await findable.start();
    if (this.findable === findable && problems.length) this.state = { ...this.state, message: problems.join("; ").slice(0, 300) };
    return this.status();
  }

  /** find-computers: each read of where it stands keeps the wait going; none for `findIdleMs` ends it. */
  private keepFinding(): void {
    if (this.findIdle) clearTimeout(this.findIdle);
    const findable = this.findable;
    this.findIdle = setTimeout(() => { if (findable && this.findable === findable) this.halt(notPicked); }, this.deps.findIdleMs ?? findIdleMs);
    this.findIdle.unref?.();
  }

  /** find-computers: whether this computer is waiting to be found now. */
  get finding(): boolean { return this.findable !== null; }

  /** find-computers: the person here refuses the offer shown (`id`); this computer keeps waiting for another. */
  refuseOffer(input: unknown): JoinStatus {
    const { offer } = z.object({ offer: z.string().regex(/^[a-f0-9]{16}$/) }).strict().parse(input);
    if (!this.findable) throw Object.assign(new Error("This computer is not waiting to be found."), { status: 409 });
    try { this.findable.refuse(offer); } catch (error) { throw Object.assign(error as Error, { status: 409 }); }
    return this.status();
  }

  /** find-computers: what another door does with an offer while this computer is being found; null otherwise. */
  offerHandler(): OfferHandler | null {
    const findable = this.findable;
    return findable?.waiting ? (body, from) => findable.take(body, from) : null;
  }

  private async offered(id: string | undefined): Promise<PendingOffer> {
    if (this.state.state !== "finding" || !this.findable) throw Object.assign(new Error("Give the link and the number from the other computer."), { status: 400 });
    if (!id) throw Object.assign(new Error("That invitation is no longer the one shown here."), { status: 409 });
    const findable = this.findable;
    const offer = await findable.use(id).catch((error: unknown) => { throw Object.assign(error as Error, { status: 409 }); });
    if (this.findable === findable) { this.findable = null; this.deps.onFindChange?.(); }
    return offer;
  }

  /** Answers an invitation from the other computer's Add a Trunk › Another computer, then waits for the yes. */
  async start(input: unknown): Promise<JoinStatus> {
    const { link: typed, offer: offerId, code, name } = JoinSchema.parse(input);
    if (lockdownActive(this.deps.store, this.deps.owner)) throw Object.assign(new Error(lockdownWords), { status: 409 });
    if (!this.os) throw Object.assign(new Error("Lending this computer works on macOS, Linux and Windows."), { status: 409 });
    if (this.state.state === "waiting" || this.state.state === "joined")
      throw Object.assign(new Error("This computer is already joined to a Branch. Leave it first."), { status: 409 });
    const link = typed ?? (await this.offered(offerId)).link; // find-computers: the offered link shown here, used once
    const { hub } = parsePairLink(link);
    this.halt(null);
    const pairing = new AbortController();
    this.pairing = pairing;
    this.state = { state: "waiting", hub, name: name ?? null, connected: false, message: null, check: null };
    const check = keyCheck((await loadIdentity(this.deps.nodeDir)).publicKey);
    if (this.pairing !== pairing) return this.status();
    this.state = { ...this.state, check };
    void this.pair(link, code.replace(/\s/g, ""), name, pairing.signal);
    return this.status();
  }

  private async pair(link: string, code: string, name: string | undefined, signal: AbortSignal): Promise<void> {
    try {
      const identity = await pairNode(this.deps.nodeDir, link, code, {
        platform: this.os!, offers: await this.actions().available(), ...(name ? { name } : {}), signal,
        ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}), ...(this.deps.pairIntervalMs ? { intervalMs: this.deps.pairIntervalMs } : {}),
      });
      if (signal.aborted || this.state.state !== "waiting") return;
      this.pairing = null;
      this.remember(true);
      this.connect(identity);
    } catch (error) {
      if (signal.aborted || this.state.state !== "waiting") return;
      this.pairing = null;
      const message = error instanceof Error ? error.message : String(error);
      this.state = { ...this.state, state: /refused/i.test(message) ? "refused" : "failed", message: plainPairError(message) };
    }
  }

  private async resume(): Promise<void> {
    const identity = await loadIdentity(this.deps.nodeDir).catch(() => null);
    if (!identity?.hub || !identity.deviceId || !this.os) return;
    this.connect(identity);
  }

  private connect(identity: NodeIdentity): void {
    this.stopper?.abort();
    const stopper = new AbortController();
    this.stopper = stopper;
    this.state = { state: "joined", hub: identity.hub, name: identity.name, connected: false, message: null, check: null };
    const client = new NodeClient({ identity, platform: this.os!, actions: this.actions(), dial: this.watchedDial(),
      log: (line) => { if (this.stopper === stopper) this.state.message = line.slice(0, 300); } });
    void client.run(stopper.signal).then((why) => {
      if (why !== "revoked" || this.stopper !== stopper) return;
      this.remember(false);
      this.state = { ...idle, message: "The owner of the other Branch took this computer off their list." };
      // Integration review: taken off the list, its key is forgotten here too, as Leave does.
      return rm(join(this.deps.nodeDir, "identity.json"), { force: true });
    }).catch(() => undefined);
  }

  /** The socket as the client dials it, noting when the other side has let this computer in. */
  private watchedDial(): DialNode {
    const dial = this.deps.dial ?? dialNode;
    return async (hub, deviceId, events) => {
      const socket = await dial(hub, deviceId, { ...events, onText: (text) => {
        if (/"type"\s*:\s*"welcome"/.test(text)) this.state.connected = true;
        events.onText(text);
      } });
      void socket.closed.finally(() => { this.state.connected = false; });
      return socket;
    };
  }

  /** Stops lending this computer and forgets its key and pairing. */
  async leave(): Promise<JoinStatus> {
    this.halt(null);
    this.remember(false);
    await rm(join(this.deps.nodeDir, "identity.json"), { force: true });
    this.state = { ...idle };
    return this.status();
  }

  private halt(message: string | null): void {
    if (this.findIdle) clearTimeout(this.findIdle);
    this.findIdle = null;
    const findable = this.findable;
    void findable?.stop(); // find-computers: no more advertising, the door closed
    this.findable = null;
    if (this.state.state === "finding") this.state = { ...idle, message };
    if (findable) this.deps.onFindChange?.();
    this.pairing?.abort();
    this.pairing = null;
    this.stopper?.abort();
    this.stopper = null;
    if (this.state.state === "joined" || this.state.state === "waiting")
      this.state = { ...this.state, state: message ? "failed" : this.state.state, connected: false, message };
  }

  private actions(): NodeActions {
    return this.deps.actions ?? new NodeActions({ os: this.os!, identityDir: this.deps.nodeDir });
  }
  private saved(): boolean {
    return RecordSchema.safeParse(this.deps.store.get("settings", this.deps.owner, recordKey)?.data ?? {}).data?.on === true;
  }
  private remember(on: boolean): void {
    this.deps.store.save("settings", this.deps.owner, recordKey, { on });
  }

  close(): void {
    if (this.findIdle) clearTimeout(this.findIdle);
    const findable = this.findable;
    void findable?.stop();
    this.findable = null;
    if (findable) this.deps.onFindChange?.();
    this.stopListening();
    this.pairing?.abort();
    this.stopper?.abort();
    this.stopper = null;
  }
}

/** The pairing errors in the words the window shows. */
function plainPairError(message: string): string {
  if (message === pairingStopped) return message;
  if (/refused this computer/i.test(message)) return "The owner of the other Branch said no.";
  if (/in time/i.test(message)) return "Nobody answered on the other computer in time. Ask for a new invitation and try again.";
  if (/https|Tailscale/i.test(message)) return message;
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|getaddrinfo/i.test(message)) return "The other computer could not be reached at that address.";
  return "The other computer did not accept that invitation. Check the number, or ask for a new invitation.";
}
