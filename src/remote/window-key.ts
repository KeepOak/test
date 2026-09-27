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

/**
 * Requests that came through a door rather than this computer's own window: the paired door, a paired phone's own
 * key, or a caller beyond this computer. Switching Lockdown off is refused to them (src/other-api.ts): a phone's
 * screen greys it, and the engine holds to it whatever the phone sends.
 */
const doorRequests = new WeakSet<object>();
export const markDoorRequest = (request: object): void => { doorRequests.add(request); };
export const throughADoor = (request: object): boolean => doorRequests.has(request);
export const lockdownOffHereOnly = "Lockdown can only be switched off in the app on this computer.";
/** Said to a door asking to make something that would outlast a removed phone, or to widen where Branch is reached. */
export const hereOnly = "That can only be done in the app on this computer.";
/**
 * What a door may never change: making a short-lived key or a phone invitation (either would outlast the phone that
 * made it once that phone is removed) and where Branch listens. Switching the phone door is refused where it is
 * handled (src/server.ts). Looking stays open.
 *
 * Nor anything else that keeps working after the phone that made it is removed: an outgoing webhook (or switching a
 * stopped one back on; a trigger is switched back on in src/server.ts, where the body says which way), a trigger and its
 * secret, a chat app's token or setup, letting a new chat account reach the assistant, and a person's sign-in code, the
 * services people sign in with, an outside sign-in tied to a person, or a new person with a PIN (each makes a person's
 * key). Removing one of these stays open to a door.
 */
const outlastsAPhone = [
  /^\/api\/(tokens|listen|deployment\/remote\/invite)$/,
  /^\/api\/webhooks$/,
  /^\/api\/webhooks\/[a-f0-9-]{36}\/enable$/,
  /^\/api\/triggers$/, /^\/api\/triggers\/[a-f0-9-]{36}\/rotate-secret$/,
  /^\/api\/channel-setup(\/|$)/, /^\/api\/channels\/pairings\/approve$/,
  /^\/api\/people\/settings$/, /^\/api\/people\/[a-f0-9-]{36}\/reset-code$/, /^\/api\/people\/links\/confirm$/,
  /^\/api\/profiles$/,
];
/**
 * What a door may not even read, nor change: the address each chat service posts to carries that service's own secret
 * word, which a phone would keep after it is removed, and its settings keep the old addresses without one answered.
 */
const secretToADoor = [/^\/api\/channels\/addresses(\/|$)/];
/**
 * Deleting conversations for good (src/conversation-actions.ts, and the retention sweep, src/retention.ts): only in the
 * app on this computer, never a phone.
 */
const permanentHereOnly = [/^\/api\/sessions\/[a-f0-9-]{36}\/delete-now$/, /^\/api\/sessions\/put-away\/empty$/, /^\/api\/retention\/prune$/];
export function hereOnlyRefusal(method: string | undefined, path: string): string | null {
  if (secretToADoor.some((route) => route.test(path))) return hereOnly;
  if (method === "GET" || method === "HEAD") return null;
  return [...outlastsAPhone, ...permanentHereOnly].some((route) => route.test(path)) ? hereOnly : null;
}
