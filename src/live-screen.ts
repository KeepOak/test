/**
 * parity-b2: the owner's live view of this computer's screen, in the window's full-size computer view.
 *
 * One frame per read, taken at the moment it is asked for (src/integrations/desktop.ts liveFrame): the window reads
 * about once a second while the view is open on This computer and the page is showing, and stops reading when it is
 * closed, hidden, locked or left. Nothing here runs between reads, so a closed view costs nothing, and nothing is kept.
 * Two reads at once share one frame.
 *
 * Who may look: the owner, at this computer's own window. Refused, before anything is captured, to
 *   - every short-lived key (src/short-lived-keys.ts ownerOnlyReads) and a household person (src/household-routes.ts
 *     fails closed for any read not listed there),
 *   - a paired phone or anything else reaching Branch through a door (the paired listener, or a caller not on this
 *     computer), which carries the window's own key: `viaDoor`,
 *   - anyone while Lockdown is on, and while Branch is locked (the app lock answers 423 before any route runs).
 * The picture itself follows every rule a task's picture of the screen follows: the owner's switch for the screen,
 * Windows' own permission, and no frame at all while a window that handles passwords is showing.
 *
 *   GET /api/panels/screen
 */
import type { Store } from "./store.js";
import { lockdownActive, lockdownToolRefusalText } from "./lockdown.js";

export const liveScreenPath = "/api/panels/screen";
/** Said to a paired phone, or any caller through a door, asking to see this screen. */
export const liveScreenDoorRefusal = "This computer's screen is shown only in Branch's own window on this computer.";

export interface LiveScreenFrame { frame: string; width: number; height: number; at: string }
export interface LiveScreenDeps {
  store: Store;
  owner: string;
  profiles: { isOwner(): boolean };
  /** True when the request came through a door (the paired listener, or a caller not on this computer). */
  viaDoor: boolean;
  desktop: { liveFrame(owner: string): Promise<{ bytes: Buffer; type: string; width: number; height: number }> } | null;
}

export class LiveScreenRefusal extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

let inFlight: Promise<LiveScreenFrame> | null = null;

/** Why this caller may not see the screen now, or null. Checked before anything is captured. */
export function liveScreenRefusal(deps: Omit<LiveScreenDeps, "desktop">): LiveScreenRefusal | null {
  if (deps.viaDoor) return new LiveScreenRefusal(403, liveScreenDoorRefusal);
  if (!deps.profiles.isOwner()) return new LiveScreenRefusal(403, "Only the owner sees this computer's screen.");
  if (lockdownActive(deps.store, deps.owner)) return new LiveScreenRefusal(403, lockdownToolRefusalText);
  return null;
}

/** One frame of this computer's screen, taken now, for the owner. */
export async function liveScreen(deps: LiveScreenDeps): Promise<LiveScreenFrame> {
  const refused = liveScreenRefusal(deps);
  if (refused) throw refused;
  if (!deps.desktop) throw new LiveScreenRefusal(404, "This Branch has no screen to show.");
  const desktop = deps.desktop;
  inFlight ??= (async () => {
    try {
      const shot = await desktop.liveFrame(deps.owner);
      return { frame: `data:${shot.type};base64,${shot.bytes.toString("base64")}`, width: shot.width, height: shot.height, at: new Date().toISOString() };
    } finally {
      inFlight = null;
    }
  })();
  try {
    return await inFlight;
  } catch (error) {
    throw new LiveScreenRefusal(409, error instanceof Error ? error.message : String(error));
  }
}
