import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { requestSource } from "../auth-limits.js";
import { acceptKey, frame, readFrame } from "../ws.js";
import type { DeviceBook, DeviceRecord } from "./book.js";
import { capabilityInfo, mediaLimitBytes, type Capability } from "./capabilities.js";
import {
  helloText, HelloSchema, newInvokeId, newNonce, nodeHeader, NodeFrameSchema, protocolVersion, readMediaFrame,
  signedBy, WindowLimit, type HubFrame,
} from "./protocol.js";

/**
 * mac7/nodes: Branch's side of the device socket. A device dials in (so nothing is ever opened on
 * the device, and a phone behind a home router works), proves itself, and is then asked to do things.
 *
 * What is checked, in order, before a device can be asked anything:
 *   1. the address the request was sent to, and the page it came from (src/server.ts, before this);
 *   2. the feature is not switched off, and this address has not been trying too often;
 *   3. the device named in the request is on the owner's list;
 *   4. the first message is a hello signed over this connection's own fresh challenge.
 */
/** The device a socket says it is: a header from `branch node`, or `?device=` from a phone app, which cannot set headers. */
export function claimedDevice(request: Pick<IncomingMessage, "headers" | "url">): string {
  const header = String(request.headers[nodeHeader] ?? "");
  if (header) return header;
  return new URL(request.url ?? "/", "http://device").searchParams.get("device") ?? "";
}
export const phoneAppOrigins: readonly string[] = ["capacitor://localhost", "https://localhost"];
const helloWaitMs = 10_000;
const textLimit = 256 * 1024;
/** Integration review: what a socket may hold before it has proven itself (OpenClaw allows 64 KiB too). */
const unprovenLimit = 64 * 1024;
/** How long the owner's hold on a device lasts without a click, key or frame from the view. */
export const drivingIdleMs = 120_000;
const badRequest = "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n";

/** An error in the device's own words, as opposed to Branch's; the tools mark and guard it. */
export class DeviceSaid extends Error {}
export interface MediaResult { mime: string; bytes: number; name?: string; data: Buffer }
export interface InvokeAnswer { value: unknown; media?: MediaResult }
interface Waiting {
  resolve: (answer: InvokeAnswer) => void; reject: (error: Error) => void; timer: NodeJS.Timeout;
  media?: { mime: string; bytes: number; name?: string; value: unknown };
}
interface Link {
  device: string; platform: string; since: string;
  send(value: HubFrame): void; close(reason: string): void;
  waiting: Map<string, Waiting>;
}

export interface HubOptions { invokeTimeoutMs?: number; pingMs?: number; now?: () => number }

export class DeviceHub {
  private readonly links = new Map<string, Link>();
  /**
   * Wrong device names per address, and failed proofs per device and address; ten in a minute and
   * that one waits. Integration review: kept apart, so noise from one address (every device behind
   * a gateway on 127.0.0.1 shares it) never locks a device that proves itself out.
   */
  private readonly failures = new WindowLimit(10, 60_000);
  private readonly invokes = new WindowLimit(30, 60_000);
  /** computer-control: the owner's live view of a device's screen has its own budget, so watching never starves tasks. */
  private readonly views = new WindowLimit(40, 60_000);
  /** computer-control: the owner's clicks and keys on a device, and which devices the owner is driving (until when). */
  private readonly inputs = new WindowLimit(120, 60_000);
  private readonly holds = new Map<string, { owner: string; timer: NodeJS.Timeout }>();
  /** When someone at a device pressed Stop on its notice, so the owner's view can say so. */
  private readonly stoppedAt = new Map<string, number>();
  private readonly stopListening: () => void;
  private closed = false;
  constructor(private readonly book: DeviceBook, private readonly options: HubOptions = {}) {
    this.stopListening = book.onChange((id, why) => {
      // computer-control: switching "use its screen and keyboard" off (or removing the device) ends the owner's hold.
      if (this.holds.has(id) && (why === "removed" || !this.book.device(id)?.enabled.includes("input"))) this.drive(id, false);
      const link = this.links.get(id);
      if (!link) return;
      if (why === "removed") link.close("This device was taken off the owner's list.");
      else link.send(this.enabledFrame(this.book.device(id)));
    });
  }

  private enabledFrame(device: DeviceRecord | undefined): HubFrame {
    return { type: "enabled", enabled: device?.enabled ?? [], folder: device?.folder ?? null };
  }
  connected(id: string): boolean { return this.links.has(id); }
  connections(): { id: string; platform: string; since: string }[] {
    return [...this.links.values()].map((link) => ({ id: link.device, platform: link.platform, since: link.since }));
  }

