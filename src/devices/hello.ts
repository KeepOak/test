import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";
import { isTailnetAddress } from "../remote/tailscale.js";
import { WindowLimit } from "./protocol.js";
import { isPrivateAddress, unsafeText } from "./dns-sd.js";

/**
 * find-computers: the node door, a very small web server a Branch computer opens so the owner's other computers can
 * find it. It answers two things and nothing else:
 *
 *   GET  /branch-node/hello   { branch, name, platform, version }, without a key, and only to a request that reached
 *        it on this computer's Tailscale or loopback address: never on the local network, never on every address.
 *   POST /branch-node/offer   { link, name }: another computer offering a pairing invitation. Only while this
 *        computer is waiting to pair (the `offer` handler is set), at most 2 KB, a few a minute. It never pairs by
 *        itself: the person at this computer still types the six-digit number shown on the other one.
 *
 * It binds one named address at a time (a Tailscale address, a private local address, or loopback), never 0.0.0.0.
 */
export const defaultNodePort = 3216;
export function nodePort(env: NodeJS.ProcessEnv = process.env): number {
  const port = Number(env.BRANCH_NODE_PORT ?? defaultNodePort);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : defaultNodePort;
}
export const helloPath = "/branch-node/hello";
export const offerPath = "/branch-node/offer";

const plainText = (text: z.ZodString) => text.refine((value) => !unsafeText.test(value), "A name may not hold control characters.");
export const HelloSchema = z.object({
  branch: z.literal("hello"),
  name: plainText(z.string().trim().min(1).max(80)),
  platform: plainText(z.string().max(20)),
  version: plainText(z.string().max(40)),
}).strict();
export type Hello = z.infer<typeof HelloSchema>;

export const OfferSchema = z.object({ link: plainText(z.string().trim().min(10).max(400)), name: plainText(z.string().trim().min(1).max(80)) }).strict();
export type OfferBody = z.infer<typeof OfferSchema>;
/** What waiting to pair does with an offer: its answer, or an Error whose message goes back with 409. */
export type OfferHandler = (offer: unknown, from: string) => unknown;

const loopback = (address: string): boolean => /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(address);
const plain = (address: string): string => address.replace(/^::ffff:/, "");
/** Where hello answers: a request that reached this computer on its Tailscale address or on loopback. */
export const helloAnswersOn = (localAddress: string): boolean => loopback(localAddress) || isTailnetAddress(plain(localAddress));
/** The addresses a node door may bind: one private address, never the wildcard. */
export function assertDoorHost(host: string): void {
  if (!loopback(host) && !isPrivateAddress(host))
    throw new Error("The node door binds only this computer's Tailscale, private local or loopback address, never every address.");
}

const bodyLimit = 2048;
function readSmall(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > bodyLimit) { reject(new Error("too large")); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("not JSON")); } });
    request.on("error", reject);
  });
}
function answer(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(value));
}

export interface NodeDoorOptions { hello: () => Hello; offer?: () => OfferHandler | null }

export class NodeDoor {
  private readonly servers: Server[] = [];
  private readonly limit = new WindowLimit(30, 60_000);
  /** Bumped by close(), so a door still opening when it is closed shuts again as soon as it listens. */
  private generation = 0;
  constructor(private readonly options: NodeDoorOptions) {}

  /** Opens the door on one named address; resolves with the port it listens on. */
  async open(host: string, port: number): Promise<number> {
    assertDoorHost(host);
    const generation = this.generation;
    const server = createServer((request, response) => void this.handle(request, response));
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => { server.off("error", reject); resolve(); });
    });
    const address = server.address();
    const opened = address && typeof address !== "string" ? address.port : port;
    if (generation !== this.generation) { await new Promise<void>((resolve) => server.close(() => resolve())); return opened; }
    this.servers.push(server);
    return opened;
  }
  get listening(): boolean { return this.servers.length > 0; }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const from = plain(request.socket.remoteAddress ?? "");
    if (!this.limit.take(from)) return answer(response, 429, { error: "Too many tries just now." });
    const path = (request.url ?? "").split("?")[0];
    if (request.method === "GET" && path === helloPath && helloAnswersOn(request.socket.localAddress ?? ""))
      return answer(response, 200, this.options.hello());
    const offer = this.options.offer?.() ?? null;
    if (request.method !== "POST" || path !== offerPath || !offer) return answer(response, 404, { error: "Not found" });
    try {
      return answer(response, 200, await offer(await readSmall(request), from) ?? { ok: true });
    } catch (error) {
      return answer(response, 409, { error: error instanceof Error ? error.message.slice(0, 300) : "Refused" });
    }
  }

  async close(): Promise<void> {
    this.generation++;
    const servers = this.servers.splice(0);
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    })));
  }
}

/* ---------- the asking side ---------- */

export type ProbeHello = (address: string, port: number) => Promise<Hello | null>;
export type SendOffer = (address: string, port: number, offer: OfferBody) => Promise<void>;
const answerLimit = 4096;

async function smallAnswer(response: Response): Promise<string> {
  const text = await response.text();
  if (text.length > answerLimit) throw new Error("The other computer answered with too much.");
  return text;
}

/** Asks one computer who it is. Anything but a well-formed hello, in time, is nothing. */
export function makeProbeHello(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): ProbeHello {
  const fetcher = options.fetch ?? fetch;
  return async (address, port) => {
    try {
      const response = await fetcher(`http://${address}:${port}${helloPath}`, { redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? 1500) });
      if (!response.ok) return null;
      const parsed = HelloSchema.safeParse(JSON.parse(await smallAnswer(response)));
      return parsed.success ? parsed.data : null;
    } catch { return null; } // not a Branch computer, or not answering: it is simply not listed
  };
}

/** Hands one found computer the invitation's link and this computer's name. Its refusal comes back in its words. */
export function makeSendOffer(options: { fetch?: typeof fetch; timeoutMs?: number } = {}): SendOffer {
  const fetcher = options.fetch ?? fetch;
  return async (address, port, offer) => {
    const response = await fetcher(`http://${address}:${port}${offerPath}`, {
      method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify(offer),
      signal: AbortSignal.timeout(options.timeoutMs ?? 4000),
    }).catch(() => { throw new Error("That computer could not be reached. Check that it is still waiting to pair."); });
    if (response.ok) return;
    const text = await smallAnswer(response).catch(() => "");
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = null; } // no words from it: the plain refusal below is said
    const said = z.object({ error: z.string().max(300) }).safeParse(body);
    throw new Error(said.success ? said.data.error : "That computer is not waiting to pair.");
  };
}
