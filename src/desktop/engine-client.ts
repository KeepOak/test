import { Agent, request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import type { Socket } from "node:net";
import { Duplex, Readable } from "node:stream";
import { answerHeader, askHeader, markHolds, newAsk, provenSocket, sessionKey } from "../engine-proof.js";
import type { EngineAccess } from "./engine-gate.js";

/**
 * Every request the desktop app sends to its engine's address: the window's (through the protocol handler in main.ts)
 * and main's own (backup, canary, update readiness, the quick-ask keys, the clipboard's files, the background engine's
 * close). Kept apart from main.ts so it can be checked without Electron.
 *
 * - Each connection is proved before anything is sent on it (src/engine-proof.ts provenSocket), for the engine process
 *   the request is signed for; a request, and its body, go only on such a connection. A connection, once made, reaches
 *   the process that took it and ends with it, so nothing reaches a program that took the port after the engine stopped.
 * - /api/ requests carry the session key for that engine process, never the window key.
 * - Each answer must carry the engine's mark for its request; one that does not is refused before its body is read.
 */
export const startingAgain = "Branch is starting its engine again. Try again in a moment.";
const notTheEngine = "The answer did not come from Branch's engine.";

export interface EngineClientOptions {
  origin: string;
  access: Pick<EngineAccess, "boot">;
  /** The window's key as it is now (removing a phone that was handed it replaces it). */
  windowKey: () => string;
  timeoutMs?: number;
}

export interface EngineRequest {
  method: string;
  /** The path and query, at the engine's address. */
  path: string;
  headers?: Record<string, string>;
  body?: Readable | Buffer | string | null;
  /** Sign it with the session key (every /api/ request is). */
  sign: boolean;
  signal?: AbortSignal | undefined;
}

const hopByHop = new Set(["host", "connection", "keep-alive", "authorization", askHeader, "transfer-encoding", "upgrade", "proxy-connection"]);

/**
 * One connection to the engine, as the http client sees it: made at once (so the pool counts it), but nothing written
 * to it goes out until the connection has proved it reaches the engine process `boot` names. What was written before
 * is held, and dropped with the connection when the proof does not come.
 */
class ProvedConnection extends Duplex {
  private socket: Socket | null = null;
  private waiting: { chunk: Buffer; done: (error?: Error | null) => void }[] = [];
  private ending: ((error?: Error | null) => void) | null = null;
  constructor(port: number, key: string, readonly boot: string, timeoutMs: number) {
    super();
    provenSocket(port, key, timeoutMs).then(({ socket, boot: proved }) => {
      if (this.destroyed) { socket.destroy(); return; }
      if (proved !== boot) { socket.destroy(); this.destroy(new Error(startingAgain)); return; }
      this.socket = socket;
      socket.on("data", (chunk: Buffer) => { if (!this.push(chunk)) socket.pause(); });
      socket.on("end", () => this.push(null));
      socket.on("error", (error) => this.destroy(error));
      socket.on("close", () => { if (!this.destroyed) this.destroy(); });
      for (const { chunk, done } of this.waiting) socket.write(chunk, done);
      this.waiting = [];
      if (this.ending) socket.end(this.ending);
    }, (error: Error) => this.destroy(error));
  }
  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    if (this.socket) this.socket.write(chunk, done);
    else this.waiting.push({ chunk, done });
  }
  override _final(done: (error?: Error | null) => void): void {
    if (this.socket) this.socket.end(done);
    else this.ending = done;
  }
  override _read(): void { this.socket?.resume(); }
  override _destroy(error: Error | null, done: (error?: Error | null) => void): void {
    this.socket?.destroy();
    for (const { done: dropped } of this.waiting) dropped(error ?? new Error(startingAgain));
    this.waiting = [];
    done(error);
  }
  // What the http pool asks of a connection.
  setKeepAlive(): this { return this; }
  setNoDelay(): this { return this; }
  setTimeout(ms: number, onTimeout?: () => void): this {
    if (this.socket) this.socket.setTimeout(ms, onTimeout);
    return this;
  }
  ref(): this { this.socket?.ref(); return this; }
  unref(): this { this.socket?.unref(); return this; }
}

