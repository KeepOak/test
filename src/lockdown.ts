import { z } from "zod";
import type { Store } from "./store.js";
import { audit } from "./audit.js";
import type { ChangeWriter } from "./settings-kit/history.js"; // Q48 review

/**
 * One switch that shuts everything down at once. Turning Lockdown on makes every tool wait for the
 * owner's yes — the yeses already given for a conversation are ended too, by the route that sets it,
 * or an answer given earlier would keep standing in for the question — and switches off the things
 * that reach past this app on their own: running a script, leaving a program running, using the
 * screen and keyboard, borrowing the owner's browser, and sending anything out, which is both
 * messages and notes to other programs.
 *
 * What made it possible to turn back on again is the exact settings that were there before. They
 * are copied, untouched, into one kept record; turning Lockdown off writes those same settings back
 * and nothing else, so a switch that was already off before stays off afterwards. Both moments are
 * written into the record of what the assistant was allowed to do.
 */

/** The settings Lockdown takes over, and what it sets each one to while it is on. */
const guarded: readonly { key: string; locked: Record<string, unknown> }[] = [
  // Every tool, on anything, waits for a yes. The first matching rule wins, so one rule is enough.
  { key: "policy", locked: { preset: "custom", rules: [{ tool: "*", match: "*", applies: "any", decision: "ask", remember: "never" }], limits: { toolCallsPerMinute: 0, modelRoundsPerMinute: 0 } } },
  { key: "code-run", locked: { enabled: false } },
  // Programs the owner allows to be left running: with the list empty, process.start refuses by name.
  { key: "background-processes", locked: { programs: {} } },
  { key: "desktop-control", locked: { enabled: false } },
  { key: "browser-attach", locked: { enabled: false, runId: "", grantedAt: "" } },
];
const stateKey = "lockdown";

export const LockdownSchema = z.object({ on: z.boolean() }).strict();
export interface LockdownState {
  on: boolean;
  /** When it was turned on, so the rail can say how long it has been on. */
  since: string | null;
  /** In plain language, what is switched off while it is on. */
  effects: string[];
}
export const lockdownEffects = [
  "Every other tool waits for your yes.",
  "Anything you already said yes to has to be asked again.",
  "Running a command or a script, leaving a program running, and handing work to another computer are refused outright; you are not asked.",
  "Using your screen and keyboard is refused.",
  "Borrowing your browser is refused.",
  "Sending messages out, steps that send to other apps, and telling other programs what happened are all off.",
  "Automations that start by themselves, routines a Trunk owns, your other devices and your personal connectors are off, whatever they were set to.",
];

/** `record` is the change record turning it on wrote, so turning it off can be recorded as putting that back. */
interface SavedLockdown { on: boolean; since: string | null; before: Record<string, Record<string, unknown> | null>; record?: string }

function saved(store: Store, owner: string): SavedLockdown {
  const record = store.get("settings", owner, stateKey)?.data as unknown as SavedLockdown | undefined;
  return record && typeof record.on === "boolean" ? record : { on: false, since: null, before: {} };
}

/** Whether Lockdown is on, and what that stops. */
export function lockdownState(store: Store, owner: string): LockdownState {
  const current = saved(store, owner);
  return { on: current.on, since: current.since, effects: lockdownEffects };
}

/** True while Lockdown is on. The one question the sending paths ask before they send anything. */
export function lockedDown(store: Store, owner: string): boolean {
  return lockdownActive(store, owner);
}

/* ---------- mac7/lockdown-fix: Lockdown wins over any saved switch, read at the moment of use ---------- */

/**
 * The switches written above are only half of it: a feature with a saved mode ("on", "when
 * needed") reads its mode first, and a change saved while Lockdown is on would switch it back on.
 * So every covered feature also asks here each time it is read, and while Lockdown is on the answer
 * is "off" whatever was saved.
 */
type Reader = Pick<Store, "get">;

/** True while Lockdown is on; for the settings readers, which only hold a reader. */
export function lockdownActive(store: Reader, owner: string): boolean {
  const record = store.get("settings", owner, stateKey)?.data as { on?: unknown } | undefined;
  return record?.on === true;
}

