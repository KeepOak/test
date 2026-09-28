import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";

/**
 * Proving that the program at an engine's address is that engine, before the window's key is sent there.
 *
 * The desktop window signs its requests with the window's key. When the engine it talks to stops (a background engine
 * restarting, an update), its port is free for a moment, and any program on this computer could take it and collect
 * the key from the window's next request. So the window asks first, with no key: it sends a fresh random challenge,
 * and only the real engine, which holds the key, can answer with the challenge signed with that key. The answer also
 * names the port the engine really accepted the question on, so a program on the old port cannot pass the question on
 * to the real engine at another port and hand back its answer.
 *
 * The answer reveals nothing about the key (it is an HMAC of a challenge the asker chose, under a label used for
 * nothing else), so it is given to any program on this computer without a key.
 */
export const proofPath = "/api/engine-proof";
const label = "branch-engine-proof-v1";
const challengeShape = /^[a-f0-9]{64}$/;
const bootShape = /^[a-f0-9]{32}$/;
const hex64 = /^[a-f0-9]{64}$/;

/**
 * What the window sends and checks once the engine has proved itself (the engine's side is in src/server.ts):
 *
 * - The window signs its requests with a key made for this one engine's process (`sessionKey`), never with the window
 *   key itself. A request signed just before the engine stopped can still reach whatever takes its port a moment later
 *   (the computer keeps trying to connect for a while); what it carries then is a key no engine running now accepts.
 * - Each request asks for a mark (`askHeader`, a fresh random value), and the engine answers with it signed and bound
 *   to the port it answered at (`answerHeader`), only at 127.0.0.1. An answer without the right mark did not come from
 *   the engine, and the window refuses it before the page reads a byte of it.
 */
export const askHeader = "x-branch-ask";
export const answerHeader = "x-branch-answer";

/** A fresh value naming one engine's process: its session key and its marks hold only while that process runs. */
export const newBoot = (): string => randomBytes(16).toString("hex");

/** Whether `supplied` is exactly `wanted`, compared in constant time. */
export function sameKey(supplied: unknown, wanted: string): boolean {
  if (typeof supplied !== "string") return false;
  const given = Buffer.from(supplied), expected = Buffer.from(wanted);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const mac = (key: string, text: string): string => createHmac("sha256", key).update(text).digest("hex");
const sameHex = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));

/** The engine's answer to `challenge`, asked on its own `port`, under its window key, from the process named `boot`. */
export function engineProof(key: string, challenge: string, port: number, boot: string): string {
  return mac(key, `${label}\n${challenge}\n${port}\n${boot}`);
}

type Local = { port?: number | undefined; address?: string | undefined };

/** The port a request reached the engine at, when it reached it at 127.0.0.1, the one address a window's engine has. */
export function atWindowAddress(local: Local): number | null {
  const address = (local.address ?? "").toLowerCase().replace(/^::ffff:/, "");
  return local.port && address === "127.0.0.1" ? local.port : null;
}

/**
 * The engine's side: the answer for a question to `proofPath`, or null when it is not one it answers. It answers only a
 * question that reached it at 127.0.0.1: a program holding the port there cannot pass the question on to the engine at
 * the same port by another of its addresses (::1, a wider door) and hand back the answer.
 */
export function answerProof(search: URLSearchParams, key: string, local: Local, boot: string): { proof: string; boot: string } | null {
  const challenge = search.get("challenge") ?? "";
  const port = atWindowAddress(local);
  if (!challengeShape.test(challenge) || port === null || !bootShape.test(boot)) return null;
  return { proof: engineProof(key, challenge, port, boot), boot };
}

export const newChallenge = (): string => randomBytes(32).toString("hex");

/** Whether `proof` is the engine's answer to `challenge` on `port` under `key` from `boot`, compared in constant time. */
export function proofHolds(proof: unknown, key: string, challenge: string, port: number, boot: unknown): boolean {
  if (typeof proof !== "string" || !hex64.test(proof) || !hex64.test(key) || typeof boot !== "string" || !bootShape.test(boot)) return false;
  return sameHex(proof, engineProof(key, challenge, port, boot));
}

/** The key the window signs with for the engine's process `boot`: the window key's shape, useless to any other process. */
export function sessionKey(key: string, boot: string): string {
  return mac(key, `branch-window-session-v1\n${boot}`);
}

