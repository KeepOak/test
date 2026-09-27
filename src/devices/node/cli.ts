import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { capabilityInfo, CapabilitySchema, type DevicePlatform } from "../capabilities.js";
import { NodeActions } from "./actions.js";
import { loadIdentity, NodeClient, pairNode, saveIdentity } from "./client.js";
import type { NodeOs } from "./commands.js";
import { findAndPair, type FindCliParts } from "./find-cli.js"; // find-computers

/**
 * mac7/nodes: `branch node …`, the small mode of the `branch` command that lends this computer to
 * the owner's Branch elsewhere. It opens no database, no workspace and no window, and dials out. The one
 * time it listens is `branch node pair` with no link: for ten minutes at most it waits to be found (the
 * node door on its private addresses, and `_branch-node._tcp` on the local network; src/devices/findable.ts).
 *
 *   branch node pair [--name "Kitchen Mac"]                   wait to be found by Pair another computer, then type its number
 *   branch node pair <link> <number> [--name "Kitchen Mac"]   answer an invitation from the Devices card
 *   branch node run                                           stay connected (reconnects by itself)
 *   branch node status                                        what this computer is paired with and can offer
 *   branch node never <capability,…>                          refuse these here, whatever Branch says
 *   branch node forget                                        remove this computer's key and pairing
 */
export interface NodeCliDeps {
  argv: string[]; env: NodeJS.ProcessEnv; platform: NodeJS.Platform;
  print: (line: string) => void; signal?: AbortSignal;
  actions?: NodeActions; fetch?: typeof fetch;
  /** find-computers: stand-ins for the network and the keyboard while waiting to be found (tests). */
  find?: FindCliParts;
}

export function nodeDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (env.BRANCH_NODE_DIR) return env.BRANCH_NODE_DIR;
  if (platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Branch", "node");
  return join(homedir(), ".branch-node");
}

export const nodeUsage = [
  "branch node pair [--name NAME]                   Wait (up to ten minutes) to be found by Pair another computer",
  "branch node pair <link> <number> [--name NAME]   Pair this computer using the link and number from Devices",
  "branch node run                                  Stay connected to Branch (dials out; nothing listens here)",
  "branch node status                               Show what this computer is paired with and could offer",
  "branch node never <capability,...>                Refuse these here whatever Branch says (or \"none\")",
  "branch node forget                               Remove this computer's key and pairing",
].join("\n");

const flag = (argv: string[], name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};

/** find-computers: `branch node pair` with no link: wait to be found, then the number typed here. */
async function findThenPair(deps: NodeCliDeps, dir: string, platform: DevicePlatform, actions: NodeActions): Promise<number> {
  const stop = new AbortController();
  const quit = (): void => stop.abort();
  process.once("SIGINT", quit);
  deps.signal?.addEventListener("abort", quit, { once: true });
  try {
    const name = flag(deps.argv.slice(1), "--name");
    const identity = await findAndPair({ dir, platform, env: deps.env, offers: await actions.available(), print: deps.print, signal: stop.signal,
      ...(name ? { name } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}), ...(deps.find ? { parts: deps.find } : {}) });
    if (!identity) return 1;
    deps.print(`Paired as "${identity.name}". Everything starts switched off; the owner switches things on in Devices. Now run: branch node run`);
    return 0;
  } finally { process.off("SIGINT", quit); }
}

export async function nodeCommand(deps: NodeCliDeps): Promise<number> {
  if (deps.platform !== "darwin" && deps.platform !== "linux" && deps.platform !== "win32") {
    deps.print("A Branch node runs on macOS, Linux and Windows.");
    return 1;
  }
  const os: NodeOs = deps.platform;
  const dir = nodeDir(deps.env, deps.platform);
  const [sub, ...rest] = deps.argv;
  const actions = deps.actions ?? new NodeActions({ os, env: deps.env, identityDir: dir });
  const platform: DevicePlatform = os;
  if (sub === "pair" && (rest.length === 0 || rest[0] === "--name")) return findThenPair(deps, dir, platform, actions);
  if (sub === "pair") {
    const [link, code] = rest;
    if (!link || !code) { deps.print(nodeUsage); return 1; }
    const name = flag(rest, "--name");
    const identity = await pairNode(dir, link, code, { platform, offers: await actions.available(), log: deps.print,
      ...(name ? { name } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
    deps.print(`Paired as "${identity.name}". Everything starts switched off; the owner switches things on in Devices. Now run: branch node run`);
    return 0;
  }
  if (sub === "run") {
    const identity = await loadIdentity(dir);
    const client = new NodeClient({ identity, platform, actions, log: deps.print });
    const stop = new AbortController();
    const quit = (): void => stop.abort();
    process.once("SIGINT", quit);
    process.once("SIGTERM", quit);
    deps.signal?.addEventListener("abort", quit, { once: true });
    deps.print(`Connecting to ${identity.hub ?? "nothing yet"} as "${identity.name}". Press Ctrl+C to stop.`);
    const why = await client.run(stop.signal);
    if (why === "revoked") { deps.print("The owner took this computer off the list. Pair it again to reconnect."); return 2; }
    return 0;
  }
  if (sub === "status") {
    const identity = await loadIdentity(dir);
    const offers = await actions.available();
    deps.print(identity.deviceId ? `Paired with ${identity.hub} as "${identity.name}".` : "Not paired yet.");
    deps.print(`This computer could offer: ${offers.map((c) => capabilityInfo[c].label).join("; ") || "nothing"}.`);
    if (identity.never.length) deps.print(`Refused here whatever Branch says: ${identity.never.join(", ")}.`);
    return 0;
  }
  if (sub === "never") {
    const list = (rest[0] ?? "").split(",").map((word) => word.trim()).filter((word) => word && word !== "none");
    const never = list.map((word) => CapabilitySchema.parse(word));
    await saveIdentity(dir, { ...(await loadIdentity(dir)), never });
    deps.print(never.length ? `Refused here from now on: ${never.join(", ")}. Restart "branch node run".` : "Nothing is refused here beyond Branch's own switches.");
    return 0;
  }
  if (sub === "forget") {
    await rm(join(dir, "identity.json"), { force: true });
    deps.print("This computer's key and pairing are gone.");
    return 0;
  }
  deps.print(nodeUsage);
  return sub ? 1 : 0;
}
