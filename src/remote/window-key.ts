import { randomBytes } from "node:crypto";
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { fromThisComputer } from "../listen-address.js";
import { isTailnetAddress } from "./tailscale.js";

/**
 * The window's key, taken away from a removed phone.
 *
 * A phone let in from "Pair a phone" (src/devices/book.ts collectPhoneSession) or from a Tailscale
 * invitation (POST /api/pair) is handed the window's own key. Forgetting its "this exact phone"
 * secret closes the paired door's device step, but a listener opened to the private network checks
 * the key alone. So removing such a phone makes a new key: saved where the first one is
 * (`session-token` in the data folder), then used in place of the old one. The window on this
 * computer is handed it (the desktop app reads the file again); a phone that still belongs collects
 * it over the paired door with its own secret (`renewPath`); the removed phone has no way to.
 */
export const windowKeyFile = "session-token";
/** A phone that still belongs asks for the window's current key here, on the paired door, with its own secret. */
export const renewPath = "/api/pair/renew";

/** A fresh key, saved over `session-token` without ever leaving the file half written or following a link. */
export async function writeNewWindowKey(dataDir: string): Promise<string> {
  const path = join(dataDir, windowKeyFile);
  if ((await lstat(path).catch(() => null))?.isSymbolicLink()) throw new Error("Session token must not be a link");
  const key = randomBytes(32).toString("hex");
  const next = join(dataDir, `${windowKeyFile}.${randomBytes(6).toString("hex")}.next`);
  await writeFile(next, key, { mode: 0o600, flag: "wx" });
  try {
    await renameSoon(next, path);
  } catch (error) {
    await rm(next, { force: true }).catch(() => undefined);
    throw error;
  }
  return key;
}

/** Windows refuses a rename over a file another program has open for a moment; it is tried again briefly. */
async function renameSoon(from: string, to: string): Promise<void> {
  for (let tries = 0; ; tries++) {
    try { return await rename(from, to); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (tries >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw error;
      await new Promise((done) => setTimeout(done, 25));
    }
  }
}

const bare = (address: string | undefined): string => (address ?? "").replace(/^::ffff:/i, "");
/**
 * Whether the window's key may be handed over on this connection: the paired door (Tailscale), a
 * caller on this computer, or a connection that arrived at this computer's Tailscale address from
 * another one. Plain HTTP across a home network is none of these, so it is never handed over there,
 * as POST /api/pair has only ever been served on the Tailscale door.
 */
export function keyMayTravel(request: Pick<IncomingMessage, "socket" | "headers">, viaRemote: boolean): boolean {
  if (viaRemote) return true;
  if (fromThisComputer(request.socket?.remoteAddress, request.headers)) return true;
  return isTailnetAddress(bare(request.socket?.localAddress)) && isTailnetAddress(bare(request.socket?.remoteAddress));
}
