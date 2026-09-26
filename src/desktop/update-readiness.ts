import { z } from "zod";
import { defaultDevLine, devLines, type DevLine } from "../dev-lines.js";

const readinessSchema = z.object({
  channel: z.enum(["stable", "beta", "dev"]),
  /* The Dev channel's line of work (src/dev-lines.ts). An engine from before it does not say it, which means the main line. */
  devLine: z.enum(devLines).optional(),
  busyTasks: z.number().int().nonnegative(),
  /* Dogfood F1 (NAS): the owner's "update by itself" choice, read again at the last gate. An engine that does not say
     it leaves an automatic install waiting. */
  autoUpdate: z.enum(["off", "check", "install"]).optional(),
});
export type UpdateReadiness = z.infer<typeof readinessSchema>;

/** What the owner had chosen when an install began: the channel, its line of work, and whether "update by itself" started it. */
export interface InstallStart { channel: UpdateReadiness["channel"]; automatic: boolean; devLine?: DevLine }

/** The line an answer names, the main line when it names none. */
export const lineOf = (state: Pick<UpdateReadiness, "devLine">): DevLine => state.devLine ?? defaultDevLine;

/**
 * Dogfood F1 (NAS): a Dev install builds for many minutes, and the owner may change their mind meanwhile. Why the
 * install should now wait, or null when it may go on: leaving the channel (or the Dev line of work) it began on stops any install, and turning
 * "update by itself" off stops one that it started (the Update button still works with it off).
 */
export function changedMind(state: UpdateReadiness, start: InstallStart | null): string | null {
  if (!start) return null;
  if (state.channel !== start.channel) return "The update channel was changed, so this update is not installed.";
  // Following another line of work is a change of channel too: the build under way is of the line that was left.
  if (start.channel === "dev" && lineOf(state) !== (start.devLine ?? defaultDevLine))
    return "The line of work the Dev channel follows was changed, so this update is not installed.";
  if (start.automatic && state.autoUpdate !== "install") return "Update by itself was turned off, so this update is not installed.";
  return null;
}

/** Ask the authenticated local engine, including a joined background engine, before an update. */
export async function updateReadiness(url: string, token: string, call: typeof fetch = fetch) {
  const origin = new URL(url);
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/")
    throw new Error("The local engine address is not safe for an update check.");
  const response = await call(`${origin.origin}/api/comfort/update-readiness`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Branch could not confirm that work is idle, so the update is waiting.");
  return readinessSchema.parse(await response.json());
}
