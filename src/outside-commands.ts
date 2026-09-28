import type { RunOrigin } from "./key-context.js";

/**
 * RES-253, first step: a command asked for by someone other than the owner runs behind the operating system's own wall,
 * with no network and writes held to the workspace, or it does not run at all.
 *
 * "Someone other than the owner" is read from where the task came from, never from what it says: a household person's
 * task, a short-lived or pairing key's (a script, another assistant over A2A, a lent conversation), and work another
 * program started over MCP, A2A or ACP. The owner's own work, including their Trunks, schedules, triggers and their own
 * paired chat, keeps Full Access exactly as before; other people in a chat never get commands at all (src/channels).
 *
 * The wall is the held command Branch already has (src/integrations/shell.ts, Q12): behind bubblewrap on Linux, macOS's
 * sandbox on a Mac, and on Windows inside WSL behind bubblewrap. Where none of those can run, the held command is refused
 * with a sentence saying why, so a command from outside never runs unwalled.
 */
export const outsideSourcesWalled: ReadonlySet<string> = new Set(["mcp", "a2a", "acp"]);

/** Why this task counts as someone other than the owner, in a few words, or null for the owner's own work. */
export function outsideCaller(origin: RunOrigin): string | null {
  if (origin.personProfileId) return "a household person";
  if (origin.shortLivedKey) return "a key";
  if (outsideSourcesWalled.has(origin.source)) return `another program (${origin.source})`;
  if (origin.lentTo) return "a lent conversation";
  return null;
}

/** The tools that start a program; only a command can be held to one folder, so the other two are refused. */
export const heldOnly = "shell.execute";
/**
 * The owner's other computers (src/remote/ssh-workspace.ts) are reached over SSH, which no wall on this computer can hold:
 * every byte goes through ssh to a computer that can reach anything. So they are the owner's own work alone.
 */
export const remoteTools: readonly string[] = ["remote.list", "remote.files", "remote.read", "remote.run"];
export const outsideRemoteRefusal = (who: string, tool: string): string =>
  `${tool} is not run for ${who}: the owner's other computers are reached over SSH, which nothing here can hold back, so only the owner's own work may use them.`;
export const outsideProgramRefusal = (who: string, tool: string): string =>
  `${tool} is not run for ${who}: a program started for someone other than the owner runs only as a command (shell.execute), held to the workspace with no network.`;
