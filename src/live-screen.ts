/**
 * parity-b2: what the owner's live view of this computer shares with the rest of the screen code. The view itself (the
 * chosen display or app window, its frames, Take over and Hand back through it) is src/local-screen.ts at
 * GET /api/panels/screen; the stream that read the first monitor whatever it showed, Branch's own window included, was
 * replaced by it.
 *
 * Kept here: placing a Trunk's newest click on a frame (`cursor`, as a share of the frame's width and height, with the
 * Trunk whose task it is; a click on another screen is not drawn), and "Take over" / "Hand back" for the paths the
 * window still calls, refused to a door, to anyone but the owner, under Lockdown and while Branch is locked.
 */
import type { Store } from "./store.js";
import { lockdownActive, lockdownToolRefusalText } from "./lockdown.js";

/** Said to a paired phone, or any caller through a door, asking to see this screen. */
export const liveScreenDoorRefusal = "This computer's screen is shown only in Branch's own window on this computer.";

export interface LiveFrameSource {
  next(maxWidth: number, signal: AbortSignal): Promise<{ bytes: Buffer; type: string; width: number; height: number; screen?: { x: number; y: number; w: number; h: number } }>;
  close(): void;
}
/** Where a task's newest click landed, in the pixels the screen box is in. */
export interface LivePointer { x: number; y: number; at: string; trunk: string | null }
/** A click placed on a frame: shares of its width and height, or null when it is not on this screen. */
export function placeOnFrame(pointer: LivePointer | null, screen: { x: number; y: number; w: number; h: number } | undefined): { x: number; y: number; at: string; trunk: string | null } | null {
  if (!pointer || !screen || screen.w <= 0 || screen.h <= 0) return null;
  const x = (pointer.x - screen.x) / screen.w, y = (pointer.y - screen.y) / screen.h;
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
  return { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000, at: pointer.at, trunk: pointer.trunk };
}
export interface LiveScreenDeps {
  store: Store;
  owner: string;
  profiles: { isOwner(): boolean };
  /** True when the request came through a door (the paired listener, or a caller not on this computer). */
  viaDoor: boolean;
  /** Why Branch is locked right now (the app lock), or null. */
  locked: () => string | null;
  desktop: { liveFrames(owner: string): LiveFrameSource; pointer?(): LivePointer | null; isDriving?(): boolean } | null;
}

export class LiveScreenRefusal extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/**
 * "Take over" and "Hand back" for this computer's screen (POST /api/panels/screen/take-over and /hand-back): the owner,
 * at this computer's own window, drives, and every task's screen action waits until they hand it back. Refused to a
 * paired phone or any caller through a door, to anyone but the owner (a household person, and a short-lived key, which
 * src/short-lived-keys.ts refuses before this), and while Branch is locked. No tool reaches these, so no task, Trunk or
 * model can hand the screen back to itself.
 */
export const screenTakeOverPath = "/api/panels/screen/take-over";
export const screenHandBackPath = "/api/panels/screen/hand-back";
export interface ScreenControl { takeOver(): { driving: boolean }; handBack(): { driving: boolean } }
export function screenControl(deps: Pick<LiveScreenDeps, "viaDoor" | "profiles" | "locked" | "store" | "owner">, control: ScreenControl | null, path: string): { driving: boolean } {
  if (deps.viaDoor) throw new LiveScreenRefusal(403, liveScreenDoorRefusal);
  if (!deps.profiles.isOwner()) throw new LiveScreenRefusal(403, "Only the owner takes over this computer's screen.");
  if (lockdownActive(deps.store, deps.owner)) throw new LiveScreenRefusal(403, lockdownToolRefusalText);
  const locked = deps.locked();
  if (locked) throw new LiveScreenRefusal(423, locked);
  if (!control) throw new LiveScreenRefusal(404, "This Branch has no screen to show.");
  return path === screenTakeOverPath ? { driving: control.takeOver().driving } : control.handBack();
}