/**
 * The settings records Lockdown switches off: the screen and keyboard, borrowing the browser,
 * running a script, every automation part, routines a Trunk owns, the owner's other devices
 * (src/devices/) and every personal connector (src/personal/).
 */
export const coveredSettings: readonly RegExp[] = [
  /^desktop-control$/, /^browser-attach$/, /^code-run$/, /^autonomy-/, /^trunks-routines$/, /^devices-book$/, /^personal-/,
  // r17-i integration: the reach parts that reach past this computer (src/reach/settings.ts). Notes, the
  // arena and pausing a chat app stay: they are local, or only ever tighten.
  /^reach-(machines|remote-trunks|background-screen|video|relay|send|agent-git|skill-bundles|usb)$/,
  // mac7/wake-pins: listening for a word is the microphone open by itself, so Lockdown switches it off.
  /^wake-word$/,
  // mac7/live-voice: dictation holds the microphone open while it listens, so Lockdown switches it
  // off too — and the listener asks again before every piece of sound, so it lets go within a tick.
  /^live-dictation$/,
  // mac7/vault-autofill (R17-068): typing one of the owner's saved passwords into a page.
  /^vault-autofill$/,
  // mac7/bind: a door open to the private network is Branch reaching past this computer, which is
  // the very thing Lockdown shuts. It reads as "this computer" while Lockdown is on.
  /^listen-address$/,
  // mac7/one-click (issue #107): installing a program changes the owner's own computer.
  /^local-runner-install$/,
  // mac7/clean-uninstall: letting an installer put a program outside Branch reaches further still,
  // so Lockdown reads it as no. (Removing Branch is not here: Lockdown must never trap the owner.)
  /^local-runner-place$/,
  // FQ-execution.desktop: the shared Linux desktop reads off, and a running one is taken down.
  /^linux-desktop$/,
];

/** True when Lockdown is on and this settings record is one it switches off. */
export function lockdownOverrides(store: Reader, owner: string, key: string): boolean {
  return coveredSettings.some((pattern) => pattern.test(key)) && lockdownActive(store, owner);
}

/** Kinds of tool refused outright while Lockdown is on, rather than asked about. */
const refusedPermissions: readonly string[] = [
  "shell.execute", "code.execute", "remote.execute", "process.manage", "desktop.control", "desktop.view", "desktop.clipboard",
  "devices.read", "devices.capture", "devices.act", "devices.run",
  // Integration review: handing a task to another computer running Branch, and a step that sends
  // something to another app (Slack, Notion, Telegram...), reach past this computer on their own.
  "nodes.run", "blocks.run",
];
const refusedTools: readonly string[] = ["browser.borrow",
  // r17-i integration: another computer, a Trunk over there, a paid video, a bundle fetched from an address.
  "machines.list", "machines.look", "trunks.remote.roster", "trunks.remote.message", "video.generate", "skills.bundle.preview"];
/** Tools that only lower the risk (stopping a program), so Lockdown never stands in their way. */
const stillAllowedTools: readonly string[] = ["process.stop"];
export const lowersRiskOnly = (tool: string): boolean => stillAllowedTools.includes(tool);

export const lockdownToolRefusalText =
  "Lockdown is on, so commands, programs, your screen and keyboard, your own browser, your other devices and other computers are refused, without asking. Turn Lockdown off in Settings to allow this again.";

/** Why this tool is refused while Lockdown is on, or null. Checked in `Runtime.checkPolicy`. */
export function lockdownToolRefusal(store: Reader, owner: string, tool: string, permission: string): string | null {
  if (lowersRiskOnly(tool)) return null;
  if (!refusedTools.includes(tool) && !refusedPermissions.includes(permission)) return null;
  return lockdownActive(store, owner) ? lockdownToolRefusalText : null;
}
type LockdownListener = (store: Reader, owner: string, on: boolean) => void;
const listeners = new Set<LockdownListener>();

/**
 * Integration review: told each time Lockdown is turned on or off, so a part holding something open
 * (a device's socket) can let go at once. Hands back the way to stop listening.
 */
