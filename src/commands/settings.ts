import { z } from "zod";
import type { Store } from "../store.js";
import { FeatureModeSchema, type FeatureMode } from "../feature-switches.js";
import { COMMANDS, type CatalogCommand, type Surface } from "./catalog.js";

/**
 * The owner's three-way switch for the commands the shared table added (wave mac3, commands). It
 * ships off (`commandsShipAs`), except in the terminal (`terminalShipsAs`) and this computer's own window
 * (`windowShipsAs`), and it never touches a command a surface already had:
 *
 *   off          each surface keeps exactly the commands it had before; anything else typed with
 *                a slash is what it always was there (a message, or "I do not know that one")
 *   when-needed  every command in the table works when it is typed, but the lists and menus show
 *                only the everyday ones; `/help all` shows the rest
 *   on           every command works and every list shows it
 *
 * The chat apps have their own switch as well (chat-live-settings.ts), which still decides whether
 * a chat reads commands at all; this one decides which of the table's commands it may read.
 */
export const CommandSettingsSchema = z.object({ mode: FeatureModeSchema.default("off") }).strict();
export type CommandSettings = z.infer<typeof CommandSettingsSchema>;
/**
 * The record as kept. `mode` is the switch for every surface (POST /api/commands/settings, which clears `window`);
 * `window` is Settings › General's switch, for this computer's own window only (`saveWindowCommands`), so turning
 * it on or putting it back never turns the phone's or the chat apps' commands on. Either one missing reads as it ships.
 */
const StoredSchema = z.object({ mode: FeatureModeSchema.optional(), window: FeatureModeSchema.optional() }).strict();
const settingKey = "command-catalog";

/** What `POST /api/commands/run` takes: the page it was typed on, the line, and the conversation it is for. */
export const CommandRunSchema = z.object({
  surface: z.enum(["window", "phone", "dashboard"]), line: z.string().trim().min(1).max(16000), sessionId: z.string().uuid().optional(),
}).strict();

// Kept off, by the owner's rule (outside access): the table's commands would be read from the phone and the chat
// apps, where the owner's commands come from outside this window.
export const commandsShipAs: FeatureMode = "off";
// The terminal view is typed at on this computer, and the redesign's terminal (design/redesign/prototype.html termRun)
// answers /usage, /status, /health, /goal and the rest: there the switch, never saved, is on. A saved switch wins.
export const terminalShipsAs: FeatureMode = "on";
// This computer's own window is typed at here too (the owner's ship-on rule, the lead's decision of 2026-09-27): /bg,
// /usage, /new and the rest work there as in the terminal. Only the window on this computer, with its own key: a
// window reached through a door (the paired door, a phone's own key, a caller beyond this computer) or with a
// short-lived key keeps the shipped off, as the phone does. A saved switch wins.
export const windowShipsAs: FeatureMode = "on";

/** How the switch ships where a line is typed; `ownWindow` says the window is this computer's own (see above). */
function shipped(surface: Surface | undefined, ownWindow: boolean): FeatureMode {
  if (surface === "terminal") return terminalShipsAs;
  return surface === "window" && ownWindow ? windowShipsAs : commandsShipAs;
}

type Reader = Pick<Store, "get">;
/** The switch where a line is typed: this computer's window reads its own switch, then the one for every surface; never
    saved is how it ships (on the surface asked about), and a saved record that cannot be read is off. */
export function commandSettings(store: Reader, owner: string, surface?: Surface, ownWindow = false): CommandSettings {
  const found = store.get("settings", owner, settingKey);
  const saved = StoredSchema.safeParse(found?.data ?? {});
  if (!saved.success) return { mode: "off" };
  const here = surface === "window" && ownWindow ? saved.data.window : undefined;
  return { mode: here ?? saved.data.mode ?? shipped(surface, ownWindow) };
}
/** Settings › General's switch: what this computer's own window does (`commandSettings(…, "window", true)`). */
export const windowCommands = (store: Reader, owner: string): CommandSettings => commandSettings(store, owner, "window", true);
/** Saves Settings › General's switch for this computer's own window alone; the phone and the chat apps keep theirs. */
export function saveWindowCommands(store: Store, owner: string, input: unknown): CommandSettings {
  const { mode } = CommandSettingsSchema.parse(input ?? {});
  const saved = StoredSchema.safeParse(store.get("settings", owner, settingKey)?.data ?? {});
  store.save("settings", owner, settingKey, { ...(saved.success ? saved.data : { mode: "off" }), window: mode });
  return { mode };
}
export function saveCommandSettings(store: Store, owner: string, input: unknown): CommandSettings {
  const value = CommandSettingsSchema.parse(input ?? {});
  store.save("settings", owner, settingKey, value);
  return value;
}
export const commandMode = (store: Reader, owner: string, surface?: Surface, ownWindow = false): FeatureMode =>
  commandSettings(store, owner, surface, ownWindow).mode;

/** True when the command can be typed on this surface with the switch where it is. */
export function available(command: CatalogCommand, surface: Surface, mode: FeatureMode): boolean {
  if (!command.surfaces.includes(surface)) return false;
  return command.legacy.includes(surface) || mode !== "off";
}
/** True when the surface's list or menu shows it (the "when needed" position hides the new ones). */
export function listed(command: CatalogCommand, surface: Surface, mode: FeatureMode): boolean {
  return available(command, surface, mode) && (mode === "on" || command.legacy.includes(surface));
}
/** The commands a surface lists, in table order; `all` also takes in what "when needed" hides. */
export function commandsFor(surface: Surface, mode: FeatureMode, all = false): CatalogCommand[] {
  return COMMANDS.filter((command) => (all ? available(command, surface, mode) : listed(command, surface, mode)));
}
