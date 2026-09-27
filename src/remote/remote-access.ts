import { createServer, type IncomingMessage, type RequestListener, type Server } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { Pairing, type PairingView } from "./pairing.js";
import { encodeQr, type QrMatrix } from "./qr.js";
import { probeTailscale, isTailnetAddress, type ProbeTailscale, type TailnetAddress } from "./tailscale.js";

/**
 * The "reach Branch from my phone" switch. While it is off nothing listens beyond this computer.
 * While it is on, one extra door is open on the private Tailscale address only — never on the
 * ordinary network, and never on every address at once — and it still needs the same key as the
 * window on this computer, which a phone only gets by accepting an invitation.
 */
export interface RemoteStatus {
  enabled: boolean;
  /** The address to open on the phone, or null when remote access is off. */
  url: string | null;
  hostname: string | null;
  address: string | null;
  tailscale: TailnetAddress | null;
  pairing: PairingView | null;
  message: string;
}
export interface RemoteInvitation { url: string; code: string; expiresAt: string; qr: QrMatrix }

/** Refuses anything that would open the app to more than the one private address. */
export function assertPrivateAddress(address: string): void {
  if (!isTailnetAddress(address))
    throw new Error("Branch only listens on a private Tailscale address, never on every network address.");
}

/**
 * Closes one door and forgets it; a door already closed counts as closed. Connections still open through it are cut
 * too, so nothing keeps talking through a closed door and switching off never waits on a phone.
 */
function closeDoor(server: Server, opened: Set<Server>): Promise<void> {
  opened.delete(server);
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  return closed;
}

export class RemoteAccess {
  private listener: Server | null = null;
  private tailnet: TailnetAddress | null = null;
  private origin: string | null = null;
  /** Every door this opened and has not closed yet, so switching off or closing Branch closes all of them. */
  private readonly opened = new Set<Server>();
  /** The one enable waiting on Tailscale or on listen; a second switch-on while it waits shares it. */
  private pending: Promise<RemoteStatus> | null = null;
  /** Moves on at every switch-off, so an enable that was waiting when the owner switched off never opens. */
  private generation = 0;
  /** Set when Branch closes: nothing opens this door again, and a switch-on answers with the door still off. */
  private shut = false;
  readonly pairing: Pairing;
  /** mac7/nodes: what the paired door does with a WebSocket upgrade; set by the server, refused while unset. */
  upgrade: ((request: IncomingMessage, socket: Duplex) => void) | null = null;
  /** Every connection open on the paired door, so a rotated window key can end the ones made with the old one. */
  private readonly connections = new Set<Socket>();
  constructor(token: string | (() => string), private readonly probe: ProbeTailscale = probeTailscale) {
    this.pairing = new Pairing(token);
  }
  /** Ends every connection open on the paired door but `keep`; a phone that still belongs reconnects with its new key. */
  dropConnections(keep?: unknown): void {
    for (const socket of this.connections) if (socket !== keep) socket.destroy();
  }
  /** Host header values the ordinary checks should also accept while remote access is on. */
  allowedHosts(): string[] {
    if (!this.listener || !this.tailnet?.address) return [];
    const port = this.port();
    const hosts = [`${this.tailnet.address}:${port}`];
    if (this.tailnet.hostname) hosts.push(`${this.tailnet.hostname}:${port}`);
    return hosts;
  }
  allowedOrigins(): string[] { return this.allowedHosts().map((host) => `http://${host}`); }
  private port(): number {
    const address = this.listener?.address();
    return address && typeof address !== "string" ? address.port : 0;
  }
  status(): RemoteStatus {
    const enabled = this.listener !== null;
    return {
      enabled, url: this.origin, hostname: this.tailnet?.hostname ?? null,
      address: this.tailnet?.address ?? null, tailscale: this.tailnet, pairing: this.pairing.view(),
      message: enabled
        ? `Your phone can open ${this.origin} while it is signed in to the same Tailscale network.`
        : "Reaching Branch from your phone is off. Nothing outside this computer can see it.",
    };
  }
  /**
   * Opens the extra door on the Tailscale address only, then makes the first invitation. Two switch-ons at once share
   * one opening, and a switch-off (or Branch closing) while it waits on Tailscale or on listen wins: the door stays shut.
   */
  enable(handler: RequestListener, port = 0): Promise<RemoteStatus> {
    if (this.shut || this.listener) return Promise.resolve(this.status());
    if (this.pending) return this.pending;
    const pending = this.open(handler, port, this.generation)
      .finally(() => { if (this.pending === pending) this.pending = null; });
    this.pending = pending;
    return pending;
  }
  private async open(handler: RequestListener, port: number, generation: number): Promise<RemoteStatus> {
    const tailnet = await this.probe();
    if (generation !== this.generation) return this.status();
    this.tailnet = tailnet;
    if (!tailnet.address) throw new Error(tailnet.message);
    assertPrivateAddress(tailnet.address);
    const server = createServer(handler);
    server.on("connection", (socket: Socket) => {
      this.connections.add(socket);
      socket.once("close", () => this.connections.delete(socket));
    });
    // ---- mac7/nodes: the paired door had no WebSocket upgrade handler; the server's own checks run in `upgrade`. ----
    server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
      if (this.upgrade) this.upgrade(request, socket);
      else socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    });
    // ---- end mac7/nodes ----
    this.opened.add(server);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, tailnet.address!, () => { server.off("error", reject); resolve(); });
      });
    } catch (error) {
      this.opened.delete(server);
      throw error;
    }
    if (generation !== this.generation) {
      await closeDoor(server, this.opened);
      return this.status();
    }
    server.requestTimeout = 150000;
    server.headersTimeout = 10000;
    this.listener = server;
    this.origin = `http://${tailnet.hostname ?? tailnet.address}:${this.port()}`;
    return this.status();
  }
  /** Closes the door, every one this opened, and any enable still waiting. Always allowed, Lockdown or not. */
  async disable(): Promise<RemoteStatus> {
    this.generation++;
    this.pending = null;
    this.listener = null;
    this.origin = null;
    this.pairing.cancel();
    await Promise.all([...this.opened].map((server) => closeDoor(server, this.opened)));
    return this.status();
  }
  /** Branch is closing: the door is closed and never opens again in this run. */
  async close(): Promise<void> {
    this.shut = true;
    await this.disable();
  }
  /** A fresh invitation: the link for the barcode, and the number to read out. */
  invite(): RemoteInvitation {
    if (!this.listener || !this.origin) throw new Error("Switch on reaching Branch from your phone first.");
    const offer = this.pairing.create();
    const url = `${this.origin}/pair?id=${offer.id}`;
    return { url, code: offer.code, expiresAt: offer.expiresAt, qr: encodeQr(url) };
  }
}
