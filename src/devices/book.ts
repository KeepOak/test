import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { audit } from "../audit.js";
import { lockdownOverrides } from "../lockdown.js"; // mac7/lockdown-fix
import type { Store } from "../store.js";
import { capabilities, capabilityInfo, CapabilitySchema, offeredOn, type Capability } from "./capabilities.js";
import { checkPublicKey, newDeviceId, pairText, PlatformSchema, signedBy, WindowLimit } from "./protocol.js";

/**
 * mac7/nodes: the owner's list of devices, the invitations on offer and the requests waiting for a
 * yes. Kept in one settings record. Only a device's public key is kept, never anything that could
 * be used to pretend to be it.
 *
 * Pairing, in the owner's order of events:
 *   1. "Pair a device" makes an invitation: a six-digit number and a link. Five minutes, five tries.
 *   2. The device sends the number, its name, its platform and the public half of a key it made.
 *      The invitation is used up; a request now waits in the Devices card.
 *   3. The owner presses "Let it in" (or "Refuse"). Nothing is switched on: every capability is off.
 *   4. The device asks how its request went, signing the question with its key, and learns its id.
 */
export const DeviceModeSchema = z.enum(["off", "when-needed", "on"]);
export type DeviceMode = z.infer<typeof DeviceModeSchema>;

const Folder = z.string().trim().min(1).max(500).refine((value) => isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value),
  "The folder must be a full path on that device");
export const DeviceRecordSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{16}$/),
  name: z.string().trim().min(1).max(80),
  platform: PlatformSchema,
  publicKey: z.string().min(40).max(200),
  pairedAt: z.string().max(40),
  lastSeen: z.string().max(40).nullable().default(null),
  offers: z.array(CapabilitySchema).max(20).default([]),
  enabled: z.array(CapabilitySchema).max(20).default([]),
  /** The one folder `device.files` and `device.run` work in, on the device itself. */
  folder: Folder.nullable().default(null),
  /** Household profiles the owner shared this device with. Empty means the owner alone. */
  sharedWith: z.array(z.string().min(1).max(80)).max(20).default([]),
  /** B6: the id of the "this exact phone" secret handed over with the phone's session, forgotten with the device. */
  gatewayId: z.string().regex(/^[a-f0-9]{16}$/).nullable().default(null),
}).strict();
export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;
/** finish-soon-a: the glyphs the window draws a device with, and a colour as #rrggbb. */
export const deviceGlyphs = ["laptop", "desktop", "server", "phone"] as const;
export const DeviceLookSchema = z.object({
  glyph: z.enum(deviceGlyphs).nullable().default(null),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "A colour is # and six hex digits").nullable().default(null),
}).strict();
export type DeviceLook = z.infer<typeof DeviceLookSchema>;
const looksKey = "devices-looks";

const RequestSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{32}$/),
  name: z.string().trim().min(1).max(80),
  platform: PlatformSchema,
  publicKey: z.string().min(40).max(200),
  offers: z.array(CapabilitySchema).max(20),
  at: z.string().max(40),
  status: z.enum(["waiting", "approved", "refused"]),
  deviceId: z.string().nullable().default(null),
  /** B6: answered a "Pair a phone" invitation from an iPhone or Android phone, so it may collect a phone session once. */
  phone: z.boolean().default(false),
  /** B6: the phone session was handed over; it is never handed over again. */
  collected: z.boolean().default(false),
}).strict();
export type PairRequest = z.infer<typeof RequestSchema>;
const BookSchema = z.object({
  mode: DeviceModeSchema.default("off"),
  devices: z.array(DeviceRecordSchema).max(20).default([]),
  requests: z.array(RequestSchema).max(10).default([]),
}).strict();
type Book = z.infer<typeof BookSchema>;
export const bookKey = "devices-book";

export const RedeemSchema = z.object({
  offer: z.string().regex(/^[a-f0-9]{32}$/),
  code: z.string().trim().max(12),
  name: z.string().trim().min(1).max(80).default("A device"),
  platform: PlatformSchema,
  publicKey: z.string().min(40).max(200),
  offers: z.array(CapabilitySchema).max(20).default([]),
}).strict();

