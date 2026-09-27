/**
 * parity-b2: the owner types an address or a search into the full-size view of Branch's browser, and Branch's own
 * browser goes there, in that conversation's window, which the live view (src/live-stage.ts) then shows.
 *
 * Nothing here goes round a rule. The page is opened with browser.navigate through the same gate as any tool pressed by
 * hand (src/playground.ts tryTool, with the runtime's manualVerdict): the owner's rules, the network's address rules
 * (a private or unlisted address is refused as it is to a task), a household role, and a short-lived key that can
 * never confirm. It is the owner's alone on top of that: refused to a household person, to every short-lived key
 * (POST routes fail closed for them), to a paired phone or anything reaching Branch through a door, and while
 * Lockdown is on. While a task of the conversation is working or waiting, the field is refused, so the owner's
 * typing never steers the task's own tab.
 *
 * Words that are not an address are searched for on the free search page the engine already reads
 * (src/integrations/web-search.ts: DuckDuckGo's plain page), opened as a page like any other.
 *
 * The window is a run of its own, made the first time and finished at once (so the conversation shows no task
 * working), kept open under that run's name while the owner watches: every read of the live view keeps it, and it
 * closes a little after the view stops reading (the way src/devices/find.ts stops looking), when the owner closes it,
 * or when Branch stops. The run's name is kept in memory only.
 *
 *   POST /api/panels/browse        { sessionId, address, confirm? }
 *   POST /api/panels/browse/close  { sessionId }
 */
import { z } from "zod";
import type { Store } from "./store.js";
import type { ToolContext } from "./contracts.js";
import type { TryOutcome, HandRun } from "./playground.js";
import { lockdownActive, lockdownRefusal } from "./lockdown.js";

export const ownerBrowsePath = "/api/panels/browse";
export const ownerBrowseClosePath = "/api/panels/browse/close";
export const BrowseSchema = z.object({
  sessionId: z.string().uuid(),
  address: z.string().trim().min(1).max(2000),
  confirm: z.boolean().default(false),
}).strict();
export const BrowseCloseSchema = z.object({ sessionId: z.string().uuid() }).strict();
/** How long a window stays open once the live view stops reading it. */
export const browseIdleMs = 30_000;
const searchPage = "https://lite.duckduckgo.com/lite/?q=";
export const browseDoorRefusal = "Branch's browser takes addresses only from Branch's own window on this computer.";
export const browseBusyRefusal = "A task is working in this conversation. Its browser is its own until it finishes.";

/** An address as typed, as the page to open: a web address, a site's name, or words to search for. */
export function addressFor(typed: string): string {
  const words = typed.trim();
  if (/^https?:\/\//i.test(words)) return words;
  if (!/\s/.test(words) && /^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(words)) return `https://${words}`;
  return searchPage + encodeURIComponent(words);
}

interface Kept { runId: string; stop: AbortController; timer: ReturnType<typeof setTimeout> | null }
const kept = new Map<string, Kept>();

function idle(sessionId: string, entry: Kept): void {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => close(sessionId), browseIdleMs);
  entry.timer.unref?.();
}
/** The run whose window shows this conversation's page for the owner, if one is open; reading it keeps it open. */
export function browsedRun(sessionId: string): string | null {
  const entry = kept.get(sessionId);
  if (!entry) return null;
  idle(sessionId, entry);
  return entry.runId;
}
/** Closes the owner's window for this conversation (its run's browser window closes with the signal). */
export function close(sessionId: string): boolean {
  const entry = kept.get(sessionId);
  if (!entry) return false;
  if (entry.timer) clearTimeout(entry.timer);
  kept.delete(sessionId);
  entry.stop.abort();
  return true;
}
/** Every window closes when Branch stops. */
export function closeAll(): void { for (const sessionId of [...kept.keys()]) close(sessionId); }

export interface BrowseDeps {
  store: Store;
  owner: string;
  profiles: { isOwner(): boolean };
  viaDoor: boolean;
  /** The conversation has a task working or waiting in it. */
  busy: (sessionId: string) => boolean;
  context: (signal: AbortSignal) => ToolContext;
  /** src/playground.ts tryTool with the runtime's hand-pressed gate, run with this context and run. */
  tryTool: (context: ToolContext, input: { name: string; arguments: Record<string, unknown>; confirm: boolean; sessionId: string },
    ownRun: (tool: string, target: string, sessionId?: string) => HandRun | null) => Promise<TryOutcome>;
}
export class BrowseRefusal extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Why this caller may not steer the browser now, or null. */
export function browseRefusal(deps: Pick<BrowseDeps, "store" | "owner" | "profiles" | "viaDoor" | "busy">, sessionId: string): BrowseRefusal | null {
  if (deps.viaDoor) return new BrowseRefusal(403, browseDoorRefusal);
  if (!deps.profiles.isOwner()) return new BrowseRefusal(403, "Only the owner types into Branch's browser.");
  if (lockdownActive(deps.store, deps.owner)) return new BrowseRefusal(403, lockdownRefusal);
  if (!deps.store.ownsSession(deps.owner, sessionId)) return new BrowseRefusal(404, "Conversation not found");
  if (deps.busy(sessionId)) return new BrowseRefusal(409, browseBusyRefusal);
  return null;
}

/** Opens what the owner typed in the conversation's window, through the gate every hand-pressed tool goes through. */
export async function browse(deps: BrowseDeps, input: z.infer<typeof BrowseSchema>): Promise<TryOutcome & { url: string }> {
  const refused = browseRefusal(deps, input.sessionId);
  if (refused) throw refused;
  const url = addressFor(input.address);
  const had = kept.get(input.sessionId);
  const stop = had?.stop ?? new AbortController();
  // The window's run: made once, the first time the gate lets a page open, and finished at once.
  const ownRun = (_tool: string, target: string): HandRun => {
    if (had) return { id: had.runId, done: () => undefined };
    const run = deps.store.createRun(deps.owner, `browser.navigate: ${target || url}`.slice(0, 2000), input.sessionId, false, "window");
    kept.set(input.sessionId, { runId: run.id, stop, timer: null });
    return { id: run.id, done: (ok, output) => { deps.store.finish(run.id, ok ? "completed" : "failed", output.slice(0, 4000), { mend: false }); } };
  };
  const outcome = await deps.tryTool(deps.context(stop.signal), { name: "browser.navigate", arguments: { url }, confirm: input.confirm, sessionId: input.sessionId }, ownRun);
  const entry = kept.get(input.sessionId);
  if (entry) idle(input.sessionId, entry);
  return { ...outcome, url };
}