  /**
   * Why this upgrade may not go ahead, or null. The address and page checks are the server's; this
   * adds the switch, the per-address limit, the device list and the page a phone app is allowed from.
   */
  refusal(request: Pick<IncomingMessage, "headers" | "url">, from: string, hostOk: boolean, originOk: boolean): string | null {
    if (!hostOk) return "Host rejected";
    const origin = request.headers.origin;
    if (origin && !originOk && !phoneAppOrigins.includes(origin)) return "Origin rejected";
    if (this.book.mode() === "off") return "Using other devices is switched off";
    const claimed = claimedDevice(request);
    if (!this.book.device(claimed)) {
      if (this.failures.full(`address:${from}`)) return "Too many tries from this address";
      this.failures.add(`address:${from}`);
      return "This device is not on the owner's list";
    }
    return this.failures.full(`device:${claimed}:${from}`) ? "Too many wrong proofs for this device" : null;
  }

  /** Counts a hello that did not prove the device it named. */
  noteBadProof(device: string, from: string): void {
    this.failures.add(`device:${device}:${from}`);
  }

  /** Completes the handshake. Call only after `refusal` answered null. */
  attach(request: IncomingMessage, socket: Duplex): void {
    const claimed = claimedDevice(request);
    const from = requestSource(request.socket?.remoteAddress);
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(String(request.headers["sec-websocket-key"] ?? ""))}`, "", ""].join("\r\n"));
    const nonce = newNonce();
    const state = { open: true, proven: false, pending: Buffer.alloc(0), lastPong: this.now() };
    const link: Link = {
      device: claimed, platform: "", since: new Date(this.now()).toISOString(), waiting: new Map(),
      send: (value) => { if (state.open) socket.write(frame(JSON.stringify(value))); },
      close: (reason) => {
        if (this.links.get(link.device) === link) this.links.delete(link.device);
        if (!state.open) return;
        link.send({ type: "bye", reason });
        state.open = false;
        socket.end(Buffer.from([0x88, 0x00]));
        // A device that does not close its end in a few seconds is cut off.
        setTimeout(() => socket.destroy(), 3000).unref();
      },
    };
    const helloTimer = setTimeout(() => { if (!state.proven) link.close("No hello in time."); }, helloWaitMs);
    const ping = setInterval(() => this.keepAlive(link, socket, state), this.options.pingMs ?? 25_000);
    helloTimer.unref();
    ping.unref();
    link.send({ type: "challenge", nonce, version: protocolVersion });
    socket.on("data", (chunk: Buffer) => {
      state.pending = Buffer.concat([state.pending, chunk]);
      if (state.pending.length > (state.proven ? mediaLimitBytes + 64 : unprovenLimit)) { link.close("A message was too large."); socket.destroy(); return; }
      for (let decoded = readFrame(state.pending); decoded && state.open; decoded = readFrame(state.pending)) {
        state.pending = state.pending.subarray(decoded.consumed);
        this.onFrame(link, state, nonce, decoded, socket, from);
      }
    });
    const gone = (): void => {
      state.open = false;
      clearTimeout(helloTimer);
      clearInterval(ping);
      for (const waiting of link.waiting.values()) { clearTimeout(waiting.timer); waiting.reject(new Error("The device went away before it answered.")); }
      link.waiting.clear();
      if (this.links.get(link.device) === link) this.links.delete(link.device);
      if (state.proven && !this.closed) this.book.seen(link.device);
    };
    socket.once("close", gone);
    // The server keeps its half open when the device hangs up; end ours too, or the link lingers.
    socket.once("end", () => socket.destroy());
    socket.on("error", () => socket.destroy());
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  private keepAlive(link: Link, socket: Duplex, state: { open: boolean; lastPong: number }): void {
    if (!state.open) return;
    if (this.book.mode() === "off") { link.close("Using other devices is switched off."); socket.destroy(); return; } // mac7/lockdown-fix
    if (this.now() - state.lastPong > 3 * (this.options.pingMs ?? 25_000)) { link.close("The device stopped answering."); socket.destroy(); return; }
    socket.write(Buffer.from([0x89, 0x00]));
  }

  private onFrame(link: Link, state: { open: boolean; proven: boolean; lastPong: number }, nonce: string,
    decoded: { fin: boolean; opcode: number; payload: Buffer }, socket: Duplex, from: string): void {
    if (!decoded.fin || decoded.opcode === 0x0) { link.close("Split messages are not used on this socket."); return; }
    if (decoded.opcode === 0x8) { link.close("Closed."); return; }
    if (decoded.opcode === 0x9) { if (decoded.payload.length <= 125) socket.write(Buffer.concat([Buffer.from([0x8a, decoded.payload.length]), decoded.payload])); return; }
    if (decoded.opcode === 0xa) { state.lastPong = this.now(); return; }
    if (decoded.opcode === 0x2) { if (state.proven) this.onMedia(link, decoded.payload); else link.close("Say hello first."); return; }
    if (decoded.opcode !== 0x1 || decoded.payload.length > textLimit) { link.close("That message is not understood."); return; }
    let parsed: unknown;
    try { parsed = JSON.parse(decoded.payload.toString("utf8")); } catch { link.close("That message is not understood."); return; }
    if (!state.proven) {
      state.proven = this.onHello(link, nonce, parsed);
      if (!state.proven) this.noteBadProof(link.device, from);
      return;
    }
    const message = NodeFrameSchema.safeParse(parsed);
    if (!message.success) { link.close("That message is not understood."); return; }
    state.lastPong = this.now();
    if (message.data.type === "offers") this.book.noteOffers(link.device, message.data.offers);
    else if (message.data.type === "hold-stopped") this.heldStopped(link.device);
    else if (message.data.type === "result") this.onResult(link, message.data);
  }

  private onHello(link: Link, nonce: string, parsed: unknown): boolean {
    const hello = HelloSchema.safeParse(parsed);
    const device = hello.success ? this.book.device(hello.data.deviceId) : undefined;
    if (!hello.success || !device || hello.data.deviceId !== link.device || hello.data.platform !== device.platform
      || !signedBy(device.publicKey, helloText(device.id, nonce), hello.data.signature)) {
      link.close("This device could not prove who it is.");
      return false;
    }
    this.links.get(device.id)?.close("The same device connected again.");
    link.platform = device.platform;
    this.links.set(device.id, link);
    this.book.noteOffers(device.id, hello.data.offers);
    this.book.seen(device.id);
    link.send({ type: "welcome", deviceId: device.id, enabled: device.enabled, folder: device.folder });
    // Back after a drop while the owner still holds it: the notice goes up again before anything else.
    const held = this.holds.get(device.id);
    if (held) link.send({ type: "driving", on: true, owner: held.owner });
    return true;
  }

  private onResult(link: Link, result: { id: string; ok: boolean; value?: unknown; error?: string | undefined; media?: { mime: string; bytes: number; name?: string | undefined } | undefined }): void {
    const waiting = link.waiting.get(result.id);
    if (!waiting || waiting.media) return;
    if (!result.ok) { this.settle(link, result.id); waiting.reject(new DeviceSaid(result.error ?? "The device could not do it.")); return; }
    if (!result.media) { this.settle(link, result.id); waiting.resolve({ value: result.value }); return; }
    if (result.media.bytes > mediaLimitBytes) {
      this.settle(link, result.id);
      waiting.reject(new Error(`The device sent more than ${mediaLimitBytes / 1024 / 1024} MB, which is refused.`));
      return;
    }
    waiting.media = { mime: result.media.mime, bytes: result.media.bytes, value: result.value,
      ...(result.media.name ? { name: result.media.name } : {}) };
  }

  private onMedia(link: Link, payload: Buffer): void {
    const media = readMediaFrame(payload);
    const waiting = media && link.waiting.get(media.id);
    if (!media || !waiting?.media) return;
    this.settle(link, media.id);
    if (media.payload.length !== waiting.media.bytes) { waiting.reject(new Error("The device's picture or sound did not arrive whole.")); return; }
    const { value, ...meta } = waiting.media;
    waiting.resolve({ value, media: { ...meta, data: Buffer.from(media.payload) } });
  }

  private settle(link: Link, id: string): void {
    const waiting = link.waiting.get(id);
    if (waiting) clearTimeout(waiting.timer);
    link.waiting.delete(id);
  }

  /** Asks one connected device to do one switched-on thing. The tool gate has already decided. */
  invoke(deviceId: string, capability: Capability, args: Record<string, unknown>, options: { timeoutMs?: number; signal?: AbortSignal; ownerView?: boolean } = {}): Promise<InvokeAnswer> {
    // mac7/lockdown-fix (integration review): nothing reaches a device while the feature reads off (Lockdown included).
    if (this.book.mode() === "off") return Promise.reject(new Error("Using other devices is switched off, or Lockdown is on."));
    if (options.ownerView && capability !== "screen" && capability !== "input") return Promise.reject(new Error("The owner's view only looks at a device's screen and uses it."));
    if (!options.ownerView && capabilityInfo[capability].ownerOnly) return Promise.reject(new Error("Only the owner uses a device's screen and keyboard, from Branch's computer view."));
    const device = this.book.device(deviceId);
    if (!device) return Promise.reject(new Error("That device is not on the list."));
    if (capability === "input" && !this.driving(deviceId)) return Promise.reject(new Error(`Take over ${device.name} in the computer view first.`));
    if (!options.ownerView && capabilityInfo[capability].kind !== "capture" && this.driving(deviceId))
      return Promise.reject(new Error(`You're driving ${device.name}. The task can act on it again once you hand it back.`));
    if (options.ownerView && this.driving(deviceId)) this.drive(deviceId, true, this.holds.get(deviceId)!.owner);
    if (!device.enabled.includes(capability))
      return Promise.reject(new Error(`"${capabilityInfo[capability].label}" is switched off for ${device.name}. The owner can switch it on in Customize, Channels, Devices.`));
    const link = this.links.get(deviceId);
    if (!link) return Promise.reject(new Error(`${device.name} is not connected right now.`));
    if (!(capability === "input" ? this.inputs : options.ownerView ? this.views : this.invokes).take(deviceId)) return Promise.reject(new Error(`${device.name} has been asked too often in the last minute. Wait a little.`));
    const id = newInvokeId(), timeoutMs = options.timeoutMs ?? this.options.invokeTimeoutMs ?? 30_000;
    return new Promise<InvokeAnswer>((resolve, reject) => {
      const timer = setTimeout(() => { link.waiting.delete(id); reject(new Error(`${device.name} did not answer in time.`)); }, timeoutMs);
      link.waiting.set(id, { resolve, reject, timer });
      options.signal?.addEventListener("abort", () => { this.settle(link, id); reject(new Error("The task was stopped.")); }, { once: true });
      link.send({ type: "invoke", id, capability, args, deadline: this.now() + timeoutMs });
    });
  }

  /**
   * computer-control: the owner takes over a device from the computer view (or hands it back). While
   * driving, only the owner's input reaches it and a task cannot act on it; it lapses after two quiet minutes.
   * The device is told each time, so it shows (or takes down) its notice with a Stop of its own.
   */
  drive(deviceId: string, on: boolean, owner = ""): void {
    const held = this.holds.get(deviceId);
    if (held) clearTimeout(held.timer);
    if (!on) {
      this.holds.delete(deviceId);
      if (held) this.links.get(deviceId)?.send({ type: "driving", on: false, owner: held.owner });
      return;
    }
    const timer = setTimeout(() => this.drive(deviceId, false), drivingIdleMs);
    timer.unref();
    this.holds.set(deviceId, { owner, timer });
    if (!held) { this.stoppedAt.delete(deviceId); this.links.get(deviceId)?.send({ type: "driving", on: true, owner }); }
  }
  driving(deviceId: string): boolean { return this.holds.has(deviceId); }
  /** Whether someone at that device pressed Stop on its notice in the last minute. */
  stoppedHere(deviceId: string): boolean {
    const at = this.stoppedAt.get(deviceId);
    return at !== undefined && this.now() - at < 60_000;
  }
  private heldStopped(deviceId: string): void {
    const held = this.holds.get(deviceId);
    if (!held) return;
    clearTimeout(held.timer);
    this.holds.delete(deviceId);
    this.stoppedAt.set(deviceId, this.now());
  }

  /** Closes every device's socket; used when the feature is switched off. */
  disconnectAll(reason = "Using other devices was switched off."): void {
    for (const link of [...this.links.values()]) link.close(reason);
    this.links.clear();
  }

  close(): void {
    this.closed = true;
    for (const held of this.holds.values()) clearTimeout(held.timer);
    this.holds.clear();
    this.stopListening();
    this.disconnectAll("Branch is closing.");
  }
}

/** The one plain line a refused upgrade gets; the reason is kept out of the reply. */
export function refuseUpgrade(socket: Duplex): void {
  socket.end(badRequest);
}
