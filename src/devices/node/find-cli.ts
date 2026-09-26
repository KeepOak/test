import { createRequire } from "node:module";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { makeTailscaleStatus, readStatus, type TailscaleStatus } from "../../remote/tailscale.js";
import type { Capability, DevicePlatform } from "../capabilities.js";
import { openMdnsSocket, type OpenMdnsSocket } from "../dns-sd.js";
import { Findable, localAddresses, type PendingOffer } from "../findable.js";
import { nodePort } from "../hello.js";
import { pairNode, type NodeIdentity } from "./client.js";

/**
 * find-computers: `branch node pair` with nothing after it. This computer waits to be found, for ten minutes at most:
 * the node door opens on its private addresses (Tailscale's among them) and `_branch-node._tcp` is advertised on the
 * local network with its name and the door's port. When the owner picks it in Pair another computer, the offer (a
 * link and a name, never a number) is shown here, and the person here types the six-digit number shown over there.
 * Then the normal pairing follows. Being found stops the moment the number is typed, or when the time runs out.
 */
export interface FindCliParts {
  status?: TailscaleStatus;
  openMdns?: OpenMdnsSocket;
  addresses?: () => string[];
  port?: number;
  timeoutMs?: number;
  readLine?: (prompt: string) => Promise<string>;
}
export interface FindCliDeps {
  dir: string; platform: DevicePlatform; env: NodeJS.ProcessEnv; offers: Capability[]; name?: string;
  print: (line: string) => void; signal?: AbortSignal; fetch?: typeof fetch; parts?: FindCliParts;
}

async function askLine(prompt: string): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stdout });
  try { return await lines.question(prompt); } finally { lines.close(); }
}

async function tailnetAddress(status: TailscaleStatus): Promise<string | null> {
  const printed = await status();
  try { return printed ? readStatus(printed).address : null; } catch { return null; } // not signed in: the local network only
}

/** Waits until an offer is held, the wait ends, or this command is stopped. */
async function offered(findable: Findable, signal?: AbortSignal): Promise<PendingOffer | null> {
  while (findable.waiting && !signal?.aborted) {
    const offer = findable.offer();
    if (offer) return offer;
    await sleep(300, undefined, signal ? { signal } : undefined).catch(() => undefined);
  }
  return null;
}

export async function findAndPair(deps: FindCliDeps): Promise<NodeIdentity | null> {
  const parts = deps.parts ?? {};
  const name = (deps.name ?? hostname()).slice(0, 80) || "Branch";
  const version = String(createRequire(import.meta.url)("../../../package.json").version);
  const tailnet = await tailnetAddress(parts.status ?? makeTailscaleStatus());
  const lan = parts.addresses ?? localAddresses;
  const findable = new Findable({ hello: () => ({ branch: "hello", name, platform: deps.platform, version }), name,
    port: parts.port ?? nodePort(deps.env), openMdns: parts.openMdns ?? openMdnsSocket, ...(parts.timeoutMs ? { timeoutMs: parts.timeoutMs } : {}),
    addresses: () => [...lan(), ...(tailnet ? [tailnet] : [])] });
  deps.signal?.addEventListener("abort", () => void findable.stop(), { once: true });
  for (const problem of await findable.start()) deps.print(`Could not open here: ${problem}`);
  deps.print(`Waiting to be found as "${name}" for ten minutes. On the computer running Branch, open Pair another computer and pick this one. Press Ctrl+C to stop.`);
  const offer = await offered(findable, deps.signal);
  if (!offer) {
    await findable.stop();
    deps.print(deps.signal?.aborted ? "Stopped. This computer is no longer waiting to be found." : "Nobody picked this computer in time. Nothing is advertised any more.");
    return null;
  }
  deps.print(`"${offer.name}" at ${offer.hub} offers to pair this computer.`);
  const code = (await (parts.readLine ?? askLine)("Type the six-digit number shown there: ")).replace(/\s/g, "");
  await findable.use(); // no longer found: the goodbye is sent and the door closes before pairing
  return pairNode(deps.dir, offer.link, code, { platform: deps.platform, offers: deps.offers, name, log: deps.print,
    ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.signal ? { signal: deps.signal } : {}) });
}