export class EngineClient {
  readonly port: number;
  private readonly agent: Agent;
  constructor(private readonly options: EngineClientOptions) {
    const url = new URL(options.origin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw new Error("The engine's address is not on this computer.");
    this.port = Number(url.port);
    this.agent = new Agent({ keepAlive: true, maxSockets: 16, maxFreeSockets: 8 });
    type Asked = RequestOptions & { branchBoot?: string };
    const agent = this.agent as unknown as { getName: (options: Asked) => string; createConnection: (options: Asked) => Duplex };
    const name = agent.getName.bind(this.agent);
    // Connections are kept per engine process, so one proved for a process is never used for another's requests.
    agent.getName = (request: Asked) => `${name(request)}:${request.branchBoot ?? ""}`;
    agent.createConnection = (request: Asked) =>
      new ProvedConnection(this.port, this.options.windowKey(), request.branchBoot ?? "", this.options.timeoutMs ?? 5000);
  }

  /** Sends one request on a proved connection; resolves with the engine's answer once its mark holds. */
  send(input: EngineRequest): Promise<IncomingMessage> {
    const boot = this.options.access.boot();
    if (!boot) return Promise.reject(new Error(startingAgain));
    const session = sessionKey(this.options.windowKey(), boot), ask = newAsk();
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.headers ?? {})) if (!hopByHop.has(name.toLowerCase())) headers[name] = value;
    headers.host = `127.0.0.1:${this.port}`;
    headers[askHeader] = ask;
    if (input.sign) headers.authorization = `Bearer ${session}`;
    if (typeof input.body === "string" || Buffer.isBuffer(input.body)) headers["content-length"] = String(Buffer.byteLength(input.body));
    return new Promise((resolve, reject) => {
      const request: ClientRequest = httpRequest({ host: "127.0.0.1", port: this.port, method: input.method, path: input.path, headers,
        agent: this.agent, branchBoot: boot } as RequestOptions);
      const abort = () => request.destroy(new Error("The request was stopped."));
      if (input.signal?.aborted) { abort(); } else input.signal?.addEventListener("abort", abort, { once: true });
      request.once("socket", (socket: Duplex) => {
        // A connection of another engine process never carries this request (getName keeps them apart; this is the check).
        if (!(socket instanceof ProvedConnection) || socket.boot !== boot) request.destroy(new Error(startingAgain));
      });
      request.once("response", (answer) => {
        if (!markHolds(answer.headers[answerHeader], session, ask, this.port, boot)) {
          answer.destroy();
          request.destroy();
          reject(new Error(notTheEngine));
          return;
        }
        resolve(answer);
      });
      request.once("error", reject);
      if (input.body instanceof Readable) input.body.pipe(request);
      else request.end(input.body ?? undefined);
    });
  }

  /** A fetch for main's own requests, at this engine's address only: signed, proved and marked as above. */
  readonly fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin !== new URL(this.options.origin).origin) throw new Error("Only the engine's own address is asked here.");
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const given = init.body;
    const body = given === undefined || given === null ? null
      : typeof given === "string" ? given
        : given instanceof Uint8Array ? Buffer.from(given)
          : given instanceof ReadableStream ? Readable.fromWeb(given as import("node:stream/web").ReadableStream) // a file, streamed as it is read
            : Buffer.from(await new Response(given).arrayBuffer());
    const answer = await this.send({ method: init.method ?? "GET", path: `${url.pathname}${url.search}`, headers, body,
      sign: url.pathname.startsWith("/api/"), signal: init.signal ?? undefined });
    return webResponse(answer, init.method ?? "GET");
  };

  close(): void { this.agent.destroy(); }
}

const noBody = new Set([101, 204, 205, 304]);

/** The engine's answer as a web Response, its body streamed as it comes (and the answer ended when it is dropped). */
export function webResponse(answer: IncomingMessage, method: string): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(answer.headers)) {
    if (value === undefined || name === answerHeader) continue;
    for (const one of Array.isArray(value) ? value : [value]) headers.append(name, one);
  }
  const status = answer.statusCode ?? 502;
  const empty = noBody.has(status) || method.toUpperCase() === "HEAD";
  if (empty) answer.resume();
  return new Response(empty ? null : (Readable.toWeb(answer) as ReadableStream<Uint8Array>), { status, statusText: answer.statusMessage ?? "", headers });
}
