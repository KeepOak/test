import { assertHealthCurrent } from "./health-check.js";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable, pipeline } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import * as zlib from "node:zlib";

/**
 * A checked request connects only to the addresses its check judged.
 *
 * The network policy looks a site's name up once and judges every address that came back. The
 * request then goes to those addresses and nowhere else: the name is never looked up a second time
 * on the way out. The site's name is kept for the secure handshake, for the certificate check and
 * for the Host line, so the request is the same one it would have been. The platform's `fetch` has
 * no way to be told where to connect, so a checked request is sent here with Node's own http and
 * https, the way the sandbox door (src/sandbox-proxy.ts) sends a program's request to the address it
 * checked. Every connection is a fresh one, so none can carry an address judged for another request.
 *
 * The judged addresses ride along in the request's options under `pinnedTo`, so a wrapper that hands
 * its options on (the size-limited fetch, a model connection's health record) delivers them here.
 * A request without them goes to the platform's fetch unchanged. Each request that arrives here with
 * them is noted, so the network policy can tell when a checked request's fetch did not keep to the
 * checked addresses, and refuse it.
 */
export const pinnedTo: unique symbol = Symbol("branch.pinnedTo");

/** A site's name and the addresses its check judged. `dial` is where each is really dialled: only tests change it. */
export interface Pin {
  host: string;
  addresses: readonly string[];
  dial: (address: string) => string;
}
export type PinnedInit = RequestInit & { [pinnedTo]?: Pin };

/** The platform's own fetch, as it was when Branch started. */
export const platformFetch: typeof fetch = globalThis.fetch;

/** Branch's fetch for checked requests: held to the judged addresses when it carries them, the platform's otherwise. */
export const pinnedFetch: typeof fetch = (input, init) => {
  const pin = (init as PinnedInit | undefined)?.[pinnedTo];
  return pin ? sendPinned(input, init as PinnedInit, pin) : platformFetch(input, init);
};

/** How long a connection may take to open, and then sit without a byte either way, as the platform's fetch allows. */
const connectMs = 10_000, idleMs = 300_000;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const bodilessStatuses = new Set([204, 205, 304]);
/** Never passed on from the caller: each is set here or belongs to one connection. */
const connectionHeaders = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "te", "trailer", "upgrade", "host", "content-length"]);
const fetchFailed = (cause: unknown): TypeError => new TypeError("fetch failed", { cause });

/** The pins whose request reached this sender. Only `sendPinned` adds one, before it does anything else. */
const taken = new WeakSet<Pin>();

/** Whether the request carrying this pin reached this sender, which holds it to the judged addresses. */
export const pinTaken = (pin: Pin): boolean => taken.has(pin);

async function sendPinned(input: string | URL | Request, init: RequestInit, pin: Pin): Promise<Response> {
  taken.add(pin);
  // Method, headers, body and signal, read exactly the way the platform's fetch reads them.
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname !== pin.host) throw fetchFailed(new Error(`${pin.host} was checked, not ${url.host}`));
  if (request.signal.aborted) throw request.signal.reason;
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined;
  assertHealthCurrent();
  request.signal.throwIfAborted();
  const answer = await exchange(url, request, body, pin);
  return responseFrom(answer, request, url);
}

/** Answers a connection's lookup with the judged addresses only, and refuses any other name. */
function judgedOnly(pin: Pin): LookupFunction {
  return (hostname, options, callback) => {
    try {
      if (hostname.toLowerCase() !== pin.host) throw new Error(`${pin.host} was checked, not ${hostname}`);
      const answers = pin.addresses.map((judged) => {
        const address = pin.dial(judged);
        return { address, family: isIP(address) };
      });
      if (options.all) callback(null, answers);
      else callback(null, answers[0]!.address, answers[0]!.family);
    } catch (error) {
      callback(error as NodeJS.ErrnoException, "");
    }
  };
}

