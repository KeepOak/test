import { z } from "zod";

export type TrayState = "idle" | "working" | "needs-you" | "unavailable";
const activitySchema = z.array(z.object({
  status: z.string(), parentRunId: z.string().optional(),
  task: z.object({ state: z.string() }).passthrough().optional(),
}).passthrough());

/** Read the same profile-scoped activity as the window, through its proved engine connection. */
export async function readTrayState(url: string, call: typeof fetch): Promise<TrayState> {
  const origin = new URL(url);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1") return "unavailable";
  const response = await call(`${origin.origin}/api/activity?waiting=1`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) return "unavailable";
  const parsed = activitySchema.safeParse(await response.json());
  if (!parsed.success) return "unavailable";
  const own = parsed.data.filter((run) => !run.parentRunId);
  if (own.some((run) => run.task?.state === "waiting-owner" || ["needs_input", "interrupted"].includes(run.status))) return "needs-you";
  return own.some((run) => run.status === "running") ? "working" : "idle";
}

export const trayStateWords = (state: TrayState): string => ({
  idle: "Ready", working: "Working", "needs-you": "Needs you", unavailable: "Reconnecting",
})[state];

/** A steady badge keeps the mascot visible, with a dot for work and an exclamation for a question. */
export function trayStateBitmap(bitmap: Buffer, side: number, state: TrayState, template: boolean): Buffer {
  if (state === "idle") return bitmap;
  const out = Buffer.from(bitmap), radius = Math.max(2, Math.round(side * 0.19));
  const centre = side - radius - 1;
  const colour = template ? [0, 0, 0] : state === "working" ? [0x5a, 0xa8, 0x3f]
    : state === "needs-you" ? [0x2e, 0x98, 0xc9] : [0x8a, 0x8a, 0x8a];
  for (let y = centre - radius; y <= centre + radius; y++) for (let x = centre - radius; x <= centre + radius; x++) {
    const distance = Math.hypot(x - centre, y - centre);
    if (distance > radius || x < 0 || y < 0 || x >= side || y >= side) continue;
    const at = (y * side + x) * 4;
    const cut = state === "needs-you" && x === centre && (y === centre + radius - 1 || (y < centre && y > centre - radius));
    out[at] = cut ? 255 : colour[0]!; out[at + 1] = cut ? 255 : colour[1]!; out[at + 2] = cut ? 255 : colour[2]!;
    out[at + 3] = cut && template ? 0 : Math.round(255 * Math.min(1, radius - distance + 0.5));
  }
  return out;
}
