import { z } from "zod";

const readinessSchema = z.object({
  /* Two channels. An engine from before Beta became the source build says "dev" for it (src/comfort/settings.ts). */
  channel: z.preprocess((value) => (value === "dev" ? "beta" : value), z.enum(["stable", "beta"])),
  busyTasks: z.number().int().nonnegative(),
  /* Dogfood F1 (NAS): the owner's "update by itself" choice, read again at the last gate. An engine that does not say
     it leaves an automatic install waiting. */
  autoUpdate: z.enum(["off", "check", "install"]).optional(),
});
export type UpdateReadiness = z.infer<typeof readinessSchema>;

/** What the owner had chosen when an install began: the channel, and whether "update by itself" started it. */
export interface InstallStart { channel: UpdateReadiness["channel"]; automatic: boolean }

/**
 * Dogfood F1 (NAS): a Dev install builds for many minutes, and the owner may change their mind meanwhile. Why the
 * install should now wait, or null when it may go on: leaving the channel it began on stops any install, and turning
 * "update by itself" off stops one that it started (the Update button still works with it off).
 */
export function changedMind(state: UpdateReadiness, start: InstallStart | null): string | null {
  if (!start) return null;
  if (state.channel !== start.channel) return "The update channel was changed, so this update is not installed.";
  if (start.automatic && state.autoUpdate !== "install") return "Update by itself was turned off, so this update is not installed.";
  return null;
}

/**
 * The Beta change the owner confirmed in the window although it does not contain this copy's change, or null when
 * none was. Update by itself never confirms: an automatic install that names one is refused outright, as is anything
 * but a whole commit id.
 */
export function confirmedChange(automatic: unknown, confirm: unknown): string | null {
  if (confirm === undefined || confirm === null) return null;
  if (automatic === true) throw new Error("Update by itself never moves to a change that does not contain this copy's, so nothing was installed.");
  if (typeof confirm !== "string" || !/^[0-9a-f]{40}$/.test(confirm))
    throw new Error("Only a Beta change that does not contain this copy's change can be confirmed, so nothing was installed.");
  return confirm;
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