/** Sends the request on a fresh connection to the judged addresses; a stop from the caller ends it, body included, with the caller's reason. */
function exchange(url: URL, request: Request, body: Buffer | undefined, pin: Pin): Promise<IncomingMessage> {
  const secure = url.protocol === "https:";
  return new Promise((resolve, reject) => {
    assertHealthCurrent();
    request.signal.throwIfAborted();
    let answer: IncomingMessage | undefined;
    const outgoing = (secure ? httpsRequest : httpRequest)({
      host: pin.host, port: url.port || (secure ? 443 : 80), path: `${url.pathname}${url.search}`, method: request.method,
      headers: outgoingHeaders(url, request, body), agent: false, lookup: judgedOnly(pin),
      ...(secure ? { servername: pin.host } : {}),
    }, (received) => { answer = received; resolve(received); });
    const stop = () => { answer?.destroy(request.signal.reason); outgoing.destroy(request.signal.reason); };
    outgoing.on("error", (error) => reject(request.signal.aborted ? request.signal.reason : fetchFailed(error)));
    if (request.signal.aborted) { stop(); return; }
    request.signal.addEventListener("abort", stop, { once: true });
    outgoing.on("close", () => request.signal.removeEventListener("abort", stop));
    outgoing.once("socket", (socket) => {
      const late = setTimeout(() => outgoing.destroy(new Error(`${url.host} did not open a connection in time`)), connectMs);
      socket.once("connect", () => clearTimeout(late)).once("close", () => clearTimeout(late));
    });
    outgoing.setTimeout(idleMs, () => outgoing.destroy(new Error(`${url.host} stopped answering`)));
    outgoing.end(body);
  });
}

/** The caller's headers, with what the platform's fetch adds when they are missing, and this request's own Host line and length. */
function outgoingHeaders(url: URL, request: Request, body: Buffer | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "*/*", "accept-language": "*", "sec-fetch-mode": "cors", "user-agent": "node",
    "accept-encoding": request.headers.has("range") ? "identity" : url.protocol === "https:" ? "br, gzip, deflate" : "gzip, deflate",
  };
  request.headers.forEach((value, name) => { if (!connectionHeaders.has(name)) headers[name] = value; });
  headers.host = url.host;
  if (body) headers["content-length"] = String(body.length);
  else if (request.method === "POST" || request.method === "PUT") headers["content-length"] = "0";
  return headers;
}

function responseFrom(answer: IncomingMessage, request: Request, url: URL): Response {
  const status = answer.statusCode ?? 0;
  const refuse = (why: string) => { answer.destroy(); return fetchFailed(new Error(why)); };
  if (status < 200 || status > 599) throw refuse(`${url.host} answered with status ${status}`);
  // A checked request never follows a redirect by itself: the caller asks again, and that address is checked first.
  if (request.redirect !== "manual" && redirectStatuses.has(status)) throw refuse("unexpected redirect");
  const headers = new Headers();
  for (let at = 0; at + 1 < answer.rawHeaders.length; at += 2) headers.append(answer.rawHeaders[at]!, answer.rawHeaders[at + 1]!);
  const bodiless = request.method === "HEAD" || bodilessStatuses.has(status);
  if (bodiless) answer.resume();
  const body = bodiless ? null : Readable.toWeb(decoded(answer, headers.get("content-encoding"))) as WebReadableStream<Uint8Array>;
  const response = new Response(body as ReadableStream<Uint8Array> | null, { status, statusText: answer.statusMessage ?? "", headers });
  Object.defineProperty(response, "url", { value: url.href });
  return response;
}

/** The decoders the platform's fetch applies to a compressed answer, each forgiving a missing final flush the same way. */
const gunzip = () => zlib.createGunzip({ flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH });
const decoders = new Map<string, () => NodeJS.ReadWriteStream>([
  ["gzip", gunzip], ["x-gzip", gunzip],
  ["deflate", () => zlib.createInflate({ flush: zlib.constants.Z_SYNC_FLUSH, finishFlush: zlib.constants.Z_SYNC_FLUSH })],
  ["br", () => zlib.createBrotliDecompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH, finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH })],
]);

