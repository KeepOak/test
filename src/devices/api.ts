import { z } from "zod";
import { qrRows } from "../deployment-api.js";
import { encodeQr } from "../remote/qr.js";
import type { Store } from "../store.js";
import { CapabilitySchema, capabilityInfo, capabilities, offeredOn } from "./capabilities.js";
import type { Devices } from "./index.js";
import { deviceGlyphs, pairingBusy, pairingRefused, type RememberPhone } from "./book.js";
import { isComputer, pickDevice, pickedDevice, trunkComputerRefusal } from "./tools.js";
import { keyCheck } from "./protocol.js";
import { hereOnly } from "../remote/window-key.js";
import { errorText, validationText } from "../request-errors.js";

/**
 * mac7/nodes: the web side of Devices.
 *
 *   /api/devices/pair, /api/devices/pair/status   a device answering an invitation. No key: the
 *        invitation number and the device's own signature are what is checked, and every try counts.
 *   /api/devices/pair/session   B6: the phone let in from "Pair a phone" collects its session, once, signed.
 *   everything else under /api/devices             the owner's, behind the same key as the window.
 *        A short-lived key may not even read it (src/short-lived-keys.ts), and a household person
 *        is refused by the server's owner check.
 */
export const handlesDevicesPath = (path: string): boolean => path === "/api/devices" || path.startsWith("/api/devices/");
export const openDevicePaths = ["/api/devices/pair", "/api/devices/pair/status", "/api/devices/pair/session"];

export class DevicesHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface DevicesHttpDeps {
  chatPairing?: { list(): unknown[]; consume(id: string, kind: "phone" | "computer"): void };
  devices: Devices; store: Store; owner: string; method: string;
  readBody: () => Promise<unknown>;
  /** The address a device should dial: the paired door while it is open, otherwise this computer. */
  baseUrl: string;
  /** P17-D §9: the Trunk a conversation belongs to, or null for the owner's own assistant. */
  trunkOf?: (sessionId: string) => string | null;
  /** B6: forgets a removed phone's "this exact phone" secret and its own key on the paired door. */
  forgetGateway?: (id: string) => void;
  /** Whether that phone was paired before phones had keys of their own, and so was handed the window's key. */
  heldWindowKey?: (id: string) => boolean;
  /** B6: the request came through the paired door (a phone), not this computer's own. */
  viaDoor?: boolean;
  /**
   * A phone paired before phones had keys of their own, and so handed the window's key, is removed: a new window key
   * replaces it (src/remote/window-key.ts), and this answers it once it is in use.
   */
  rotateKey?: () => Promise<string>;
  /** The caller is this computer's own window, which may be handed the new key when it asks (`keepKey`). */
  keyHere?: boolean;
  /**
   * Every phone on the paired door's list (src/remote/gateway-auth.ts). One no device record points to was let in by a
   * Tailscale invitation (POST /api/pair) and is listed and removed through `doorPhones` here.
   */
  gatewayPhones?: () => { id: string; name: string; pairedAt: string }[];
}
/** B6: said when a phone invitation is asked for anywhere but this computer's own window. */
export const phoneInviteHereOnly = "A phone can only be paired from the window on this computer.";
/** B6: what the open door needs to hand a phone its session: the window's key and the paired door's secret maker. */
export interface PhoneSessionDeps { remember: RememberPhone }

/**
 * A device answering an invitation, or asking how its request went.
 *
 * mac7/channel-leaks: nothing this route says depends on what is on this computer. Every refusal is
 * `pairingRefused`, with the same 403, whether the method was wrong, the body was rubbish, the
 * invitation was not the one on offer, the number was wrong, the five tries were used up, Devices
 * is switched off or the request asked after was never made. The one other answer, 429, is about
 * how fast the caller is going and so says nothing about Branch either.
 */
export async function openDevicesApi(deps: Omit<DevicesHttpDeps, "baseUrl" | "store" | "owner"> & { phone?: PhoneSessionDeps },
  path: string, from: string): Promise<unknown> {
  if (deps.method !== "POST") throw new DevicesHttpError(403, pairingRefused);
  const body = await deps.readBody().catch(() => null);
  try {
    if (path === "/api/devices/pair") return deps.devices.book.redeem(body, from);
    const status = body as { requestId?: unknown; signature?: unknown } | null;
    if (path === "/api/devices/pair/session") {
      if (!deps.phone) throw new Error(pairingRefused);
      return deps.devices.book.collectPhoneSession(status?.requestId, status?.signature, deps.phone.remember);
    }
    return deps.devices.book.requestStatus(status?.requestId, status?.signature);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === pairingBusy) throw new DevicesHttpError(429, pairingBusy);
    // A body zod would not take, a wrong number and a request nobody made are one answer.
    throw new DevicesHttpError(403, pairingRefused);
  }
}