export const offerLifetimeMs = 5 * 60_000;
export const requestLifetimeMs = 30 * 60_000;
export const offerAttempts = 5;
export const offLine = "Using other devices is switched off. Switch it on in Settings, Computer & browser, Add a computer.";

interface Offer { id: string; code: string; expiresAt: number; attempts: number; phone: boolean }
/** B6: the platforms a phone session is ever handed to. */
export const phonePlatforms: readonly string[] = ["ios", "android"];
/** B6: exactly what a phone signs to collect its session, so no other signature of its key is valid for it. */
export const phoneSessionText = (requestId: string): string => `branch-phone-session-v1
${requestId}`;
/** B6: what `collectPhoneSession` needs from the paired door: the phone's own "this exact phone" secret. */
export type RememberPhone = (name: string) => { device: { id: string }; secret: string; key: string };
const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * mac7/channel-leaks: the one thing a device is ever told when a pairing try does not work.
 *
 * The number is six digits — twenty bits — so what the answer says about the try matters as much as
 * the number itself. It used to say whether "Pair a device" had been pressed at all, whether Devices
 * was even switched on, and how many of the five tries were left, which turns guessing from a shot
 * in the dark into a thing you can plan. Now every way of getting it wrong ends here, in the same
 * words with the same status: no window open, the wrong invitation, the wrong number, the fifth
 * wrong number, a body that is not even the right shape, and a question about a request nobody made.
 * The five tries still burn the invitation underneath, and the wait after repeated failures is
 * counted where every other wrong key and PIN is counted (src/server.ts).
 */
export const pairingRefused = "That did not work. Check the number on the computer and try again.";
/** Said when a caller is going too fast. It is about the caller, so it says nothing about Branch. */
export const pairingBusy = "Too many pairing tries just now. Wait a minute and try again.";

export class DeviceBook {
  private offer: Offer | null = null;
  /**
   * An invitation that matches nothing, made once per launch. A try that arrives when no window is
   * open is compared against this rather than turned away, so both comparisons are made either way
   * and the answer never comes back sooner because there was nothing to compare.
   */
  private readonly decoy: Offer = { id: randomBytes(16).toString("hex"),
    code: String(randomInt(0, 1_000_000)).padStart(6, "0"), expiresAt: 0, attempts: 0, phone: false };
  private readonly listeners = new Set<(deviceId: string, why: "changed" | "removed") => void>();
  /** Twenty pairing tries a minute from anywhere at all, on top of the five per invitation. */
  private readonly tries = new WindowLimit(20, 60_000);
  /**
   * Integration review: ten a minute per address as well, so one address cannot use up everybody's
   * tries. Behind a gateway that forwards from 127.0.0.1 every caller shares one address, so there
   * the per-invitation limit (five, then it is burned) is what stops guessing.
   */
  private readonly triesFrom = new WindowLimit(10, 60_000);
  /**
   * B6: the phone requests made from a "Pair a phone" invitation in this launch, not yet collected. Kept in memory only,
   * so a restart mid-pairing leaves none of them open: a phone request saved before it can no longer be let in as a
   * phone, and one let in but not yet collected never collects the window's key.
   */
  private readonly phoneOpen = new Set<string>();
  constructor(private readonly store: Store, private readonly owner: string, private readonly now: () => number = Date.now) {}

  private read(): Book {
    const saved = BookSchema.safeParse(this.store.get("settings", this.owner, bookKey)?.data ?? {});
    return saved.success ? saved.data : BookSchema.parse({});
  }
  private write(book: Book): void { this.store.save("settings", this.owner, bookKey, book); }
  private note(action: "channel.paired" | "policy.changed" | "auth.refused", subject: string, reason: string, outcome: string): void {
    audit(this.store, this.owner, { action, actor: this.owner, subject, reason, outcome });
  }
  /** Told whenever a device's switches change or it is taken off the list, so its socket follows. */
  onChange(listener: (deviceId: string, why: "changed" | "removed") => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }
  private tell(deviceId: string, why: "changed" | "removed"): void {
    for (const listener of this.listeners) try { listener(deviceId, why); } catch { /* telling must not break saving */ }
  }