/** The engine's side: whether `supplied` is its session key (it then stands for the window key), in constant time. */
export function isSessionKey(supplied: string, key: string, boot: string): boolean {
  return hex64.test(supplied) && hex64.test(key) && sameHex(supplied, sessionKey(key, boot));
}

/** The engine's mark on its answer to the request that asked with `ask`, at `port`, from `boot`. */
export function answerMark(key: string, ask: string, port: number, boot: string): string {
  return mac(key, `branch-answer-v1\n${ask}\n${port}\n${boot}`);
}

/** The engine's side: the mark for a request that asked for one at 127.0.0.1, or null. */
export function markFor(ask: unknown, key: string, local: Local, boot: string): string | null {
  const port = atWindowAddress(local);
  if (typeof ask !== "string" || !bootShape.test(ask) || port === null) return null;
  return answerMark(key, ask, port, boot);
}

/** Whether an answer's `mark` is the engine's, for the request that asked with `ask` at `port`, from `boot`. */
export function markHolds(mark: unknown, key: string, ask: string, port: number, boot: string): boolean {
  if (typeof mark !== "string" || !hex64.test(mark) || !hex64.test(key)) return false;
  return sameHex(mark, answerMark(key, ask, port, boot));
}

/** A fresh value a request asks its answer to be marked with. */
export const newAsk = (): string => randomBytes(16).toString("hex");

/** The loopback address and port of an engine's origin, or null for anything else (a key never goes elsewhere). */
export function loopbackPort(origin: string): number | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) return null;
    return Number(url.port);
  } catch { return null; }
}

function parsed(line: string): { proof?: unknown; boot?: unknown } {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === "object" ? value as { proof?: unknown; boot?: unknown } : {};
  } catch { return {}; }
}

/* ---------- the engine's side: the door the proof is asked at ---------- */

/**
 * How many keyless proofs are answered and how many held connections are kept: a program on this computer that asks
 * again and again is told to wait (429) instead of using the engine up. A proof is one short answer; holding the
 * connection after it is only for the desktop window, which asks with its session key.
 */
export class ProofDoor {
  private readonly recent: number[] = [];
  private readonly held = new Set<ServerResponse>();
  constructor(private readonly perSecond = 64, private readonly mostHeld = 32, private readonly now: () => number = Date.now) {}

  /** Whether one more keyless proof is answered now. */
  mayAnswer(): boolean {
    const at = this.now();
    while (this.recent.length && this.recent[0]! <= at - 1000) this.recent.shift();
    if (this.recent.length >= this.perSecond) return false;
    this.recent.push(at);
    return true;
  }

  get holding(): number { return this.held.size; }

  /** Keeps `response` open as a held connection, when there is room for one more. */
  hold(response: ServerResponse): boolean {
    if (this.held.size >= this.mostHeld) return false;
    this.held.add(response);
    response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.write("\n");
    const alive = setInterval(() => response.write("\n"), 20000);
    alive.unref();
    response.once("close", () => { clearInterval(alive); this.held.delete(response); });
    return true;
  }
}

/** A short answer with its length, so the asker's connection stays open for what it sends next. */
export function answerShort(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff",
    "content-length": String(Buffer.byteLength(body)) });
  response.end(body);
}

/* ---------- the asker's side: a connection proved to reach the engine ---------- */

/** One answer read straight off `socket`: its status and headers, and with `withBody` its body (it must give a length). */
function readAnswer(socket: Socket, withBody: boolean, limit = 8192): Promise<{ status: number; headers: Map<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    let seen = Buffer.alloc(0);
    const stop = (error: Error | null, value?: { status: number; headers: Map<string, string>; body: string }) => {
      socket.off("data", onData); socket.off("error", onEnd); socket.off("close", onEnd);
      if (error) reject(error); else resolve(value!);
    };
    const onEnd = () => stop(new Error("The connection ended before an answer."));
    const onData = (chunk: Buffer) => {
      seen = Buffer.concat([seen, chunk]);
      if (seen.length > limit) { stop(new Error("The answer was too long.")); return; }
      const end = seen.indexOf("\r\n\r\n");
      if (end < 0) return;
      const [statusLine, ...lines] = seen.subarray(0, end).toString("latin1").split("\r\n");
      const status = Number(/^HTTP\/1\.1 (\d{3}) /.exec(statusLine ?? "")?.[1] ?? 0);
      const headers = new Map(lines.map((line) => [line.slice(0, line.indexOf(":")).trim().toLowerCase(), line.slice(line.indexOf(":") + 1).trim()]));
      if (!withBody) { stop(null, { status, headers, body: "" }); return; }
      const length = Number(headers.get("content-length") ?? NaN);
      if (!Number.isInteger(length) || length < 0 || headers.has("transfer-encoding")) { stop(new Error("The answer did not say its length.")); return; }
      const rest = seen.subarray(end + 4);
      if (rest.length < length) return;
      if (rest.length > length) { stop(new Error("More came than was asked for.")); return; }
      stop(null, { status, headers, body: rest.toString("utf8") });
    };
    socket.on("data", onData);
    socket.once("error", onEnd);
    socket.once("close", onEnd);
  });
}