/** The answer's body with its content codings undone, or as it came when one of them is not known. */
function decoded(answer: IncomingMessage, encoding: string | null): Readable {
  const codings = (encoding ?? "").toLowerCase().split(",").map((coding) => coding.trim()).filter(Boolean).reverse();
  if (!codings.length || codings.length > 5 || !codings.every((coding) => decoders.has(coding))) return answer;
  const stages = codings.map((coding) => decoders.get(coding)!());
  return pipeline([answer, ...stages], () => undefined) as unknown as Readable;
}

type ProxyEnv = Readonly<Record<string, string | undefined>>;

/** The proxy Branch's own calls go through (R17-S20), as Node was last told about it, or null. */
let proxyEnv: ProxyEnv | null = null;

/** Notes the proxy Node was just given; the function returned forgets it again. */
export function noteProxy(env: ProxyEnv): () => void {
  proxyEnv = env;
  return () => { if (proxyEnv === env) proxyEnv = null; };
}

/** The proxy settings Node itself was started with (NODE_USE_ENV_PROXY=1 or --use-env-proxy), or null. */
function launchProxy(): ProxyEnv | null {
  const flags = [...process.execArgv, ...(process.env.NODE_OPTIONS ?? "").split(/\s+/)];
  return process.env.NODE_USE_ENV_PROXY === "1" || flags.includes("--use-env-proxy") ? process.env : null;
}

/**
 * Whether the platform's fetch really sends through a proxy right now: whether the dispatcher Node's
 * own proxy switch puts in place (at launch, or by `http.setGlobalProxyFromEnv`) is the one its fetch
 * uses. When that cannot be seen, no request counts as carried, so each one is held.
 */
function fetchUsesProxy(): boolean {
  const slots = globalThis as unknown as Record<symbol, { constructor?: { name?: string } } | undefined>;
  const dispatcher = slots[Symbol.for("undici.globalDispatcher.2")] ?? slots[Symbol.for("undici.globalDispatcher.1")];
  return dispatcher?.constructor?.name === "EnvHttpProxyAgent";
}

/**
 * Whether a proxy carries this request: the owner's (R17-S20), or else one Node was started with.
 * The proxy looks the name up itself, so such a request cannot be held to the addresses Branch
 * judged; it goes to the proxy by name, after the same check. A request is left unheld only when the
 * platform's fetch certainly hands it to the proxy: its proxy is in place, the settings are read the
 * way it reads them, and any entry on the leave-alone list that could match the site counts.
 */
export function proxyCarries(target: URL): boolean {
  const env = proxyEnv ?? launchProxy();
  if (!env || !fetchUsesProxy()) return false;
  // As the platform's fetch reads them: a lower-case name wins whenever it is set, even to nothing,
  // and an https address goes to the http proxy when it has none of its own.
  const plain = env.http_proxy ?? env.HTTP_PROXY;
  const proxy = (target.protocol === "https:" ? (env.https_proxy ?? env.HTTPS_PROXY) : "") || plain;
  if (!proxy) return false;
  const host = target.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return !(env.no_proxy || env.NO_PROXY || "").split(/[,\s]+/).some((entry) => leftAlone(host, entry));
}

/**
 * Whether a leave-alone entry could cover this host. The platform's fetch drops one leading "." or
 * "*." and then matches the host or any name under it, so "." covers every name written with a
 * final dot. A port is ignored here and "*" covers everything, so this leaves more sites alone than
 * the fetch does, never fewer.
 */
function leftAlone(host: string, entry: string): boolean {
  if (!entry) return false;
  const name = entry.toLowerCase().replace(/:\d+$/, "").replace(/^\*?\./, "");
  return name === "*" || host === name || host.endsWith(`.${name}`);
}