export function onLockdownChange(listener: LockdownListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function tellListeners(store: Reader, owner: string, on: boolean): void {
  for (const listener of [...listeners]) try { listener(store, owner, on); } catch { /* telling must not undo the switch */ }
}
/* ---------- end mac7/lockdown-fix ---------- */

/** The sentence a refused send gives back, so every place says the same thing. */
export const lockdownRefusal = "Lockdown is on, so nothing is being sent out. Turn it off in Settings to allow this again.";

/**
 * Turns Lockdown on or off. Turning it on copies the settings it is about to change and then
 * changes them; turning it off writes exactly those copies back — a setting that had never been
 * saved before is removed again rather than being given a made-up default.
 */
export function setLockdown(store: Store, owner: string, input: unknown, by: ChangeWriter = "owner-in-window"): LockdownState {
  const { on } = LockdownSchema.parse(input);
  const current = saved(store, owner);
  if (on === current.on) return lockdownState(store, owner);
  // Q48 review: the settings, their change record and Lockdown's own record are saved together or not at all.
  store.atomically(() => { if (on) turnOn(store, owner, by); else turnOff(store, owner, current, by); });
  audit(store, owner, {
    action: "lockdown.changed", actor: owner, subject: on ? "Lockdown on" : "Lockdown off",
    reason: on
      ? "Every tool now waits for a yes; host programs, the screen, the browser and sending out are off"
      : "The settings that were in place before Lockdown were put back exactly as they were",
    outcome: "saved",
  });
  tellListeners(store, owner, on); // mac7/lockdown-fix integration review
  return lockdownState(store, owner);
}

/**
 * Q48 review: what Lockdown changes among the Settings settings is written down as a change record
 * like any other, so "why is this on?" names Lockdown. Turning it off is recorded as putting back
 * what turning it on changed, so the two cancel out and an older change can still be undone.
 */
type LockdownRecorder = (store: Store, owner: string, origin: { writer: ChangeWriter; detail: "on" | "off"; undoes?: string },
  touches: (key: string) => boolean, write: () => void) => string | null;
let recorder: LockdownRecorder = (_store, _owner, _origin, _touches, write) => { write(); return null; };
/**
 * The settings kit hands in its recorder when it loads (src/settings-kit/recorded-write.ts). It is
 * handed in rather than imported because the catalogue imports the settings that import this file.
 */
export function recordLockdownWith(record: LockdownRecorder): void { recorder = record; }
/**
 * The settings Lockdown changes, as the settings kit shows them: the ones it writes over, and the
 * ones read as off while it is on (where Branch listens reads as this computer only).
 */
const touches = (key: string): boolean => guarded.some((entry) => entry.key === key) || coveredSettings.some((pattern) => pattern.test(key));

function turnOn(store: Store, owner: string, by: ChangeWriter): void {
  const before: Record<string, Record<string, unknown> | null> = {};
  const since = new Date().toISOString();
  const state = (): SavedLockdown => ({ on: true, since, before });
  // Lockdown's own record is saved inside the recorded write: what the kit shows can depend on it.
  const record = recorder(store, owner, { writer: by, detail: "on" }, touches, () => {
    for (const entry of guarded) {
      const saved = store.get("settings", owner, entry.key);
      before[entry.key] = saved ? saved.data : null;
      store.save("settings", owner, entry.key, { ...(saved?.data ?? {}), ...entry.locked });
    }
    store.save("settings", owner, stateKey, { ...state() });
  });
  if (record) store.save("settings", owner, stateKey, { ...state(), record });
}

function turnOff(store: Store, owner: string, current: SavedLockdown, by: ChangeWriter): void {
  const undoes = typeof current.record === "string" ? { undoes: current.record } : {};
  recorder(store, owner, { writer: by, detail: "off", ...undoes }, touches, () => {
    for (const entry of guarded) {
      const was = current.before[entry.key];
      if (was === null || was === undefined) store.delete("settings", owner, entry.key);
      else store.save("settings", owner, entry.key, was);
    }
    store.save("settings", owner, stateKey, { on: false, since: null, before: {} });
  });
}
