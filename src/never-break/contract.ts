import { z } from "zod";

/**
 * What the gateway and its worker say to each other, and which versions of that they understand.
 * Each side states the one it speaks and the range it can still read, so a new worker runs under an
 * old gateway (after an update, before the gateway itself is replaced) and an old worker under a new
 * one (after a rollback). Add a field freely; bump `speaks` only when a message changes meaning,
 * and keep the old number in `accepts` for one release.
 */
export const gatewayContract = { speaks: 1, accepts: [1, 1] as [number, number] };

const range = z.tuple([z.number().int().min(1), z.number().int().min(1)]);

export const WorkerReadySchema = z.object({
  type: z.literal("ready"),
  contract: z.number().int().min(1),
  accepts: range,
  port: z.number().int().min(1).max(65535),
  version: z.string().max(40),
  pid: z.number().int().positive(),
  /** A desktop candidate may serve restoration reads, but has not passed the renderer check yet. */
  provisional: z.boolean().optional(),
}).passthrough();
export type WorkerReady = z.infer<typeof WorkerReadySchema>;

export const GatewayMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stop") }).passthrough(),
  z.object({ type: z.literal("hello"), contract: z.number().int().min(1), accepts: range }).passthrough(),
]);
export type GatewayMessage = z.infer<typeof GatewayMessageSchema>;

/** True when either side can read the other's messages. */
export function contractsMeet(
  gateway: { speaks: number; accepts: [number, number] },
  worker: { speaks: number; accepts: [number, number] },
): boolean {
  const within = (value: number, [low, high]: [number, number]) => value >= low && value <= high;
  return within(worker.speaks, gateway.accepts) || within(gateway.speaks, worker.accepts);
}