/**
 * Opens a connection to 127.0.0.1:`port` and asks, on it and with no key, for the engine's proof. Resolves with the
 * connection once the answer holds for `key`, with the engine process it names; nothing else is ever sent on a
 * connection before that, so what is sent after it reaches the engine or nothing (a connection, once made, goes to the
 * process that took it, and ends with it).
 */
export function provenSocket(port: number, key: string, timeoutMs = 5000): Promise<{ socket: Socket; boot: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    socket.setNoDelay(true);
    const late = setTimeout(() => socket.destroy(new Error("No answer in time.")), timeoutMs);
    late.unref?.();
    const fail = (error: Error) => { clearTimeout(late); socket.destroy(); reject(error); };
    socket.once("error", fail);
    socket.once("connect", () => {
      const challenge = newChallenge();
      socket.write(`GET ${proofPath}?challenge=${challenge} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: application/json\r\n\r\n`);
      readAnswer(socket, true).then((answer) => {
        const said = parsed(answer.body.trim());
        if (answer.status !== 200 || !proofHolds(said.proof, key, challenge, port, said.boot)) { fail(new Error(`Not Branch's engine (${answer.status}).`)); return; }
        clearTimeout(late);
        socket.off("error", fail);
        resolve({ socket, boot: said.boot as string });
      }, fail);
    });
  });
}

export interface ProofWatch {
  /** Resolves with the engine's process (its boot) once the program at the address has proved it is the engine, or null. */
  proved: Promise<string | null>;
  /** Resolves when the proved connection ends (the engine stopped); never when it did not prove itself. */
  ended: Promise<void>;
  close(): void;
}

/**
 * Asks the program at `origin` to prove it is the engine holding `key`, then, on that same proved connection and with
 * the session key for the engine's process, asks it to hold the connection open: the moment the engine's process ends,
 * the connection ends with it and `ended` resolves. The window key itself is never sent.
 */
export function watchEngine(origin: string, key: string, timeoutMs = 5000): ProofWatch {
  const port = loopbackPort(origin);
  let settle!: (value: string | null) => void;
  let finish!: () => void;
  const proved = new Promise<string | null>((resolve) => { settle = resolve; });
  const ended = new Promise<void>((resolve) => { finish = resolve; });
  let closed = false;
  let current: Socket | null = null;
  if (port === null) { settle(null); return { proved, ended, close: () => undefined }; }
  void provenSocket(port, key, timeoutMs).then(({ socket, boot }) => {
    current = socket;
    if (closed) { socket.destroy(); settle(null); return; }
    const late = setTimeout(() => socket.destroy(), timeoutMs);
    late.unref?.();
    socket.write(`GET ${proofPath}?hold=1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${sessionKey(key, boot)}\r\n\r\n`);
    readAnswer(socket, false).then((answer) => {
      clearTimeout(late);
      if (answer.status !== 200) { socket.destroy(); settle(null); return; }
      socket.on("data", () => undefined); // the engine's keep-alive newlines
      socket.once("close", () => finish());
      socket.on("error", () => undefined);
      settle(boot);
    }, () => { clearTimeout(late); socket.destroy(); settle(null); });
  }, () => settle(null));
  return { proved, ended, close: () => { closed = true; current?.destroy(); } };
}

/** Asks once, and closes the connection: the boot of the engine holding `key` at `origin`, or null when it is not. */
export async function proveOnce(origin: string, key: string, timeoutMs = 5000): Promise<string | null> {
  const port = loopbackPort(origin);
  if (port === null) return null;
  try {
    const { socket, boot } = await provenSocket(port, key, timeoutMs);
    socket.destroy();
    return boot;
  } catch { return null; }
}
