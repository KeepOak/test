import { z } from "zod";
import type { createBranch } from "../index.js";
import { COMMANDS, aliasesOn, surfaces } from "./catalog.js";
import { commandHost } from "./host.js";
import { CommandRunSchema, commandSettings, listed, available, saveCommandSettings } from "./settings.js";
import { executeCommand } from "./execute.js";
import { PARITY } from "./parity.js";
import type { Access } from "./handlers.js";
import { dashboardSettings } from "../dashboard-api.js";
import { savedCommandRows } from "./saved.js";
import { byCard, recordedWrite } from "../settings-kit/recorded-write.js"; // Q48
import { householdHere, mayUseConversation } from "./household.js"; // Q259

/**
 * The commands' routes (wave mac3, commands). The window, the phone and the dashboard read their
 * list here and carry commands out here; the terminal and the chat apps call the same code directly.
 *
 *   GET  /api/commands?surface=window|phone|dashboard   the list that surface offers
 *   GET  /api/commands/table                            every command on every surface, and the parity table
 *   POST /api/commands/run { surface, line, sessionId }  any command the key allows; a key that may
 *                                                        only look may send only commands that look.
 *                                                        Never GET: typed text stays out of addresses and logs.
 *   GET/POST /api/commands/settings                     the switch; changing it needs the key of this computer
 */
type Branch = Awaited<ReturnType<typeof createBranch>>;
export class CommandApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const RunBody = CommandRunSchema;
const WebSurface = RunBody.shape.surface;

export const handlesCommandsPath = (path: string): boolean => path === "/api/commands" || path.startsWith("/api/commands/");

export interface CommandApiDeps {
  method: string;
  url: URL;
  access: Access;
  readBody: () => Promise<unknown>;
}

function listFor(app: Branch, surface: z.infer<typeof WebSurface>) {
  const mode = commandSettings(app.store, app.runtime.owner).mode;
  const commands = COMMANDS.filter((command) => available(command, surface, mode)).map((command) => ({
    name: command.name, aliases: aliasesOn(command, surface, mode === "off"), args: command.args, key: command.key, english: command.english,
    level: command.level, bareLooks: command.bareLooks === true, listed: listed(command, surface, mode),
  }));
  // bucket 12: the owner's own saved commands follow the shipped ones (never on the dashboard, which has no message box)
  // Q259: and never to a household person at the window, for whom they are no commands (execute.ts).
  const saved = surface === "dashboard" || householdHere(app.store, surface) ? [] : savedCommandRows(app.store, app.runtime.owner, !commands.some((row) => row.name === "prompts"));
  return { surface, mode, commands: [...commands, ...saved] };
}

async function run(app: Branch, deps: CommandApiDeps, input: z.infer<typeof RunBody>) {
  // Q259: the conversation must be the typing person's own: the owner's for the owner, and for a household person at
  // the window theirs (lent to the owner while their task works). Anybody else's reads exactly like one that is not there.
  if (input.sessionId && !mayUseConversation(app.store, app.runtime.owner, input.surface, input.sessionId))
    throw new CommandApiError(404, "Conversation not found");
  const host = commandHost(app.runtime, app);
  // What the key may do is checked here, command by command (execute.ts `refusalFor`).
  const outcome = await executeCommand(host, {
    surface: input.surface, line: input.line, sessionId: input.sessionId, access: deps.access,
  });
  return outcome ? { handled: true, ...outcome } : { handled: false };
}

/** The dashboard's commands exist only while the dashboard itself is switched on. */
function dashboardOpen(app: Branch, surface: string): void {
  if (surface === "dashboard" && dashboardSettings(app.store, app.runtime.owner).mode === "off")
    throw new CommandApiError(404, "The dashboard is switched off.");
}

export async function commandsApi(app: Branch, path: string, deps: CommandApiDeps): Promise<unknown> {
  const { method, url } = deps;
  if (method === "GET" && path === "/api/commands") {
    const surface = WebSurface.parse(url.searchParams.get("surface") ?? "window");
    dashboardOpen(app, surface);
    return listFor(app, surface);
  }
  if (method === "GET" && path === "/api/commands/table")
    return { surfaces, commands: COMMANDS, parity: PARITY, mode: commandSettings(app.store, app.runtime.owner).mode };
  if (path === "/api/commands/run") {
    if (method !== "POST") throw new CommandApiError(405, "Send commands with POST.");
    const input = RunBody.parse(await deps.readBody());
    dashboardOpen(app, input.surface);
    return run(app, deps, input);
  }
  if (path === "/api/commands/settings") {
    if (method === "GET") return { ...commandSettings(app.store, app.runtime.owner), access: deps.access };
    if (deps.access !== "full") throw new CommandApiError(403, "Only the key of this computer can change which commands are offered.");
    app.store.profiles.requireOwner("Which commands are offered");
    const input = await deps.readBody();
    return recordedWrite(app.store, app.runtime.owner, byCard("command-catalog"), ["command-catalog"], () => saveCommandSettings(app.store, app.runtime.owner, input));
  }
  throw new CommandApiError(404, "Not found");
}
