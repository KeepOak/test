import { z } from "zod";
import type { Store } from "../store.js";
import type { Trunk, TrunkRecords } from "./record.js";
import type { Room, TrunkRooms } from "./rooms.js";

/**
 * Redesign phase 2 "rooms" (critique #32): who answers in a conversation.
 *
 *   plain       your assistant answers, as before
 *   trunk       a Trunk you chose answers here; every task in it runs as that Trunk (its own
 *               instructions, memory, tools, model and keys), exactly as in the Trunk's own chat
 *   trunk-chat  a Trunk's own permanent conversation
 *   room        a room's own conversation: two to six Trunks and you (src/trunks/rooms.ts)
 *   member      one Trunk's side of a room, which follows the room's conversation
 *
 * The choice is kept in the `governance` table under `trunk-conversation:<sessionId>`, beside the
 * Trunks and rooms themselves. `authors` says from which reply on each choice answered, so a
 * conversation that changed hands mid-way still signs every reply with whoever gave it. Choosing
 * only ever narrows what a task may do: a Trunk's shape never adds a tool the owner's set lacks.
 */
export const ConversationChoiceSchema = z.object({ trunkId: z.string().uuid().nullable() }).strict();
export const ConversationStartSchema = z.object({ trunkId: z.string().uuid() }).strict();
export const ConversationRoomSchema = z.object({ trunkId: z.string().uuid() }).strict();

export type ConversationKind = "plain" | "trunk" | "trunk-chat" | "room" | "member";
interface Choice { sessionId: string; trunkId: string | null; authors: { from: number; trunkId: string | null }[]; updatedAt: string }
/** What the window needs to know about a Trunk: never its instructions, keys or reach. */
export interface TrunkBrief { id: string; name: string; handle: string; title: string; avatar: Trunk["avatar"]; voice: string; look?: unknown }
/** `look` is the face the owner gave it (p2-shell), passed along when there is one. */
const brief = (t: Trunk): TrunkBrief => {
  const look = (t as unknown as { look?: unknown }).look;
  return { id: t.id, name: t.name, handle: t.handle, title: t.title, avatar: t.avatar, voice: t.voice, ...(look ? { look } : {}) };
};
const key = (sessionId: string) => `trunk-conversation:${sessionId}`;
/** How much of the conversation a room made from it carries over, so its Trunks know what came before. */
const contextMessages = 8, contextChars = 3000;

export interface ConversationDeps {
  store: Store;
  owner: string;
  records: TrunkRecords;
  rooms: TrunkRooms;
  /** A conversation belongs to the one asking (the owner's own, not a household person's). */
  owns: (sessionId: string) => boolean;
  changed: () => void;
}

export class TrunkConversations {
  constructor(private readonly deps: ConversationDeps) {}

  private saved(sessionId: string): Choice | undefined {
    return this.deps.store.get("governance", this.deps.owner, key(sessionId))?.data as unknown as Choice | undefined;
  }
  /** Every conversation a Trunk was chosen for: conversation → Trunk. */
  chosen(): Map<string, string> {
    return new Map(this.deps.store.list("governance", this.deps.owner).filter((r) => r.id.startsWith("trunk-conversation:"))
      .map((r) => r.data as unknown as Choice).filter((c) => c.trunkId).map((c) => [c.sessionId, c.trunkId!] as const));
  }
  private roomOf(sessionId: string): Room | undefined {
    return this.deps.rooms.list().find((room) => room.sessionId === sessionId);
  }
  kind(sessionId: string): ConversationKind {
    if (this.roomOf(sessionId)) return "room";
    if (this.deps.rooms.memberRooms().has(sessionId)) return "member";
    if (this.deps.records.list().some((t) => t.chatSessionId === sessionId || t.retiredChats.includes(sessionId))) return "trunk-chat";
    return this.saved(sessionId)?.trunkId ? "trunk" : "plain";
  }
  private check(sessionId: string): void {
    if (!this.deps.owns(sessionId)) throw Object.assign(new Error("Conversation not found"), { status: 404 });
  }

  /** Who answers here, who answered each reply, and which Trunks could join. */
  info(sessionId: string) {
    this.check(sessionId);
    const kind = this.kind(sessionId), all = this.deps.records.list();
    const room = this.roomOf(sessionId);
    const trunkId = this.trunkIdOf(sessionId, kind);
    const trunk = trunkId ? this.deps.records.find(trunkId) : undefined;
    return {
      sessionId, kind, trunk: trunk ? brief(trunk) : null,
      room: room ? { id: room.id, name: room.name, members: this.deps.rooms.roster(room).map((m) => brief(this.deps.records.get(m.id))) } : null,
      authors: this.saved(sessionId)?.authors ?? [],
      /** For one Trunk's side of a room: the room, so the window can open it instead. */
      memberOf: kind === "member" ? this.deps.rooms.list().find((r) => Object.values(r.memberSessions).includes(sessionId))?.id ?? null : null,
      trunks: all.filter((t) => !t.hidden).map(brief),
    };
  }

  /** The room shape a named household member may see, without the owner's other Trunks. */
  sharedRoomInfo(room: Room) {
    return {
      sessionId: room.sessionId, kind: "room" as const, trunk: null,
      room: { id: room.id, name: room.name, members: this.deps.rooms.roster(room).map((member) => brief(this.deps.records.get(member.id))) },
      authors: [], memberOf: null, trunks: [],
    };
  }

