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

/** The engine's answer to `challenge`, asked on its own `port`, under its window key. */
export function engineProof(key: string, challenge: string, port: number): string {
  return createHmac("sha256", key).update(`${label}\n${challenge}\n${port}`).digest("hex");
}

/**
 * The engine's side: the answer for a question to `proofPath`, or null when it is not one it answers. It answers only a
 * question that reached it at 127.0.0.1, the one address a window's engine has: a program holding the port there cannot
 * pass the question on to the engine at the same port by another of its addresses (::1, a wider door) and hand back
 * the answer.
 */
export function answerProof(search: URLSearchParams, key: string, local: { port?: number | undefined; address?: string | undefined }): { proof: string } | null {
  const challenge = search.get("challenge") ?? "";
  const address = (local.address ?? "").toLowerCase().replace(/^::ffff:/, "");
  if (!challengeShape.test(challenge) || !local.port || address !== "127.0.0.1") return null;
  return { proof: engineProof(key, challenge, local.port) };
}

export const newChallenge = (): string => randomBytes(32).toString("hex");

/** Whether `proof` is the engine's answer to `challenge` on `port` under `key`, compared in constant time. */
export function proofHolds(proof: unknown, key: string, challenge: string, port: number): boolean {
  if (typeof proof !== "string" || !/^[a-f0-9]{64}$/.test(proof) || !/^[a-f0-9]{64}$/.test(key)) return false;
  return timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(engineProof(key, challenge, port), "hex"));
}

/** The loopback address and port of an engine's origin, or null for anything else (a key never goes elsewhere). */
function loopbackPort(origin: string): number | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) return null;
    return Number(url.port);
  } catch { return null; }
}

export interface ProofWatch {
  /** Resolves true once the program at the address has proved it is the engine, false when it could not. */
  proved: Promise<boolean>;
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
  let settle!: (value: boolean) => void;
  let finish!: () => void;
  const proved = new Promise<boolean>((resolve) => { settle = resolve; });
  const ended = new Promise<void>((resolve) => { finish = resolve; });
  let answered = false;
  if (port === null) { settle(false); return { proved, ended, close: () => undefined }; }
  const challenge = newChallenge();
  const asked = httpRequest({ host: "127.0.0.1", port, method: "GET", agent: false,
    path: `${proofPath}?challenge=${challenge}&hold=1`, headers: { accept: "application/json" } });
  const timer = setTimeout(() => { if (!answered) asked.destroy(new Error("No answer in time")); }, timeoutMs);
  timer.unref?.();
  const done = () => { clearTimeout(timer); if (!answered) settle(false); else finish(); };
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
      let proof: unknown;
      try { proof = (JSON.parse(line.slice(0, end)) as { proof?: unknown }).proof; } catch { proof = null; }
      if (!proofHolds(proof, key, challenge, port)) { asked.destroy(); return; }
      answered = true;
      clearTimeout(timer);
      settle(true);
    });
    response.on("error", done);
  });
  asked.end();
  return { proved, ended, close: () => asked.destroy() };
}

/** Asks once, without holding the connection: whether the program at `origin` is the engine holding `key`. */
export async function proveOnce(origin: string, key: string, timeoutMs = 5000): Promise<boolean> {
  const watch = watchEngine(origin, key, timeoutMs);
  try { return await watch.proved; } finally { watch.close(); }
}
