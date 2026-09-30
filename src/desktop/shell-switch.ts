import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * The shell's own update with versioned app folders (app-folders.ts): the new version is already whole in its own
 * folder and has passed its checks, so all that is left is to switch `current.json` to it and start it in place of
 * this one. The gateway and its engine keep running through it (they belong to the detached gateway, not to this
 * window), and the window comes back where it was, with the draft, caret and scroll the owner left (`HandOver`).
 *
 * The switch is done by the hand-over runner (hand-over.ts) with version-switch.ts, because it has to outlive this
 * process: it waits for this process to end, renames the new pointer into place, starts the new version and watches for
 * it to say its window is up (`shellUpMarker`). If it does not say so in time, it ends that process by its id (never by
 * name: other Electron programs on this computer are left alone), renames the old pointer back when the old version can
 * still read the saved work, leaves the reason where the version then in use finds it (`SwitchFailure`), and starts that
 * version, in the same place. So a missing window after an update is always noticed and a window always comes back.
 */

/** Written by a shell once its window has drawn (or, started hidden, once its page is ready), for the script to see. */
export const shellUpMarker = (scratchDir: string, version: string): string =>
  join(scratchDir, `shell-up-${version.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80)}`);
export async function markShellUp(scratchDir: string, version: string, pid = process.pid, restored: boolean | null = null): Promise<void> {
  await mkdir(scratchDir, { recursive: true });
  // `restored`: after a switch, whether the page confirmed it put back what the old window had open (null: nothing kept).
  await writeFile(shellUpMarker(scratchDir, version), JSON.stringify({ pid, at: new Date().toISOString(), restored }));
}

/** What the old version reads when the new one did not come up, so it can say so (never silently). */
export const FailureSchema = z.object({ kept: z.string().max(100), tried: z.string().max(100), commit: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  at: z.iso.datetime(), message: z.string().max(600) }).strict();
export type SwitchFailure = z.infer<typeof FailureSchema>;
export const failureName = "shell-switch-failed.json";

export async function readSwitchFailure(scratchDir: string, runningVersion: string): Promise<SwitchFailure | null> {
  const path = join(scratchDir, failureName);
  let failure: SwitchFailure;
  try { failure = FailureSchema.parse(JSON.parse(await readFile(path, "utf8"))); } catch { return null; }
  await rm(path, { force: true });
  // Only the version it went back to reports it, once, and only while it is news (the last day).
  return failure.kept === runningVersion && Date.now() - Date.parse(failure.at) < 24 * 3600_000 ? failure : null;
}

/** The window as the owner left it, for the new version to open the same way (in userData, private, short-lived). */
export const HandOverSchema = z.object({ version: z.string().max(100), visible: z.boolean(), at: z.iso.datetime(),
  /** The page's own record of what was open (public/app/shell/liveupdate.js keepForShell), or null. */
  kept: z.string().max(2_000_000).nullable() }).strict();
export type HandOver = z.infer<typeof HandOverSchema>;
export const handOverName = "shell-handover.json";

export async function writeHandOver(userData: string, handOver: HandOver): Promise<void> {
  await writeFile(join(userData, handOverName), JSON.stringify(HandOverSchema.parse(handOver)), { mode: 0o600 });
}
/** Taken once by the version it was written for, within ten minutes; anything else is removed and ignored. */
export async function takeHandOver(userData: string, version: string, now = Date.now()): Promise<HandOver | null> {
  const path = join(userData, handOverName);
  let found: HandOver | null = null;
  try { found = HandOverSchema.parse(JSON.parse(await readFile(path, "utf8"))); } catch { found = null; }
  await rm(path, { force: true }).catch(() => undefined);
  return found && found.version === version && now - Date.parse(found.at) < 10 * 60_000 ? found : null;
}

/**
 * The invisible moment for a shell switch: the window is not on screen (hidden in the tray or minimised), the screen is
 * locked, or the owner has stepped away from it (no input for two minutes and another window in front). Never while it
 * is in front of them, even untouched: the old window goes before the new one comes, and they would see the gap.
 */
export function invisibleMoment(state: { visible: boolean; minimized: boolean; focused?: boolean; idle: "active" | "idle" | "locked" | "unknown" }): boolean {
  return !state.visible || state.minimized || state.idle === "locked" || (state.idle === "idle" && state.focused === false);
}
export const invisibleWaitWords = "The new version is ready. It takes over the moment Branch is minimised or in the tray, or when you step away; your conversations and chat apps keep running.";
