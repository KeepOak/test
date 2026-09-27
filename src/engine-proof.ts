import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";

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
function loopbackPort(origin: string): number | null {
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

export interface ProofWatch {
  /** Resolves with the engine's process (its boot) once the program at the address has proved it is the engine, or null. */
  proved: Promise<string | null>;
  /** Resolves when the proved connection ends (the engine stopped); never when it did not prove itself. */
  ended: Promise<void>;
  close(): void;
}

/**
 * Asks the program at `origin` to prove it is the engine holding `key`, and keeps that one connection open: the engine
 * holds its answer open, so the moment the engine's process ends, the connection ends with it and `ended` resolves.
 * Nothing here carries the key: only the challenge goes out.
 */
export function watchEngine(origin: string, key: string, timeoutMs = 5000): ProofWatch {
  const port = loopbackPort(origin);
  let settle!: (value: string | null) => void;
  let finish!: () => void;
  const proved = new Promise<string | null>((resolve) => { settle = resolve; });
  const ended = new Promise<void>((resolve) => { finish = resolve; });
  let answered = false;
  if (port === null) { settle(null); return { proved, ended, close: () => undefined }; }
  const challenge = newChallenge();
  const asked = httpRequest({ host: "127.0.0.1", port, method: "GET", agent: false,
    path: `${proofPath}?challenge=${challenge}&hold=1`, headers: { accept: "application/json" } });
  const timer = setTimeout(() => { if (!answered) asked.destroy(new Error("No answer in time")); }, timeoutMs);
  timer.unref?.();
  const done = () => { clearTimeout(timer); if (!answered) settle(null); else finish(); };
  asked.on("error", done);
  asked.on("close", done);
  asked.on("response", (response: IncomingMessage) => {
    if (response.statusCode !== 200) { response.resume(); asked.destroy(); return; }
    let line = "";
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      if (answered) return; // the engine's keep-alive newlines
      line += chunk;
      if (line.length > 512) { asked.destroy(); return; }
      const end = line.indexOf("\n");
      if (end < 0) return;
      const said = parsed(line.slice(0, end));
      if (!proofHolds(said.proof, key, challenge, port, said.boot)) { asked.destroy(); return; }
      answered = true;
      clearTimeout(timer);
      settle(said.boot as string);
    });
    response.on("error", done);
  });
  asked.end();
  return { proved, ended, close: () => asked.destroy() };
}

/** Asks once, without holding the connection: the boot of the engine holding `key` at `origin`, or null when it is not. */
export async function proveOnce(origin: string, key: string, timeoutMs = 5000): Promise<string | null> {
  const watch = watchEngine(origin, key, timeoutMs);
  try { return await watch.proved; } finally { watch.close(); }
}
