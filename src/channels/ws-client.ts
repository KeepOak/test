import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { acceptKey, readFrame } from "../ws.js";

/**
 * A minimal WebSocket client (RFC 6455, no extensions) for the chat services that push messages
 * over a socket instead of answering polls: Discord's gateway and Slack's Socket Mode. The server
 * pieces in src/ws.ts write unmasked frames and read masked ones, which is exactly the wrong way
 * round for a client, so the framing here masks what it sends and accepts what the server sends.
 */
export interface WebSocketConnection {
  send(text: string): void;
  close(): void;
  /** Resolves when the socket is gone, whichever side ended it. */
  readonly closed: Promise<void>;
  /** The status code in the server's close frame, once one has arrived (Discord's 4014 and the like). */
  readonly closeCode?: number | undefined;
  /** mac6/bucket-16: sends a ping frame; `onPong` runs when the server's pong comes back. */
  ping?(onPong: () => void): void;
}
export interface WebSocketOptions {
  headers?: Record<string, string>;
  onMessage: (text: string) => void;
  /** Fails a connection that never finishes its handshake. */
  timeoutMs?: number;
}
export type WebSocketConnect = (url: string, options: WebSocketOptions) => Promise<WebSocketConnection>;

/** Wraps a payload in a masked frame, which is the only shape a server accepts from a client. */
export function maskedFrame(payload: Buffer, opcode: number): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] = masked[i]! ^ mask[i % 4]!;
  const length = masked.length;
  const head = length < 126 ? Buffer.from([0x80 | opcode, 0x80 | length])
    : length < 65536 ? Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 126]), sized(length, 2)])
    : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), sized(length, 8)]);
  return Buffer.concat([head, mask, masked]);
}
function sized(length: number, bytes: number): Buffer {
  const buffer = Buffer.alloc(bytes);
  if (bytes === 2) buffer.writeUInt16BE(length);
  else buffer.writeBigUInt64BE(BigInt(length));
  return buffer;
}

/** Wait before trying a dropped connection again: base, doubling, capped at thirty seconds. */
export function reconnectDelay(attempt: number, base = 1000): number {
  return Math.min(30000, base * 2 ** Math.max(0, attempt - 1));
}

/** Opens a socket to a ws:// or wss:// address and delivers whole text messages to `onMessage`. */
export const connectWebSocket: WebSocketConnect = (address, options) =>
  new Promise((resolve, reject) => {
    const url = new URL(address);
    const secure = url.protocol === "wss:";
    if (!secure && url.protocol !== "ws:") { reject(new Error("A chat socket address must start with ws:// or wss://")); return; }
    const key = randomBytes(16).toString("base64");
    const call = secure ? httpsRequest : httpRequest;
    const outgoing = call({
      protocol: secure ? "https:" : "http:", hostname: url.hostname, port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`, method: "GET",
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-key": key, "sec-websocket-version": "13", ...options.headers },
    });
    const fail = (error: Error) => { outgoing.destroy(); reject(error); };
    outgoing.setTimeout(options.timeoutMs ?? 20000, () => fail(new Error("The chat service did not answer in time")));
    outgoing.on("error", fail);
    outgoing.on("response", (response) => fail(new Error(`The chat service refused the connection (${response.statusCode ?? 0})`)));
    outgoing.on("upgrade", (response, socket, head) => {
      if (String(response.headers["sec-websocket-accept"] ?? "") !== acceptKey(key)) { socket.destroy(); reject(new Error("The chat service answered with a bad handshake")); return; }
      resolve(attach(socket as Socket, head, options.onMessage));
    });
    outgoing.end();
  });

/** Reassembles frames into messages, answers pings, and reports the socket closing exactly once. */
function attach(socket: Socket, head: Buffer, onMessage: (text: string) => void): WebSocketConnection {
  let pending = head.length ? Buffer.from(head) : Buffer.alloc(0);
  let message = Buffer.alloc(0);
  let done = () => undefined as void;
  let closeCode: number | undefined;
  const pongs: (() => void)[] = []; // mac6/bucket-16
  const closed = new Promise<void>((resolve) => { done = resolve; });
  const drain = () => {
    for (let decoded = readFrame(pending); decoded; decoded = readFrame(pending)) {
      pending = pending.subarray(decoded.consumed);
      if (decoded.opcode === 0x8) {
        // The first two bytes of a close frame are its status code (RFC 6455 section 5.5.1).
        if (decoded.payload.length >= 2) closeCode = decoded.payload.readUInt16BE(0);
        socket.end(maskedFrame(Buffer.alloc(0), 0x8));
        return;
      }
      if (decoded.opcode === 0x9) { socket.write(maskedFrame(decoded.payload, 0xa)); continue; }
      if (decoded.opcode === 0xa) { for (const pong of pongs.splice(0)) pong(); continue; }
      message = Buffer.concat([message, decoded.payload]);
      if (!decoded.fin) continue;
      const text = message.toString("utf8");
      message = Buffer.alloc(0);
      try { onMessage(text); } catch { /* one bad message must not take the socket down */ }
    }
  };
  socket.on("data", (chunk: Buffer) => { pending = Buffer.concat([pending, chunk]); drain(); });
  // The first frames can arrive in the same packet as the handshake, so read what came with it.
  if (pending.length) setImmediate(drain);
  socket.on("close", done);
  socket.on("error", () => socket.destroy());
  socket.setTimeout(0);
  return {
    send: (text) => { if (socket.writable) socket.write(maskedFrame(Buffer.from(text, "utf8"), 0x1)); },
    close: () => {
      if (!socket.writable) { socket.destroy(); return; }
      socket.end(maskedFrame(Buffer.alloc(0), 0x8));
      // A peer that has gone silent never answers the close, so the socket is let go after a short wait.
      setTimeout(() => socket.destroy(), 5000).unref();
    },
    closed,
    get closeCode() { return closeCode; },
    // mac6/bucket-16: a client-side heartbeat for services that ask for one (Guilded).
    ping: (onPong) => { if (!socket.writable) return; pongs.push(onPong); socket.write(maskedFrame(Buffer.from("branch"), 0x9)); },
  };
}
