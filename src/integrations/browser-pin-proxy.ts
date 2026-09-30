import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, isIP, type Socket } from 'node:net';

/**
 * Where Branch's own browser really connects, in any-website mode.
 *
 * The browser checks every request a page makes against the network rules before Chromium sends it, and the rules
 * look the site's name up to refuse this computer and the home network. Chromium would then look the name up again
 * itself, and a site that answers the second lookup with a private address (DNS rebinding) would reach the home
 * network after passing the check. So Chromium is started with this local proxy: it never looks a name up, it asks the
 * proxy, and the proxy connects only to an address the network rules judged for that very name, looked up once
 * (`NetworkPolicy.allowedAddresses`, shared for a few seconds with the page's own check).
 *
 * A secure tunnel only says which site and port it goes to, so here the host rules and the address are checked; the
 * path rules were already applied to the page's request by the browser's own check. The proxy listens on 127.0.0.1
 * only, and connects nowhere the network rules would not let the browser go anyway.
 */
export interface PinRules {
  /** The judged addresses for this site, or null to reach it as written; throws a plain reason when refused. */
  allowedAddresses(target: URL, what?: string, scope?: 'address' | 'host'): Promise<string[] | null>;
  dialAddress?(address: string): string;
}
export interface PinProxyOptions {
  rules: () => PinRules;
  /** The one local page a benchmark window was granted (http://127.0.0.1:port), reached as written. */
  granted?: (host: string, port: number) => boolean;
}

const hopHeaders = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer', 'transfer-encoding']);
const connectTimeoutMs = 15_000;
const siteName = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*\.?$/;

export class BrowserPinProxy {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  /** Plain reasons for the last refusals, newest last, for tests and the record. */
  readonly refused: string[] = [];
  constructor(private readonly options: PinProxyOptions) {
    this.server = createServer((request, response) => { void this.forward(request, response).catch(() => response.destroy()); });
    this.server.on('connect', (request: IncomingMessage, socket: Socket, head: Buffer) => {
      void this.tunnel(request, socket, head).catch(() => socket.destroy());
    });
    this.server.on('connection', (socket: Socket) => this.track(socket));
  }
  private track(socket: Socket): Socket {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    return socket;
  }
  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    const at = this.server.address();
    if (!at || typeof at !== 'object') throw new Error('The browser\'s network door did not open');
    return `http://127.0.0.1:${at.port}`;
  }
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
  private refuse(reason: string): string {
    this.refused.push(reason);
    if (this.refused.length > 32) this.refused.shift();
    return reason;
  }
  /** The addresses to try for this site and port, in order, or why it may not be reached. */
  private async admit(rawHost: string, port: number, secure: boolean): Promise<{ to: string[] } | { reason: string }> {
    const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host || host.length > 253 || !(isIP(host) || siteName.test(host))) return { reason: 'That is not a site name.' };
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { reason: 'That is not a port.' };
    if (!secure && this.options.granted?.(host, port)) return { to: [host] };
    const target = new URL(`${secure ? 'https' : 'http'}://${isIP(host) === 6 ? `[${host}]` : host}:${port}/`);
    try {
      const rules = this.options.rules();
      const judged = await rules.allowedAddresses(target, 'browser address', 'host');
      if (!judged) return { to: [host] };
      return { to: judged.map(address => rules.dialAddress?.(address) ?? address) };
    } catch (error) { return { reason: error instanceof Error ? error.message : String(error) }; }
  }
  /** Connects to the first judged address that answers. */
  private dial(addresses: string[], port: number, downstream: Socket, ready: (upstream: Socket) => void, failed: () => void): void {
    const [first, ...rest] = addresses;
    if (!first) { failed(); return; }
    const upstream = this.track(connect(port, first));
    upstream.setTimeout(connectTimeoutMs, () => upstream.destroy());
    const retry = () => { upstream.destroy(); this.dial(rest, port, downstream, ready, failed); };
    upstream.once('error', retry);
    upstream.once('connect', () => {
      upstream.off('error', retry);
      upstream.setTimeout(0);
      upstream.on('error', () => downstream.destroy());
      downstream.on('close', () => upstream.destroy());
      ready(upstream);
    });
  }
  private async tunnel(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    const target = /^([^:\s]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(request.url ?? '');
    const port = target ? Number(target[2]) : 0;
    const admitted = target ? await this.admit(target[1]!, port, port !== 80) : { reason: 'That is not a site and a port.' };
    if ('reason' in admitted) {
      socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\n${this.refuse(admitted.reason)}\n`);
      return;
    }
    this.dial(admitted.to, port, socket, upstream => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(socket).pipe(upstream);
    }, () => socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n'));
  }
  private async forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const deny = (status: number, reason: string) => {
      response.writeHead(status, { 'content-type': 'text/plain', connection: 'close' }).end(`${this.refuse(reason)}\n`);
    };
    let url: URL;
    try { url = new URL(request.url ?? ''); } catch { deny(400, 'Send the whole address through the proxy.'); return; }
    if (url.protocol !== 'http:') { deny(400, 'Only plain addresses go through this way.'); return; }
    const port = url.port ? Number(url.port) : 80;
    const admitted = await this.admit(url.hostname, port, false);
    if ('reason' in admitted) { deny(403, admitted.reason); return; }
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(request.headers))
      if (value !== undefined && !hopHeaders.has(name)) headers[name] = value;
    headers.host = url.host;
    this.send(request, response, admitted.to, port, `${url.pathname}${url.search}`, headers);
  }
  private send(request: IncomingMessage, response: ServerResponse, addresses: string[], port: number, path: string,
    headers: Record<string, string | string[]>): void {
    const [first, ...rest] = addresses;
    if (!first) { if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' }); response.end('The site could not be reached.\n'); return; }
    let answered = false;
    const outgoing = httpRequest({ host: first, port, method: request.method, path, headers, setHost: false }, answer => {
      answered = true;
      const out: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries(answer.headers)) if (value !== undefined && !hopHeaders.has(name)) out[name] = value;
      response.writeHead(answer.statusCode ?? 502, out);
      answer.pipe(response);
    });
    outgoing.setTimeout(connectTimeoutMs * 4, () => outgoing.destroy());
    // A request with no body (GET, HEAD) that never got an answer is tried at the next judged address.
    const bodiless = ['GET', 'HEAD'].includes(request.method ?? '');
    outgoing.on('error', () => {
      if (!answered && rest.length && bodiless) { this.send(request, response, rest, port, path, headers); return; }
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('The site could not be reached.\n');
    });
    if (bodiless) outgoing.end(); else request.pipe(outgoing);
  }
}