  mode(): DeviceMode { return lockdownOverrides(this.store, this.owner, bookKey) ? "off" : this.savedMode(); } // mac7/lockdown-fix
  /** The mode as saved, Lockdown aside: what the catalog follows, so turning Lockdown off needs no restart. */
  savedMode(): DeviceMode { return this.read().mode; }
  setMode(input: unknown): DeviceMode {
    const mode = DeviceModeSchema.parse((input as { mode?: unknown } | null)?.mode);
    this.write({ ...this.read(), mode });
    this.note("policy.changed", "using other devices", `switched to ${mode}`, "saved");
    return mode;
  }
  requireOn(): void { if (this.mode() === "off") throw new Error(offLine); }

  devices(): DeviceRecord[] { return this.read().devices; }
  device(id: string): DeviceRecord | undefined { return this.devices().find((each) => each.id === id); }
  requests(): PairRequest[] {
    const since = this.now() - requestLifetimeMs;
    return this.read().requests.filter((request) => Date.parse(request.at) > since)
      // B6: a phone request still waiting from before a restart is not offered to be let in.
      .filter((request) => !(request.phone && request.status === "waiting" && !this.phoneOpen.has(request.id)));
  }
  /** B6: whether this request, made in this launch from a "Pair a phone" invitation, may still collect its session. */
  phoneSessionOpen(request: Pick<PairRequest, "id" | "phone" | "collected">): boolean { return request.phone && !request.collected && this.phoneOpen.has(request.id); }
  private update(id: string, change: (device: DeviceRecord) => DeviceRecord): DeviceRecord {
    const book = this.read();
    const found = book.devices.find((each) => each.id === id);
    if (!found) throw new Error("That device is not on the list.");
    const next = DeviceRecordSchema.parse(change(found));
    this.write({ ...book, devices: book.devices.map((each) => (each.id === id ? next : each)) });
    this.tell(id, "changed");
    return next;
  }

  /**
   * A fresh invitation, replacing any earlier one. The number is shown on this computer only. B6: `phone` marks the
   * window's "Pair a phone" invitation, the only kind whose phone may collect a session after the owner's yes.
   */
  invite(options: { phone?: boolean } = {}): { id: string; code: string; expiresAt: string } {
    this.requireOn();
    const offer = { id: randomBytes(16).toString("hex"), code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
      expiresAt: this.now() + offerLifetimeMs, attempts: 0, phone: options.phone === true };
    this.offer = offer;
    return { id: offer.id, code: offer.code, expiresAt: new Date(offer.expiresAt).toISOString() };
  }
  invitation(): { id: string; expiresAt: string; attemptsLeft: number } | null {
    const offer = this.liveOffer();
    return offer ? { id: offer.id, expiresAt: new Date(offer.expiresAt).toISOString(), attemptsLeft: offerAttempts - offer.attempts } : null;
  }
  cancelInvite(): void { this.offer = null; }
  private liveOffer(): Offer | null {
    if (this.offer && this.offer.expiresAt <= this.now()) this.offer = null;
    return this.offer;
  }