function overview(deps: DevicesHttpDeps): unknown {
  const { book, hub } = deps.devices;
  const looks = book.looks(); // finish-soon-a: how each device shows (glyph, colour)
  return {
    mode: book.mode(),
    invitation: book.invitation(),
    requests: book.requests().filter((request) => request.status === "waiting")
      // phase2/shell integration review: the check code the device shows while it waits, never the key itself.
      .map(({ publicKey, ...request }) => ({ ...request, phone: book.phoneSessionOpen(request), check: keyCheck(publicKey) })),
    devices: book.devices().map(({ publicKey: _key, gatewayId: _gateway, ...device }) => ({
      ...device, ...(looks[device.id] ?? {}), connected: hub.connected(device.id), canOffer: offeredOn(device.platform),
    })),
    capabilities: capabilities.map((id) => ({ id, label: capabilityInfo[id].label, kind: capabilityInfo[id].kind, platforms: capabilityInfo[id].platforms })),
    doorPhones: doorPhones(deps),
  };
}

/** Phones let in by a Tailscale invitation (POST /api/pair): on the paired door's list, with no device record. */
function doorPhones(deps: DevicesHttpDeps): { id: string; name: string; pairedAt: string }[] {
  const linked = new Set(deps.devices.book.devices().map((device) => device.gatewayId));
  return (deps.gatewayPhones?.() ?? []).filter((phone) => !linked.has(phone.id))
    .map(({ id, name, pairedAt }) => ({ id, name, pairedAt }));
}

/**
 * Removes a phone a Tailscale invitation let in, from this computer's own window only. One paired before phones had
 * keys of their own was handed the window's key, so that key is replaced first, as for any other phone (deviceChange).
 */
async function removeDoorPhone(deps: DevicesHttpDeps, id: string, keepKey: boolean): Promise<unknown> {
  if (deps.viaDoor !== false) throw new DevicesHttpError(403, hereOnly);
  const key = (deps.heldWindowKey?.(id) ?? true) && deps.rotateKey ? await deps.rotateKey() : null;
  deps.forgetGateway?.(id);
  return { removed: true, ...(key && keepKey && deps.keyHere === true ? { key } : {}) };
}

/** mac7/residuals (integration): letting a device in without saying the check codes match. */
export const codeNotConfirmed =
  "Compare the check code first. The device shows the same code while it waits; let it in only once you have said the two match.";
const deviceRoute = /^\/api\/devices\/([a-f0-9]{16})\/(switch|folder|share|rename|revoke)$/;
const requestRoute = /^\/api\/devices\/requests\/([a-f0-9]{32})$/;
const RenameSchema = z.object({ name: z.string().trim().min(1).max(80), glyph: z.enum(deviceGlyphs).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "A colour is # and six hex digits").optional() }).strict();
const SwitchSchema = z.object({ capability: CapabilitySchema, on: z.boolean() }).strict();
/** P17-D §9: "this" is this PC picked on purpose, so a Trunk's first computer does not stand in for it. */
const PickSchema = z.object({ sessionId: z.string().uuid(), deviceId: z.union([z.literal("this"), z.string().regex(/^[a-f0-9]{16}$/)]).nullable() }).strict();
const pickedPath = /^\/api\/devices\/pick\/([a-f0-9-]{36})$/;

/**
 * P17-D §9: what a conversation's computer menu needs: what it picked, and, for a Trunk's conversation, the
 * computers that Trunk may use (null while the owner saved no list) and how many at once.
 */
function pickedFor(deps: DevicesHttpDeps, sessionId: string): unknown {
  const trunkId = deps.trunkOf?.(sessionId) ?? null;
  const limits = trunkId ? deps.devices.computerRule?.saved(trunkId) ?? null : null;
  return { sessionId, picked: pickedDevice(deps.store, deps.owner, sessionId), trunkId,
    allowed: limits?.allowed ?? null, atOnce: limits?.atOnce ?? null };
}

