import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { z } from "zod";
import { CapabilitySchema, devicePlatforms, type DevicePlatform } from "./capabilities.js";

/**
 * mac7/nodes: the words a device and Branch say to each other over the device socket.
 *
 * The shape follows OpenClaw's node protocol (MIT): the device dials out, Branch answers with a
 * challenge, the device proves who it is, and from then on Branch sends `invoke` and the device
 * sends `result`. Branch's differences:
 *
 *   - a device proves itself with a signature from a key that never leaves it (Ed25519). Branch only
 *     keeps the public half, so a copy of Branch's data cannot be used to pretend to be the device;
 *   - the challenge is fresh for every connection, so a recorded answer is useless the next time;
 *   - the key only opens this socket. It is not Branch's own key and cannot reach anything else;
 *   - pictures and sound travel as one binary frame after their `result`, never as base64 in JSON,
 *     and are refused above `mediaLimitBytes`.
 */
export const protocolVersion = 1;
export const socketPath = "/api/devices/socket";
export const nodeHeader = "x-branch-node";

const Id = z.string().regex(/^[a-f0-9]{16}$/);
const InvokeId = z.string().regex(/^[a-f0-9]{32}$/);
export const PlatformSchema = z.enum(devicePlatforms as [DevicePlatform, ...DevicePlatform[]]);

export const HelloSchema = z.object({
  type: z.literal("hello"), version: z.number().int().min(1).max(100), deviceId: Id,
  signature: z.string().min(40).max(200), platform: PlatformSchema,
  /** What this device could do if the owner switched it on; Branch keeps only what it recognises. */
  offers: z.array(CapabilitySchema).max(20).default([]),
}).strict();

export const MediaSchema = z.object({
  mime: z.string().regex(/^(image|audio|video|text|application)\/[a-z0-9.+-]{1,60}$/),
  bytes: z.number().int().min(0),
  name: z.string().max(120).optional(),
}).strict();

export const ResultSchema = z.object({
  type: z.literal("result"), id: InvokeId, ok: z.boolean(),
  value: z.unknown().optional(), error: z.string().max(2000).optional(), media: MediaSchema.optional(),
}).strict();

export const OffersSchema = z.object({ type: z.literal("offers"), offers: z.array(CapabilitySchema).max(20) }).strict();

/** Anything the device may send after the hello. */
export const NodeFrameSchema = z.discriminatedUnion("type", [ResultSchema, OffersSchema,
  z.object({ type: z.literal("pong"), at: z.number() }).strict(),
  // computer-control: Stop was pressed on the device's own notice (or it could not show one): the owner's hold ends.
  z.object({ type: z.literal("hold-stopped"), reason: z.string().max(200) }).strict()]);
export type NodeFrame = z.infer<typeof NodeFrameSchema>;

/** Everything Branch sends to a device. */
export type HubFrame =
  | { type: "challenge"; nonce: string; version: number }
  | { type: "welcome"; deviceId: string; enabled: string[]; folder: string | null }
  | { type: "enabled"; enabled: string[]; folder: string | null }
  | { type: "invoke"; id: string; capability: string; args: Record<string, unknown>; deadline: number }
  | { type: "ping"; at: number }
  | { type: "bye"; reason: string }
  /** computer-control: the owner takes over this device from Branch's view (on), or lets go (off). */
  | { type: "driving"; on: boolean; owner: string };

export const newNonce = (): string => randomBytes(32).toString("base64url");
export const newInvokeId = (): string => randomBytes(16).toString("hex");
export const newDeviceId = (): string => randomBytes(8).toString("hex");

/** Exactly what the device signs, so a signature for one purpose is never valid for another. */
export const helloText = (deviceId: string, nonce: string): string => `branch-node-hello-v1\n${deviceId}\n${nonce}`;
/**
 * phase2/shell integration review: a short check code made from a device's public key. The device
 * shows it while it waits and Branch shows it beside the request, so the owner can see the request
 * really came from the computer in front of them before pressing "Let it in". Not a secret.
 */
export function keyCheck(publicKey: string): string {
  const hex = createHash("sha256").update(publicKey, "utf8").digest("hex").slice(0, 8).toUpperCase();
  return `${hex.slice(0, 4)} ${hex.slice(4)}`;
}
export const pairText = (requestId: string, purpose: "pair" | "status"): string => `branch-node-${purpose}-v1\n${requestId}`;

/** A public key as the device sends it: SPKI DER in base64. Refuses anything but Ed25519. */
export function checkPublicKey(spki: string): string {
  const key = createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("A device key must be an Ed25519 key.");
  return key.export({ format: "der", type: "spki" }).toString("base64");
}

/** True when `signature` (base64) is the device's signature of `text`. Never throws. */
export function signedBy(publicKey: string, text: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" });
    return verify(null, Buffer.from(text, "utf8"), key, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

/** The media frame: the 32-character invoke id, then the bytes. */
export function mediaFrame(id: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id, "ascii"), payload]);
}
export function readMediaFrame(frame: Buffer): { id: string; payload: Buffer } | null {
  if (frame.length < 32) return null;
  const id = frame.subarray(0, 32).toString("ascii");
  return InvokeId.safeParse(id).success ? { id, payload: frame.subarray(32) } : null;
}

/**
 * A plain sliding-window count: at most `limit` events in `windowMs`. Used for invokes per device,
 * socket attempts per address and pairing attempts, so nothing can be hammered.
 */
export class WindowLimit {
  private readonly seen = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}
  /** Counts one event and answers whether it was still within the limit. */
  take(key: string): boolean {
    if (this.full(key)) return false;
    this.add(key);
    return true;
  }
  /** Whether `key` has used up its window, without counting anything. */
  full(key: string): boolean {
    const since = this.now() - this.windowMs;
    const kept = (this.seen.get(key) ?? []).filter((at) => at > since);
    this.seen.set(key, kept);
    return kept.length >= this.limit;
  }
  /** Counts one event whatever the count already is. */
  add(key: string): void {
    this.seen.set(key, [...(this.seen.get(key) ?? []), this.now()]);
    if (this.seen.size > 1000) this.seen.delete(this.seen.keys().next().value!);
  }
}
