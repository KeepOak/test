import { z } from "zod";
import { validationText } from "../request-errors.js";
import { lockedDown } from "../lockdown.js";
import { GitSourceInput } from "./agent-git.js";
import type { Reach } from "./index.js";
import { machineViews } from "./machines.js";
import { platformSettings, saveOwnerAccounts, sendToChat, setPaused } from "./platform.js";
import { relaySettings, saveRelaySettings } from "./relay.js";
import { ReachModeSchema, ReachOffError, ReachPartSchema, reachKey, reachLabels, reachParts, requireReach } from "./settings.js";
import { saveVideoSettings, videoSettings } from "./video.js";
import { byCard, inCatalogue, recordedWrite } from "../settings-kit/recorded-write.js"; // Q48

/**
 * The web side of R17-I: the routes under /api/reach/. The server checks the owner's own profile
 * before any of them, and a short-lived key is refused every change here by the fail-closed rule in
 * src/short-lived-keys.ts — except `POST /api/reach/trunks/inbox`, which another of the owner's
 * computers sends with the "run" key the owner gave it (the same kind of key R17-076 uses), and
 * which only hands a message to a Trunk. That key is what says which computer is sending: the owner
 * pairs key and computer under `/api/reach/trunks/keys`, which is the owner's own route. Reads answer whatever the switches say; every change needs
 * its part switched on, except the switches themselves.
 */
export const handlesReachPath = (path: string): boolean => path === "/api/reach" || path.startsWith("/api/reach/");

export class ReachHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface ReachHttpDeps {
  reach: Reach; method: string; query: URLSearchParams; readBody: () => Promise<unknown>;
  /**
   * mac7/reach-leftovers: the short-lived key this request came with (src/key-context.ts), or
   * nothing when it came with this computer's own key. The Trunks inbox believes it, and not the
   * `machine` written in the message, about which computer is sending.
   */
  keyId?: string | undefined;
}

type Handler = (deps: ReachHttpDeps) => unknown;
const body = async <T extends z.ZodType>(deps: ReachHttpDeps, schema: T): Promise<z.infer<T>> => schema.parse(await deps.readBody());
const Id = z.object({ id: z.string().uuid() }).strict();
const Source = z.object({ path: z.string().max(300).optional(), url: z.string().url().max(2000).optional() }).strict();
const need = (d: ReachHttpDeps, part: Parameters<typeof requireReach>[2]): void => requireReach(d.reach.store, d.reach.owner, part);

function overview({ reach }: ReachHttpDeps) {
  const { store, owner } = reach;
  const relay = relaySettings(store, owner);
  return {
    modes: reach.modes(), labels: reachLabels, parts: reachParts,
    machineName: (() => { try { return reach.machineName(); } catch { return ""; } })(),
    video: videoSettings(store, owner),
    relay: { ...relay, health: reach.relay.health(), refused: reach.relay.refused, chats: reach.relay.knownChats().length },
    platforms: platformSettings(store, owner),
    usb: reach.usb.rules(),
    git: reach.git.sources(),
    chats: reach.deps.router.chats(owner).map((c) => ({ channel: c.channel, chatId: c.chatId, title: c.title })),
    channels: reach.deps.router.summary().channels.map((c) => c.id),
  };
}

/** GET routes. */
const reads: Record<string, Handler> = {
  "/api/reach": overview,
  "/api/reach/machines": ({ reach }) => ({ machines: reach.machines.list() }),
  "/api/reach/continuity": ({ reach }) => ({ transfers: reach.continuity.list() }),
  "/api/reach/trunks/roster": ({ reach }) => reach.remoteTrunks.shared(),
  "/api/reach/trunks/keys": ({ reach }) => ({ keys: reach.remoteTrunks.keys() }),
  "/api/reach/notes": ({ reach }) => ({ notes: reach.notes.list() }),
  "/api/reach/arena": ({ reach }) => ({ leaderboard: reach.arena.leaderboard() }),
};

