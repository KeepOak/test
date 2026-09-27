import { plainLine, type ConverseOptions, type RemoteAgent } from "../a2a-client.js";
import type { RoomMember } from "./room-plan.js";

/**
 * a2a-rooms: agents elsewhere, connected by their A2A card (Customize › Tools), seated in a room
 * beside its Trunks. The room hands one the words it would give a Trunk for that turn — the
 * messages of this room since it last spoke, what the room was made from, and artifacts the owner
 * shared here — scrubbed of secrets, and records its answer as a message from it. Its answer is
 * only ever text in the room: it runs no tool, answers no question, and brings nobody in.
 */
export interface OutsideAgents {
  byId(id: string): RemoteAgent | undefined;
  converse(id: string, text: string, options?: ConverseOptions): Promise<{ answer: string; state: string; contextId?: string }>;
  online(id: string): boolean;
  probe(id: string): void;
}

/** At most this many outside agents in one room. */
export const maxRoomAgents = 4;
/** What an outside agent's message may hold, once recorded in the room. */
export const maxAgentReply = 4000;
/** Words a handle cannot be, since the room reads them as everyone or the owner. */
const reserved = new Set(["all", "everyone", "you", "owner", "user"]);

/** The @name an outside agent answers to: from its card's name, never one a Trunk here already has. */
export function agentHandle(name: string, taken: Set<string>): string {
  let base = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/[-._:]+$/, "").slice(0, 30) || "agent";
  if (reserved.has(base)) base = `${base}-agent`;
  let handle = base;
  for (let n = 2; taken.has(handle); n++) handle = `${base}-${n}`;
  taken.add(handle);
  return handle;
}

/** "A2A · " and where it runs: the card's provider, else the host of the address it answers on. */
export function agentBadge(agent: RemoteAgent): string {
  let host = "";
  try { host = new URL(agent.url).hostname; } catch { host = ""; }
  const where = plainLine(agent.provider) || plainLine(host);
  return where ? `A2A · ${where}` : "A2A";
}

/**
 * The outside agents seated in a room, as the planner sees them, after its Trunks. One this Branch is no longer
 * connected to keeps its seat under the name it was seated with (`names`), marked `gone`, so its @name still names it.
 */
export function outsideMembers(ids: readonly string[], trunks: readonly RoomMember[], outside: OutsideAgents | null,
  names: Readonly<Record<string, string>> = {}): RoomMember[] {
  const taken = new Set(trunks.map((m) => m.handle.toLowerCase()));
  return ids.flatMap((id) => {
    const agent = outside?.byId(id);
    const name = plainLine(agent?.name ?? names[id]) || (agent ? "Agent" : "");
    if (!name) return [];
    return [{ id, handle: agentHandle(name, taken), name, outside: true, ...(agent ? {} : { gone: true }) }];
  });
}

/** The name an agent is seated under, kept with the room so its seat outlives the connection. */
export function seatName(agent: RemoteAgent | undefined): string {
  return plainLine(agent?.name) || "Agent";
}

/** An error from elsewhere, on one line and short, for the room's "didn't answer" note. */
export function reasonText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 200) || "no reason given";
}

/** A task the agent ended without doing it. */
export const refusedStates = new Set(["failed", "rejected", "canceled", "cancelled", "auth-required"]);
