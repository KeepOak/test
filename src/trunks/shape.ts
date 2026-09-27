import type { ReasoningEffort } from "../models.js";
import { styledPermissions, type SpecialistStyle } from "../specialist-styles.js";
import { commandPermissions } from "./settings.js";
import type { Trunk } from "./record.js";

/**
 * What a Trunk's turn runs with. The runtime asks for this at the start of every top-level task
 * (src/runtime.ts, the R17-A block), so a Trunk Chat runs as its Trunk however the message arrived:
 * the window, a queued message, a chat app linked to it, a routine or another Trunk.
 */
export interface TrunkRunShape {
  trunkId: string;
  /** The memory scope (src/trunks/memory-scope.ts). */
  agent: string;
  /** Added after Branch's own instructions: who it is, who else is on the roster, and how to reach them. */
  instructions: string;
  model?: string;
  reasoning?: ReasoningEffort | null;
  permissions: string[];
  style?: SpecialistStyle;
  /**
   * Integrator (R17-A): a turn in a room is one voice among several, so it runs like a delegated task —
   * no plan of its own and no reviewer pass — or one message from the owner would multiply model calls.
   */
  roomTurn: boolean;
  /** mac7/lockdown-fix: the keys it may use; a sign-in account never answers for it. */
  keys: Trunk["keys"];
}

const mcpPermission = /^mcp\.([^.]+)\.[a-f0-9]{16}$/;

/**
 * The permissions a Trunk's turn gets: its own list (or the owner's ordinary set), never more than
 * the caller allowed, with commands and connected tool servers kept off unless its reach allows them.
 */
export function trunkPermissions(trunk: Trunk, available: readonly string[], caller?: readonly string[]): string[] {
  const allowed = new Set(caller ?? available);
  const base = trunk.permissions.length ? trunk.permissions : available;
  return [...new Set(base)].filter((permission) => {
    if (!allowed.has(permission)) return false;
    if (!trunk.reach.commands && commandPermissions.includes(permission)) return false;
    const server = mcpPermission.exec(permission)?.[1];
    return server === undefined || trunk.mcpServers.includes(server);
  }).sort();
}

/** One line per Trunk on the roster, with what it does, so a Trunk knows whom to ask. */
export function rosterLines(roster: readonly Trunk[], self: string): string[] {
  return roster.filter((t) => !t.hidden || t.id === self).map((t) =>
    `- @${t.handle}: ${t.name}${t.title ? `, ${t.title}` : ""}${t.description ? ` — ${t.description.slice(0, 160)}` : ""}${t.id === self ? " (you)" : ""}`);
}

/** The instructions a Trunk's own turn carries. Its SOUL text is the owner's, handed in as data. */
export function trunkInstructions(trunk: Trunk, roster: readonly Trunk[], messaging: boolean): string {
  const lines = [
    "",
    `You are ${trunk.name} (@${trunk.handle}), one of the owner's Trunks: a named assistant with its own conversation, memory and settings.`,
    trunk.title ? `Your role: ${trunk.title}.` : "",
    trunk.description ? `About you: ${trunk.description}` : "",
    trunk.instructions ? `Your own instructions from the owner:\n${trunk.instructions}` : "",
    trunk.skills.length ? `Skills to reach for first: ${trunk.skills.join(", ")}.` : "",
    "The Trunks on this roster:",
    ...rosterLines(roster, trunk.id),
    messaging
      ? "To ask another Trunk something, call trunk.message with its @name and a message you write yourself. It answers later in your conversation; do not wait for it."
      : "",
  ];
  return lines.filter((line, index) => index === 0 || line).join("\n");
}

export function shapeFor(trunk: Trunk, roster: readonly Trunk[], options: {
  available: readonly string[]; caller?: readonly string[] | undefined; messaging: boolean; sessionModel: boolean; agent: string;
  roomTurn?: boolean;
}): TrunkRunShape {
  return {
    trunkId: trunk.id,
    roomTurn: options.roomTurn === true,
    keys: trunk.keys,
    agent: options.agent,
    instructions: trunkInstructions(trunk, roster, options.messaging),
    // A reviewing style takes away everything that writes, exactly as it does for a specialist.
    // Direct messages exist only in a Trunk's own conversation, never in a room or a routine.
    permissions: styledPermissions(trunk.style, trunkPermissions(trunk, options.available, options.caller))
      .filter((permission) => options.messaging || permission !== "trunks.message")
      // Only Branch proposes a new Trunk (src/trunks/propose.ts); a Trunk never does.
      .filter((permission) => permission !== "trunks.propose"),
    ...(trunk.model && !options.sessionModel ? { model: trunk.model } : {}),
    ...(trunk.reasoning ? { reasoning: trunk.reasoning } : {}),
    ...(trunk.style !== "default" ? { style: trunk.style } : {}),
  };
}
