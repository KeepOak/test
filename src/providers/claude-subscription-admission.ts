import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { Completion, CompletionRequest } from "../contracts.js";
import { NativeCapture } from "./claude-subscription-capture.js";
import { maximumNativeRequestBytes, type NativeInventory } from "./claude-subscription-history.js";

export type NativeConnector = (headers: Record<string, string>, payload: Buffer, query: string, signal: AbortSignal) => Promise<Response>;
/** Production has one fixed first-party origin, verified by Node TLS; no environment endpoint or redirect applies. */
export const connectNative: NativeConnector = (headers, payload, query, signal) => new Promise((resolve, reject) => {
  let response: IncomingMessage | undefined;
  const call = httpsRequest({ hostname: "api.anthropic.com", port: 443, servername: "api.anthropic.com",
    rejectUnauthorized: true, method: "POST", path: "/v1/messages" + query,
    headers: { ...headers, "content-length": String(payload.length), "accept-encoding": "identity" } }, (incoming) => {
    response = incoming;
    const kept = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) kept.set(key, Array.isArray(value) ? value.join(", ") : value);
    const body = Readable.toWeb(incoming) as ReadableStream<Uint8Array>;
    resolve(new Response(body, { status: incoming.statusCode ?? 502, headers: kept }));
    incoming.once("close", () => signal.removeEventListener("abort", stop));
  });
  const stop = (): void => { call.destroy(new Error("Claude subscription request cancelled")); response?.destroy(); };
  call.once("error", () => reject(new Error("Claude subscription could not reach its official service")));
  call.once("close", () => { if (!response) signal.removeEventListener("abort", stop); });
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop(); else call.end(payload);
});
const omittedHeaders = new Set(["host", "connection", "content-length", "transfer-encoding", "proxy-authorization", "proxy-connection", "accept-encoding"]);
function forwardHeaders(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers))
    if (value !== undefined && !omittedHeaders.has(key)) headers[key] = Array.isArray(value) ? value.join(", ") : value;
  return headers;
}
async function boundedBody(request: IncomingMessage, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const value of request) {
    signal.throwIfAborted(); const chunk = Buffer.from(value as Uint8Array); size += chunk.length;
    if (size > maximumNativeRequestBytes) throw new Error("Claude subscription native request exceeds 8 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function refuse(response: ServerResponse, status: number): void {
  response.writeHead(status, { "content-type": "application/json", connection: "close" });
  response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "BRANCH_NATIVE_ADMISSION_REFUSED" } }));
}
/** Exactly one Messages generation. Native authentication is forwarded in memory and never logged or saved. */
export class NativeAdmission {
  readonly capture: NativeCapture;
  readonly prefix = "/admit/" + randomBytes(32).toString("hex");
  url = "";
  used = false;
  denied = 0;
  status: number | null = null;
  completion: Completion | null = null;
  failure: string | null = null;
  private readonly server: Server;
  private readonly active = new Set<Promise<void>>();
  constructor(private readonly request: CompletionRequest, inventory: NativeInventory,
    private readonly authorize: () => void, private readonly connect: NativeConnector = connectNative) {
    this.capture = new NativeCapture(inventory, request);
    this.server = createServer((incoming, response) => {
      const work = this.receive(incoming, response).catch(() => {
        this.failure = "Native admission or response failed";
        if (!response.headersSent) refuse(response, 502); else response.destroy();
      }).finally(() => this.active.delete(work));
      this.active.add(work);
    });
    this.server.headersTimeout = 10000;
    this.server.requestTimeout = 180000;
  }
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => { this.server.removeListener("error", reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Claude subscription relay did not bind loopback");
    this.url = `http://127.0.0.1:${address.port}${this.prefix}`;
  }
  private async receive(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(incoming.url ?? "/", "http://127.0.0.1");
    if (incoming.method !== "POST" || path.pathname !== this.prefix + "/v1/messages" || incoming.headers.origin || incoming.headers["content-encoding"])
      return refuse(response, 404);
    if (this.used || this.request.signal.aborted) { this.denied++; return refuse(response, 400); }
    this.authorize(); this.request.signal.throwIfAborted(); this.used = true;
    const body = await boundedBody(incoming, this.request.signal);
    this.authorize(); this.request.signal.throwIfAborted();
    const upstream = await this.connect(forwardHeaders(incoming), body, path.search, this.request.signal);
    this.status = upstream.status;
    const headers: Record<string, string> = {};
    upstream.headers.forEach((value, key) => { if (!omittedHeaders.has(key) && key !== "content-length") headers[key] = value; });
    response.writeHead(upstream.status, { ...headers, connection: "close" });
    if (upstream.status !== 200) { await upstream.body?.cancel(); response.end(); return; }
    if (!upstream.headers.get("content-type")?.includes("text/event-stream") || !upstream.body)
      throw new Error("Claude subscription official service returned no event stream");
    const reader = upstream.body.getReader();
    try {
      while (true) {
        this.request.signal.throwIfAborted(); const part = await reader.read();
        if (part.done) break;
        this.capture.feed(part.value); response.write(part.value);
      }
      this.request.signal.throwIfAborted(); this.authorize();
      this.completion = this.capture.result(); response.end();
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await Promise.allSettled([...this.active]);
  }
}