  /**
   * A device answering an invitation. Burns the invitation and leaves a request for the owner.
   *
   * Every refusal below is the same sentence. Whether Devices is switched on, whether a window is
   * open, whether the invitation was the right one and how many tries are left are all state, and
   * none of it is said to somebody who has not yet got the number right.
   */
  redeem(input: unknown, from = "unknown"): { requestId: string; status: "waiting" } {
    if (this.tries.full("all") || this.triesFrom.full(from)) throw new Error(pairingBusy);
    this.tries.add("all");
    this.triesFrom.add(from);
    const parsed = RedeemSchema.safeParse(input);
    const offer = this.mode() === "off" ? null : this.liveOffer();
    // Compared against the decoy when there is no window, so both comparisons happen whatever the
    // state is and neither branch returns before the other has done its work.
    const against = offer ?? this.decoy;
    const rightOffer = same(parsed.success ? parsed.data.offer : "", against.id);
    const rightCode = same(parsed.success ? parsed.data.code : "", against.code);
    if (!parsed.success || !offer || !rightOffer) throw new Error(pairingRefused);
    const body = parsed.data;
    offer.attempts++;
    if (offer.attempts > offerAttempts) { this.offer = null; throw new Error(pairingRefused); }
    if (!rightCode) {
      this.note("auth.refused", `a device at ${from}`, "A wrong pairing number was typed", "refused");
      throw new Error(pairingRefused);
    }
    this.offer = null;
    const request: PairRequest = { id: randomBytes(16).toString("hex"), name: body.name, platform: body.platform,
      publicKey: checkPublicKey(body.publicKey), offers: offeredOn(body.platform).filter((c) => body.offers.includes(c)),
      at: new Date(this.now()).toISOString(), status: "waiting", deviceId: null,
      phone: offer.phone && phonePlatforms.includes(body.platform), collected: false };
    const book = this.read();
    this.write({ ...book, requests: [...this.requests(), request].slice(-10) });
    if (request.phone) this.phoneOpen.add(request.id);
    return { requestId: request.id, status: "waiting" };
  }

  /** The owner's answer to a waiting request. A yes adds the device with every capability off. */
  decide(requestId: string, approve: boolean): PairRequest {
    const book = this.read();
    const request = this.requests().find((each) => each.id === requestId && each.status === "waiting");
    if (!request) throw new Error("That request has already been answered or has expired.");
    let decided: PairRequest = { ...request, status: approve ? "approved" : "refused" };
    let devices = book.devices;
    if (approve) {
      if (devices.length >= 20) throw new Error("Twenty devices are already paired. Remove one first.");
      const device = DeviceRecordSchema.parse({ id: newDeviceId(), name: request.name, platform: request.platform,
        publicKey: request.publicKey, pairedAt: new Date(this.now()).toISOString(), offers: request.offers });
      devices = [...devices, device];
      decided = { ...decided, deviceId: device.id };
    }
    this.write({ ...book, devices, requests: book.requests.map((each) => (each.id === requestId ? decided : each)) });
    if (!approve) this.phoneOpen.delete(requestId);
    this.note("channel.paired", request.name, approve ? "The owner let a device in; everything on it starts switched off"
      : "The owner refused a device that asked to pair", approve ? "paired" : "refused");
    return decided;
  }

  /** How a request went, for the device that made it; it proves itself with its key. */
  requestStatus(requestId: unknown, signature: unknown): { status: string; deviceId: string | null } {
    const request = this.requests().find((each) => each.id === requestId);
    if (!request || typeof signature !== "string" || !signedBy(request.publicKey, pairText(request.id, "status"), signature))
      // The same sentence a wrong number gets: whether a request with that id exists is state too.
      throw new Error(pairingRefused);
    return { status: request.status, deviceId: request.deviceId };
  }

  /**
   * B6: the phone session, handed once to the phone the owner let in from a "Pair a phone" invitation. The phone proves
   * itself with the key it paired with, signing `phoneSessionText`. What it gets is what the Tailscale invitation
   * (POST /api/pair) hands over: a key of the phone's own (never the window's), plus its "this exact phone" secret,
   * both from `remember` (src/remote/gateway-auth.ts).
   * Anything else — still waiting, refused, already collected, not a phone invitation, not a phone, the device removed,
   * Devices off or Lockdown on, a wrong signature, a request nobody made — is `pairingRefused`. Checked and written with nothing awaited between.
   */
  collectPhoneSession(requestId: unknown, signature: unknown, remember: RememberPhone):
    { token: string; deviceId: string; deviceKey: string } {
    const request = this.requests().find((each) => each.id === requestId);
    if (!request || typeof signature !== "string" || !signedBy(request.publicKey, phoneSessionText(request.id), signature))
      throw new Error(pairingRefused);
    const book = this.read();
    const device = book.devices.find((each) => each.id === request.deviceId);
    // Devices switched off since, or Lockdown on (which reads as off), hands nothing over.
    // A request from before a restart, or one already collected, is not open (phoneSessionOpen).
    if (this.mode() === "off" || request.status !== "approved" || !this.phoneSessionOpen(request) || !device || !phonePlatforms.includes(device.platform))
      throw new Error(pairingRefused);
    this.phoneOpen.delete(request.id);
    const gateway = remember(device.name);
    this.write({ ...book,
      requests: book.requests.map((each) => (each.id === request.id ? { ...each, collected: true } : each)),
      devices: book.devices.map((each) => (each.id === device.id ? { ...each, gatewayId: gateway.device.id } : each)) });
    this.note("channel.paired", device.name, "The phone the owner let in collected its session, once", "paired");
    return { token: gateway.key, deviceId: gateway.device.id, deviceKey: gateway.secret };
  }