  private trunkIdOf(sessionId: string, kind: ConversationKind): string | null | undefined {
    return kind === "trunk" ? this.saved(sessionId)!.trunkId
      : kind === "trunk-chat" ? this.deps.records.list().find((t) => t.chatSessionId === sessionId || t.retiredChats.includes(sessionId))?.id
        : kind === "member" ? this.deps.rooms.memberConversations().get(sessionId) : undefined;
  }
  /**
   * Integration review: for "… needs you", the Trunk that answers in this conversation and where to
   * open it (a Trunk's side of a room opens the room itself); null for your assistant.
   */
  answerer(sessionId: string): { name: string; room: string | null; sessionId: string } | null {
    const kind = this.kind(sessionId);
    const trunkId = this.trunkIdOf(sessionId, kind);
    const trunk = trunkId ? this.deps.records.find(trunkId) : undefined;
    if (!trunk) return null;
    const room = kind === "member" ? this.deps.rooms.list().find((r) => Object.values(r.memberSessions).includes(sessionId)) : undefined;
    return { name: trunk.name, room: room?.name ?? null, sessionId: room?.sessionId ?? sessionId };
  }

  /** Makes a Trunk answer in this conversation from now on, or (null) your assistant again. */
  choose(sessionId: string, input: unknown) {
    this.check(sessionId);
    const { trunkId } = ConversationChoiceSchema.parse(input);
    const kind = this.kind(sessionId);
    if (kind !== "plain" && kind !== "trunk")
      throw new Error(kind === "room" ? "This is a room: add or take out Trunks with its members instead."
        : "This conversation belongs to a Trunk already. Start a new conversation to choose another.");
    if (trunkId) this.deps.records.get(trunkId);
    const before = this.saved(sessionId);
    if ((before?.trunkId ?? null) === trunkId) return this.info(sessionId);
    const from = this.deps.store.messages(sessionId).filter((m) => m.role === "assistant" && !m.toolCalls?.length).length;
    const authors = [...(before?.authors ?? [{ from: 0, trunkId: null }]).filter((a) => a.from < from), { from, trunkId }].slice(-50);
    this.deps.store.save("governance", this.deps.owner, key(sessionId),
      { sessionId, trunkId, authors, updatedAt: new Date().toISOString() } satisfies Choice);
    this.deps.changed();
    return this.info(sessionId);
  }

  /**
   * Pass 17: a path branched off a conversation is answered by whoever answered there, signed the
   * same way; a Trunk's own chat hands its paths to that Trunk as ordinary conversations with it.
   */
  carryTo(fromId: string, toId: string): void {
    const kind = this.kind(fromId), trunkId = this.trunkIdOf(fromId, kind), now = new Date().toISOString();
    const choice: Choice | null = kind === "trunk" ? { ...this.saved(fromId)!, sessionId: toId, updatedAt: now }
      : kind === "trunk-chat" && trunkId ? { sessionId: toId, trunkId, authors: [{ from: 0, trunkId }], updatedAt: now } : null;
    if (!choice) return;
    this.deps.store.save("governance", this.deps.owner, key(toId), { ...choice });
    this.deps.changed();
  }

  /** A new conversation with a Trunk, before anything is said in it. */
  start(input: unknown, open: (title: string) => string): { sessionId: string } {
    const { trunkId } = ConversationStartSchema.parse(input);
    const trunk = this.deps.records.get(trunkId);
    const sessionId = open(`Talking to ${trunk.name}`);
    this.choose(sessionId, { trunkId });
    return { sessionId };
  }

  /**
   * Brings another Trunk in: a new room with whoever answers here now and the one added, carrying the
   * last few messages over so both know what came before. This conversation stays as it was.
   */
  room(sessionId: string, input: unknown): Room {
    this.check(sessionId);
    const { trunkId } = ConversationRoomSchema.parse(input);
    const here = this.info(sessionId).trunk;
    if (!here) throw new Error("Choose who answers here first; a room needs two Trunks.");
    if (here.id === trunkId) throw new Error(`${here.name} is already in this conversation.`);
    const added = this.deps.records.get(trunkId);
    return this.deps.rooms.create({ name: this.freeName(`${here.name} and ${added.name}`), members: [here.id, added.id] },
      { context: this.context(sessionId) });
  }
  private freeName(base: string): string {
    const taken = new Set(this.deps.rooms.list().map((r) => r.name.toLowerCase()));
    const cut = base.slice(0, 54);
    for (let n = 1; n < 100; n++) { const name = n === 1 ? cut : `${cut} (${n})`; if (!taken.has(name.toLowerCase())) return name; }
    return `${cut} (${Date.now() % 1000})`;
  }
  private context(sessionId: string): string {
    const lines = this.deps.store.messages(sessionId)
      .filter((m) => (m.role === "user" || m.role === "assistant") && !m.toolCalls?.length && m.content.trim())
      .slice(-contextMessages).map((m) => `${m.role === "user" ? "The owner" : "Reply"}: ${m.content.trim().slice(0, 600)}`);
    let text = lines.join("\n");
    while (text.length > contextChars && lines.length > 1) { lines.shift(); text = lines.join("\n"); }
    return text.slice(-contextChars);
  }

  /** A Trunk that is removed stops answering in the conversations it was chosen for. */
  forget(trunkId: string): void {
    for (const [sessionId, chosen] of this.chosen()) if (chosen === trunkId) this.choose(sessionId, { trunkId: null });
  }
}