async function deviceChange(deps: DevicesHttpDeps, id: string, action: string): Promise<unknown> {
  const { book } = deps.devices;
  if (action === "revoke") {
    const { keepKey } = z.object({ keepKey: z.boolean().optional() }).strict().parse((await deps.readBody()) ?? {});
    if (!book.device(id) && doorPhones(deps).some((phone) => phone.id === id)) return removeDoorPhone(deps, id, keepKey === true);
    const gatewayId = book.device(id)?.gatewayId ?? null;
    // A phone's own key goes with its record. One paired before phones had keys of their own (or whose record is gone)
    // may hold the window's key, so that is decided before the record is forgotten.
    const heldWindowKey = gatewayId !== null && (deps.heldWindowKey?.(gatewayId) ?? true);
    // Forgetting its secret is not enough on a listener open to the private network, which asks for the key alone, so
    // the window's key is replaced, and first: when the new key cannot be saved nothing is removed, and removing the
    // phone again tries again. The window on this computer that asks is handed the new key, so it stays signed in.
    const key = heldWindowKey && deps.rotateKey ? await deps.rotateKey() : null;
    const removed = book.revoke(id);
    if (removed && gatewayId) deps.forgetGateway?.(gatewayId);
    return { removed, ...(key && keepKey === true && deps.keyHere === true ? { key } : {}) };
  }
  const body = (await deps.readBody() ?? {}) as Record<string, unknown>;
  if (action === "switch") { const { capability, on } = SwitchSchema.parse(body); return { device: book.setSwitch(id, capability, on) }; }
  if (action === "folder") return { device: book.setFolder(id, typeof body.folder === "string" && body.folder.trim() ? body.folder : null) };
  if (action === "share") return { device: book.share(id, body.profiles) };
  // finish-soon-a: "Name your new computer" saves the name and, when given, how it shows (its glyph and colour).
  const { name, ...look } = RenameSchema.parse(body);
  const device = book.rename(id, name);
  return { device: { ...device, ...(Object.keys(look).length ? book.setLook(id, look) : book.looks()[id] ?? {}) } };
}

/**
 * phase2/shell: lending this computer to another Branch from the window (src/devices/join.ts).
 *   GET  /api/devices/join         where it stands
 *   POST /api/devices/join         { link, code, name? } answers the other computer's invitation
 *   POST /api/devices/join/leave   stops lending it and forgets the key
 *   POST /api/devices/join/find    find-computers: waits to be found; POST /api/devices/join { offer, code } answers the
 *                                  offer shown, and POST /api/devices/join/find/refuse { offer } says no to it
 */
async function joinRoute(deps: DevicesHttpDeps, path: string): Promise<unknown> {
  const joining = deps.devices.joining;
  if (!joining) throw new DevicesHttpError(404, "This Branch cannot join another one.");
  if (deps.method === "GET" && path === "/api/devices/join") return joining.status();
  if (deps.method !== "POST") return undefined;
  if (path === "/api/devices/join/leave") return joining.leave();
  try {
    if (path === "/api/devices/join/find") return await joining.find(); // find-computers: wait to be found
    if (path === "/api/devices/join/find/refuse") return joining.refuseOffer(await deps.readBody()); // find-computers: say no to the offer shown
    return await joining.start(await deps.readBody());
  } catch (error) {
    if (error instanceof z.ZodError) throw new DevicesHttpError(400, validationText(error));
    const status = (error as { status?: unknown }).status;
    throw new DevicesHttpError(typeof status === "number" ? status : 400, errorText(error));
  }
}

/**
 * find-computers: "Found nearby" in Pair another computer (src/devices/find.ts), the owner's alone like the rest.
 *   GET  /api/devices/find          the list, while looking (reading it keeps the looking going)
 *   POST /api/devices/find          { on } starts or stops looking; Lockdown refuses starting
 *   POST /api/devices/find/offer    { id } hands that computer the current invitation's link, never its number
 */
const FindSchema = z.object({ on: z.boolean() }).strict();
const OfferPickSchema = z.object({ id: z.string().regex(/^[a-f0-9]{16}$/) }).strict();
async function findRoute(deps: DevicesHttpDeps, path: string): Promise<unknown> {
  const { finder, book } = deps.devices;
  if (deps.method === "GET" && path === "/api/devices/find") return finder.list();
  if (deps.method !== "POST") return undefined;
  try {
    if (path === "/api/devices/find") return FindSchema.parse(await deps.readBody()).on ? await finder.start() : finder.stop();
    const { id } = OfferPickSchema.parse(await deps.readBody());
    const invitation = book.invitation();
    if (!invitation) throw new DevicesHttpError(409, "Make an invitation first: the other computer needs its number.");
    const link = `${deps.baseUrl.replace(/\/+$/, "")}/devices/pair?offer=${invitation.id}`;
    return await finder.offer(id, link, deps.devices.hello().name);
  } catch (error) {
    if (error instanceof DevicesHttpError) throw error;
    if (error instanceof z.ZodError) throw new DevicesHttpError(400, validationText(error));
    const status = (error as { status?: unknown }).status;
    throw new DevicesHttpError(typeof status === "number" ? status : 502, errorText(error));
  }
}