  /** One capability on or off. A capability the device's platform cannot offer stays off. */
  setSwitch(id: string, capability: Capability, on: boolean): DeviceRecord {
    CapabilitySchema.parse(capability);
    return this.update(id, (device) => {
      if (on && !offeredOn(device.platform).includes(capability))
        throw new Error(`${capabilityInfo[capability].label} is not something this device can do.`);
      const enabled = capabilities.filter((c) => (c === capability ? on : device.enabled.includes(c)));
      this.note("policy.changed", `${device.name}: ${capabilityInfo[capability].label}`, on ? "switched on" : "switched off", "saved");
      return { ...device, enabled };
    });
  }
  setFolder(id: string, folder: string | null): DeviceRecord {
    return this.update(id, (device) => ({ ...device, folder: folder === null ? null : Folder.parse(folder) }));
  }
  share(id: string, profiles: unknown): DeviceRecord {
    const list = z.array(z.string().min(1).max(80)).max(20).parse(profiles);
    return this.update(id, (device) => {
      this.note("policy.changed", `${device.name}: shared with`, list.length ? list.join(", ") : "the owner alone", "saved");
      return { ...device, sharedWith: list };
    });
  }
  rename(id: string, name: unknown): DeviceRecord {
    const next = z.string().trim().min(1).max(80).parse(name);
    return this.update(id, (device) => ({ ...device, name: next }));
  }
  /**
   * finish-soon-a: how each device shows in the window (a glyph and a colour), kept in its own record by device id, so the
   * strict device list is never widened and an older Branch reading it keeps every paired device.
   */
  looks(): Record<string, DeviceLook> {
    const saved = z.record(z.string(), DeviceLookSchema).safeParse(this.store.get("settings", this.owner, looksKey)?.data ?? {});
    const kept = new Set(this.devices().map((device) => device.id));
    return saved.success ? Object.fromEntries(Object.entries(saved.data).filter(([id]) => kept.has(id))) : {};
  }
  setLook(id: string, input: unknown): DeviceLook {
    if (!this.device(id)) throw new Error("That device is not on the list.");
    const look = DeviceLookSchema.parse({ ...this.looks()[id], ...(input as object) });
    this.store.save("settings", this.owner, looksKey, { ...this.looks(), [id]: look });
    return look;
  }
  /** What the device says it can do now, kept to what its platform can. Switches never widen here. */
  noteOffers(id: string, offers: readonly Capability[]): void {
    const device = this.device(id);
    if (!device) return;
    const kept = offeredOn(device.platform).filter((c) => offers.includes(c));
    if (kept.join() === device.offers.join()) return;
    const book = this.read();
    this.write({ ...book, devices: book.devices.map((each) => (each.id === id ? { ...each, offers: kept } : each)) });
  }
  seen(id: string): void {
    const book = this.read();
    if (!book.devices.some((each) => each.id === id)) return;
    const at = new Date(this.now()).toISOString();
    this.write({ ...book, devices: book.devices.map((each) => (each.id === id ? { ...each, lastSeen: at } : each)) });
  }
  /** Takes a device off the list at once; its socket is closed and its key stops working. */
  revoke(id: string): boolean {
    const book = this.read();
    const device = book.devices.find((each) => each.id === id);
    if (!device) return false;
    this.write({ ...book, devices: book.devices.filter((each) => each.id !== id) });
    this.note("channel.paired", device.name, "The owner took a device off the list; its key no longer works", "removed");
    this.tell(id, "removed");
    return true;
  }
}
