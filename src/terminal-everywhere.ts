import { hostname } from "node:os";
import type { Runtime } from "./runtime.js";
import type { Store } from "./store.js";
import type { Words } from "./terminal-words.js";
import { trunksFor } from "./trunks/index.js";
import { usageGlance } from "./usage-limits-api.js";

/**
 * phase2/everywhere: what the terminal view shows beside the conversation so it reads like the window
 * (redesign "Branch, grown up", critique #44): the rail down the left with this computer, the owner's
 * paired devices and Trunks, and the usage line with what the tightest connection has left. Both are
 * read from the same records the window reads and only for the owner; a household profile or a
 * short-lived key gets neither. Nothing here draws or writes anything.
 */
export interface RailItem { kind: "computer" | "phone" | "trunk"; name: string; detail: string; on: boolean; sessionId?: string }
export interface UsageBar { name: string; percentLeft: number; note: string }

interface DeviceLike { name: string; platform: string; lastSeen: string | null }
/** The parts of the app the rail and the usage line read; any of them may be missing. */
export interface EverywhereApp {
  store: Store;
  runtime: Runtime;
  devices?: { book: { devices(): DeviceLike[] } };
}

const ownerHere = (store: Store): boolean => {
  try { store.profiles.requireOwner("The rail"); return true; } catch { return false; }
};
const clip = (text: string, size: number): string => (text.length > size ? `${text.slice(0, size - 1)}…` : text);

/** This computer first, then the owner's other devices, then each Trunk that is switched on and shown. */
export function railItems(app: EverywhereApp, words: Words, sessionId?: string, host = hostname()): RailItem[] {
  const here: RailItem = { kind: "computer", name: clip(host || words.t("terminal.rail.here", "This computer"), 40),
    detail: words.t("terminal.rail.here", "This computer"), on: false };
  if (!ownerHere(app.store)) return [here];
  const devices = (app.devices?.book.devices() ?? []).map((device): RailItem => ({
    kind: device.platform === "ios" || device.platform === "android" ? "phone" : "computer", name: clip(device.name, 40),
    detail: device.lastSeen ? words.t("terminal.rail.seen", "Seen {when}", { when: device.lastSeen.slice(0, 16).replace("T", " ") })
      : words.t("terminal.rail.paired", "Paired"), on: false,
  }));
  const trunks = trunksFor(app.runtime);
  const shown = trunks && trunks.mode("trunks") !== "off" ? trunks.records.list().filter((trunk) => !trunk.hidden) : [];
  const faces = shown.map((trunk): RailItem => ({
    kind: "trunk", name: clip(trunk.name, 40), detail: trunk.title ? clip(trunk.title, 60) : `@${trunk.handle}`,
    on: !!sessionId && trunk.chatSessionId === sessionId, sessionId: trunk.chatSessionId,
  }));
  here.on = !faces.some((face) => face.on);
  return [here, ...devices, ...faces];
}

/** "resets at 18:00", "resets on 21 Sep", or nothing when the service never said. */
export function resetText(resetAt: string | null, words: Words, now: number): string {
  const at = resetAt ? Date.parse(resetAt) : NaN;
  if (!Number.isFinite(at)) return "";
  const when = new Date(at);
  const sameDay = new Date(now).toDateString() === when.toDateString();
  const time = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`;
  return sameDay ? words.t("terminal.usage.resetsAt", "resets at {time}", { time })
    : words.t("terminal.usage.resetsOn", "resets on {day}", { day: when.toISOString().slice(0, 10) });
}

/**
 * The tightest connection, as the ring under the window's message box shows it; nothing at all when no
 * service reported a share, the owner hid the ring, or somebody other than the owner is here.
 */
export function usageBar(app: EverywhereApp, words: Words, now = Date.now()): UsageBar | undefined {
  const glance = usageGlance(app, now);
  if (!glance.available || glance.settings.ring === "hidden" || !glance.tightest) return undefined;
  const tight = glance.tightest;
  const name = tight.accountLabel ? `${tight.connectionName} — ${tight.accountLabel}` : tight.connectionName;
  const note = [resetText(tight.resetAt, words, now), tight.estimated ? words.t("terminal.usage.estimate", "an estimate") : ""]
    .filter(Boolean).join(" · ");
  return { name: clip(name, 40), percentLeft: tight.percentLeft, note };
}
