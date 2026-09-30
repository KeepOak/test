import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { Completion, CompletionRequest } from "../contracts.js";
import { NativeCapture } from "./claude-subscription-capture.js";
import { maximumNativeRequestBytes, type NativeInventory } from "./claude-subscription-history.js";
import { canonicalNativePayload } from "./claude-subscription-continuation.js";
import { currentAccountCall, withAccountCall, type AccountCall } from "../accounts/context.js";

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
/**
 * selfdev: Claude Code attaches its context reminders to the newest user turn, so the turn that carried them last
 * round no longer matches this round, and the cache marker it puts at the very end is never reached again: every
 * round of a long task paid for its whole history. One more marker, on the message just before the newest user
 * turn (the history that stays the same next round), lets the next round read that history from the cache. Nothing
 * else in the request changes; a request that cannot be read, or already has the four markers allowed, is sent as is.
 */
export function cacheHistory(payload: Buffer): Buffer {
  let body: { messages?: { role?: string; content?: unknown }[] };
  try { body = JSON.parse(payload.toString("utf8")); } catch { return payload; }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const markers = (payload.toString("utf8").match(/"cache_control":/g) ?? []).length;
  let newest = -1;
  for (let at = messages.length - 1; at >= 0; at--) if (messages[at]?.role === "user") { newest = at; break; }
  const target = newest > 0 ? messages[newest - 1] : undefined;
  if (!target || markers >= 4 || target.role !== "assistant") return payload;
  const blocks = typeof target.content === "string" ? [{ type: "text", text: target.content }] : target.content;
  const last = Array.isArray(blocks) ? blocks.at(-1) as Record<string, unknown> | undefined : undefined;
  if (!last || typeof last !== "object" || "cache_control" in last || !["text", "tool_use"].includes(String(last.type))
    || (last.type === "text" && !String(last.text ?? "").trim())) return payload; // Claude refuses a mark on thinking or empty text
  last.cache_control = { type: "ephemeral", ttl: "1h" };
  target.content = blocks;
  return Buffer.from(JSON.stringify(body), "utf8");
}
/** Exactly one Messages generation per armed Branch turn. Idle and native tool-loop requests are refused. */
export class NativeAdmission {
  capture: NativeCapture;
  readonly prefix = "/admit/" + randomBytes(32).toString("hex");
  url = "";
  used = false;
  denied = 0;
  status: number | null = null;
  /** When the plan limit a 429 reported resets, if the service said. */
  resetsAt: Date | null = null;
  completion: Completion | null = null;
  failure: string | null = null;
  /** selfdev: why the response could not be read, kept so a reply cut off at its ceiling is told apart. */
  error: unknown = null;
  private readonly server: Server;
  private readonly active = new Set<Promise<void>>();
  private armed = true;
  private call: AccountCall | undefined = currentAccountCall();
  constructor(private request: CompletionRequest, private inventory: NativeInventory,
    private authorize: () => void, private readonly connect: NativeConnector = connectNative, private marker = "") {
    this.capture = new NativeCapture(inventory, request);
    this.server = createServer((incoming, response) => {
      const receive = () => this.receive(incoming, response);
      const work = (this.call ? withAccountCall(this.call, receive) : receive()).catch((error: unknown) => {
        this.failure = "Native admission or response failed"; this.error = error;
        if (!response.headersSent) refuse(response, 502); else response.destroy();
      }).finally(() => this.active.delete(work));
      this.active.add(work);
    });
    this.server.headersTimeout = 10000;
    this.server.requestTimeout = 180000;
  }
  arm(request: CompletionRequest, inventory: NativeInventory, authorize: () => void, marker: string): void {
    if (this.armed || this.active.size) throw new Error("Claude subscription previous turn is not settled");
    this.request = request; this.inventory = inventory; this.authorize = authorize; this.marker = marker;
    this.call = currentAccountCall(); this.capture = new NativeCapture(inventory, request);
    this.used = false; this.denied = 0; this.status = null; this.resetsAt = null;
    this.completion = null; this.failure = null; this.error = null; this.armed = true;
  }
  async disarm(): Promise<void> {
    this.armed = false;
    await Promise.allSettled([...this.active]);
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
    if (!this.armed || this.used || this.request.signal.aborted) { this.denied++; return refuse(response, 400); }
    this.authorize(); this.request.signal.throwIfAborted(); this.used = true;
    const body = await boundedBody(incoming, this.request.signal);
    this.authorize(); this.request.signal.throwIfAborted();
    const canonical = this.marker ? canonicalNativePayload(body, this.request, this.inventory, this.marker) : body;
    const upstream = await this.connect(forwardHeaders(incoming), cacheHistory(canonical), path.search, this.request.signal);
    try { this.authorize(); this.request.signal.throwIfAborted(); } catch (error) { await upstream.body?.cancel(); throw error; }
    this.status = upstream.status;
    // selfdev: when a plan limit says when it resets (Unix seconds), the refusal can say so too.
    const reset = Number(upstream.headers.get("anthropic-ratelimit-unified-reset"));
    if (upstream.status === 429 && Number.isFinite(reset) && reset > 0) this.resetsAt = new Date(reset * 1000);
    const headers: Record<string, string> = {};
    upstream.headers.forEach((value, key) => { if (!omittedHeaders.has(key) && key !== "content-length") headers[key] = value; });
    response.writeHead(upstream.status, { ...headers, connection: "close" });
    if (upstream.status !== 200) { await upstream.body?.cancel(); response.end(); return; }
    if (!upstream.headers.get("content-type")?.includes("text/event-stream") || !upstream.body)
      throw new Error("Claude subscription official service returned no event stream");
    const reader = upstream.body.getReader();
    try {
      while (true) {
        this.request.signal.throwIfAborted(); const part = await reader.read(); this.authorize();
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
