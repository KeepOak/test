/**
 * live-stage: what the window's full-size view of Branch's browser shows while a conversation's task works in it.
 *
 * Nothing runs here and nothing is kept on disk. While the conversation's newest task is going and has its own browser
 * window open, each read takes one frame of the tab it works in (BranchBrowser.watch: a small JPEG with the secret boxes
 * of every frame in it covered), with the page's address and title, the tabs beside it, and what the task is doing now
 * in the words the activity feed uses. The window reads it about twice a second while the view is open, which makes the live view.
 * The browser window closes when its task ends; the last frame read is then kept in memory only, for a few
 * conversations, so the view can still show where the task finished until Branch restarts.
 *
 * The owner's alone: a household person and every short-lived key are refused before this runs
 * (src/short-lived-keys.ts ownerOnlyReads, src/household-routes.ts fails closed), and the conversation must be the
 * owner's own. A window borrowed in the owner's own browser (browser.borrow) is never pictured. Every word that
 * comes back (addresses, titles, the step) is passed through the saved-secret scrubber and the leak guard.
 *
 * The owner's own browser for the conversation (its kept browser) is read through /api/panels/browser instead
 * (src/browser-control-api.ts); a task working in it is watched here like any other.
 *
 *   GET /api/panels/live?session=<id>
 */
import type { Store } from "./store.js";
import type { WatchedWindow } from "./integrations/browser.js";
import { runActivity } from "./activity.js";
import { redactLeaksIn } from "./leak-guard.js";

export const liveStagePath = "/api/panels/live";

export interface LiveTab { url: string; title: string; active: boolean }
export interface LiveBrowser {
  /** True while the task's window is open and this frame was just taken; false for the last frame kept after it closed. */
  live: boolean;
  runId: string;
  url: string;
  title: string;
  tabs: LiveTab[];
  /** The frame as a data: address (image/jpeg), or null when none could be taken. */
  frame: string | null;
  /** An unavailable picture never means that the page is closed. No raw capture errors leave the engine. */
  preview: "ready" | "unavailable" | "borrowed";
  /** The page is waiting for a person (a sign-in or a "prove you're a person" check), not for the task. */
  needs: "sign-in" | "captcha" | null;
  at: string;
}
export interface LiveStage {
  /** The conversation's newest task that is still going, if any. */
  runId: string | null;
  status: string | null;
  /** What that task is doing now, as the activity feed says it. */
  doing: string | null;
  browser: LiveBrowser | null;
}

export interface LiveStageDeps {
  store: Store;
  /** The runtime's owner, the name the browser keys each task's window under. */
  owner: string;
  /** Who is at the window: records are theirs (`scope`), and only the owner is shown anything. */
  profiles: { scope(): string; isOwner(): boolean };
  browser: { watch?(owner: string, runId: string): Promise<WatchedWindow | null> } | null;
}

const GOING = new Set(["running", "needs_input"]);
/** How many conversations keep their last frame in memory. */
const KEPT = 8;
const kept = new Map<string, LiveBrowser>();

function keep(key: string, view: LiveBrowser): void {
  kept.delete(key);
  kept.set(key, view);
  while (kept.size > KEPT) kept.delete(kept.keys().next().value!);
}
/** Only a web address or the empty page is shown as an address; anything else reads as empty. */
const shownAddress = (url: string): string => (/^https?:\/\//i.test(url) || url === "about:blank" ? url : "");

/** Addresses, titles and the step, with saved secrets and key-shaped values taken out. */
function cleaned<T>(store: Store, value: T): T {
  return redactLeaksIn(store.secrets.scrubber.deep(value)).value;
}

/** The window being watched: the conversation's newest task while it is still going, else the owner's own. */
async function watching(deps: LiveStageDeps, runId: string | null): Promise<LiveBrowser | null> {
  if (!runId || !deps.browser?.watch) return null;
  const seen = await deps.browser.watch(deps.owner, runId);
  if (!seen) return null;
  const words = cleaned(deps.store, { url: shownAddress(seen.url), title: seen.title,
    tabs: seen.tabs.map((tab) => ({ url: shownAddress(tab.url), title: tab.title, active: tab.active })) });
  return { live: true, runId, ...words,
    preview: seen.borrowed ? "borrowed" : seen.frame ? "ready" : "unavailable", needs: seen.needs ?? null,
    frame: seen.frame ? `data:image/jpeg;base64,${seen.frame.toString("base64")}` : null, at: new Date().toISOString() };
}

/** What the full-size view shows for this conversation now; empty for anyone but the owner or another's conversation. */
export async function liveStage(deps: LiveStageDeps, sessionId: string): Promise<LiveStage> {
  const empty: LiveStage = { runId: null, status: null, doing: null, browser: null };
  const scope = deps.profiles.scope();
  if (!sessionId || !deps.profiles.isOwner() || !deps.store.ownsSession(scope, sessionId)) return empty;
  const runs = deps.store.runs(scope).filter((run) => run.sessionId === sessionId);
  // Only the newest task counts as going: an older one left waiting was carried on by a newer one (a yes answered in
  // the conversation starts the next task), so its question is no longer the one that matters.
  const going = runs[0] && GOING.has(runs[0].status) ? runs[0] : null;
  const key = JSON.stringify([scope, sessionId]);
  const found = await watching(deps, going?.id ?? null), last = kept.get(key);
  // A frame can fail while the page is between two addresses or its window is closing; the last one of the same
  // window stands in for that moment rather than a blank. Only a real frame is kept.
  const now = found && found.preview !== "borrowed" && !found.frame && last?.runId === found.runId ? { ...found, frame: last.frame } : found;
  if (found?.frame) keep(key, found);
  // The last frame kept is shown only while its task is still the conversation's newest: never beside another task.
  const browser = now ?? (last && last.runId === runs[0]?.id ? { ...last, live: false } : null);
  const doing = going ? cleaned(deps.store, runActivity(going, deps.store.events(going.id)).current) : null;
  return { runId: going?.id ?? null, status: going?.status ?? null, doing, browser };
}
