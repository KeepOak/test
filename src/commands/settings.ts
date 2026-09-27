import { z } from "zod";
import type { Store } from "../store.js";
import { FeatureModeSchema, type FeatureMode } from "../feature-switches.js";
import { COMMANDS, type CatalogCommand, type Surface } from "./catalog.js";

/**
 * The owner's three-way switch for the commands the shared table added (wave mac3, commands). It
 * ships off (`commandsShipAs`), except in the terminal (`terminalShipsAs`), and it never touches a command a surface already had:
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

type Reader = Pick<Store, "get">;
/** The switch as saved; never saved is how it ships (on the surface asked about), and a saved record that cannot be read is off. */
export function commandSettings(store: Reader, owner: string, surface?: Surface): CommandSettings {
  const found = store.get("settings", owner, settingKey);
  if (!found) return { mode: surface === "terminal" ? terminalShipsAs : commandsShipAs };
  const saved = CommandSettingsSchema.safeParse(found.data ?? {});
  return saved.success ? saved.data : CommandSettingsSchema.parse({});
}
export function saveCommandSettings(store: Store, owner: string, input: unknown): CommandSettings {
  const value = CommandSettingsSchema.parse(input ?? {});
  store.save("settings", owner, settingKey, value);
  return value;
}
export const commandMode = (store: Reader, owner: string, surface?: Surface): FeatureMode => commandSettings(store, owner, surface).mode;

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
