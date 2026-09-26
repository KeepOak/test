import { levelFor, parseLine, type CatalogCommand, type Level, type Surface } from "./catalog.js";
import { available, commandMode } from "./settings.js";
import { HANDLERS, type Access, type Call, type CommandHost, type Reply } from "./handlers.js";
import { promptsLine, runSavedCommand } from "./saved.js";
import { householdCommandRefusal, householdHere } from "./household.js"; // Q259
import { householdRefusal } from "../household-routes.js"; // Q259

/**
 * Carries out one typed command for a surface (wave mac3, commands). The rules, in order:
 *
 * 1. A line that is not a command the surface can take right now is not a command: the caller
 *    treats it as it always did (a message, or "I do not know that one").
 * 2. The key must allow what the command does. Looking needs any key; starting a task needs a key
 *    that may start tasks; changing settings or permissions needs the key of this computer, and in
 *    the window also the owner's own profile — exactly what the matching API route asks, or more.
 * 3. A chat app never gets a command that changes settings or permissions, whoever sent it.
 */
export interface Invocation {
  surface: Surface;
  line: string;
  sessionId?: string | undefined;
  access: Access;
  permissions?: string[];
}
export interface Outcome extends Reply { command: string; refused?: true }

const rank: Record<Level, number> = { look: 0, run: 1, owner: 2 };
const allows: Record<Access, number> = { read: 0, run: 1, full: 2 };

/** Why this key may not do this, or null when it may. */
export function refusalFor(level: Level, access: Access, surface: Surface): string | null {
  if (surface === "chat" && level === "owner") return "That can only be changed in the Branch app, not from a chat.";
  if (allows[access] >= rank[level]) return null;
  return level === "owner"
    ? "Only the key of this computer can change that. Do it in the app window on this computer."
    : "This key may only look. Start tasks with a key that may run them.";
}

/** The command a line is for this surface, or null when the surface should treat it as before. */
export function commandFor(host: CommandHost, surface: Surface, line: string): { command: CatalogCommand; argument: string } | null {
  const mode = commandMode(host.runtime.store, host.runtime.owner);
  const parsed = parseLine(line, mode === "off", surface);
  if (!parsed || !available(parsed.command, surface, mode) || !HANDLERS[parsed.command.name]) return null;
  return parsed;
}

export async function executeCommand(host: CommandHost, input: Invocation): Promise<Outcome | null> {
  const parsed = commandFor(host, input.surface, input.line);
  // ---- bucket 12: the owner's own saved commands, only when the shipped table did not know the line ----
  // Q259: they are the owner's, so for a household person at the window such a line is no command at all (which says
  // nothing about what the owner saved), and `/prompts` typed while the shipped table is off is refused as it is on.
  if (!parsed && householdHere(host.runtime.store, input.surface))
    return promptsLine(host.runtime.store, host.runtime.owner, input.line) ? { command: "prompts", text: householdRefusal, refused: true } : null;
  if (!parsed) return runSavedCommand(host, input);
  // ---- end of the bucket 12 hook ----
  const { command, argument } = parsed, name = command.name;
  const level = levelFor(command, argument);
  const refused = refusalFor(level, input.access, input.surface);
  if (refused) return { command: name, text: refused, refused: true };
  // Q259: a household person at the window sends only the commands that work on their own things (./household.ts).
  const notTheirs = householdCommandRefusal(host.runtime.store, input.surface, name, argument);
  if (notTheirs) return { command: name, text: notTheirs, refused: true };
  const call: Call = {
    host, surface: input.surface, argument, sessionId: input.sessionId, access: input.access,
    mode: commandMode(host.runtime.store, host.runtime.owner), ...(input.permissions ? { permissions: input.permissions } : {}),
  };
  try {
    if (level === "owner") host.requireOwner(`/${name}`);
    return { command: name, ...(await HANDLERS[name]!(call)) };
  } catch (error) {
    return { command: name, text: host.runtime.hideSecrets(error instanceof Error ? error.message : String(error)) };
  }
}