/**
 * POST routes. Three of them only look, but they reach every other computer with the owner's keys
 * or run a program on this one, so they are the owner's, not a short-lived key's.
 */
const changes: Record<string, Handler> = {
  "/api/reach/continuity/start": async (d) => d.reach.continuity.start(await d.readBody()),
  "/api/reach/continuity/prepare": async (d) => d.reach.continuity.prepare(await d.readBody()),
  "/api/reach/continuity/preview": async (d) => d.reach.continuity.preview(await d.readBody()),
  "/api/reach/continuity/retry": async (d) => d.reach.continuity.dispatch(await d.readBody()),
  "/api/reach/continuity/inspect": async (d) => d.reach.continuity.status(await d.readBody()),
  "/api/reach/continuity/reclaim": async (d) => d.reach.continuity.reclaim(await d.readBody()),
  "/api/reach/continuity/receive": async (d) => d.reach.continuity.receive(await d.readBody(), d.keyId),
  "/api/reach/continuity/status": async (d) => d.reach.continuity.remoteStatus(await d.readBody(), d.keyId),
  "/api/reach/continuity/release": async (d) => d.reach.continuity.release(await d.readBody(), d.keyId),
  "/api/reach/machines/all": async (d) => d.reach.machines.lookAll((await body(d, z.object({ view: z.enum(["health", "working", "conversations"]).default("health") }).strict())).view),
  "/api/reach/trunks/remote": async ({ reach }) => ({ computers: await reach.remoteTrunks.roster() }),
  "/api/reach/usb/devices": async ({ reach }) => ({ devices: await reach.usb.devices() }),
  "/api/reach/switch": async (d) => {
    const { part, mode } = await body(d, z.object({ part: ReachPartSchema, mode: ReachModeSchema }).strict());
    // Q48: setMode saves the switch before its first wait, so the record is written with it; the relay follows after.
    let saving: Promise<unknown> = Promise.resolve();
    recordedWrite(d.reach.store, d.reach.owner, byCard(reachKey(part)), inCatalogue(reachKey(part)), () => { saving = d.reach.setMode(part, { mode }); });
    return { part, mode: await saving };
  },
  "/api/reach/machine-name": async (d) => ({ name: d.reach.saveMachineName(await d.readBody()) }),
  "/api/reach/machines/look": async (d) => d.reach.machines.look(await body(d, z.object({ machine: z.string(), view: z.enum(machineViews), id: z.string().uuid().optional() }).strict())),
  "/api/reach/machines/start": async (d) => d.reach.machines.start(await d.readBody()),
  "/api/reach/machines/stop": async (d) => d.reach.machines.stop(await d.readBody()),
  "/api/reach/trunks/message": async (d) => d.reach.remoteTrunks.send(await d.readBody(), d.reach.machineName()),
  "/api/reach/trunks/inbox": async (d) => d.reach.remoteTrunks.receive(await d.readBody(), d.keyId),
  "/api/reach/trunks/keys": async (d) => ({ keys: d.reach.remoteTrunks.pair(await d.readBody()) }),
  "/api/reach/trunks/keys/remove": async (d) => ({ keys: d.reach.remoteTrunks.unpair((await body(d, z.object({ keyId: z.string().trim().min(1).max(64) }).strict())).keyId) }),
  "/api/reach/video/settings": async (d) => { need(d, "video"); return { video: saveVideoSettings(d.reach.store, d.reach.owner, await d.readBody()) }; },
  "/api/reach/relay/settings": async (d) => { need(d, "relay"); return { relay: saveRelaySettings(d.reach.store, d.reach.owner, await d.readBody()) }; },
  "/api/reach/send": async (d) => sendToChat(d.reach.store, d.reach.owner, d.reach.deps.router, await d.readBody()),
  "/api/reach/platforms/owners": async (d) => { need(d, "platform-pause"); return saveOwnerAccounts(d.reach.store, d.reach.owner, (await body(d, z.object({ owners: z.unknown() }).strict())).owners); },
  "/api/reach/platforms/pause": async (d) => {
    need(d, "platform-pause");
    const { channel, paused } = await body(d, z.object({ channel: z.string().trim().min(1).max(64), paused: z.boolean() }).strict());
    return { paused: setPaused(d.reach.store, d.reach.owner, channel, paused, "in the window") };
  },
  "/api/reach/git/publish": async (d) => d.reach.git.publish(await d.readBody()),
  "/api/reach/git/install": async (d) => d.reach.git.install(await body(d, GitSourceInput)),
  "/api/reach/git/update": async (d) => d.reach.git.update((await body(d, Id)).id),
  "/api/reach/git/remove": async (d) => ({ sources: d.reach.git.remove((await body(d, Id)).id) }),
  "/api/reach/bundles/write": async (d) => d.reach.bundles.write(await d.readBody()),
  "/api/reach/bundles/preview": async (d) => d.reach.bundles.preview(await body(d, Source)),
  "/api/reach/bundles/install": async (d) => {
    const { names, ...source } = await body(d, Source.extend({ names: z.array(z.string().max(200)).max(50).default([]) }));
    return { reports: await d.reach.bundles.install(source, names) };
  },
  "/api/reach/usb/rules": async (d) => ({ rules: d.reach.usb.save(await d.readBody()) }),
  "/api/reach/usb/enable": async (d) => { const { id, on } = await body(d, Id.extend({ on: z.boolean() })); return { rules: d.reach.usb.enable(id, on) }; },
  "/api/reach/usb/remove": async (d) => ({ rules: d.reach.usb.remove((await body(d, Id)).id) }),
  "/api/reach/notes": async (d) => ({ note: d.reach.notes.save(await d.readBody()) }),
  "/api/reach/notes/remove": async (d) => ({ removed: d.reach.notes.remove((await body(d, Id)).id) }),
  "/api/reach/notes/rewrite": async (d) => d.reach.notes.rewrite(await d.readBody(), AbortSignal.timeout(130000)),
  "/api/reach/arena/start": async (d) => d.reach.arena.start(await d.readBody(), AbortSignal.timeout(130000)),
  "/api/reach/arena/vote": async (d) => d.reach.arena.vote(await d.readBody()),
};

