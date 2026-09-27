/**
 * parity-b2: the owner's live view of this computer's screen, in the window's full-size computer view.
 *
 * One stream per open view (GET /api/panels/screen?width=<drawn width>): a line of JSON per frame, for as long as the
 * window keeps the request open. The window lets go when the view is closed, hidden, locked or left, or the page dies,
 * and the engine stops the frames with it. Every open view shares one reader of the screen (DesktopControl.liveFrames:
 * on Windows one program, started with the first view and ended with the last), so nothing runs while no view is
 * open and nothing is kept.
 *
 * Smooth but cheap: frames come about ten times a second for a large view and five for a small one, and never faster
 * than the screen can be read without the reader working more than about a third of the time, so a busy computer gets
 * fewer. A view that cannot take frames as fast as they come skips them rather than queueing them.
 *
 * Who may look: the owner, at this computer's own window. Refused, before anything is captured, to
 *   - every short-lived key (src/short-lived-keys.ts ownerOnlyReads) and a household person (src/household-routes.ts
 *     fails closed for any read not listed there),
 *   - a paired phone or anything else reaching Branch through a door (the paired listener, or a caller not on this
 *     computer), which carries the window's own key: `viaDoor`,
 *   - anyone while Lockdown is on, and while Branch is locked (the app lock answers 423 before any route runs).
 * All but the door are asked again before every frame, and the view is ended the moment one of them says no.
 * No frame is taken while Branch's own sign-in handling is under way (src/sign-in-showing.ts): a saved sign-in being read
 * and typed, or the window the owner signs in by hand in; a frame taken as one began is dropped. The picture itself
 * follows every rule a task's picture of the screen follows: the owner's switch for the screen, Windows' own
 * permission, and no frame at all while a window that handles passwords is showing. While one of these holds, the view
 * is told why, in the engine's words, and the frames resume by themselves when it no longer does.
 * Frames are never written to disk, never logged, never put in an event and never shown to a model.
 *
 * Each frame also says whether the owner is driving ("Take over": every task's screen actions wait) and, while a task
 * that clicked is still going, where its newest click landed on this frame (`cursor`, as a share of the frame's width and
 * height, with the Trunk whose task it is), so the view draws that Trunk's cursor. A click on another screen is not drawn.
 *
 *   GET /api/panels/screen
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Store } from "./store.js";
import { lockdownActive, lockdownToolRefusalText } from "./lockdown.js";
import { signInShowing } from "./sign-in-showing.js";

export const liveScreenPath = "/api/panels/screen";
/** Said to a paired phone, or any caller through a door, asking to see this screen. */
export const liveScreenDoorRefusal = "This computer's screen is shown only in Branch's own window on this computer.";
/** Said while Branch is filling a saved sign-in, or its own sign-in window is open. */
export const liveScreenSignInRefusal = "Branch is handling a sign-in right now, so the screen is not shown until it finishes.";

export interface LiveScreenFrame { frame: string; width: number; height: number; at: string }
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

/** The pace: ten frames a second for a large view, five for a small one, one at the slowest. */
export const livePace = { fastMs: 100, smallMs: 200, slowestMs: 1000, smallWidth: 640, busyFactor: 3 };
/** The narrowest and widest frame a view may ask for. */
const WIDTHS = { least: 320, most: 1280 };

/** Why this caller may not see the screen now, or null. Checked before anything is captured. */
export function liveScreenRefusal(deps: Omit<LiveScreenDeps, "desktop">): LiveScreenRefusal | null {
  if (deps.viaDoor) return new LiveScreenRefusal(403, liveScreenDoorRefusal);
  if (!deps.profiles.isOwner()) return new LiveScreenRefusal(403, "Only the owner sees this computer's screen.");
  if (lockdownActive(deps.store, deps.owner)) return new LiveScreenRefusal(403, lockdownToolRefusalText);
  const locked = deps.locked();
  if (locked) return new LiveScreenRefusal(423, locked);
  if (signInShowing()) return new LiveScreenRefusal(409, liveScreenSignInRefusal);
  return null;
}

/** How long to wait after a frame that took `tookMs` before taking the next: by the view's size, and longer when the
 *  frame was slow to take (a busy computer), so the reader works no more than a third of the time. */
export function nextFrameIn(width: number, tookMs: number): number {
  const wanted = width <= livePace.smallWidth ? livePace.smallMs : livePace.fastMs;
  return Math.max(0, Math.min(livePace.slowestMs, Math.max(wanted, tookMs * livePace.busyFactor)) - tookMs);
}