/** The owner's routes. Answers undefined for a path it does not know. */
export async function devicesApi(deps: DevicesHttpDeps, path: string): Promise<unknown> {
  const { devices, method } = deps;
  if (path === "/api/devices/chat-pairing" && method === "GET") {
    if (deps.viaDoor !== false) throw new DevicesHttpError(403, phoneInviteHereOnly);
    return { proposals: deps.chatPairing?.list() ?? [] };
  }
  if (path === "/api/devices" && method === "GET") return overview(deps);
  const picked = pickedPath.exec(path);
  if (picked && method === "GET") return pickedFor(deps, picked[1]!);
  if (path === "/api/devices/join" || path === "/api/devices/join/leave" || path === "/api/devices/join/find" || path === "/api/devices/join/find/refuse")
    return joinRoute(deps, path); // phase2/shell
  if (path === "/api/devices/find" || path === "/api/devices/find/offer") return findRoute(deps, path); // find-computers
  if (method !== "POST") return undefined;
  if (path === "/api/devices/mode") return { mode: devices.setMode(await deps.readBody()) };
  if (path === "/api/devices/invite") {
    const scope = deps.store.profiles.scope();
    const body = await deps.readBody();
    // The owner asked; a household switch while the body arrived consumes no request and makes no invitation.
    if (!deps.store.profiles.isOwner() || deps.store.profiles.scope() !== scope)
      throw new DevicesHttpError(403, "Your devices belong to the owner. Switch back to the owner's profile to use them.");
    const { phone, proposalId } = z.object({ phone: z.boolean().optional(), proposalId: z.string().regex(/^[a-f0-9]{32}$/).optional() }).strict().parse(body ?? {});
    // B6: a phone invitation hands the window's key to the phone let in, so only this computer's window makes one.
    if (phone === true && deps.viaDoor !== false) throw new DevicesHttpError(403, phoneInviteHereOnly);
    if (proposalId) {
      if (deps.viaDoor !== false || !deps.chatPairing) throw new DevicesHttpError(403, phoneInviteHereOnly);
      try { deps.chatPairing.consume(proposalId, phone === true ? "phone" : "computer"); }
      catch { throw new DevicesHttpError(409, "That chat pairing request expired or is no longer authorized. Send /pair again."); }
    }
    const offer = devices.book.invite({ phone: phone === true });
    const link = `${deps.baseUrl.replace(/\/+$/, "")}/devices/pair?offer=${offer.id}`;
    return { ...offer, link, qr: qrRows(encodeQr(link)) };
  }
  if (path === "/api/devices/invite/cancel") { devices.book.cancelInvite(); return { cancelled: true }; }
  if (path === "/api/devices/pick") {
    const { sessionId, deviceId } = PickSchema.parse(await deps.readBody());
    const device = deviceId && deviceId !== "this" ? devices.book.device(deviceId) : undefined;
    if (deviceId && deviceId !== "this" && !device) throw new DevicesHttpError(404, "That device is not on the list.");
    // P17-D §9: one of a Trunk's conversations may pick only a computer that Trunk may use.
    const trunkId = deps.trunkOf?.(sessionId) ?? null;
    if (deviceId && trunkId && devices.computerRule && (deviceId === "this" || (device && isComputer(device)))
      && !devices.computerRule.allows(trunkId, deviceId)) throw new DevicesHttpError(403, trunkComputerRefusal);
    pickDevice(deps.store, deps.owner, sessionId, deviceId);
    return { sessionId, deviceId };
  }
  const request = requestRoute.exec(path);
  if (request) {
    // mac7/residuals (integration): a yes says the owner compared the check code on both screens.
    const body = z.object({ approve: z.boolean(), codeMatches: z.boolean().optional() }).strict().parse(await deps.readBody());
    if (body.approve && body.codeMatches !== true) throw new DevicesHttpError(400, codeNotConfirmed);
    const { publicKey: _key, ...decided } = devices.book.decide(request[1]!, body.approve);
    return { request: decided };
  }
  const match = deviceRoute.exec(path);
  if (match) return deviceChange(deps, match[1]!, match[2]!);
  return undefined;
}