export const reachLockdownRefusal = "Lockdown is on, so nothing here changes or reaches out. Switching a part off still works.";

/** Integration review: under Lockdown every change is refused, except switching a part off. */
async function lockdownGate(deps: ReachHttpDeps, path: string): Promise<void> {
  if (deps.method !== "POST" || !lockedDown(deps.reach.store, deps.reach.owner)) return;
  if (["/api/reach/continuity/status", "/api/reach/continuity/release", "/api/reach/continuity/reclaim"].includes(path)) return;
  if (path === "/api/reach/switch") {
    const body = await deps.readBody();
    deps.readBody = async () => body;
    if ((body as { mode?: unknown } | null)?.mode === "off") return;
  }
  throw new ReachHttpError(423, reachLockdownRefusal);
}

export async function reachApi(deps: ReachHttpDeps, path: string): Promise<unknown> {
  const handler = deps.method === "GET" ? reads[path] : deps.method === "POST" ? changes[path] : undefined;
  if (!handler) throw new ReachHttpError(404, "Not found");
  await lockdownGate(deps, path);
  try {
    return await handler(deps);
  } catch (error) {
    if (error instanceof ReachOffError) throw new ReachHttpError(409, error.message);
    if (error instanceof z.ZodError) throw new ReachHttpError(400, validationText(error).slice(0, 300));
    const status = (error as { status?: unknown } | null)?.status;
    if (error instanceof Error && typeof status === "number" && status >= 400 && status < 600) throw new ReachHttpError(status, error.message);
    throw error;
  }
}