interface Viewer { width: number; send(line: object): void; end(): void }
interface Hub { viewers: Set<Viewer>; source: LiveFrameSource; abort: AbortController; deps: LiveScreenDeps }
let hub: Hub | null = null;

const pause = (ms: number, signal: AbortSignal): Promise<void> => new Promise((done) => {
  if (signal.aborted) return done();
  const timer = setTimeout(finish, ms);
  function finish() { clearTimeout(timer); signal.removeEventListener("abort", finish); done(); }
  signal.addEventListener("abort", finish, { once: true });
});

/** Tells every open view `line` and ends them all: someone may no longer look. */
function endAll(line: object | null): void {
  const current = hub;
  if (!current) return;
  hub = null;
  current.abort.abort();
  current.source.close();
  for (const viewer of current.viewers) { if (line) viewer.send(line); viewer.end(); }
  current.viewers.clear();
}

/** Frames for as long as a view is open, one at a time, shared by every open view. */
async function loop(current: Hub): Promise<void> {
  let said = "";
  while (hub === current && current.viewers.size) {
    const refused = liveScreenRefusal(current.deps);
    if (refused && refused.status !== 409) { endAll({ refusal: refused.message, status: refused.status }); return; }
    const width = Math.max(...[...current.viewers].map((viewer) => viewer.width));
    const started = Date.now();
    let line: object;
    try {
      if (refused) throw refused;
      const shot = await current.source.next(width, current.abort.signal);
      // Asked again once the frame is taken: whatever said no while it was being taken (Lockdown or the app lock
      // turned on, the window switched to someone else, a sign-in that began) drops it, not shows it.
      const since = liveScreenRefusal(current.deps);
      if (since && since.status !== 409) { endAll({ refusal: since.message, status: since.status }); return; }
      if (since) throw since;
      const cursor = placeOnFrame(current.deps.desktop?.pointer?.() ?? null, shot.screen);
      line = { frame: `data:${shot.type};base64,${shot.bytes.toString("base64")}`, width: shot.width, height: shot.height, at: new Date().toISOString(),
        driving: current.deps.desktop?.isDriving?.() === true, ...(cursor ? { cursor } : {}) };
      said = "";
    } catch (error) {
      if (hub !== current) return;
      const message = error instanceof Error ? error.message : String(error);
      await pause(livePace.slowestMs, current.abort.signal);
      if (message === said) continue;
      said = message;
      line = { refusal: message, status: 409 };
    }
    if (hub !== current) return;
    for (const viewer of current.viewers) viewer.send(line);
    await pause(nextFrameIn(width, Date.now() - started), current.abort.signal);
  }
}

/** Stops every live view and the reader behind them (Branch stopping). */
export function stopLiveScreen(): void { endAll(null); }
/** How many views are open, and whether a reader is behind them. */
export const liveScreenViews = (): number => hub?.viewers.size ?? 0;

/**
 * Serves one open view: refuses it before anything is captured, else streams frames until the request goes away.
 * Throws LiveScreenRefusal before anything is sent.
 */
export function streamLiveScreen(deps: LiveScreenDeps, request: IncomingMessage, response: ServerResponse): void {
  const refused = liveScreenRefusal(deps);
  if (refused) throw refused;
  if (!deps.desktop) throw new LiveScreenRefusal(404, "This Branch has no screen to show.");
  const asked = Number(new URL(request.url ?? "/", "http://local").searchParams.get("width"));
  const width = Math.min(WIDTHS.most, Math.max(WIDTHS.least, Number.isFinite(asked) && asked > 0 ? Math.round(asked) : WIDTHS.most));
  response.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  let full = false, ended = false;
  const viewer: Viewer = {
    width,
    send(line) {
      if (full || ended) return; // a view that is behind skips frames rather than queueing them
      full = !response.write(`${JSON.stringify(line)}\n`);
    },
    end() { if (!ended) { ended = true; response.end(); } },
  };
  response.on("drain", () => { full = false; });
  // The view went away (closed, hidden, locked, left, or the page died): its frames stop, and with the last view the reader.
  response.on("close", () => {
    ended = true;
    const current = hub;
    if (!current?.viewers.delete(viewer) || current.viewers.size) return;
    hub = null;
    current.abort.abort();
    current.source.close();
  });
  if (hub) { hub.viewers.add(viewer); return; }
  const current: Hub = { viewers: new Set([viewer]), source: deps.desktop.liveFrames(deps.owner), abort: new AbortController(), deps };
  hub = current;
  void loop(current).catch(() => endAll(null));
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
